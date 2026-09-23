# Quick start

Runnable v0.2 commands; consult validation.md for the verified environment and remaining limitations.

## Prerequisites

- Linux x64 or arm64 (glibc), Git, an installed Google Chrome, and `agent-browser` on `PATH`. Standalone installation and upgrade also require `flock` from util-linux. A source checkout additionally needs Bun >= 1.3 and Node >= 24.
- Your own ChatGPT account with access to the selected model. The default selects Latest and the Pro endpoint of Power without pinning a version. Override with `convorel config set model MODEL`; other visible models are verified after manual selection.
- For code tools: your own OpenAI tunnel, runtime key and ChatGPT developer app. Browser-only conversation does not need these.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/MarioJames/convorel/main/install.sh | bash
```

The installer downloads the release archive for the current architecture, verifies it against that release's `sha256sums.txt`, unpacks it under `~/.local/lib/convorel` and links `convorel` into `~/.local/bin`. It does not install `agent-browser`. Its only installer options are `--version vX.Y.Z`, `--prefix PATH`, `--bin-dir PATH`, `--dist-dir PATH`, `--uninstall` and `--release-base URL`; installer options are not read from environment variables. It never uses sudo or touches conversation state, preferences or installed skills. Release artifacts carry GitHub build provenance: `gh attestation verify convorel-<version>-linux-x64.tar.gz --repo MarioJames/convorel`. No published npm package is assumed.

From a source checkout, `bun --no-env-file setup.ts ...` runs `bun install --frozen-lockfile` before the same initialization. The commands below use the installed `convorel`; in a checkout substitute `bun --no-env-file src/cli.ts`.

## Start a browser

Example for Linux; use the actual installed binary:

```bash
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.local/share/convorel-chrome" https://chatgpt.com
```

Use headed Chrome over CDP and sign in manually. Keep this dedicated profile to preserve login. Do not reuse browser-harness’s bundled headless Chromium, session, or profile for ChatGPT review. Chrome 136+ requires a non-default data directory when these remote-debugging switches are used: [Chrome documentation](https://developer.chrome.com/blog/remote-debugging-port).

## Initialize

```bash
convorel setup --workspace /absolute/path/to/repo --cdp 9222
```

Preferences default to `~/.config/convorel/preferences.json`; task state defaults to `~/.local/share/convorel`. Use `convorel [--config-dir PATH] [--state-dir PATH] COMMAND` to select different directories, with global options before the command. Keep both directories outside MCP-shared roots. Configuration comes only from the preferences file, with no environment override. Use separate configuration and state directories for independently configured workspaces.

`setup` finds `agent-browser` on `PATH`, saves that path, initializes private configuration, optionally installs the skill and checks CDP/MCP; the source bootstrap additionally installs locked dependencies. Agent skill installation is described below. Missing `agent-browser` stops initialization before the workspace binding is saved. Missing CDP produces a nonzero doctor result while preserving configuration. Bun, Git, Chrome and agent-browser remain user-managed prerequisites.

## Manage a persistent conversation

The caller submits the complete UTF-8 request through stdin or `--prompt`. `create` commits the task and first run to private `tasks.db` without opening a browser. `start --id --run` reads that saved run and sends `[CONVOREL:<runId>]`, two newlines and the prompt unchanged. The marker is a transport correlation key used to reconcile uncertain delivery; it is not a role or review instruction. Convorel does not load source files into the prompt, add workspace context, or select a review strategy. Include any desired code paths and context in the caller's message. Review policy and prompt preparation belong to the bundled, independently installable `chatgpt-review` skill.

```bash
bun --no-env-file src/cli.ts conversation create --id auth-design --prompt 'Review the agreed authentication boundary' --type DES --topic 'Auth boundary'
bun --no-env-file src/cli.ts conversation start --id auth-design --run RUN_ID
bun --no-env-file src/cli.ts conversation wait --id auth-design --run RUN_ID
bun --no-env-file src/cli.ts conversation result --id auth-design --run RUN_ID
bun --no-env-file src/cli.ts conversation finish --id auth-design --run RUN_ID
```

Replace RUN_ID with the returned currentRun. `--run` pins status, result, wait and finish to that exact round. `resume` reconciles an interrupted submission with its visible request marker; it does not press Send again. `followup` saves a new round for a separate `start --id --run` after the prior reply is complete. A repeated `start` on the same task does not send again.

`finish` closes only a verified, completed task-owned tab. Borrowed tabs remain open. It retains conversation links, earlier runs and results. Executing a saved followup reopens the saved URL when necessary and verifies the previous completed turn before sending a successor; a new CLI process uses the same private state. A completed `resume` returns stored state without reopening the tab unless initial naming is still pending. Skills request these operations; Convorel owns their persistence, identity checks, recovery and cleanup mechanics.

Archival is a separate projection of that same state. When a run completes, its prompt source and the Markdown copied from the reply are appended to `conversations.db` as immutable content versions, and `conversation archive|capture|history|search|content|export` read or backfill them. `reply_version_id` selects only captured Markdown, so a round whose capture failed reports an empty reply plus a recorded gap rather than passing rendered page text off as the source. Archive and capture outcomes never change delivery, completion or retry authorization, so a missing capture is a gap, not a failed round; `archive`/`capture` exit 1 on archive failure and 2 on gaps. `--from PATH` makes `search`/`history`/`content` read an exported store or a renamed snapshot with no preferences, workspace or browser, which keeps old content readable after the project directory or Chrome session is gone.

The prompt file is persisted unchanged. During pre-send draft verification, ordinary spaces and nonbreaking spaces are compared as equivalent because Chromium contenteditable may substitute them when rendering indentation. Other text changes still stop the send. Restoring a saved URL includes a bounded wait for the newly opened page/history; failures preserve the binding for inspection rather than create replacement tabs.

## Code access through a tunnel

Install the official [tunnel-client](https://github.com/openai/tunnel-client/releases/latest) using your normal tool installation policy. Create your tunnel in [Platform settings](https://platform.openai.com/settings/organization/tunnels), associate the intended ChatGPT workspace, then generate concrete local commands:

```bash
bun --no-env-file src/cli.ts tunnel instructions --tunnel-id YOUR_TUNNEL_ID
```

Create a key at [Runtime API keys](https://platform.openai.com/settings/organization/api-keys) in the organization owning the tunnel. Its identity needs Tunnels Read + Use. This is not an Admin API key. Store it with `convorel config set tunnel.apiKey KEY` and the ID with `convorel config set tunnel.id tunnel_...`; `convorel config path` prints the 0600 preferences file, and config output never echoes the key. Tunnel commands use `--tunnel-id` when supplied, otherwise the configured `tunnel.id`. Once configured, the ID can be omitted for instructions, doctor, run and recover-lock. Keep `--no-env-file` on Bun commands to prevent automatic environment-file loading. The wrapper maps the key to the official client’s `CONTROL_PLANE_API_KEY` only in its child environment. The generated `tunnel doctor` and `tunnel run` commands use fixed stdio arguments and a private single-instance registry; no YAML profile is required. Use `convorel start` for background operation, `convorel status` for local liveness, `convorel logs --follow` for output, and `convorel stop` or `convorel restart` to manage it. `tunnel run` remains available for foreground use. These commands do not start Chrome or verify cloud connectivity. Do not paste the key into a chat or commit it; avoid leaking it into shell history when configuring it.

In [ChatGPT Plugins](https://chatgpt.com/plugins), create a developer app, choose Connection → Tunnel, select your tunnel, and enable that app for the review conversation. Access/organization permissions are separate from Chrome login.

**Only one active tunnel-client per tunnel ID for stdio.** Stop the old process before replacing it. Separate instances/workspaces need separate tunnel IDs. An initialized client and a healthy local process are not proof that the ChatGPT workspace can call it.

First verify with a synthetic file containing a known marker: ask ChatGPT to call capabilities and exec (`read_file --path ...`); compare its reported hash/content with the local file. This is distinct from local SDK stdio testing.

See [official setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and [stdio deployment limits](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md#stdio-deployment-limits).

## Recovery

`conversation wait` holds one task-level watcher lock for its entire lifetime and pins the original run. SIGINT/SIGTERM wake its sleep and release that lock without cancelling the remote generation. Recover a crashed watcher only after verifying its recorded owner is dead, with `recover-lock --watch-task ID`; `LOCK_BUSY` does not authorize launching another watcher.

`conversation status` reads persisted state; `conversation resume` observes the page without resending. A successfully saved final reply is immutable even if a later page observation fails. If a lock remains after a crash, inspect its PID/identity, then use `recover-lock`; a live owner is never displaced. For a tunnel wrapper crash use `tunnel recover-lock --tunnel-id ID`, which also refuses a surviving native child. Do not start the same tunnel outside the wrapper in parallel.

Submission failures before Send retain `prepared` with the error and any draft. `resume` only observes and keeps that state when no submitted marker exists. After resolving the reported precondition, explicitly continue the same saved run:

```bash
bun --no-env-file src/cli.ts conversation retry --id auth-design --run RUN_ID
```

`retry` is accepted only for `prepared`: it rechecks the page, model, prior completed turn and draft, retaining the same request/run/message. A changed draft is not overwritten. Once a run entered `submitting` or `delivery_unknown`, retry is rejected; use observation and inspect the exact existing turn. Legacy `needs_attention` records are not assumed safe to send again. Uncertain submission must be reconciled, never blindly retried. A tab creation whose result was lost similarly needs operator inspection; the CLI will not accumulate replacement blank tabs.

## Multiple read-only directories

Set `mcp.roots` to a JSON array with `convorel config set mcp.roots '["~/workspaces","~/opensource"]'`. Give ChatGPT the full project path to review. Without this setting, the root saved by init is the sole allowed directory. Restart the tunnel after changing the allowlist.

The MCP server exposes four functions: `exec`, `memory`, `artifact` and `capabilities`. Refresh the ChatGPT connector's cached tool definitions when upgrading to `functions-v1`; the former individual tools are now operations inside `exec`.

```json
{"name":"capabilities","arguments":{"path":"/absolute/project"}}
{"name":"exec","arguments":{"command":"git status --path '/absolute/project'"}}
{"name":"exec","arguments":{"command":"read_file --path '/absolute/project/src/main.ts' --startLine 1 --maxLines 100"}}
{"name":"artifact","arguments":{"kind":"image","path":"/absolute/project/proof.png"}}
{"name":"exec","arguments":{"command":"bun run build","cwd":"/absolute/project","timeoutSeconds":30}}
```

`capabilities` lists allowed roots, project identity, full input schemas for query commands, execution availability and explicit memory/dependency grants. Query results live in `execution.result`; artifact metadata lives in `artifact.result`. Follow the existing line/file/patch continuation fields. Query commands use `--name value` with the original camelCase option names. Shell quoting is parsed with shell-quote, but no shell expands commands, variables or globs; pipe/redirection/substitution syntax is rejected. `git status`, `git diff`, `git log`, `git show`, `git compare` and `git read_file` alias the corresponding `git_*` operations.

All workspace paths are absolute or `~/` paths. `capabilities` without a path lists roots; with a path it reports the nearest project identity and revision. The CLI can also serve explicitly with `mcp serve --roots '["/absolute/root-a","/absolute/root-b"]'`. `.convorelignore`, `.gitignore`, credential, symlink and hardlink policies continue to apply to reads and execution input snapshots. Git worktrees require their metadata storage to remain in permitted roots.

Build/test execution currently supports Linux with Bubblewrap, prlimit and Bun already installed: `bun test`, or `bun run` followed by `build`, `test`, `check`, `typecheck`, `dist`, or a colon-suffixed variant. Other package managers and arbitrary scripts/arguments are rejected. The project must contain package.json; an explicit non-Bun packageManager is rejected. Source inputs are filtered, limited to 32 MiB total/1 MiB per file, and copied into an isolated writable filesystem. The host checkout is never writable; HOME, Git metadata, environment files and network are unavailable. Temporary outputs are discarded after execution; a private bounded JSON execution report is retained under the state directory's executions folder. This is execution evidence, not a deploy or an exported build.

Dependencies are not mounted by default. Grant only trusted, project-specific node_modules directories with `convorel config set mcp.execDependencyRoots '["/absolute/project/node_modules"]'`. This explicitly exposes all readable content in that dependency directory to the build/test script; keep private data out of it. The mount is read-only and used only for its owning project's execution, never as a file-reading bypass. Shared dependencies remain live and are not included in the returned inputSha256.

The default wall timeout is 30 seconds (maximum 120). One build/test runs at a time per server; cancellation, timeout and excessive output terminate execution. Responses retain up to 8 KiB of combined stdout/stderr; over 1 MiB total output stops the process. Workspace and /tmp tmpfs sizes are 512/256 MiB; CPU, process, file-size and descriptor limits also apply. These are bounded local execution controls, not a VM or a total memory cgroup quota. Check exitCode, signal, timedOut and outputLimited even when the MCP call itself succeeded. Missing sandbox support fails closed.

To expose existing OpenViking context, configure explicit canonical scopes, for example `convorel config set mcp.memoryRoots '["viking://user/YOUR_USER/memories/PROJECT"]'`. Optionally set `mcp.memoryExecutable` to the absolute ov CLI path; otherwise the server resolves ov on PATH. Existing ov configuration handles authentication; Convorel never returns those credentials. `memory(action="search", uri=..., query=...)` performs scoped semantic retrieval; `memory(action="read", uri=...)` reads an exact permitted URI. No writes/deletes or automatic broad sharing. URI aliases, traversal and encoded paths are rejected. Configured status is not a health probe. Restart the tunnel after changing MCP preferences.

`artifact` supports paginated text reports and native PNG/JPEG/WebP images up to 1 MiB under the same workspace policy. Arbitrary binary downloads/uploads and private execution-report browsing are not exposed. A screenshot hash does not prove its producing revision or test result.

Allowed roots have `rootId`; evidence also carries `workspaceId` and `workspacePath` for the nearest Git checkout inside the root (or the root itself). `capabilities.workspace` is null for a roots-only request. IDs are evidence identities, not authentication.

## 安装 chatgpt-review

包装入口接受 `--agent codex|claude-code|codex,claude-code`、可选 `--scope user|project`（默认 `user`）和 `--cwd PATH`。安装命令在读取任务配置前处理，无需先 `init`：

```bash
bun --no-env-file src/cli.ts skills install --dir /absolute/custom-skills
bun --no-env-file src/cli.ts skills install --agent codex,claude-code
bun --no-env-file src/cli.ts skills install --agent claude-code --scope project --cwd /absolute/project
# 或在源码初始化时选择安装
bun --no-env-file setup.ts --workspace /absolute/project --cdp 9222 --agent codex
```

该入口固定调用 `skills@1.6.0`，安装源是当前 Convorel 安装包的 `skills` 目录；安装前检查公共 `.agents/skills/chatgpt-review` 与所选 Agent 路径（包括旧 `.codex/skills/chatgpt-review`），存在目录或链接即拒绝覆盖；安装后核验 `SKILL.md`，不另建技能注册表。Codex 使用公共目录，Claude Code 链接到同一技能。`setup --agent` 在初始化后安装，再 doctor；不传 `--agent` 则不安装。已有个人技能保持原状，安装不更改其内容。

在 Convorel 源码或解包后的安装包根目录运行：

```bash
bunx skills add ./skills --skill chatgpt-review -a codex -g
```

直接使用 Skills CLI 时保留交互步骤，遇到同名个人技能取消覆盖，不自动替换已有链接或目录。源码发布后可改用 `bunx skills add https://github.com/MarioJames/convorel --skill chatgpt-review -a codex -g`。本步骤仅安装技能；运行时需独立安装，技能直接调用 `PATH` 中的 `convorel`（安装脚本默认链接到 `~/.local/bin`）。源码方式可显式调用 `bun --no-env-file /path/to/convorel/src/cli.ts`，不从技能安装目录推断运行时。

用 `convorel config set project.url URL`、`convorel config set project.name NAME` 成对设置目标项目，可选 `convorel config set model MODEL`。配置只来自偏好文件，不接受环境覆盖。新 task 保存 snapshot，续谈保持原配置；修改配置不会改写旧任务。未指定模型默认 Latest + Power 末端 Pro，不锁版本。全部配置键及目录参数见[使用指南](usage.md#配置文件与目录)。

创建时通过 `create --type DES --topic '具体主题'` 提供命名信息，首次命名放到发送成功后的第一轮 `wait` 正常或超时返回前，无需等回复完成。`start`/`resume` 不改名；URL 延迟时继续观察同一轮，在后续 `wait` 返回前补做；命名失败记录在 `organization.error`，检查后用 `organize` 显式重试，不重发消息。审查技能使用 `MMDD｜TYPE｜Topic`：日期取会话 `createdAt` 转 `Asia/Shanghai`，默认英文 TYPE；用户明确要求中文时给 `create` 或 `organize` 加 `--language zh`。配置项目时直接使用该项目的“新建对话”入口；命名只改标题，归属不符即报错，不移动会话。主题不明保留原标题，不改置顶、归档等状态。组织失败仍保留错误并尝试安全 finish。

Herdr 可选。技能优先复用现有 Herdr 技能或 `herdr --skill`，只有当前 pane 可解析时创建服务 lane；否则用宿主后台进程或分段 `conversation wait --timeout-seconds 60`。一个 run 只保留一个等待者，通知后仍需读取精确 run 的完整结果；未知发送不得重发。

## Existing private state

Keep the same state directory, configuration directory, task ID and run when continuing an existing conversation. Installing the skill does not migrate or delete task state, browser profiles, tunnels or historical review records. Use `conversation attach` only when an existing conversation URL and exact submitted user-message identity are verified; attaching sends nothing. Do not replace an existing live binding or duplicate an uncertain submission.
