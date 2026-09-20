// Bun auto-loads this module for every `bun test` run (see bunfig.toml).
// src/env.ts falls back to the installation's own .env, so a developer's real
// ChatGPT project, model or tunnel settings would otherwise become test inputs.
// Empty values win over that file by the same precedence the CLI documents, and
// a test that needs a preference still sets it explicitly in its own body.
for (const key of [
  "CONVOREL_TUNNEL_API_KEY",
  "CONVOREL_TUNNEL_ID",
  "CONVOREL_MCP_ROOTS",
  "CONVOREL_MODEL",
  "CONVOREL_PROJECT_URL",
  "CONVOREL_PROJECT_NAME",
])
  process.env[key] = "";
