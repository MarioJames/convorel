import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

// Resolve against this installation, never the caller's or shared workspace's cwd.
export function tunnelEnv(
  key: "CONVOREL_TUNNEL_API_KEY" | "CONVOREL_TUNNEL_ID",
  file = resolve(import.meta.dir, "../.env"),
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env[key] !== undefined) return env[key];
  let contents: string;
  try {
    contents = readFileSync(file, "utf8");
  } catch (error: any) {
    if (error.code === "ENOENT") return undefined;
    throw new Error("TUNNEL_ENV_READ_FAILED: cannot read convorel .env");
  }
  // Parse only; do not execute shell syntax or import unrelated settings.
  return parseEnv(contents)[key];
}
