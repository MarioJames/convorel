# Convorel 1.0 CLI and daemon contract

`convorel [--config-dir PATH] [--state-dir PATH] COMMAND [OPTIONS]`

Global directory options must precede COMMAND, take one nonempty path, and resolve
relative paths against the current directory. Defaults are `~/.config/convorel`
and `~/.local/share/convorel`; XDG and model environment overrides are not used.
The state directory retains `config.json`, `tasks.db`, `diagnostics.db`, and
`conversations.db` in place. Preferences remain `<config-dir>/preferences.json`.
No command aliases from 0.9 are accepted.

Each invocation writes one JSON document to stdout. `mcp serve` is the exception:
it speaks SDK MCP stdio framing. Help (`--help`, `help`, or COMMAND `--help`)
is a JSON document with `usage`, `commands`, and `version`. Commands are case
sensitive. Unknown flags, repeated flags, unexpected positional arguments, and
missing values are rejected. Value flags accept `--flag VALUE` or `--flag=VALUE`.
Boolean switches use `--flag`, `--flag=true`, or `--flag=false`.

## Exit status and errors

| Exit | Meaning |
| --- | --- |
| 0 | Requested outcome succeeded; ask/followup/retry confirm delivery, wait/result confirm a completed reply. Read-only status/history/list/search succeeded even when a reported run is pending. |
| 1 | Invalid input, explicit terminal failure, transport/configuration failure,. |
| 2 | Requested run outcome is pending, rejected, or uncertain, or a wait timed out. Naming is never a reason for exit 2. |

Errors print `{"code":"STABLE_CODE","error":{"code":"STABLE_CODE","message":"details"}}`.
Codes include `UNKNOWN_COMMAND`, `UNKNOWN_FLAG`, `INVALID_ARGUMENT`,
`UNKNOWN_SETTING`, `INVALID_VALUE`, `TIMEOUT`,
`DAEMON_ALREADY_RUNNING`, `DAEMON_UNAVAILABLE`, `RPC_FRAME_TOO_LARGE`, and
`INTERNAL_ERROR`. Run implementations additionally use `REQUEST_CONFLICT`,
`TASK_NOT_FOUND`, `PRIOR_RUN_NOT_COMPLETE`, `RETRY_NOT_ALLOWED`,
`RESULT_TOO_LARGE`, `RUN_IN_FLIGHT`, `COMPLETED_TURN_CHANGED`, `PAGE_NOT_IDLE`,
`UI_TARGET_AMBIGUOUS`, and `BROWSER_UNAVAILABLE`. Workspace/MCP errors include
`ACCESS_DENIED`, `INVALID_ARGUMENTS`, `FILE_NOT_FOUND` and operation-specific
`GIT_*`, `EXEC_*`, and `MEMORY_*` codes. These examples are not an exhaustive list;
clients must preserve unfamiliar codes and inspect the accompanying message.
Handlers report pending payloads with `daemon.Result{Value: payload, ExitCode: 2}`;
plain successful values exit 0. The CLI forwards the daemon outcome.

## Conversation commands

All flags in this table take values except `--prompt-stdin`. `--id` is a stable
task ID. `--run` is optional: omission selects the current run, and an explicit
run selects that exact historical run. `reply` is `{id,markdown,model?}`. Optional
identity fields are omitted until observed. Collections are JSON objects, not
unwrapped arrays. Success payload fields below form the public contract; fields
marked `?` may be absent.

| Command | Flags | JSON fields | Exit |
| --- | --- | --- | --- |
| `ask` | required `--id`; exactly one of `--prompt TEXT`, `--prompt-file PATH`, `--prompt-stdin`; optional `--request-id` (default `initial`), `--workspace`, paired `--type` and `--topic`, `--language en\|zh`, `--effort 1..5` | `id,run,phase,delivery,userMessageId?,conversationId?` | 0 confirmed delivery; 2 pending/rejected/unknown; 1 error |
| `followup` | required `--id`, `--request-id`, one prompt source as for ask; optional `--effort 1..5` | `id,run,phase,delivery,userMessageId?,conversationId?` | same as ask |
| `wait` | required `--id`; optional `--run`, `--timeout-seconds` (positive integer, default 60) | `id,run,phase,reply?` | 0 complete; 2 timeout/pending; 1 terminal error |
| `status` | required `--id`; optional `--run` | `id,run,phase,delivery,naming,binding?,draft?` | 0 read succeeded; 1 error |
| `result` | required `--id`; optional `--run` | `id,run,phase,reply?` | 0 complete; 2 pending; 1 terminal error |
| `history` | required `--id` | `id,runs` (run records with identity, phase, delivery facts, saved prompt, reply when available) | 0 or 1 |
| `retry` | required `--id`; optional `--run` | `id,run,phase,delivery,userMessageId?` | same as ask; 1 if retry forbidden |
| `finish` | required `--id`; optional `--run` | `id,run,phase,cleanup,naming` | 0 release succeeded; 1 release refused/failed |
| `list` | optional `--workspace`, `--limit` (positive integer), `--offset` (nonnegative integer) | `tasks,total` | 0 or 1 |
| `search` | required `--query`; optional `--id`, `--role user\|assistant`, `--limit`, `--offset` | `hits,total`; hits include `taskId,runId,role,format,text,versionId` | 0 or 1 |

Ask creates and sends in one operation. Followup uses the same saved conversation
and requires a completed preceding run. Original input, guidance snapshot,
rendered prompt, marker and hashes are saved before sending. Prompt sources are
UTF-8 text, nonempty and bounded at 100000 bytes; stdin is consumed only when
explicitly requested. First creation snapshots preferences (default effort 5,
Pro); a supplied effort overrides that new run's effort. Continuation retains the
task binding and its configuration snapshot. `--language` requires the naming
pair. `finish` releases owned browser resources without deleting history.

A request ID is claimed atomically with task/run creation and is scoped to its
task, including the default `initial`, so separate tasks may reuse labels such
as `decision-v1`; request lookup always takes both task ID and request ID.
Claims made by 1.0.2 and earlier under a global key still replay for the task
that owns them and no longer block other tasks. Repeating the same
task/request/input resolves to the original run, never a second send.
Different input under that task's key is `REQUEST_CONFLICT`. A replay
of an older run returns that original run, not a successor. This requires the
store's transactional claim; the RPC request `id` alone is a correlation field,
not the persistence mechanism. Retrying reuses the frozen prompt of the same run.

Run phases are `prepared`, `rejected`, `delivered`, `delivery_unknown`, `complete`,
`failed`, `blocked`, `superseded`, and legacy terminal `lost`.
`delivery` in command results is `not_sent`, `rejected`, `confirmed`, or `unknown`.
The persisted `DeliveryFacts` separately records `requestSent`, `postStatus`,
`requestUserMessageId` (an unconfirmed request candidate),
`userMessageId`, `conversationId`, `model`, `streamComplete`, and `streamAborted`.
Only `prepared` (no dispatched POST) and `rejected` (confirmed non-2xx rejection)
permit retry. After dispatch but before confirmed rejection/input-message receipt,
uncertainty must be persisted before further observation. During dispatch, a
`prepared` run with `submittedAt` may already contain request facts while awaiting
the HTTP outcome; this fenced intent cannot be retried and becomes unknown on
restart. HTTP 200 alone does
not prove delivery. Stream completion and Markdown capture establish completion.
`delivery_unknown` may be observed by wait, never automatically re-sent.

Wait returns the saved reply as soon as it completes and does not await naming.
Calling `wait` again on a completed run whose naming failed retries only the
background naming operation, without sending a message. `status.naming` separately reports `{state,title?,verified,error?}`, with states
`pending`, `running`, `verified`, `failed`, or `not_requested`. Naming failure
never changes run delivery or reply success. `status.draft` appears only when the run moved a composer draft aside: `{state,url,savedAt,restoredAt?,error?,text?}` with states `saved`, `restored`, `conflict` or `failed`; `text` is present until the draft is back in its composer. Draft handling never changes run delivery or reply success either. Killing a wait process only removes
that subscriber. The daemon continues observing; another wait reattaches.

## Other commands

| Command | Flags / arguments | JSON fields | Exit |
| --- | --- | --- | --- |
| `daemon` | none; foreground daemon, stop with SIGTERM/SIGINT | `stopped:true` on orderly shutdown; error on startup failure | 0 or 1 |
| `service install` | none | `installed,unit` | 0 or 1 |
| `service uninstall` | none | `installed,unit` | 0 or 1 |
| `service status` | none | `installed,active,unit` | 0 or 1 |
| `mcp serve` | optional `--roots JSON_ARRAY` (otherwise `mcp.roots`); stdout is MCP stdio only | MCP protocol; functions remain `capabilities`, `exec`, `artifact`, `memory` | 0 or 1 |
| `doctor` | boolean `--ui`, `--local` | `ok,checks,ui?,tools`; UI includes `composer,send,modelMenu,effortSlider,rename,effort` | 0 healthy; 1 failed check |
| `setup` | optional `--workspace`, `--cdp`, `--chrome`, `--user-data-dir`, boolean `--headless` | `configured,config,login,runtime` | 0 or 1 |
| `login` | none | `ready,profile,cdp` | 0 ready; 1 error |
| `config get KEY` | one positional known setting key | `key,source,configured,value` | 0 or 1 |
| `config set KEY VALUE` | two positional arguments; empty VALUE removes an override | `action,key,source,configured,value` | 0 or 1 |
| `config list` | none | `file,settings` | 0 or 1 |
| `skills install` | optional `--target PATH` | `installed,path` | 0 or 1 |
| `upgrade` | optional `--version VERSION` | `version,previousVersion` | 0 or 1 |
| `version` | none | `version` | 0 |
| `diagnostics` | optional `--id`, `--run`, `--limit`, `--since` | `events,total` | 0 or 1 |

Doctor UI checks never send a message or create a conversation. `--local` avoids
browser access; it cannot be combined with `--ui`. `doctor --local` reports `ok,checks,profile,profileSource,tools`; absent setup is reported as `checks.configured:false` and is locally healthy. UI checks require exactly one existing ChatGPT page. Setup chooses managed Chrome
unless an external CDP binding is supplied. Service operations target
`convorel.service`. The tunnel child and browser belong to the daemon; MCP stdio
is spawned separately by the tunnel-client using this same binary.

Preferences retain `{"version":1,"values":{"KEY":"STRING"}}`. Supported keys
are `tunnel.apiKey`, `tunnel.id`, `mcp.roots`, `mcp.memoryRoots`,
`mcp.execDependencyRoots`, `mcp.memoryExecutable`, `model`, `project.url`,
`project.name`, `browser.executable`, `browser.serial`, `browser.headless`,
`browser.userDataDir`, `browser.actionIntervalMs`, `browser.navigationWaitMs`,
`locks.taskWaitMs`, `release.baseUrl`, `diagnostics.enabled`, `effort`, and
`browser.idleStopMinutes`. Legacy synchronization/pacing keys remain accepted as stored settings for file compatibility; runtime serialization is in process. `effort` is 1..5 (1 Instant,
5 Pro; default 5), and `browser.idleStopMinutes` is a positive integer (default
10). Browser profile resolution is preference, then saved binding, then
`<state-dir>/chrome`. Changing a preference does not rewrite the saved fallback.
`tunnel.apiKey` is always masked as `set` in config output.

## Daemon protocol and extension API

The daemon listens on `<state-dir>/convorel.sock`; directory mode is 0700 and
socket mode is 0600. One connection carries one bounded newline-delimited JSON
request followed by one response, or progress responses and a final response
for streaming wait. The maximum frame size is 8 MiB; a larger frame is rejected
with `RPC_FRAME_TOO_LARGE` while it is read. The request is
`{id?,command,params?,deadline?,stream?}`; `deadline` is an RFC3339 timestamp.
`params` contains CLI flags as string values using their hyphenated names, with
prompt-file/stdin resolved to `prompt` by the client. Config positional arguments
become `key` and `value`. The response is
`{id?,result?,error?,exitCode,done}`. Only `done:true` is terminal. The CLI prints
only the final `result` (or error document), so streaming never adds stdout JSON
documents. Default RPC deadlines are 30 seconds, with wait's explicit deadline.
Handlers must honor request cancellation/deadlines for the subscription only;
run execution is owned by the daemon lifecycle and must use its own context.
Client disconnect never cancels daemon-owned work and never authorizes replay.

`daemon.New() *Server` registers `ping` and `version`. `(*Server).Register(name,
Handler)` registers `func(context.Context,rpc.Request)(any,error)`.
`RegisterStream(name, StreamHandler)` additionally takes `emit func(any)error`.
A handler can return `daemon.Result{Value: ..., ExitCode: ...}` to set an outcome.
`Listen(stateDir)`, `Serve(ctx)`, and `Close()` implement process lifecycle;
SIGTERM cancels the root context and closes connections and the socket.
`rpc.Client{Socket:path}.Call(ctx,req)` returns the final response;
`Stream(ctx,req,receive)` also exposes progress frames. Unknown RPC commands return `UNKNOWN_COMMAND`. CLI registration wires configuration, service, conversation, login and doctor handlers; `doctor --local` bypasses the daemon.

Single-instance election takes a non-blocking exclusive `flock` on the state
directory itself and holds it for the daemon lifetime; no lock file is created,
and the kernel releases the lock if the process dies. The winner unlinks any
`convorel.sock` left by a hard kill and binds a fresh 0600 socket, so a
SIGKILL/OOM no longer blocks the next supervised start. A second daemon fails
the lock with `DAEMON_ALREADY_RUNNING`. Clean shutdown removes the socket.
There are no lock files or recovery commands.

For development/tests, a CLI seeing an absent socket may spawn this executable
as a detached `convorel daemon`, forwarding both directory options. It refuses
this fallback if `convorel.service` exists in the standard user/system unit
locations and reports `DAEMON_UNAVAILABLE`. An installed service must be started
by its supervisor. An existing but unreachable socket never triggers auto-start,
and an RPC whose connection was established is never replayed automatically.

`cdp.Manager.IdlePolicy()` is the shared activity policy. Conversation observers reserve activity across sending, waiting and naming; the engine drives its periodic Tick. Login and doctor also reserve activity. Only managed Chrome is stopped.

## Verification boundary

See [validation.md](validation.md) for repository tests, A1–A13 mapping and unverified live-platform behavior. All browser acceptance uses disposable local fixtures; no live ChatGPT or real-user state is used.
