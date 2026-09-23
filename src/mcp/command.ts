import { parse } from "shell-quote";
import { z } from "zod";

/** Parse a single bounded command. No shell, expansion, pipes or subprocess lookup. */
export function commandTokens(command: string) {
  if (!command.trim() || command.length > 8192 || /[\r\n\0`]/.test(command))
    throw new Error("COMMAND_DENIED");
  const tokens = parse(command, () => {
    throw new Error("EXPANSION_DENIED");
  }).map((token) =>
    typeof token !== "string" && "op" in token && token.op === "glob"
      ? token.pattern
      : token,
  );
  if (tokens.some((token) => typeof token !== "string"))
    throw new Error("SHELL_SYNTAX_DENIED");
  return tokens as string[];
}

export function parseCommand(command: string) {
  const argv = commandTokens(command);
  let name = argv.shift()!;
  if (name === "git") name = `git_${argv.shift()}`;
  const args: Record<string, string> = Object.create(null);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!/^--[a-zA-Z][a-zA-Z0-9]*$/.test(key) || argv[i + 1] === undefined)
      throw new Error("COMMAND_ARGUMENTS_INVALID");
    if (Object.hasOwn(args, key.slice(2)))
      throw new Error("DUPLICATE_ARGUMENT");
    args[key.slice(2)] = argv[i + 1];
  }
  return { name, args };
}

export function commandArgs(schema: z.ZodObject, args: Record<string, string>) {
  const values: Record<string, unknown> = Object.create(null);
  const json = z.toJSONSchema(schema) as {
    properties?: Record<string, { type?: string }>;
  };
  for (const [key, value] of Object.entries(args)) {
    const type = json.properties?.[key]?.type;
    values[key] =
      type === "integer" || type === "number" ? Number(value) : value;
  }
  return schema.strict().parse(values);
}
