import { fields, page, runOpt, taskId } from "./shared.ts";

const conversation = [
  page(
    ["conversation", "list"],
    ["conversation list"],
    "List saved tasks from this state directory. The read is local and does not open Chrome.",
    [fields],
    [
      "Each item includes id, url, currentRun, the latest run state, whether the task lock is active, and summary. The original workspace and init configuration are not required.",
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
        "Task objective, constraints and acceptance criteria. Runtime workspace/tool guidance is added automatically. Use this or --prompt-stdin, not both; non-empty, at most 100000 bytes.",
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
      "Stores the original input, versioned workspace/tool guidance and complete rendered prompt with a run marker. start/retry send that snapshot without rebuilding it. This is a normal ChatGPT user message, not a system-role message. Copy currentRun and pass it to conversation start.",
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
        "This turn's task request. Current runtime guidance is included in the new run snapshot. Use this or --prompt-stdin, not both.",
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
      "The prompt has to be created first. Naming is deferred until the first wait return; start only sends and confirms. Exit 0 means the send was confirmed, or the run was already waiting or complete without an observation error. Exit 2 means the run needs attention. Exit 1 is a parameter or infrastructure failure.",
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
      "Exit 0 means the local record was read. It does not mean the reply is complete. Chrome, the original workspace and init configuration are not required; an explicit --workspace is still checked.",
    ],
  ),
  page(
    ["conversation", "resume"],
    ["conversation resume --id ID [--run UUID]"],
    "Observe the saved run again. It does not click Send.",
    [taskId, runOpt(false), fields],
    [
      "Exit 0 only when the reply is complete and any requested naming is verified. Exit 2 when the run is unfinished, naming is unfinished, or the page needs attention. This command observes only; use wait for a naming checkpoint, or organize for explicit naming.",
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
        "Local observation time limit. Default 1800. The value must be finite, greater than 0, and at most 86400. A final bounded naming check can extend the command beyond this limit; generation in the browser continues.",
      ],
      fields,
    ],
    [
      "The same fields are printed on each report. Exit 0 only when the reply is complete and any requested naming is verified. Exit 2 when the run is unfinished or needs attention. SIGINT and SIGTERM stop the local wait and do not send the prompt again.",
      "Initial naming is deferred until the first normal or timed-out wait return. Each wait return checks the current title and repairs it once if the saved write stage permits it. Cancellation skips this check. A confirmed send awaiting its conversation URL is observed every second.",
    ],
  ),
  page(
    ["conversation", "result"],
    ["conversation result --id ID [--run UUID]"],
    "Print the saved reply for a completed run and write the local archive projection.",
    [taskId, runOpt(false), fields],
    [
      "Chrome, the original workspace and init configuration are not required. The command fails with RESULT_NOT_COMPLETE until the run is complete and its reply hash matches. reply.markdown is the copied Markdown. The rendered page text is not a substitute. archive in the output reports whether that projection was stored; a failed archive does not make the run incomplete.",
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
    "Change the project bound to an unsent task. Updates generated workspace context and audits the old prompt; the original task request, run id and global config stay unchanged. Historical prompts without generated context are preserved.",
    [
      taskId,
      runOpt(true),
      ["--from-workspace PATH", "Project currently saved on the task."],
      ["--workspace PATH", "Project to save instead."],
      fields,
    ],
    [
      "The only eligible run is a prepared first run with no send timestamp, confirmed user message or conversation URL. Existing browser drafts are never rewritten; a stale draft will block start until separately reconciled.",
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

export const conversationPage = page(
  ["conversation"],
  ["conversation <command>"],
  "Save prompts, send one exact run, watch it, and read the private archive. create and followup only save; start sends.",
  [],
  [
    "A run marker is stored with each prompt. Repeating start or retry never resends a run that already left prepared. Legacy JSON tasks remain readable until migrate, and old writers must be stopped before migration.",
  ],
  conversation,
);
