import { quote } from "shell-quote";
import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { outputSchemas } from "../../src/mcp/schemas.ts";

// Exercise existing evidence assertions through the public four-function API.
export async function callOperation(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const result = await client.callTool(
    name === "workspace_info"
      ? { name: "capabilities", arguments: args }
      : name === "read_image"
        ? { name: "artifact", arguments: { kind: "image", ...args } }
        : {
            name: "exec",
            arguments: {
              command: quote([
                name,
                ...Object.entries(args).flatMap(([key, value]) => [
                  `--${key}`,
                  String(value),
                ]),
              ]),
            },
          },
  );
  if (result.isError || name === "workspace_info") return result;
  const structured = result.structuredContent as any;
  const data =
    name === "read_image"
      ? structured.artifact.result
      : structured.execution.result;
  return {
    ...result,
    structuredContent: data,
    content: [
      { type: "text", text: JSON.stringify(data) },
      ...(result.content as any[]).slice(1),
    ],
  };
}
export function operationSchema(name: string, tools: any[]) {
  return name === "workspace_info"
    ? tools.find((tool) => tool.name === "capabilities").outputSchema
    : z.toJSONSchema(outputSchemas[name as keyof typeof outputSchemas]);
}
