export type Page = {
  command: string[];
  usage: string[];
  summary: string;
  options?: [string, string][];
  notes?: string[];
  commands?: Page[];
};

export const fields: [string, string] = [
  "--fields LIST",
  "Comma-separated top-level JSON fields. Names are letters, digits, and underscores, and cannot start with a digit. Lists apply the selection to each item. A missing field is null. Saved data, stderr, and the exit code stay the same.",
];
export const taskId: [string, string] = [
  "--id ID",
  "Task id. It starts with a lowercase letter or digit, then contains only lowercase letters, digits, and hyphens, and is at most 80 characters.",
];
export const runOpt = (required: boolean): [string, string] => [
  "--run UUID",
  required
    ? "Exact run id. Repeating the command uses this same run and does not create another one."
    : "Exact run id. Omit it to use the task's current run.",
];
export const configRules = [
  "Keys:",
  "  model                         Unset selects Latest and the Pro end of Power, without pinning a version.",
  "  project.url, project.name     Set both or leave both empty. The URL is an observed ChatGPT project URL.",
  "  tunnel.id                     tunnel_ plus 32 hex digits. A command's --tunnel-id overrides it once.",
  "  tunnel.apiKey                 Runtime tunnel key. Command output says only whether it is set.",
  "  mcp.roots                     JSON array of 1 to 16 absolute paths or ~/ paths.",
  "  mcp.memoryRoots               JSON array of canonical OpenViking URI subtrees shared read-only. Unset disables memory.",
  "  mcp.memoryExecutable          Absolute ov CLI path; default resolves ov from PATH.",
  "  mcp.execDependencyRoots       JSON array of explicitly shared node_modules directories for isolated builds/tests.",
  "  browser.executable            Absolute agent-browser path saved by init. It is not Chrome.",
  "  browser.serial                true or false. true uses one global browser lock.",
  "  browser.actionIntervalMs      Integer milliseconds from 1 to 10000. Default 750.",
  "  browser.navigationWaitMs      Integer milliseconds from 1 to 10000. Default 1500.",
  "  locks.taskWaitMs              Positive integer. How long one task waits for its own operation lock.",
  "  release.baseUrl               HTTP(S) URL with no credentials, query, or fragment.",
  "  diagnostics.enabled           true or false. Unset or true records events. false disables recording.",
  "                                Any other stored value, or a failed preference read, also disables it.",
  "Values cannot contain a newline or NUL. A new task snapshots the preferences it sees; changing them later does not rewrite that task.",
].join("\n");
export const footer =
  "Global options, before the command: --config-dir PATH --state-dir PATH.\nDefaults: ~/.local/share/convorel and ~/.config/convorel.";

export function page(
  command: string[],
  usage: string[],
  summary: string,
  options: [string, string][] = [],
  notes: string[] = [],
  commands?: Page[],
): Page {
  return { command, usage, summary, options, notes, commands };
}
