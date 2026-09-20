import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { assetPath, COMPILED } from "./runtime.ts";

// Resolve against this installation, never the caller's or shared workspace's cwd.
// A standalone executable has no installation directory to read preferences from.
export function installationEnv(
  key:
    | "CONVOREL_TUNNEL_API_KEY"
    | "CONVOREL_TUNNEL_ID"
    | "CONVOREL_MCP_ROOTS"
    | "CONVOREL_MODEL"
    | "CONVOREL_PROJECT_URL"
    | "CONVOREL_PROJECT_NAME",
  file = COMPILED ? undefined : assetPath(".env"),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env[key] !== undefined) return env[key];
  if (file === undefined) return undefined;
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw new Error("INSTALLATION_ENV_READ_FAILED: cannot read convorel .env");
  }
  // Parse only; do not execute shell syntax or import unrelated settings.
  return parseEnv(contents)[key];
}
