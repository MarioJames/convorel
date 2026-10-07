import { page } from "./shared.ts";

export const setupPage = page(
  ["setup"],
  [
    "setup --workspace PATH [--cdp PORT_OR_HTTP] [--browser managed|external] [--agent codex|claude-code|codex,claude-code]",
  ],
  "Run init with the same options, optionally install the bundled skill, then run doctor. convorel setup does not install dependencies, agent-browser or Chrome.",
  [
    [
      "--workspace PATH",
      "Absolute project directory saved as this state directory's default workspace.",
    ],
    [
      "--cdp PORT_OR_HTTP",
      "Use your own Chrome at this loopback endpoint. Omit it to let Convorel start its own Chrome profile; see init --help.",
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
  [
    "init --workspace PATH [--browser managed] [--cdp PORT] [--chrome PATH] [--login-timeout SECONDS]",
    "init --workspace PATH --cdp PORT_OR_HTTP",
  ],
  "Find agent-browser on PATH, check that it runs, and save its absolute path. Then save the workspace and Chrome binding. Without --cdp, Convorel creates its own Chrome profile, opens ChatGPT and waits until you sign in. With --cdp, you start and sign in to Chrome yourself. An existing binding to a different workspace or endpoint is refused.",
  [
    ["--workspace PATH", "Absolute project directory."],
    [
      "--browser MODE",
      "managed (default without --cdp) starts Convorel's own Chrome profile; external (default with --cdp) uses a Chrome you started.",
    ],
    [
      "--cdp PORT_OR_HTTP",
      "Loopback Chrome debugging endpoint. A managed browser uses http://127.0.0.1:PORT; by default it keeps the saved port, else 9222 or a free port.",
    ],
    [
      "--chrome PATH",
      "Managed only. Absolute Chrome executable. By default google-chrome, google-chrome-stable, chromium or chromium-browser on PATH (Google Chrome.app on macOS).",
    ],
    [
      "--login-timeout SECONDS",
      "Managed only. How long to wait for the ChatGPT sign-in, 1 to 3600. Default 600.",
    ],
  ],
  [
    "The state directory must be outside the workspace. Use another --state-dir for a second binding. Set model, project, and other preferences with config set.",
    "If browser.executable is already set, init checks that saved path instead of searching PATH again. A missing or unidentified agent-browser stops init before the workspace binding is written.",
    "A managed profile lives in chrome/ under the state directory and its Chrome output in chrome.log. The binding is saved before the sign-in wait, so a timed-out sign-in continues with browser start. Later commands start that Chrome again when its endpoint is down; an endpoint answered by another browser is refused.",
  ],
);
