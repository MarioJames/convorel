import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { outputSchemas } from "./schemas.ts";
import { commandArgs, commandTokens, parseCommand } from "./command.ts";
import { MemoryAccess, memoryInput, memoryOutput } from "./memory.ts";
import { ExecutionAccess, executionOutput } from "./execution.ts";
import { MAX_OUT } from "../workspace/limits.ts";

export interface Operation {
  description: string;
  input: z.ZodObject;
  output: z.ZodObject;
  run(args: unknown): Promise<{ data: any; imageData?: string }>;
}

export function registerFunctions(
  server: McpServer,
  operations: Map<string, Operation>,
  memory: MemoryAccess,
  execution: ExecutionAccess,
) {
  const commandNames = [...operations.keys()].filter(
    (name) => !["workspace_info", "read_image"].includes(name),
  );
  const execResults = commandNames.map((name) =>
    z.strictObject({
      operation: z.literal(name),
      result: operations.get(name)!.output,
    }),
  );
  execResults.push(
    z.strictObject({ operation: z.literal("run"), result: executionOutput }),
  );
  const execOutput = z
    .object({
      execution: z.union(
        execResults as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]],
      ),
    })
    .strict();
  const artifactOutput = z.strictObject({
    artifact: z.discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("text"),
        result: outputSchemas.read_file,
      }),
      z.strictObject({
        kind: z.literal("image"),
        result: outputSchemas.read_image,
      }),
    ]),
  });
  const capabilityOutput = outputSchemas.workspace_info.extend({
    mode: z.literal("guarded"),
    execution: z.strictObject({
      mode: z.literal("guarded-execution"),
      buildsAndTests: z.boolean(),
      dependencyRoots: z.array(z.string()),
      runtime: z.literal("bun"),
      network: z.literal(false),
      shell: z.literal(false),
      commands: z.array(
        z.strictObject({
          name: z.string(),
          description: z.string(),
          arguments: z.array(z.string()),
          inputSchema: z.string(),
        }),
      ),
      syntax: z.string(),
    }),
    memory: z.strictObject({
      configured: z.boolean(),
      roots: z.array(z.string()),
      actions: z.array(z.enum(["search", "read"])),
      status: z.literal("not-probed"),
    }),
    artifacts: z.strictObject({
      kinds: z.array(z.enum(["text", "image"])),
      uploads: z.literal(false),
    }),
  });
  const add = (
    name: string,
    description: string,
    inputSchema: z.ZodObject,
    outputSchema: z.ZodObject,
    run: (
      args: any,
      signal?: AbortSignal,
    ) => Promise<{ data: any; imageData?: string }>,
  ) => {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: name !== "exec",
          destructiveHint: false,
          idempotentHint: name !== "exec",
          openWorldHint: name === "memory",
        },
      },
      async (args, extra) => {
        try {
          const { data, imageData } = await run(args, extra.signal);
          const parsed: any = outputSchema.parse(data);
          const serialized = JSON.stringify(parsed);
          if (Buffer.byteLength(serialized) > MAX_OUT)
            throw new Error("RESPONSE_TOO_LARGE");
          const content: any[] = [{ type: "text", text: serialized }];
          if (imageData)
            content.push({
              type: "image",
              mimeType: parsed.artifact.result.mimeType,
              data: imageData,
            });
          return { content, structuredContent: parsed };
        } catch (error: any) {
          const code =
            error instanceof z.ZodError
              ? "INVALID_ARGUMENTS"
              : error.code === "ENOENT"
                ? "FILE_NOT_FOUND"
                : /^[A-Z_]+$/.test(error.message)
                  ? error.message
                  : "TOOL_FAILED";
          return {
            isError: true,
            content: [{ type: "text" as const, text: code }],
          };
        }
      },
    );
  };
  add(
    "capabilities",
    "Discover permitted roots, project identity, command syntax, memory sharing and artifact limits. Memory configured does not mean healthy. Call before reading evidence.",
    z.strictObject({ path: z.string().optional() }),
    capabilityOutput,
    async (args) => {
      const { data } = await operations.get("workspace_info")!.run(args);
      return {
        data: {
          ...data,
          mode: "guarded",
          execution: {
            mode: "guarded-execution",
            shell: false,
            buildsAndTests: execution.available(),
            dependencyRoots: execution.dependencyRoots,
            runtime: "bun",
            network: false,
            commands: commandNames.map((name) => ({
              name,
              description: operations.get(name)!.description,
              arguments: Object.keys(operations.get(name)!.input.shape),
              inputSchema: JSON.stringify(
                z.toJSONSchema(operations.get(name)!.input),
              ),
            })),
            syntax:
              "One command: NAME --option value. Quote values containing spaces or glob syntax. Options retain their schema names (e.g. startLine). git status/log/show/diff/compare/read_file are aliases for git_* commands. No pipes, redirects or substitutions. Build/test commands: bun test; bun run build/test/check/typecheck/dist (also colon-suffixed scripts). Supply cwd. Build/test execution is available on Linux with a Bubblewrap sandbox and explicit dependency grants; it is unavailable on macOS. Example: read_file --path '/repo/file.ts' --startLine 1 --maxLines 100. Use returned pagination fields to continue.",
          },
          memory: {
            configured: memory.roots.length > 0,
            roots: memory.roots,
            actions: memory.roots.length ? ["search", "read"] : [],
            status: "not-probed",
          },
          artifacts: { kinds: ["text", "image"], uploads: false },
        },
      };
    },
  );
  add(
    "exec",
    "Execute one permitted command string, including isolated Bun build/test scripts. Discover commands/options with capabilities. Example: git status --path '/repo'. Commands dispatch through the existing workspace policy; this is not an OS shell. Results preserve version/hash and pagination evidence.",
    z.strictObject({
      command: z.string().min(1).max(8192),
      cwd: z.string().optional(),
      timeoutSeconds: z.number().int().min(1).max(120).default(30),
    }),
    execOutput,
    async ({ command, cwd, timeoutSeconds }, signal) => {
      if (commandTokens(command)[0] === "bun") {
        if (!cwd) throw new Error("EXEC_CWD_REQUIRED");
        return {
          data: {
            execution: {
              operation: "run",
              result: await execution.run(command, cwd, timeoutSeconds, signal),
            },
          },
        };
      }
      const { name, args } = parseCommand(command);
      if (cwd !== undefined) {
        if (args.path && args.path !== cwd)
          throw new Error("EXEC_PATH_CONFLICT");
        args.path = cwd;
      }
      if (!commandNames.includes(name)) throw new Error("COMMAND_DENIED");
      const operation = operations.get(name)!;
      const { data } = await operation.run(commandArgs(operation.input, args));
      return { data: { execution: { operation: name, result: data } } };
    },
  );
  add(
    "artifact",
    "Read a permitted text report/log fragment or PNG/JPEG/WebP image. Uses the same file policy as exec, including ignored/credential paths. No uploads or arbitrary binary downloads. A hash is not proof of test execution or producing revision.",
    z.strictObject({
      kind: z.enum(["text", "image"]),
      path: z.string(),
      startLine: z.number().int().min(1).max(10000000).optional(),
      maxLines: z.number().int().min(1).max(1000).optional(),
    }),
    artifactOutput,
    async ({ kind, ...args }) => {
      if (
        kind === "image" &&
        (args.startLine !== undefined || args.maxLines !== undefined)
      )
        throw new Error("INVALID_ARGUMENTS");
      const { data, imageData } = await operations
        .get(kind === "image" ? "read_image" : "read_file")!
        .run(args);
      return { data: { artifact: { kind, result: data } }, imageData };
    },
  );
  add(
    "memory",
    "Search or read explicitly shared OpenViking URI subtrees through the locally configured ov CLI. No writes, deletes, configuration changes or unscoped search. Requires a canonical URI from capabilities.memory.roots. Memory is historical context, not proof of current implementation.",
    memoryInput,
    memoryOutput,
    async (args, signal) => ({ data: await memory.call(args, signal) }),
  );
}
