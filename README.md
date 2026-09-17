# Convorel

**让本地编码 Agent 与网页 AI 接力协作。**

[![检查](https://github.com/MarioJames/convorel/actions/workflows/check.yml/badge.svg)](https://github.com/MarioJames/convorel/actions/workflows/check.yml)
[![许可证](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Convorel 把已登录的 ChatGPT 网页接入本地开发流程：编码 Agent 提出问题，网页 AI 给出独立意见，再由本地 Agent 核对、修改和运行测试。需要代码证据时，ChatGPT 可以通过 MCP 按需读取你指定的工作区。

会话、请求、回复和标签页归属都保存在本地。进程中断后可以继续核对同一轮消息；完成后只清理自建且确认空闲的标签页，保留浏览器和登录状态。

[快速开始](#快速开始) · [接入指南](docs/quickstart.md) · [架构](docs/architecture.md) · [访问边界](docs/security.md)

## 能做什么

- **网页协作**：通过内置的 agent-browser 和 CDP 使用你自己的 Chrome，发送问题前核对模型。
- **只读代码访问**：提供工作区信息、目录、文件、文本搜索、Git 状态和 diff 六个 MCP 工具。
- **可恢复的对话**：绑定任务、会话和精确消息 ID，保存完整提示词与最终回复；发送结果不确定时不自动重发。
- **标签页管理**：绑定指定标签页，保护用户已有页面、草稿和新轮次；不因重连反复创建空白页。
- **内置审查提示词**：要求核对工作区、引用文件与 hash，并区分事实、风险和建议。
- **Agent 技能与初始化**：一个入口安装项目依赖、初始化配置、安装技能并检查连接。

适合架构讨论、代码审查和实现方案交叉验证。编码与测试仍由本地 Agent 完成；远端回复是需要核实的审查意见。

## 两条独立通道

```mermaid
flowchart LR
  Agent[本地编码 Agent] --> CLI[Convorel CLI / 技能 / 提示词]
  CLI --> State[本地持久状态]
  CLI --> Browser[agent-browser / CDP]
  Browser --> ChatGPT[已登录的 ChatGPT 网页]
  ChatGPT -->|代码工具调用| Tunnel[OpenAI Secure MCP Tunnel]
  MCP[本地只读 MCP] --> Repo[允许目录中的项目]
  Client[官方 tunnel-client] -->|出站连接| Tunnel
  Client -->|stdio| MCP
```

| 使用方式            | 需要什么                                                       | ChatGPT 能看到什么       |
| ------------------- | -------------------------------------------------------------- | ------------------------ |
| 网页对话            | 已登录浏览器、CDP、可用模型                                    | 你发送的提示词和上下文   |
| 网页对话 + 本地代码 | 上述条件，以及 tunnel-client、隧道凭据和 ChatGPT developer app | 允许目录中通过过滤的内容 |

**仅打开 CDP 不会启用代码访问。** 网页对话无需本项目使用 API key；隧道需要自己的 runtime API key。无需 OpenAI 桌面端、Herdr 或记忆服务，也不需要全局安装 agent-browser。

## 快速开始

首版支持 **Linux**，需要 Bun ≥ 1.3、Node ≥ 24、Git 和已安装的 Chrome/Chromium。当前仅实现 ChatGPT 网页适配。

### 1. 获取项目

```bash
git clone https://github.com/MarioJames/convorel.git
cd convorel
```

以下步骤使用源码安装。

### 2. 准备浏览器

在另一个终端启动 Chrome，随后手动登录 ChatGPT；已有兼容的 CDP 浏览器可以直接复用。

```bash
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.local/share/convorel-chrome" https://chatgpt.com
```

将 `google-chrome` 换成实际安装的浏览器命令。调试端口只绑定本机，并使用单独的持久化 profile；[Chrome 136+ 要求使用非默认数据目录](https://developer.chrome.com/blog/remote-debugging-port)。

### 3. 初始化并安装技能

在 Convorel 目录执行，将 `--workspace` 替换为默认审查项目的绝对路径：

```bash
bun --no-env-file setup.ts --workspace /absolute/path/to/your-project --cdp 9222
```

`setup` 会安装锁定的本地依赖，将配置写入 `~/.local/share/convorel/`，把内置技能链接到 `~/.agents/skills/convorel`，并检查 CDP 和本地 MCP。重复执行会保留已配置的可选偏好；同名技能冲突会报错，不覆盖原文件。源码目录需保留，以供技能调用。

`--workspace` 保存默认审查上下文；未配置 `CONVOREL_MCP_ROOTS` 时，它也是唯一允许读取的目录。配置多目录后，对话中直接提供目标项目的完整路径即可，无需设置 `CONVOREL_WORKSPACE`。

默认核对页面模型 **6 Pro**。若账号没有此模型，可以在初始化时传入 `--model '页面上的模型名称'`，并在网页中手动选好；程序不会静默降级。所有源码 CLI 命令保留 `--no-env-file`，避免自动加载调用目录或共享工作区的环境文件。隧道命令会单独读取 convorel 安装目录的 `.env`。

### 4. 发起第一次讨论

让支持本地技能的编码 Agent 使用已安装的 [Convorel 技能](skills/convorel/SKILL.md)，例如：

> 用 convorel 审查下面这份实现方案，取得回复后核对建议、保存总结，并清理自建标签页。

也可以直接使用 CLI。先创建一个不含敏感信息的请求文件：

```bash
CONVOREL_PROMPT_FILE=$(mktemp)
cat > "$CONVOREL_PROMPT_FILE" <<'PROMPT'
请审查这个方案：本地 Agent 负责编码和测试，网页 AI 提供独立审查。
列出两个主要风险和对应验证方法。本轮未提供代码，请只依据这段描述讨论。
PROMPT

bun --no-env-file src/cli.ts review start \
  --id first-review --prompt-file "$CONVOREL_PROMPT_FILE"
```

从输出中复制 `currentRun`，将下面的 `RUN_ID` 替换为该值：

```bash
bun --no-env-file src/cli.ts review wait --id first-review --run RUN_ID
bun --no-env-file src/cli.ts review result --id first-review --run RUN_ID
bun --no-env-file src/cli.ts review finish --id first-review --run RUN_ID
```

先消费、保存回复，再执行 `finish`。它保留会话链接和结果，只关闭经过核验的自有标签页；用户原有标签页不会关闭。

## 让 ChatGPT 读取本地代码

本地 MCP 使用 **stdio**，由 MCP 客户端或官方 tunnel-client 启动，不是浏览器直接访问的 HTTP 服务。

### 1. 准备隧道与凭据

安装官方 [tunnel-client](https://github.com/openai/tunnel-client/releases/latest)，确保命令在 `PATH` 中。在 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels) 创建隧道，并关联目标 ChatGPT 工作区。在同一组织的 [Runtime API keys](https://platform.openai.com/settings/organization/api-keys) 创建具有 **Tunnels Read + Use** 权限的运行时密钥。

### 2. 配置环境文件与读取范围

在 Convorel 安装目录复制 `.env.example` 为 `.env`（已有文件则直接编辑），填入自己的配置：

```dotenv
CONVOREL_TUNNEL_API_KEY=你的_OpenAI_运行时密钥
CONVOREL_TUNNEL_ID=tunnel_你的隧道ID
CONVOREL_MCP_ROOTS='["~/workspaces","~/opensource"]'
```

`CONVOREL_MCP_ROOTS` 是允许读取的根目录 JSON 数组，支持绝对路径和 `~/`。未设置时使用初始化时指定的目录；根目录不能重复、嵌套或是符号链接。修改读取范围后需重启隧道。

同名环境变量优先于 `.env`，包括显式空值；隧道 ID 还可用 `--tunnel-id` 覆盖。无论从哪个目录调用，程序只读取 Convorel 安装目录的 `.env`，不加载被审查项目的环境文件、`.env.local` 等变体，也不执行变量展开。保留命令中的 `--no-env-file`，由 Convorel 按上述规则加载配置。

`.env` 和 `.env.*` 已被 Git 忽略（保留可提交的 `.env.example` 模板）。可执行 `chmod 600 .env` 限制本机访问。密钥只在启动官方客户端时映射为它需要的 `CONTROL_PLANE_API_KEY`，不写入提示词或任务 JSON。

### 3. 启动并连接 ChatGPT

```bash
bun --no-env-file src/cli.ts tunnel instructions
bun --no-env-file src/cli.ts tunnel doctor
bun --no-env-file src/cli.ts tunnel run
```

保持 `tunnel run` 运行。在 [ChatGPT Plugins](https://chatgpt.com/plugins) 创建 developer app，选择 **Connection → Tunnel** 和对应隧道；当前本地 MCP 不提供应用层 OAuth，认证选择 **No Auth**。隧道连接仍受运行时密钥和工作区权限控制。随后在审查对话中启用该 app。一个 stdio 隧道 ID 同时只能运行一个客户端。

完整接入步骤见[接入指南](docs/quickstart.md#code-access-through-a-tunnel)与 [OpenAI 官方文档](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)。

### 4. 按完整路径读取并验证

对话中直接给出项目路径，例如：

> 请审查 `/home/your-name/workspaces/my-project`。先调用 workspace_info 核对目录，再读取相关文件；引用文件路径和返回的 SHA-256。

| MCP 工具           | 用途                                       |
| ------------------ | ------------------------------------------ |
| `workspace_info`   | 不传路径时列出允许根；传路径时核对目录身份 |
| `list_directory`   | 列出允许访问的目录和文件                   |
| `read_file`        | 按行读取文本，返回整文件 SHA-256           |
| `search_workspace` | 有扫描及输出上限的字面量文本搜索           |
| `git_status`       | 返回经过路径过滤的 Git 状态                |
| `git_diff`         | 读取工作区、暂存区或相对 HEAD 的 diff      |

工具使用完整 `path`，支持绝对路径和 `~/`；Git 工具需传真实 Git 根目录。远端不能添加允许根或扩大本地配置。

首次连接时，在允许目录内创建一个内容已知、无敏感信息的测试文件，让 ChatGPT 调用 `read_file`，再用本地 `sha256sum /完整路径/测试文件` 比对整文件 hash 和内容。`tunnel doctor` 成功只说明本地检查通过，网页实际调用成功才确认整条链路可用。

## 续谈、恢复和多工作区

```bash
# 查看已保存的任务和轮次
bun --no-env-file src/cli.ts review list
bun --no-env-file src/cli.ts review status --id first-review --run RUN_ID

# 只观察现有消息，恢复中断后的状态，不再次点击发送
bun --no-env-file src/cli.ts review resume --id first-review --run RUN_ID

# 消费上一轮结果后，用新的请求 ID 继续同一对话
bun --no-env-file src/cli.ts review followup \
  --id first-review --prompt-file /path/to/followup.md --request-id round-2
```

重复相同任务和请求不会重发；新问题使用 `followup` 和新请求 ID。后续操作使用它返回的新 `currentRun`。等待超时只停止本地监视，不会停止网页生成。

同一允许范围内切换审查项目，只需在对话中提供新的完整路径，无需重新初始化。`CONVOREL_HOME` 用于隔离任务状态、默认项目和 CDP 配置；它不会自动隔离安装目录 `.env` 中的读取范围。确需独立状态时，将它设为允许目录之外的私有目录，再执行 `setup`。不同读取边界的连接应分别配置允许根和独立隧道。

自定义技能安装位置用 `setup --skill-dir DIR`；完整命令见 `bun --no-env-file src/cli.ts --help`。

## 访问边界

- 只读 MCP 没有文件写入或任意 shell 工具；所有允许根统一排除 `.env`、`.env.*` 和已有敏感文件规则覆盖的凭据文件；目录列表、搜索、读取和 Git 输出执行一致的过滤。符号链接、硬链接及越界路径会被拒绝，Git diff 同时检查重命名前后路径。
- 项目继承祖先目录的 `.convorelignore` 和 `.gitignore` 限制，子目录不能重新放行上层拒绝的路径；文件名规则不能识别写在普通源码里的所有秘密。
- 同一连接的授权客户端共享配置中允许目录的读取范围；任务 ID 和工作区 hash 不承担远端鉴权。
- 文件实时读取，hash 用于标识观察到的内容，不承诺跨文件不可变快照。
- 网页 DOM、登录状态和平台权限可能变化；遇到验证挑战、草稿或不确定状态需要检查现场。

这是独立社区项目，不是 OpenAI 官方产品。分发源码不包含共享账号、隧道或公开 ChatGPT 插件。详细边界见[安全说明](docs/security.md)。

## 开发与贡献

```bash
bun install --frozen-lockfile
bun run check
bun run format:check
bun run test:browser --chrome /path/to/installed/chrome
bun run test:package
```

浏览器回归使用一次性 profile，不登录账号、不发送 ChatGPT 消息。安装包验收覆盖含空格路径、项目目录外调用、技能入口和真实 MCP stdio 读取。具体测试环境及覆盖范围见[验证记录](docs/validation.md)。

欢迎通过 [Issues](https://github.com/MarioJames/convorel/issues) 提供复现或建议；开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

采用 [Apache-2.0](LICENSE) 许可证。复用来源及第三方许可见 [NOTICE](NOTICE) 和 [第三方声明](THIRD_PARTY_LICENSES.md)。
