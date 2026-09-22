import { page } from "./shared.ts";

export const setupPage = page(
  ["setup"],
  [
    "setup --workspace PATH --cdp PORT_OR_HTTP [--agent codex|claude-code|codex,claude-code]",
  ],
  "Find agent-browser on PATH, save its path, then save the workspace and Chrome endpoint. It optionally installs the bundled skill and runs doctor. convorel setup does not install dependencies or agent-browser.",
  [
    [
      "--workspace PATH",
      "Absolute project directory saved as this state directory's default workspace.",
    ],
    [
      "--cdp PORT_OR_HTTP",
      "Loopback Chrome debugging port or http://127.0.0.1:PORT endpoint.",
    ],
    [
      "--agent LIST",
      "When set, install the skill for codex, claude-code, or both after init. Omit it to skip skill installation.",
    ],
  ],
  [
    "bun --no-env-file setup.ts is the source-checkout bootstrap. It installs the locked dependencies and then runs this command.",
    "agent-browser must already be on PATH. init runs it once and saves that absolute path as browser.executable. Later commands use the saved path.",
    "Model and project preferences are changed with config set, not with setup flags.",
  ],
);
export const initPage = page(
  ["init"],
  ["init --workspace PATH --cdp PORT_OR_HTTP"],
  "Find agent-browser on PATH, check that it runs, and save its absolute path. Then save the workspace and Chrome endpoint. An existing binding to a different workspace or endpoint is refused.",
  [
    ["--workspace PATH", "Absolute project directory."],
    [
      "--cdp PORT_OR_HTTP",
      "Loopback Chrome debugging port or http://127.0.0.1:PORT endpoint.",
    ],
  ],
  [
    "The state directory must be outside the workspace. Use another --state-dir for a second binding. Set model, project, and other preferences with config set.",
    "If browser.executable is already set, init checks that saved path instead of searching PATH again. A missing or unidentified agent-browser stops init before the workspace binding is written.",
  ],
);
