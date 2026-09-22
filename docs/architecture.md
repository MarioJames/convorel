# Architecture and v0.1 decisions

Status: the content archive below was reviewed with ChatGPT as a post-development result check, using read-only MCP evidence from the working tree; its confirmed findings are fixed and the remainder is recorded as open verification in validation.md. The reviewer did not run local tests or open the browser. Implementation evidence and live-browser limits are tracked in validation.md.

## Product boundary

A local coding agent retains ownership of edits and tests. It talks to ChatGPT through the user's existing logged-in browser. ChatGPT can independently inspect the explicitly shared working directory through read-only MCP tools. This package provides the CLI, browser adapter, state, and MCP server. It does not include a model subscription, browser login, tunnel credentials, or hosted infrastructure.

Convorel owns the persistent conversation lifecycle and read-only code access. It is the source of truth for task-to-conversation bindings, runs, delivery/completion state, saved replies and owned browser resources, and it keeps an additional content archive so archived prompts and replies stay searchable after the page is gone. The `conversation` API creates or reuses a conversation, continues it across turns and process restarts, reconciles interrupted operations, persists messages/results and releases owned tabs. It prepends only a run correlation marker; it does not inject a persona, evidence rules, project paths or source contents. The bundled, independently installable `chatgpt-review` skill owns review triggers, context selection, reviewer instructions, findings and decision gates, including a bounded post-development comparison of the actual outcome against goals and architecture constraints. Result review does not default to a detailed code audit or full-log transfer. Bundling it does not inject review policy into the transport. The skill resolves a separately installed CLI through `PATH` as `convorel`, never relative to its own installation directory.

The default model policy selects Latest with Power at its Pro endpoint, without pinning a version; callers can explicitly override it. Model and paired project settings come only from the preferences file, defaulting to `~/.config/convorel/preferences.json`; no environment override is supported. `convorel [--config-dir PATH] [--state-dir PATH] COMMAND` selects configuration and state directories with global options before the command. State defaults to `~/.local/share/convorel`. New tasks snapshot their configuration; continuation keeps the existing snapshot. Browser-side model verification remains a transport precondition. Request IDs, run IDs, message/branch matching, private state and tab ownership remain service-level safeguards regardless of message purpose.

```mermaid
flowchart LR
  A[Local coding agent / CLI] --> B[agent-browser]
  B -->|loopback CDP| C[User Chrome / ChatGPT]
  C -->|MCP tool call| T[OpenAI Secure MCP Tunnel]
  T -->|outbound client connection| M[Local stdio MCP server]
  M --> W[Configured allowed roots]
  A --> S[Private persistent task state]
  S --> AR[SQLite content archive]
```

The two channels are independent. A browser-only conversation works without the tunnel. Code access requires a running tunnel-client and a configured ChatGPT developer app. Opening CDP alone does not configure MCP.

## Reuse

- Browser model checks and observed page extraction derive from `MarioJames/skill-foundry/skills/chatgpt-review` (Apache-2.0).
- `agent-browser` remains the browser controller. `init` finds the command on `PATH`, checks that it runs, and saves its absolute path in `browser.executable`. CDP is its transport, not a second competing controller. The release does not include the controller.
- The SDK v1 maintenance line is retained to match the inspected existing MCP design. It provides standard stdio framing, discovery and tool validation; we do not implement MCP JSON-RPC manually.
- Sensitive-file patterns draw from `XiaoDuoYa/codex-with-chatgpt` (MIT). Its desktop browser, Cloudflare and OAuth deployment are not copied.
- No mandatory Herdr or memory database. Stdout JSON and process exit status are the integration contract. Optional Herdr guidance is loaded from the skill reference only when needed and reuses the installed Herdr skill/CLI; an unresolved caller falls back to host processes or bounded waits. Notifications never replace an exact run-bound result.

## Skills and service responsibilities

| Responsibility                                                                                                    | Owner                                                           |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Decide which task to initiate, its question/context, desired model/project and whether another question is needed | Skill / calling Agent                                           |
| Create/bind the remote conversation and persist its durable URL and configuration                                 | Convorel                                                        |
| Continue the same conversation after tab closure or process restart                                               | Convorel                                                        |
| Track request/run/message identity, delivery uncertainty, generation and completed replies                        | Convorel                                                        |
| Wait/reconcile, expose current status/results and preserve history                                                | Convorel                                                        |
| Archive prompts, captured reply Markdown, immutable versions and search indexes                                   | Convorel                                                        |
| Create in the requested project, rename after first delivery and safely release owned tabs                        | Convorel                                                        |
| Interpret the answer, accept/reject findings and decide business completion                                       | Skill / calling Agent                                           |
| Keep the CLI wait process alive or deliver its notification                                                       | Calling runtime / Herdr; conversation state remains in Convorel |

A skill requests lifecycle operations; it does not implement a second conversation registry, browser ownership tracker or recovery state machine. Closing a task's tab is resource release, not deletion of the remote conversation or local history. `followup` restores the saved URL and verifies the preceding completed turn before creating its successor. `resume` reconciles a pending run; for an already completed run it returns the saved result without reopening a tab unless initial naming is still pending.

Lifecycle ownership does not promise that ChatGPT keeps a remote conversation forever or remains reachable. Login failures, remote deletion, changed branches and uncertain UI actions must produce explicit failure/pending states rather than silently creating a replacement conversation. This release uses explicit CLI calls and a foreground `wait` process; it does not claim a resident daemon, durable job scheduling or automatic business retries.

创建时指定 `--type`/`--topic`（可选 `--language`），主题不明则保留原标题。配置项目时只从该项目专属输入框创建，并在填写和发送前核验项目 URL 与入口；没有先在外部创建再移动的路径。首条消息与持久化 URL 确认后立即命名；URL 延迟由后续观察补做。生成中命名使用任务记录中的临时只读观察页获取远端元数据并核验保存，原发送页继续生成，观察页核验身份后关闭。命名失败单独保存，不改变投递状态、不自动重发，显式 `organize` 可在生成期间恢复命名。

自动命名使用 `MMDD｜TYPE｜Topic`，从远端 `createdAt` 转 `Asia/Shanghai` 得到日期，默认英文 TYPE，明确要求中文时使用 `organize --language zh`。无项目配置仍命名且不移动会话；有目标项目时核验既有归属，不移动会话。标题、项目整理和自有标签页释放分别记录结果，不能用 cleanup 成功掩盖组织失败。

## Durable identities

- Workspace: canonical local root plus opaque hash; this is a routing identity, not authentication.
- Task: user-supplied stable ID mapped to a workspace and conversation. Only an unsent initial prepared run permits explicit compare-and-rebind of workspace metadata; its prompt and run stay unchanged.
- Conversation: validated ChatGPT conversation URL and ID; survives closed tabs.
- Browser binding: endpoint, browser epoch, target ID, ownership. It expires across browser restarts.
- Run: UUID, prompt marker/hash, observed user message ID, observed model, reply and terminal outcome.
- Content version: immutable archived bytes (saved prompt source or copied reply Markdown) keyed by task, run, role, message key, format and hash. A run selects versions through pointers; superseded versions stay readable.

A single atomic task document in private `tasks.db` stores each task’s runs, prompts, configuration and binding. `task-store.ts` manages the versioned SQLite schema with WAL and `synchronous=FULL`; config and process locks remain private files. Browser side effects for one task serialize on that task's own tab lock (`task-<id>`); because a tab binding is one task to one target, this equals per-tab serialization and lets different tasks create, send and observe concurrently instead of queueing behind one global lock. Two short locks preserve the cross-task invariants the old global lock guaranteed: a `registry` lock covers only the atomic conflict-check-plus-write of a conversation URL, tab binding or request key (never a browser side effect), and a `tabs` lock covers the last-tab keepalive-plus-close critical section so concurrent releases cannot strand zero tabs. A contended lock is retried for a bounded window and then fails closed; `locks.taskWaitMs` configures that window for task operations. Setting `browser.serial` to `true` with `convorel config set browser.serial true` collapses all browser side effects back onto a single `operation` lock for environments whose Chrome/CDP cannot drive parallel sessions. No age-based stealing of a live owner's lock. Linux process start identity distinguishes PID reuse. Missing or corrupt lock metadata fails closed and requires inspection. Each task's owned tab (target, epoch, ownership, closed) is recorded in its binding and projected into `status`/`list`, alongside an advisory `locked` flag for contention awareness. Persistent state is not kept inside the shared code root.

## Conversation content archive

The atomic task documents in `tasks.db` remain operational truth: they decide delivery, completion, retry authorization and tab ownership. `conversations.db` in the same private state directory is a content archive projected from them, added because page text alone cannot answer what was asked and answered across past sessions. It holds saved prompt sources, reply Markdown captured through the page's own copy control, the rendered body kept beside it for traceability, immutable content versions, per-run version selections, capture gaps, and FTS5 trigram indexes over archived text.

Dependency direction is one way. `archive.ts` knows the `Task` shape and nothing about browsers or locks; the copy-control adapter knows only how to capture one rendered message; `post-archive.ts` is the single tolerant boundary that turns any archive outcome into a notice. `conversation.ts` writes the captured Markdown back into its task document and then calls that boundary, so there is one archive write path and a capture survives a failed import. No archive or capture result reaches run state, so `result()` semantics, `replyHash` verification and exactly-once send authorization are unchanged by this layer. `publish` is one `BEGIN IMMEDIATE` transaction, because a read-then-write projection under a deferred begin lets a concurrent importer commit a version this one was about to create.

Reply selection is deliberately narrow: `reply_version_id` points only at captured Markdown, never at the rendered copy. Where Markdown is still missing the run shows an empty reply, `capture_status: pending` and a gap, while the rendered body stays archived separately for traceability. Search covers each run's selected prompt plus its best available body and reports the `format` of every hit, so a rendered fallback is never mistaken for the source. Keeping the rendered copy is not a fidelity claim: it is what the page displayed, and the store says which of the two it is looking at.

Replayability and traceability are bounded deliberately: an archived run reconstructs what was asked, what version of the reply was selected, and which remote message it came from, but it does not reconstruct delivery certainty, browser binding, or the page at that moment. `content --version` reads back any archived version, including superseded ones, because a citation that cannot be re-read proves nothing. The archive is rebuildable from the documents through `archive --all true`; Markdown is additionally retained inside the documents, so losing either side keeps the content on the other. Durability outranks throughput here because archived content cannot be regenerated by the remote service, so the store uses WAL plus `synchronous=FULL` with no override, and `VACUUM INTO` (not file copy) for snapshots, since a copy misses committed bytes still held in the WAL. Snapshots are written inside a private staging directory created by the call, then hard-linked into place at 0600.

Reading the archive is separated from every browser and configuration prerequisite: `search`, `history` and `content` accept `--from PATH` for an exported store or a renamed snapshot file, and are dispatched before preferences and CDP are consulted, so deleted project directories or a stopped Chrome cannot block reading back what was recorded. Writes still assert that the state directory and the export target sit outside every existing shared root. An `observation` table was dropped before release: writing a row per import recorded import time as page-observation time and a saved branch as the mounted message list, which is a provenance claim the evidence does not support. Secondary derivation stays a stated direction, not a schema: no table is reserved for it, because an unwritten structure is design work the next change may not want.

## Sending and recovery

1. `create` and `followup` commit prepared runs without browser access. `start --id --run` reads the saved exact run; a completed, already-started or failed run is never automatically resent. Persist the initial task, attempt and first prepared run together; never publish an empty task before its run. Record intent and unique request marker before submitting a browser action.
2. A saved followup verifies its entire previous completed branch again before filling or sending; failed validation preserves the prepared run. Check task identity, exact browser target, no active response and no unsent draft; verify configured model.
3. Fill and submit only once; record the observed message ID when visible.
4. Failures before Send remain `prepared` with their error; an explicit run-bound `retry` can continue only that unsent run after rechecking page/model/draft/prior history. `resume` observes delivery and can apply pending initial naming; it never sends a message. If submission outcome is uncertain, retain that state. Reconcile by marker on the same conversation/owned draft. Never retry Send just because a command or wait timed out.
5. Match completion to the exact submitted user message, refuse a later user message and keep each run's reply.
6. On restart, use conversation identity to recover. An existing user tab is borrowed, never retroactively marked owned.

An owned new page can restore an unrelated draft. `clear-draft` requires explicit authorization represented by the complete expected-draft file and the exact prepared run. It rejects conversation history, borrowed pages, attachments and uncertain delivery, persists a backup before editing, compares the observed page and draft inside the same synchronous browser operation, then verifies an empty editor with a second read. It does not submit. Recovery uses a browser editing deletion rather than setting a contenteditable element's synthetic `value` property; focus-triggered edits abort before deletion. Failures retain the run and backup for inspection.

`create --workspace` chooses a new task's snapshot; existing tasks reject conflicting workspace assertions. `status --workspace` diagnoses mismatches without page access, and `rebind-workspace` changes only prepared task metadata using an expected old binding. None of these operations changes allowed MCP roots or rewrites a saved prompt.

Browser UI cannot provide a transactional exactly-once send guarantee. The guarantee is no automatic second submission after an uncertain outcome, with explicit recovery evidence.

Send readiness and clicking use the same structural selector scoped to the composer form (`data-testid="send-button"` and `type="submit"`); visible text is not the locator. The composer button ID alone is insufficient because it can represent another action. Missing, ambiguous, disabled or obstructed controls prevent sending.

Observation failures do not erase confirmed message identity or roll a submitted run back to `prepared`. Runs retain the last successful page-read time and a separate observation error. The CLI `summary` projects those saved facts into delivery, phase and next-action fields; it is not another persistent workflow. Waiting makes at most three consecutive attempts on read/connection failures, with bounded delays, and never repeats a send action. Page identity and other attention conditions are not retried as transient transport failures. Reading local status succeeds independently of conversation completion; `resume` and `wait` report completion only when the exact run is complete.

## Resource ownership

Select a target unpinned before enabling pinning, avoiding an implicit blank page. Never issue browser-wide close against the user's browser. Close only an owned, identity-matching, idle page after the current reply is saved and no draft exists. Tab release, reply completion and optional title/project organization are separate states. If the owned page is the last browser tab, record and create one inert keepalive before closing it; later operations preserve that tab. The last-tab check, keepalive creation and close run as one cross-process `tabs` critical section, so two concurrent releases cannot both observe a single tab, double-create a keepalive, or close to zero tabs.

agent-browser serves every session from its own background daemon, so different tasks drive different tabs through separate sessions in parallel; a conversation operation releases each session it used before it returns; the released session stops that daemon and leaves the user's browser and tabs untouched, and the next command re-binds the same target. An explicitly short idle timeout remains the backstop for a process killed before it released.

## Code access

One stdio process binds a fixed allowed-root list. The server does not infer a trusted conversation ID from a prompt or task ID; all clients authorized to this connector can read its allowed workspace. Separate sensitive workspaces require separate connectors/tunnels or an independently authenticated server design.

The evidence interface has twelve read-only tools: workspace_info, tree, find_files, read_file, search_workspace, read_image, git_status, git_diff, git_log, git_show, git_compare and git_read_file. Directory entries and rendering share tree; there is no separate directory-list tool. Each declares a strict object output schema matching its structured response. workspace_info exposes the service version, evidence capability revision and tool names as well as project identity, branch and Git availability. It does not infer task goals from source.

File discovery uses Bun's existing Glob matcher against the permission-filtered inventory. Literal content search accepts a directory scope and file pattern, returns context and hashes, and distinguishes pagination from scan/depth limits and unreadable files. Text reports reuse read_file; read_image returns bounded native MCP PNG/JPEG/WebP content through the same policy. Reports and screenshots remain caller-provided evidence: their bytes and observation times do not certify execution, originating revision or test success. No report registry or additional private-state access is introduced.

Git history resolves revisions to commit IDs before reading. Commit enumeration uses rev-list and cat-file rather than log presentation, so repository signature-display settings do not invoke a signature verifier. Commit details, endpoint/merge-base comparisons and historical blobs form a connected historical reading path; a clean worktree does not imply no recent commits. File pages and single-file patch fragments have separate continuations. Current and historical ignore policies constrain historical reads and both endpoints/names of differences. Fixed Git invocations disable replacement objects, external diff/textconv, fsmonitor, global config, lazy fetching and optional index updates; configured clean/process filters are refused. Errors are failures, never a clean status. No write_file, command execution, test runner or dependency-graph service is exposed.

Responses identify the observed scope and provide the applicable timestamp, file/patch hash or immutable revision, filtering/scan limits and continuation. Structured JSON is capped at 64 KiB; image bytes have a separate 1 MiB ceiling. Requests exceeding process budgets fail explicitly. The skill prepares goals, architecture constraints, baseline, actual outcome and verification summary; the transport continues to own only durable conversation facts.

All tools share path and ignore policy, including Git old/new rename paths. Files are bounded by size, response bytes and line ranges. Search is literal and bounded. Symlinks and non-regular files are refused. Root/workspace identity is checked when handling requests. Policies apply to filenames, not arbitrary secrets placed in ordinary source files; users must share only appropriate workspaces.

Reads observe the live filesystem. Per-file hashes and timestamps identify observed bytes. Git HEAD alone is not a snapshot of uncommitted work. Reviews must disclose changes during reading; immutable snapshots are outside v0.1.

## Distribution

A standalone Bun package with source, lockfile, CLI, the chatgpt-review skill and references, tests, CI, architecture, security and setup docs. The skills install command copies the complete bundled skill tree, supports Codex/Claude Code individually or together and user/project scope (default user), or an explicit `--dir` skill root, and rejects pre-existing same-name canonical or selected-Agent destinations before installation. It runs before State/config initialization and verifies the installed entry point. setup optionally installs after initialization and before doctor when --agent is supplied. Skills CLI can also install the skill independently; neither route requires a runtime adjacent to the skill. Linux is the initial validated platform. Chrome, agent-browser and tunnel-client remain user-controlled prerequisites. Publishing npm/GitHub releases is separate from local implementation.

## Sources

- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- https://github.com/vercel-labs/agent-browser
- https://github.com/modelcontextprotocol/typescript-sdk/tree/v1.x
- https://github.com/XiaoDuoYa/codex-with-chatgpt

## Review decisions incorporated

Keep a single package and atomic JSON state for v0.1. Reverse-check conversation/target claims across tasks; persist caller request keys and full prompts before submission. Bind operations to attempt/run identities, use a short global writer lock, and preserve uncertain delivery without resending. Cleanup rechecks exact user/assistant IDs, reply hash, branch, drafts and browser epoch. Apply one file policy to all MCP and Git routes, including deleted/renamed paths. Bind each live tunnel client to an explicit allowed-root list; retain one live native client per tunnel ID. All MCP requests select full paths within that fixed list. Disable Bun dotenv autoload on CLI/MCP entry points and test the packaged distribution outside the checkout.

`recover-send` is a separate, explicit exception for a blocked followup whose optimistic user message disappeared after an operator-verified Cloudflare challenge rejected the send POST. It requires the exact saved input, old user ID and URL, unique sanitized 403 evidence and timestamp, explicit challenge confirmation and reason, the original owned target in the same browser epoch, an empty idle composer, and the intact previous completed turn (exact user ID, unique run marker, reply ID/hash and full branch). Rendered user Markdown is not compared byte-for-byte with the saved source; the saved source hash is still checked. It never opens or rebinds a page. Before one send, it durably records the old user/attempt and rejection evidence, preserving task/run/prompt identity. Uncertain sends do not become prepared; ordinary retry/resume semantics remain unchanged. See the recovery contract in [usage.md](usage.md). Network responses are not currently observed by the Browser adapter, so DOM recognition remains weaker than server acceptance.

Top-level `start`, `stop`, `restart`, `status` and `logs` manage a detached `tunnel run` supervisor through the existing private tunnel registry. Lifecycle operations serialize separately from the running-client lock; process identities are checked before signalling. Log rotation retains one previous run. Local liveness is distinct from cloud connectivity. Standalone `upgrade` reuses the embedded installer for download, checksum/version validation and rollback on switch failure, using installation layout metadata and retaining old release directories. `version --check` reads the release checksum manifest without needing workspace configuration.

## Legacy task documents

Legacy JSON is readable but cannot authorize browser mutations until `conversation migrate --id ID` imports the task under watch/operation/task/registry locks. The transaction preserves its complete document and records the original bytes’ hash. The original file remains unchanged; repeated migration does not overwrite database state. Every database read/write checks retained legacy evidence, and fails closed if an old runtime changed it or it disappeared. Migration requires quiescing the old runtime for that task; the hash fence detects old writes but cannot control an old binary’s browser actions. New database tasks reject colliding legacy files. No live task is migrated automatically. Content archive projection reads the current source through State and keeps its independent failure boundary.

浏览器动作节奏复用 State 的跨进程锁与私有时间记录，默认动作间隔 750ms、导航稳定等待 1500ms；只读命令不锁定，写动作只派发一次。命名持久化 locating/editing/save_pending/verifying/complete 阶段与原始元数据基线，保存不确定后仅做只读核验。观察页清理先按浏览器 epoch 与精确 target 对账，避免关闭成功但回执丢失导致永久卡住。投递未知只恢复观察，不授予再次发送权限。
