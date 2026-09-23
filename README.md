![Convorel 交融版品牌标识](docs/assets/brand/convorel-expressive-lockup.png)

# Convorel

**让你的编码 Agent，与 ChatGPT 围绕真实代码展开讨论。**

Convorel 把 ChatGPT 接入本地开发流程。让 Codex 或 Claude Code 带着问题发起讨论，取得另一个视角，再回到工作区核对建议、修改代码和运行测试。从方案取舍到复杂排障，讨论可以跟着同一项工作持续推进。

接通可选的只读代码服务后，ChatGPT 还能按需检索你允许访问的文件、查看提交历史与版本差异，并按需读取验证报告或截图，让判断有代码依据，减少手动复制上下文。

[![检查](https://github.com/MarioJames/convorel/actions/workflows/check.yml/badge.svg)](https://github.com/MarioJames/convorel/actions/workflows/check.yml)
[![许可证](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[快速开始](#快速开始) · [完整使用指南](docs/usage.md) · [架构设计](docs/architecture.md) · [参与贡献](CONTRIBUTING.md)

## 把讨论带回实现

当编码 Agent 给出一个看起来可行的方案，你可能还想确认：边界有没有遗漏？失败时能否恢复？换一种实现会不会更简单？

完成接入并安装内置技能后，可以这样交给 Agent：

> 使用 $chatgpt-review 审查当前重试机制。请结合实际代码检查重复提交和超时恢复的边界，核对建议后修复确认的问题，并运行相关验证。

整个协作过程有清楚的分工：

1. **本地 Agent 准备问题。** 整理目标、约束、相关代码和已有验证，发起有上下文的讨论。
2. **ChatGPT 提供独立意见。** 分析方案，必要时通过已配置的只读连接查看代码，指出假设和遗漏。
3. **本地 Agent 完成落地。** 核对建议，决定取舍，修改并测试；有新证据时接着同一会话讨论。

模型意见始终需要验证。Convorel 保留请求、回复与会话记录，让讨论能继续，也让结论有据可查。

## 什么时候值得用

| 你正在做的事           | Convorel 帮你推进的部分                             |
| ---------------------- | --------------------------------------------------- |
| 确定架构或重要实现方案 | 带着真实约束讨论取舍，在实现前检查关键假设          |
| 审查风险较高的修改     | 让另一个视角查看相关代码和 diff，核对边界与失败路径 |
| 功能开发完成、准备交付 | 对照原目标和架构约束检查实际结果是否合理、有无偏移  |
| 排查反复卡住的问题     | 将现象、尝试和新证据放进持续对话，重新审视诊断方向  |

## 为持续协作而设计

**减少上下文搬运。** 编码 Agent 准备问题，ChatGPT 通过 MCP 按需读取代码、核对显式共享记忆，并可在隔离环境中运行受控构建和测试。你可以控制共享哪些目录；无需反复粘贴整份文件。

**任务只描述要做什么。** Convorel 自动附加工作区路径和通用工具使用指引；调用方提供目标、约束和验收要求。每轮保存原始任务、指引快照和最终发送文本，重试沿用原文。网页版收到的是普通消息，不是真正的 system role。

**让讨论接得上。** 任务与会话、轮次和回复保存在本地。进程中断后可以核对原有消息并继续；发送结果不明时保留现场，不自动重复发送。

**内容留在本地并且搜得到。** 每轮 prompt 原文和回复自带的 Markdown 复制件写入私有 SQLite 归档，`conversation search` 直接按中文子串命中；网页关掉、Chrome 停止甚至项目目录删除后仍可回读，也能导出一致性快照备份。归档写入失败不会影响会话投递状态。

**把修改权留在本地。** 共享源码保持只读，受控构建和测试在隔离副本中执行。代码修改与最终验收仍由本地 Agent 负责。

**沿用现有工具。** 内置 `chatgpt-review` 技能支持安装到 Codex 和 Claude Code。也可通过 CLI 组织自己的问答或讨论流程；Herdr 是可选增强。

## 快速开始

当前版本面向 **Linux（x64 / arm64）+ ChatGPT 网页**，使用你已登录的 **有头 Google Chrome + CDP**。需要 Git，以及能使用目标模型的 ChatGPT 账号。默认选择网页 Latest 的 Pro 模式，不固定模型版本。

### 1. 安装

从 GitHub Release 安装独立可执行文件，不需要 Bun 或 Node。浏览器控制使用本机 PATH 上的 `agent-browser`，`init` 会检测并记下它的路径：

```bash
curl -fsSL https://raw.githubusercontent.com/MarioJames/convorel/main/install.sh | bash
```

安装与升级需要 util-linux 提供的 `flock`。脚本会校验发布的 `sha256sums.txt`，安装到 `~/.local/lib/convorel`，并在 `~/.local/bin` 链接 `convorel`；不使用 sudo。安装选项仅通过参数传入：`--version vX.Y.Z`、`--prefix PATH`、`--bin-dir PATH`、`--dist-dir PATH`、`--uninstall`、`--release-base URL`。卸载只移除可执行文件，保留会话状态、偏好和已安装技能。

安装后可用 `convorel version --check` 检查最新版、`convorel upgrade` 升级，或加 `--version vX.Y.Z` 指定版本；旧版本与用户数据保留。升级不会自动同步已安装技能，需对原安装目标显式运行 `convorel skills check` / `convorel skills update`（沿用 `--agent`/`--scope` 或 `--dir`）；更新保留本地定制，有冲突或旧安装缺基线时停止，详见[技能安装与更新](docs/usage.md#安装与更新审查技能)。

也可以从源码运行（需要 Bun ≥ 1.3、Node ≥ 24）：`git clone https://github.com/MarioJames/convorel.git`，下文命令把 `convorel` 换成 `bun --no-env-file src/cli.ts`，初始化改用 `bun --no-env-file setup.ts`。

### 2. 启动专用浏览器并登录

在另一个终端运行，使用独立的持久化 profile 保存登录态：

```bash
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.local/share/convorel-chrome" https://chatgpt.com
```

### 3. 初始化并安装审查技能

替换为实际代码工作区：

```bash
convorel setup --workspace /absolute/path/to/your-project --cdp 9222 --agent codex
```

使用 Claude Code 时，将 `codex` 换成 `claude-code`；同时安装用 `codex,claude-code`。已有同名技能时会停止并提示，不会覆盖个人修改。

技能直接使用 `PATH` 中的 `convorel`。源码方式可显式调用 `bun --no-env-file /absolute/path/to/convorel/src/cli.ts`，不从技能安装目录推断运行时。

此时可以讨论由 Agent 提供的上下文。要让 ChatGPT **直接读取本地代码**，还需按[代码连接指南](docs/usage.md#让-chatgpt-读取本地代码)配置官方隧道与 ChatGPT developer app；仅连接浏览器不会开放代码访问。

模型与目标项目用 `convorel config set model|project.url|project.name VALUE` 保存到 `~/.config/convorel/preferences.json`，只从配置文件读取，不接受环境覆盖。状态默认保存在 `~/.local/share/convorel`；入口为 `convorel [--config-dir PATH] [--state-dir PATH] COMMAND`，全局目录参数必须放在命令前。配置项目时直接在该项目中创建会话；首条消息发送成功后按调用方提供的主题命名，不等待回复完成、不移动会话。完整命令、配置和首次讨论示例见[使用指南](docs/usage.md)。

## 使用边界

- **明确共享范围。** 只读服务限制在你配置的目录内，并过滤 `.env` 等敏感路径。普通源码中的秘密无法仅靠文件名识别；分享前仍需检查内容。获准读取的内容会传给 ChatGPT。
- **保留已有工作。** 完成后只关闭经过核验的自有空闲标签页，保留用户页面、浏览器登录态和历史记录。
- **如实面对网页变化。** 当前适配 ChatGPT 网页；登录挑战、页面变化或不确定的发送状态可能需要人工处理。已验证范围和已知限制见[验证记录](docs/validation.md)。

## 文档与贡献

| 文档                             | 内容                                           |
| -------------------------------- | ---------------------------------------------- |
| [完整使用指南](docs/usage.md)    | 安装、技能、代码连接、配置、会话恢复与内容检索 |
| [接入参考](docs/quickstart.md)   | 运行时、隧道与 CLI 的详细行为                  |
| [架构设计](docs/architecture.md) | 会话管理、内容归档、只读代码服务与技能的职责   |
| [安全说明](docs/security.md)     | 访问范围、敏感路径过滤和信任边界               |
| [品牌素材](docs/brand.md)        | 项目简介、品牌图与使用约定                     |
| [贡献指南](CONTRIBUTING.md)      | 开发检查、验证要求和贡献约定                   |

欢迎通过 [Issues](https://github.com/MarioJames/convorel/issues) 分享使用场景、复现问题或提出建议，也欢迎提交改进。开发检查使用项目现有脚本：

```bash
bun install --frozen-lockfile
bun run check
bun run format:check
```

采用 [Apache-2.0](LICENSE) 许可证。复用来源见 [NOTICE](NOTICE) 和[第三方声明](THIRD_PARTY_LICENSES.md)。Convorel 是独立社区项目，与 OpenAI 无隶属或官方背书关系。
