# Quick start

Runnable v0.1 commands; consult validation.md for the verified environment and remaining limitations.

## Prerequisites

- Linux, Bun >= 1.3, Node >= 24 (agent-browser package requirement), Git, an installed Google Chrome.
- Your own ChatGPT account with access to the selected model. The default selects Latest and the Pro endpoint of Power without pinning a version. Override with `CONVOREL_MODEL`; other visible models are verified after manual selection.
- For code tools: your own OpenAI tunnel, runtime key and ChatGPT developer app. Browser-only conversation does not need these.

From the source directory, use the bootstrap command below; it runs `bun install --frozen-lockfile`. There is no published npm package assumed by this documentation. Invoke `bun --no-env-file src/cli.ts --help` or use the package's bin after a local installation.

## Start a browser

Example for Linux; use the actual installed binary:

```bash
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.local/share/convorel-chrome" https://chatgpt.com
```

Use headed Chrome over CDP and sign in manually. Keep this dedicated profile to preserve login. Do not reuse browser-harness’s bundled headless Chromium, session, or profile for ChatGPT review. Chrome 136+ requires a non-default data directory when these remote-debugging switches are used: [Chrome documentation](https://developer.chrome.com/blog/remote-debugging-port).

## Initialize

```bash
bun --no-env-file setup.ts --workspace /absolute/path/to/repo --cdp 9222
```

Configuration and task state live outside the shared repository under the user data directory. `CONVOREL_HOME` selects another private state root; never place it within an MCP-shared workspace. Use a separate state root for another configured workspace.

`setup` installs locked local dependencies, initializes private configuration and checks CDP/MCP. Agent skill installation is described below. Missing CDP produces a nonzero doctor result while preserving configuration. Bun, Git and Chrome remain user-managed prerequisites.

## Manage a persistent conversation

The caller writes the complete UTF-8 request file. Convorel sends `[CONVOREL:<runId>]`, two newlines and the file contents unchanged. The marker is a transport correlation key used to reconcile uncertain delivery; it is not a role or review instruction. Convorel does not load source files into the prompt, add workspace context, or select a review strategy. Include any desired code paths and context in the caller's message. Review policy and prompt preparation belong to the bundled, independently installable `chatgpt-review` skill.

```bash
bun --no-env-file src/cli.ts conversation start --id auth-design --prompt-file /path/to/request.md
bun --no-env-file src/cli.ts conversation wait --id auth-design --run RUN_ID
bun --no-env-file src/cli.ts conversation result --id auth-design --run RUN_ID
bun --no-env-file src/cli.ts conversation organize --id auth-design --run RUN_ID --type DES --topic 'Auth boundary'
bun --no-env-file src/cli.ts conversation finish --id auth-design --run RUN_ID
```

Replace RUN_ID with the returned currentRun. `--run` pins status, result, wait and finish to that exact round. `resume` reconciles an interrupted submission with its visible request marker; it does not press Send again. `followup` explicitly starts a new round after the prior reply is complete. A repeated `start` on the same task does not send again.

`finish` closes only a verified, completed task-owned tab. Borrowed tabs remain open. It retains conversation links, earlier runs and results. Later `followup` calls reopen the saved URL when necessary and verify the previous completed turn before sending a successor; a new CLI process uses the same private state. A completed `resume` returns stored state without reopening the tab. Skills request these operations; Convorel owns their persistence, identity checks, recovery and cleanup mechanics.

The prompt file is persisted unchanged. During pre-send draft verification, ordinary spaces and nonbreaking spaces are compared as equivalent because Chromium contenteditable may substitute them when rendering indentation. Other text changes still stop the send. Restoring a saved URL includes a bounded wait for the newly opened page/history; failures preserve the binding for inspection rather than create replacement tabs.

## Code access through a tunnel

Install the official [tunnel-client](https://github.com/openai/tunnel-client/releases/latest) using your normal tool installation policy. Create your tunnel in [Platform settings](https://platform.openai.com/settings/organization/tunnels), associate the intended ChatGPT workspace, then generate concrete local commands:

```bash
bun --no-env-file src/cli.ts tunnel instructions --tunnel-id YOUR_TUNNEL_ID
```

Create a key at [Runtime API keys](https://platform.openai.com/settings/organization/api-keys) in the organization owning the tunnel. Its identity needs Tunnels Read + Use. This is not an Admin API key. Copy `.env.example` to `.env` in the convorel installation root and set `CONVOREL_TUNNEL_API_KEY` and `CONVOREL_TUNNEL_ID`, or export them in the shell. Tunnel commands accept the ID in this order: `--tunnel-id`, environment, installation `.env`. Once configured, `--tunnel-id` can be omitted for instructions, doctor, run and recover-lock. An explicit environment value takes precedence, including an empty value. The known tunnel, MCP-root, model and project settings are read from that installation’s `.env`, regardless of the caller’s directory or configured code workspace; `.env.local` variants and variable expansion are not supported. Keep `--no-env-file` on Bun commands: convorel performs this targeted loading itself. `.env` is Git-ignored; use `chmod 600 .env`. The wrapper maps the key to the official client’s `CONTROL_PLANE_API_KEY` only in its child environment. The generated `tunnel doctor` and `tunnel run` commands use fixed stdio arguments and a private single-instance registry; no YAML profile is required. Run the client in the foreground. Do not paste the key into a chat or commit it.

In [ChatGPT Plugins](https://chatgpt.com/plugins), create a developer app, choose Connection → Tunnel, select your tunnel, and enable that app for the review conversation. Access/organization permissions are separate from Chrome login.

**Only one active tunnel-client per tunnel ID for stdio.** Stop the old process before replacing it. Separate instances/workspaces need separate tunnel IDs. An initialized client and a healthy local process are not proof that the ChatGPT workspace can call it.

First verify with a synthetic file containing a known marker: ask ChatGPT to call workspace_info and read_file; compare its reported hash/content with the local file. This is distinct from local SDK stdio testing.

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

Set `CONVOREL_MCP_ROOTS` to a JSON array in the installation `.env` or process environment, for example `["~/workspaces","~/opensource"]`. No default-workspace environment variable is needed: give ChatGPT the full project path to review. Without this setting, the root saved by init is the sole allowed directory. Restart the tunnel after changing the allowlist.

All MCP tools use full `path` arguments (absolute paths or `~/` paths). `workspace_info` without a path lists the roots; with a path it identifies that directory. The CLI can also serve explicitly with `mcp serve --roots '["/absolute/root-a","/absolute/root-b"]'`. Root selection cannot bypass nested `.convorelignore` or `.gitignore` rules. `.env`, `.env.*` and credential files remain denied. Git worktrees require their gitdir/common-dir/object storage to remain in permitted roots; alternate object stores are unsupported.

## 安装 chatgpt-review

包装入口接受 `--agent codex|claude-code|codex,claude-code`、可选 `--scope user|project`（默认 `user`）和 `--cwd PATH`。安装命令在读取任务配置前处理，无需先 `init`：

```bash
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

直接使用 Skills CLI 时保留交互步骤，遇到同名个人技能取消覆盖，不自动替换已有链接或目录。源码发布后可改用 `bunx skills add https://github.com/MarioJames/convorel --skill chatgpt-review -a codex -g`。本步骤仅安装技能；运行时需独立安装，使用 `PATH` 中的 `convorel` 或 Agent 进程中的 `CONVOREL_BIN=/absolute/path/to/convorel/src/cli.ts`。后者是脚本路径，技能使用 `bun --no-env-file` 调用，不从自身安装目录推断运行时。

在 Convorel 安装根 `.env` 或进程环境中设置成对的 `CONVOREL_PROJECT_URL`、`CONVOREL_PROJECT_NAME`，可选设置 `CONVOREL_MODEL`。同名进程环境变量包括空值优先于安装根 `.env`；不加载代码工作区或调用目录的环境文件。新 task 保存 snapshot，续谈保持原配置。未指定模型默认 Latest + Power 末端 Pro，不锁版本。

审查技能自动整理 `MMDD｜TYPE｜Topic`：日期取会话 `createdAt` 转 `Asia/Shanghai`，默认英文 TYPE；用户明确要求中文时给 `organize` 加 `--language zh`。无项目只命名、不移动；配置成对目标项目时按已有授权核验归属。主题不明保留原标题，不改置顶、归档等状态。组织失败仍保留错误并尝试安全 finish。

Herdr 可选。技能优先复用现有 Herdr 技能或 `herdr --skill`，只有当前 pane 可解析时创建服务 lane；否则用宿主后台进程或分段 `conversation wait --timeout-seconds 60`。一个 run 只保留一个等待者，通知后仍需读取精确 run 的完整结果；未知发送不得重发。

## Existing private state

Keep the same `CONVOREL_HOME`, task ID and run when continuing an existing conversation. Installing the skill does not migrate or delete task state, browser profiles, tunnels or historical review records. Use `conversation attach` only when an existing conversation URL and exact submitted user-message identity are verified; attaching sends nothing. Do not replace an existing live binding or duplicate an uncertain submission.
