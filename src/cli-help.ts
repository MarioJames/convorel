import { COMPILED } from "./runtime.ts";
import packageInfo from "../package.json";

type Page = {
  command: string[];
  usage: string[];
  summary: string;
  options?: [string, string][];
  notes?: string[];
  commands?: Page[];
};

const fields: [string, string] = [
  "--fields LIST",
  "Comma-separated top-level JSON fields. Names are letters, digits, and underscores, and cannot start with a digit. Lists apply the selection to each item. A missing field is null. Saved data, stderr, and the exit code stay the same.",
];
const taskId: [string, string] = [
  "--id ID",
  "Task id. It starts with a lowercase letter or digit, then contains only lowercase letters, digits, and hyphens, and is at most 80 characters.",
];
const runOpt = (required: boolean): [string, string] => [
  "--run UUID",
  required
    ? "Exact run id. Repeating the command uses this same run and does not create another one."
    : "Exact run id. Omit it to use the task's current run.",
];
const configRules = [
  "Keys:",
  "  model                         Unset selects Latest and the Pro end of Power, without pinning a version.",
  "  project.url, project.name     Set both or leave both empty. The URL is an observed ChatGPT project URL.",
  "  tunnel.id                     tunnel_ plus 32 hex digits. A command's --tunnel-id overrides it once.",
  "  tunnel.apiKey                 Runtime tunnel key. Command output says only whether it is set.",
  "  mcp.roots                     JSON array of 1 to 16 absolute paths or ~/ paths.",
  "  browser.executable            agent-browser controller path, not the Chrome path.",
  "  browser.serial                true or false. true uses one global browser lock.",
  "  browser.actionIntervalMs      Integer milliseconds from 1 to 10000. Default 750.",
  "  browser.navigationWaitMs      Integer milliseconds from 1 to 10000. Default 1500.",
  "  locks.taskWaitMs              Positive integer. How long one task waits for its own operation lock.",
  "  release.baseUrl               HTTP(S) URL with no credentials, query, or fragment.",
  "  diagnostics.enabled           true or false. Unset or true records events. false disables recording.",
  "                                Any other stored value, or a failed preference read, also disables it.",
  "Values cannot contain a newline or NUL. A new task snapshots the preferences it sees; changing them later does not rewrite that task.",
].join("\n");
const footer =
  "Global options, before the command: --config-dir PATH --state-dir PATH.\nDefaults: ~/.local/share/convorel and ~/.config/convorel.";

function page(
  command: string[],
  usage: string[],
  summary: string,
  options: [string, string][] = [],
  notes: string[] = [],
  commands?: Page[],
): Page {
  return { command, usage, summary, options, notes, commands };
}

const skills = [
  page(
    ["skills", "install"],
    [
      "skills install --agent codex|claude-code|codex,claude-code [--scope user|project] [--cwd PATH]",
      "skills install --dir PATH",
    ],
    "Copy the bundled chatgpt-review skill into an Agent directory or a chosen directory. This does not install the convorel runtime and does not require init.",
    [
      [
        "--agent LIST",
        "codex, claude-code, or both comma-separated. Cannot be combined with --dir.",
      ],
      [
        "--scope user|project",
        "user is the default. project installs under --cwd, or the current directory.",
      ],
      ["--cwd PATH", "Project directory used when --scope is project."],
      [
        "--dir PATH",
        "Install the skill directory itself at PATH/chatgpt-review. Refuses --agent, --scope, and --cwd.",
      ],
    ],
    [
      "An existing skill directory or link is left in place. Nothing is overwritten.",
    ],
  ),
  page(
    ["skills", "check"],
    [
      "skills check --agent codex|claude-code|codex,claude-code [--scope user|project] [--cwd PATH] [--baseline-dir OLD_SKILL]",
      "skills check --dir PATH [--baseline-dir OLD_SKILL]",
    ],
    "Compare an installed skill with the bundled skill. The command only reads; it does not create config, state, or an install directory.",
    [
      [
        "--agent, --scope, --cwd, --dir",
        "Same targets as install. --dir cannot be combined with --agent, --scope, or --cwd.",
      ],
      [
        "--baseline-dir PATH",
        "Trusted previous bundled skill directory. Use it only for an install that has no manifest and does not already match the current bundle.",
      ],
    ],
    [
      "Exit 0 when status is current. Exit 2 for update-available, conflict, unmanaged, or missing. Exit 1 when the arguments or the operation fail.",
      "current means the recorded baseline matches this bundle. Local edits can still be present.",
    ],
  ),
  page(
    ["skills", "update"],
    [
      "skills update --agent codex|claude-code|codex,claude-code [--scope user|project] [--cwd PATH] [--baseline-dir OLD_SKILL]",
      "skills update --dir PATH [--baseline-dir OLD_SKILL]",
    ],
    "Bring an installed skill up to the bundled files. Local-only edits stay. A file changed both locally and in the bundle stops the whole update.",
    [
      [
        "--agent, --scope, --cwd, --dir, --baseline-dir",
        "Same as skills check. --baseline-dir is not a way to force an overwrite.",
      ],
    ],
    [
      "Exit 0 when the skill was updated or is already current. Exit 2 when the update is refused because of a conflict, a missing install, or a missing baseline. Exit 1 when the arguments or the operation fail.",
      "There is no force flag. A crashed switch leaves .chatgpt-review.convorel-lock beside the target; later commands stop until that lock is recovered.",
    ],
  ),
];

const service = (
  name: string,
  summary: string,
  extra: [string, string][] = [],
  notes: string[] = [],
): Page =>
  page(
    [name],
    [
      name === "logs"
        ? "logs [--tunnel-id ID] [--lines NUMBER] [--follow]"
        : `${name} [--tunnel-id ID]`,
    ],
    summary,
    [
      [
        "--tunnel-id ID",
        "Tunnel used by this command. Overrides tunnel.id. The command fails when neither is set.",
      ],
      ...extra,
    ],
    notes,
  );

const config = [
  page(
    ["config", "list"],
    ["config list"],
    "Show every preference key, whether it is set, and the preferences file path. A secret is reported as set or unset, not printed.",
    [],
    [configRules],
  ),
  page(
    ["config", "get"],
    ["config get KEY"],
    "Show one preference. tunnel.apiKey is reported as set or unset and is not printed.",
    [],
    [configRules, "KEY is positional. An unknown key is an error."],
  ),
  page(
    ["config", "set"],
    ["config set KEY VALUE"],
    "Write one preference. The value is checked before it is saved. This does not change tasks that already exist.",
    [],
    [
      configRules,
      "VALUE is positional and is not an option even when it starts with a dash. Use config unset KEY to remove a value.",
    ],
  ),
  page(
    ["config", "unset"],
    ["config unset KEY"],
    "Remove one preference. The next read treats it as unset.",
    [],
    [configRules],
  ),
  page(
    ["config", "path"],
    ["config path"],
    "Print the preferences directory and file. This does not create them.",
  ),
];

const conversation = [
  page(
    ["conversation", "list"],
    ["conversation list"],
    "List saved tasks from this state directory. The read is local and does not open Chrome.",
    [fields],
    [
      "Each item includes id, url, currentRun, the latest run state, whether the task lock is active, and summary.",
    ],
  ),
  page(
    ["conversation", "create"],
    [
      "conversation create --id ID (--prompt TEXT | --prompt-stdin true) [--type TYPE --topic TOPIC [--language en|zh]] [--request-id KEY] [--workspace PATH]",
    ],
    "Store a new task and its first run. Exit 0 means the run was saved. It does not open Chrome or send the prompt.",
    [
      taskId,
      [
        "--prompt TEXT",
        "Whole prompt. Use this or --prompt-stdin, not both. The text must be non-empty and at most 100000 bytes.",
      ],
      [
        "--prompt-stdin true",
        "Read the prompt from a pipe. A terminal stdin is refused.",
      ],
      [
        "--type TYPE",
        "Title type: FEA, DES, FIX, OPT, REL, EXP, DOC, or RES. If any naming flag is present, both --type and --topic are required.",
      ],
      [
        "--topic TOPIC",
        "Short single-line title topic, at most 100 characters, without a newline or the title separator ｜.",
      ],
      [
        "--language en|zh",
        "Title language. Default en. It is part of the naming group, not a separate choice.",
      ],
      [
        "--request-id KEY",
        "Stable id for this prompt. Default initial. The same id and the same text return the existing run.",
      ],
      [
        "--workspace PATH",
        "Project bound to this new task. Omit it to use the workspace saved by init.",
      ],
      fields,
    ],
    [
      "The saved prompt is prefixed with a run marker. Copy currentRun from the output and pass it to conversation start.",
    ],
  ),
  page(
    ["conversation", "followup"],
    [
      "conversation followup --id ID (--prompt TEXT | --prompt-stdin true) --request-id KEY [--workspace PATH]",
    ],
    "Append one run to an existing task after the previous run is complete. Exit 0 means the new run was saved. It does not send it.",
    [
      taskId,
      [
        "--prompt TEXT",
        "Whole new prompt. Use this or --prompt-stdin, not both.",
      ],
      ["--prompt-stdin true", "Read the new prompt from a pipe."],
      [
        "--request-id KEY",
        "Required id for this new prompt. Reusing an id with the same text returns its original run instead of starting the current one.",
      ],
      [
        "--workspace PATH",
        "Checked against the task binding. A different path is refused and nothing is saved.",
      ],
      fields,
    ],
    [
      "Naming flags are rejected. Change the title with conversation organize. The previous run must already be complete.",
    ],
  ),
  page(
    ["conversation", "start"],
    ["conversation start --id ID --run UUID [--workspace PATH]"],
    "Send one saved run in Chrome. Running it again does not send that run again.",
    [
      taskId,
      runOpt(true),
      [
        "--workspace PATH",
        "Checked against the task binding before anything is sent.",
      ],
      fields,
    ],
    [
      "The prompt has to be created first. Exit 0 means the send was confirmed, or the run was already waiting or complete without an observation error. Exit 2 means the run needs attention. Exit 1 is a parameter or infrastructure failure.",
    ],
  ),
  page(
    ["conversation", "migrate"],
    ["conversation migrate --id ID"],
    "Copy one legacy task JSON file into tasks.db. The old file is kept. Chrome and the project directory are not required.",
    [taskId, fields],
    [
      "Stop old writers and waiters for this task first. A live lock is not taken over. Repeating the command does not replace the imported task. If the legacy file changed after import, the command stops with LEGACY_TASK_CHANGED.",
    ],
  ),
  page(
    ["conversation", "status"],
    ["conversation status --id ID [--run UUID] [--workspace PATH]"],
    "Print the saved task and its summary. This reads local state and does not claim the browser page still matches it.",
    [
      taskId,
      runOpt(false),
      [
        "--workspace PATH",
        "Compare this path with the task binding. A mismatch is returned as workspaceMismatch and the command exits 2. Nothing is changed.",
      ],
      fields,
    ],
    [
      "Exit 0 means the local record was read. It does not mean the reply is complete.",
    ],
  ),
  page(
    ["conversation", "resume"],
    ["conversation resume --id ID [--run UUID]"],
    "Observe the saved run again. It does not click Send.",
    [taskId, runOpt(false), fields],
    [
      "Exit 0 only when the reply is complete and any requested naming is verified. Exit 2 when the run is unfinished, naming is unfinished, or the page needs attention. A temporary page error may be retried up to three times; a login, identity, or draft problem is not retried.",
    ],
  ),
  page(
    ["conversation", "wait"],
    ["conversation wait --id ID [--run UUID] [--timeout-seconds SECONDS]"],
    "Watch one saved run until it finishes, the page needs attention, or the local timeout ends.",
    [
      taskId,
      runOpt(false),
      [
        "--timeout-seconds SECONDS",
        "Local time limit. Default 1800. The value must be finite, greater than 0, and at most 86400. The timeout stops this process only; generation in the browser continues.",
      ],
      fields,
    ],
    [
      "The same fields are printed on each report. Exit 0 only when the reply is complete and any requested naming is verified. Exit 2 when the run is unfinished or needs attention. SIGINT and SIGTERM stop the local wait and do not send the prompt again.",
    ],
  ),
  page(
    ["conversation", "result"],
    ["conversation result --id ID [--run UUID]"],
    "Print the saved reply for a completed run and write the local archive projection.",
    [taskId, runOpt(false), fields],
    [
      "The command fails with RESULT_NOT_COMPLETE until the run is complete and its reply hash matches. reply.markdown is the copied Markdown. The rendered page text is not a substitute. archive in the output reports whether that projection was stored; a failed archive does not make the run incomplete.",
    ],
  ),
  page(
    ["conversation", "retry"],
    ["conversation retry --id ID --run UUID [--workspace PATH]"],
    "Continue one prepared run that has not been sent. It does not retry a send whose delivery is unknown, and it does not replace a draft that changed.",
    [
      taskId,
      runOpt(true),
      [
        "--workspace PATH",
        "Checked against the task binding before the prepared run continues.",
      ],
      fields,
    ],
    [
      "A lost first page can be created again only while the run is still prepared, nothing was sent, and the recorded new tab is gone. That recreation is limited to two attempts. Exit codes match conversation start.",
    ],
  ),
  page(
    ["conversation", "recover-send"],
    [
      "conversation recover-send --id ID --run UUID --expected-user-message ID --expected-url URL --prompt-file FILE --evidence-file FILE --rejected-at UNIX_MS --confirm-cloudflare-challenge true --reason TEXT [--workspace PATH]",
    ],
    "Send the same saved prompt once more after the operator has confirmed that Cloudflare rejected the original POST.",
    [
      taskId,
      runOpt(true),
      [
        "--expected-user-message ID",
        "User message id recorded for the rejected attempt.",
      ],
      ["--expected-url URL", "Saved conversation URL."],
      [
        "--prompt-file FILE",
        "Original input without the run marker. Its hash must match the saved input.",
      ],
      [
        "--evidence-file FILE",
        "JSON array of method, url, status, and timestamp only. It must contain one POST to the conversation endpoint with status 403.",
      ],
      [
        "--rejected-at UNIX_MS",
        "Millisecond timestamp of that rejection. It must fall in the allowed window and cannot be reused.",
      ],
      [
        "--confirm-cloudflare-challenge true",
        "Required operator confirmation that the 403 was a Cloudflare challenge. The tool does not infer that.",
      ],
      ["--reason TEXT", "Why this one resend is authorized."],
      [
        "--workspace PATH",
        "Checked against the task binding before the resend.",
      ],
      fields,
    ],
    [
      "Only a blocked later run with a recorded user id and no completed reply is eligible. The page is not reopened or rebound. Exit codes match conversation start. A later confirmed DOM message still has to be checked with resume or result.",
    ],
  ),
  page(
    ["conversation", "clear-draft"],
    ["conversation clear-draft --id ID --run UUID --expected-draft-file FILE"],
    "Delete the draft in this task's own new page after the operator has saved the exact draft text. It does not send and does not call retry.",
    [
      taskId,
      runOpt(true),
      [
        "--expected-draft-file FILE",
        "Exact current draft. The command stores a backup, checks the page, deletes the draft, and reads it back.",
      ],
      fields,
    ],
    [
      "Only the first unsent run, on the task's own new page, with no history, can be cleared. A changed draft, attachment, borrowed page, or unknown delivery is refused.",
    ],
  ),
  page(
    ["conversation", "rebind-workspace"],
    [
      "conversation rebind-workspace --id ID --run UUID --from-workspace PATH --workspace PATH",
    ],
    "Change the project bound to a task that has not been sent. The prompt, run id, and global config stay as they are.",
    [
      taskId,
      runOpt(true),
      ["--from-workspace PATH", "Project currently saved on the task."],
      ["--workspace PATH", "Project to save instead."],
      fields,
    ],
    [
      "The only eligible run is a prepared first run with no confirmed user message and no conversation URL. A sent or delivery-unknown run is refused.",
    ],
  ),
  page(
    ["conversation", "finish"],
    ["conversation finish --id ID --run UUID"],
    "Close this task's own verified tab after the completed reply has been read. The conversation URL and saved result stay.",
    [taskId, runOpt(true), fields],
    [
      "The page must be idle: composer present, draft empty, no attachments, and not generating. A borrowed tab is not closed. A page whose turn no longer matches the saved reply is left open.",
    ],
  ),
  page(
    ["conversation", "attach"],
    ["conversation attach --id ID --url URL --user-message ID"],
    "Bind this task to an existing conversation URL and user message. It does not send a prompt.",
    [
      taskId,
      ["--url URL", "Existing ChatGPT conversation URL."],
      [
        "--user-message ID",
        "Exact user message id already present in that conversation.",
      ],
      fields,
    ],
    [
      "Use this only when the URL and message id are already known. The visible page is not proof of either value.",
    ],
  ),
  page(
    ["conversation", "organize"],
    [
      "conversation organize --id ID --run UUID --type TYPE --topic TOPIC [--language en|zh]",
    ],
    "Set this conversation's title and check that the saved title matches. It does not send the prompt again.",
    [
      taskId,
      runOpt(true),
      ["--type TYPE", "FEA, DES, FIX, OPT, REL, EXP, DOC, or RES."],
      [
        "--topic TOPIC",
        "Short single-line topic, at most 100 characters, without a newline or ｜.",
      ],
      ["--language en|zh", "Title language. Default en."],
      fields,
    ],
    [
      "The date in the title comes from the conversation's createdAt in Asia/Shanghai. Exit 0 only when the title check returns verified. Otherwise the command exits 2 and the message remains sent.",
    ],
  ),
  page(
    ["conversation", "archive"],
    ["conversation archive --id ID", "conversation archive --all true"],
    "Project saved task documents into the private conversations database. Pass exactly one of --id and --all true.",
    [
      ["--id ID", "Archive one task."],
      ["--all true", "Archive every readable task in this state directory."],
      fields,
    ],
    [
      "Exit 1 when the archive write failed. Exit 2 when a task was partial or a source document could not be read. Exit 0 otherwise. Repeating the command does not duplicate unchanged content, and it still reports gaps that remain.",
    ],
  ),
  page(
    ["conversation", "capture"],
    ["conversation capture --id ID [--run UUID] [--workspace PATH]"],
    "Copy the completed reply's Markdown with the page's own Copy control, then store that copy in the archive.",
    [
      taskId,
      runOpt(false),
      [
        "--workspace PATH",
        "Checked against the task binding before the page is read.",
      ],
      fields,
    ],
    [
      "The same conversation, submitted message, and final reply must still be on the page, and the rendered hash must match. Exit 1 when the archive write failed. Exit 2 when a gap remains or the copy was not stored. The run state is not changed.",
    ],
  ),
  page(
    ["conversation", "history"],
    [
      "conversation history --id ID [--run UUID] [--coverage false] [--from PATH]",
    ],
    "Read the selected prompt and reply for one task from the archive. No browser and no project directory are required.",
    [
      taskId,
      runOpt(false),
      [
        "--coverage false",
        "Omit the comparison between the task document and the archive. Any other use of the flag is not accepted as false.",
      ],
      [
        "--from PATH",
        "Read an exported archive directory, or a renamed snapshot file, instead of this state directory.",
      ],
      fields,
    ],
    [
      "reply is empty until Markdown has been captured. The rendered page text is returned separately as reply_rendered and is not the archived reply. --from does not read preferences or open Chrome.",
    ],
  ),
  page(
    ["conversation", "search"],
    [
      "conversation search --query TEXT [--task ID] [--role user|assistant] [--limit N] [--from PATH]",
    ],
    "Search the prompt and current best reply selected by each run. Superseded versions are not in the hits.",
    [
      [
        "--query TEXT",
        "Literal text. Three or more characters use the trigram index. Fewer characters use a literal scan.",
      ],
      [
        "--task ID",
        "Limit hits to one task and include that task's coverage when the task document can be read.",
      ],
      ["--role user|assistant", "Limit hits to prompts or replies."],
      ["--limit N", "Maximum hits. Default 20. The allowed range is 1 to 100."],
      [
        "--from PATH",
        "Search an exported snapshot instead of this state directory.",
      ],
      fields,
    ],
    [
      "Each hit says whether its text is captured Markdown or the rendered copy. The rendered copy is not an archived reply.",
    ],
  ),
  page(
    ["conversation", "content"],
    ["conversation content --version UUID [--from PATH]"],
    "Read one archived content version, including a version the run no longer selects.",
    [
      [
        "--version UUID",
        "Content version id from history or an earlier result.",
      ],
      [
        "--from PATH",
        "Read an exported snapshot instead of this state directory.",
      ],
      fields,
    ],
  ),
  page(
    ["conversation", "export"],
    ["conversation export --directory PATH"],
    "Write a consistent copy of the archive to a new directory. The copy contains every archived prompt and reply.",
    [
      [
        "--directory PATH",
        "Destination directory. It must not already be the state directory or a shared MCP root, and it must not already contain the snapshot.",
      ],
      fields,
    ],
    [
      "The file is created privately and its SHA-256 is returned. Treat the export as private data. It is not a backup of task state or send authorization.",
    ],
  ),
];

const mcp = [
  page(
    ["mcp", "serve"],
    ["mcp serve [--roots JSON_ARRAY]"],
    "Serve the read-only code tools on stdio for the tunnel client or another MCP client. stdout is reserved for the MCP protocol.",
    [
      [
        "--roots JSON_ARRAY",
        "Allowed directories. When omitted, mcp.roots from preferences is required. The value is a JSON array of 1 to 16 paths.",
      ],
    ],
    [
      "The process answers tool calls until the client closes it. It does not open Chrome.",
    ],
  ),
];

const tunnel = [
  page(
    ["tunnel", "instructions"],
    ["tunnel instructions [--tunnel-id ID]"],
    "Print the tunnel-client commands for the configured project and allowed roots. Nothing is connected.",
    [
      [
        "--tunnel-id ID",
        "Overrides tunnel.id for this print. One of the two is required.",
      ],
    ],
  ),
  page(
    ["tunnel", "doctor"],
    ["tunnel doctor [--tunnel-id ID]"],
    "Run the official tunnel client's local doctor check with the saved key and allowed roots.",
    [
      [
        "--tunnel-id ID",
        "Overrides tunnel.id. One of the two is required. A local doctor success does not prove a browser tool call works.",
      ],
    ],
  ),
  page(
    ["tunnel", "run"],
    ["tunnel run [--tunnel-id ID]"],
    "Run the official tunnel client in the foreground for this state directory.",
    [["--tunnel-id ID", "Overrides tunnel.id. One of the two is required."]],
    [
      "Use start, status, logs, and stop to run the same client in the background.",
    ],
  ),
  page(
    ["tunnel", "recover-lock"],
    ["tunnel recover-lock [--tunnel-id ID]"],
    "Recover the tunnel client's own single-instance lock when its recorded process is gone.",
    [
      [
        "--tunnel-id ID",
        "Tunnel whose lock is recovered. Overrides tunnel.id. This is not the top-level recover-lock command.",
      ],
    ],
    ["A live owner is not replaced."],
  ),
];

const pages: Page[] = [
  page(
    ["setup"],
    [
      "setup --workspace PATH --cdp PORT_OR_HTTP [--agent codex|claude-code|codex,claude-code]",
    ],
    "Save the workspace and Chrome endpoint, optionally install the bundled skill, then run doctor. convorel setup does not install dependencies.",
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
      "Model and project preferences are changed with config set, not with setup flags.",
    ],
  ),
  page(
    ["init"],
    ["init --workspace PATH --cdp PORT_OR_HTTP"],
    "Save the workspace and Chrome endpoint in this state directory. An existing binding to a different workspace or endpoint is refused.",
    [
      ["--workspace PATH", "Absolute project directory."],
      [
        "--cdp PORT_OR_HTTP",
        "Loopback Chrome debugging port or http://127.0.0.1:PORT endpoint.",
      ],
    ],
    [
      "The state directory must be outside the workspace. Use another --state-dir for a second binding. Set model, project, and other preferences with config set.",
    ],
  ),
  page(
    ["skills"],
    ["skills <command>"],
    "Install and update the bundled chatgpt-review skill.",
    [],
    [],
    skills,
  ),
  service(
    "start",
    "Start the tunnel client in the background for one tunnel id. This is not conversation start, which sends a saved run.",
    [],
    [
      "The saved workspace is passed to the service. A second start of the same running client does not create another process.",
    ],
  ),
  service(
    "stop",
    "Stop the background tunnel client for one tunnel id. The conversation and preferences are kept.",
    [],
    [
      "Stop still runs when the saved workspace is no longer available. It stops only the client recorded for this tunnel.",
    ],
  ),
  service(
    "restart",
    "Stop the background tunnel client and start it again for the same tunnel id.",
  ),
  service(
    "status",
    "Show whether the background tunnel client for this tunnel id is running. This is not conversation status.",
  ),
  service("logs", "Show the background tunnel client's output.", [
    ["--lines NUMBER", "How many recent lines to print. Default 100."],
    [
      "--follow",
      "Keep printing new lines. The flag takes no value. SIGINT or SIGTERM stops the follow.",
    ],
  ]),
  page(
    ["diagnostics"],
    ["diagnostics --task ID [--run UUID] [--fields LIST]"],
    "Read one task's diagnostic events from the private diagnostics database. Chrome is not opened.",
    [
      ["--task ID", "Task whose events are read."],
      ["--run UUID", "Limit events to one run. The id must be a UUID."],
      fields,
    ],
    [
      "status is missing when the database is absent, empty when the task has no rows, and ok when rows were read. complete is always false: the rows are not a full history and do not authorize a retry or another send.",
      "diagnostics.enabled unset or true records events. false disables recording. Any other stored value, or a failed preference read, also disables it. An unreadable database exits 1 instead of looking like an empty task.",
    ],
  ),
  page(
    ["upgrade"],
    ["upgrade [--version TAG]"],
    "Upgrade an installed convorel runtime. A source checkout is told to update the checkout; nothing is downloaded for it.",
    [
      [
        "--version TAG",
        "Release tag to install, such as vX.Y.Z. Omit it to use the current latest release.",
      ],
    ],
    [
      "An installed upgrade checks the checksum and the executable version, switches the install link, and keeps the previous version, sessions, preferences, and skills. It does not restart a running background client and does not update skills by itself. Run skills check afterward.",
    ],
  ),
  page(
    ["config"],
    ["config <command>"],
    "Read and write the preferences file. Preferences are not taken from the environment.",
    [],
    [configRules],
    config,
  ),
  page(
    ["doctor"],
    ["doctor", "doctor --local true"],
    "Check the local tools this state directory depends on. Without --local, the command connects to Chrome and checks the local MCP server. It does not prove that ChatGPT can call those tools.",
    [
      [
        "--local true",
        "Check only the task documents and the archive. The value must be true. Any other value is an error and does not fall through to the browser check.",
      ],
    ],
    [
      "The browser doctor exits 1 when Chrome or the local MCP check failed. doctor --local exits 1 when the archive fails its own integrity check, and 2 when the local record is readable but incomplete.",
    ],
  ),
  page(
    ["version"],
    ["version [--check]", "--version"],
    "Print this build. version prints JSON. --version prints only the version number.",
    [
      [
        "--check",
        "Also ask the release server whether this build is current. It takes no value and is only valid after version.",
      ],
    ],
    [
      "The JSON includes the version, commit, runtime, architecture, and browser-controller path. --check adds the latest release and whether this build matches it.",
    ],
  ),
  page(
    ["conversation"],
    ["conversation <command>"],
    "Save prompts, send one exact run, watch it, and read the private archive. create and followup only save; start sends.",
    [],
    [
      "A run marker is stored with each prompt. Repeating start or retry never resends a run that already left prepared. Legacy JSON tasks remain readable until migrate, and old writers must be stopped before migration.",
    ],
    conversation,
  ),
  page(
    ["mcp"],
    ["mcp <command>"],
    "Serve the local read-only code tools.",
    [],
    [],
    mcp,
  ),
  page(
    ["tunnel"],
    ["tunnel <command>"],
    "Print, check, run, or unlock the official tunnel client. These commands use --tunnel-id or the configured tunnel.id.",
    [],
    [],
    tunnel,
  ),
  page(
    ["recover-lock"],
    [
      "recover-lock --task ID | --watch-task ID | --registry true | --tabs true | --name NAME",
    ],
    "Remove one lock whose recorded process is gone. A live owner's lock is kept.",
    [
      ["--task ID", "Recover that task's operation lock."],
      ["--watch-task ID", "Recover that task's wait lock."],
      [
        "--registry true",
        "Recover the registry lock. The only accepted value is true.",
      ],
      [
        "--tabs true",
        "Recover the tab-accounting lock. The only accepted value is true.",
      ],
      ["--name NAME", "Recover one named lock."],
    ],
    [
      "Pass exactly one selector. A second selector is an error, not a priority rule. This command does not recover the tunnel client's lock; use tunnel recover-lock for that.",
    ],
  ),
];

function leafPages(page: Page): Page[] {
  return page.commands ? page.commands.flatMap(leafPages) : [page];
}

function render(item: Page): string {
  const lines = [...item.usage, "", item.summary];
  if (item.commands?.length) {
    lines.push("", "Commands:");
    for (const child of item.commands) {
      lines.push(`  ${child.usage[0]}`, `      ${child.summary}`);
    }
    const parent = item.command.join(" ");
    lines.push("", `Use convorel ${parent} <command> --help for one command.`);
  }
  if (item.options?.length) {
    lines.push("", "Options:");
    for (const [flag, text] of item.options)
      lines.push(`  ${flag}`, `      ${text}`);
  }
  if (item.notes?.length) lines.push("", ...item.notes);
  lines.push("", footer);
  return lines.join("\n");
}

function root(): string {
  const usage = pages.flatMap((item) =>
    leafPages(item).flatMap((leaf) => leaf.usage),
  );
  return [
    `convorel ${packageInfo.version} (Linux, ${COMPILED ? "standalone" : "source"})`,
    ...usage,
    "",
    "help, -h, and --help show this index and do not run a command.",
    "convorel <command> --help explains that command.",
    "convorel <group> <command> --help explains that subcommand.",
    "A bare conversation, skills, config, mcp, or tunnel lists that group's commands.",
    "",
    "Global options before the command: --config-dir PATH --state-dir PATH.",
    "Defaults: ~/.local/share/convorel and ~/.config/convorel.",
    "Invoke as: bun --no-env-file src/cli.ts ... or the installed executable.",
    "No command installs system tools or creates OpenAI resources.",
    "bun --no-env-file setup.ts installs locked dependencies, then runs setup. convorel setup does not.",
    "",
    "Configuration keys: model, project.url, project.name, tunnel.id, tunnel.apiKey,",
    "mcp.roots, browser.executable, browser.serial, browser.actionIntervalMs,",
    "browser.navigationWaitMs, locks.taskWaitMs, release.baseUrl, diagnostics.enabled.",
    "Run convorel config --help for the value rules.",
  ].join("\n");
}

const helpGroups = new Set([
  "conversation",
  "skills",
  "config",
  "mcp",
  "tunnel",
]);

function isHelpRequest(args: string[]) {
  if (!args.length) return true;
  if (["help", "--help", "-h"].includes(args[0])) return true;
  if (args.includes("--help") || args.includes("-h")) return true;
  return args.length === 1 && helpGroups.has(args[0]);
}

function commandWords(args: string[]) {
  const source = args[0] === "help" ? args.slice(1) : args;
  const words: string[] = [];
  for (const token of source) {
    if (token === "--help" || token === "-h" || token.startsWith("-")) break;
    words.push(token);
  }
  return words;
}

function lookup(words: string[]) {
  const top = pages.find((item) => item.command[0] === words[0]);
  if (!top) return null;
  if (words.length === 1) return top;
  const child = top.commands?.find((item) => item.command[1] === words[1]);
  if (!child) return null;
  return child;
}

/** Help text for a help request, or null when the arguments run a command. */
export function renderHelp(args: string[]) {
  if (!isHelpRequest(args)) return null;
  const words = commandWords(args);
  if (!words.length) return root();
  const found = lookup(words);
  if (!found)
    throw new Error(
      `Unknown help topic: ${words.join(" ")}. Run convorel --help.`,
    );
  return render(found);
}

export function helpTopics() {
  return pages.flatMap(leafPages).map((item) => ({
    args: [...item.command, "--help"],
    usage: item.usage[0],
  }));
}
