![Convorel 交融版品牌标识](docs/assets/brand/convorel-expressive-lockup.png)

# Convorel

**让你的编码 Agent，与 ChatGPT 围绕真实代码展开讨论。**

> 让代码协作，多一个独立视角。

Convorel 把 ChatGPT 接入本地开发流程。Codex 或 Claude Code 带着问题发起讨论，ChatGPT 给出独立意见，Agent 再回到工作区核对建议、修改代码和运行测试。从方案取舍到疑难排障，同一项工作的讨论可以一直接着往下走。

接通可选的只读代码服务后，ChatGPT 能在你允许的目录里按需检索文件、查看提交历史和 diff、读取验证报告或截图，判断有代码依据，你也不用手动搬运上下文。

[![检查](https://github.com/MarioJames/convorel/actions/workflows/check.yml/badge.svg)](https://github.com/MarioJames/convorel/actions/workflows/check.yml)
[![许可证](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

[快速开始](#快速开始) · [完整使用指南](docs/usage.md) · [架构设计](docs/architecture.md) · [品牌素材](docs/brand.md) · [参与贡献](CONTRIBUTING.md)

## 把讨论带回实现

编码 Agent 给出一个看起来可行的方案时，你可能还想确认：边界有没有遗漏？失败后能否恢复？换一种实现会不会更简单？

安装内置技能后，可以直接这样交给 Agent：

> 使用 $chatgpt-review 审查当前重试机制。请结合实际代码检查重复提交和超时恢复的边界，核对建议后修复确认的问题，并运行相关验证。

协作过程分工清楚：

1. **本地 Agent 准备问题。** 整理目标、约束、相关代码和已有验证，发起有上下文的讨论。
2. **ChatGPT 提供独立意见。** 分析方案，必要时通过只读连接查看代码，指出假设和遗漏。
3. **本地 Agent 完成落地。** 核对建议、决定取舍、修改并测试；有新证据时在同一会话里接着谈。

模型意见始终需要验证。Convorel 保留每一轮的请求和回复，讨论能接着继续，结论也有据可查。

## 什么时候值得用

| 你正在做的事           | Convorel 帮你推进的部分                             |
| ---------------------- | --------------------------------------------------- |
| 确定架构或重要实现方案 | 带着真实约束讨论取舍，在实现前检查关键假设          |
| 审查风险较高的修改     | 让另一个视角查看相关代码和 diff，核对边界与失败路径 |
| 功能开发完成、准备交付 | 对照原目标和架构约束检查实际结果是否合理、有无偏移  |
| 排查反复卡住的问题     | 把现象、尝试和新证据放进持续对话，重新审视诊断方向  |

## 为持续协作而设计

- **少搬上下文。** ChatGPT 通过 MCP 按需读取代码，也能读取你明确共享的记忆；Linux 上还能在隔离副本里运行受控构建和测试。共享哪些目录由你决定。
- **任务只写要做什么。** 工作区路径和通用工具指引由 Convorel 自动附加，调用方只写目标、约束和验收要求。每轮保存原始任务、指引快照和最终发送文本，重试沿用原文。网页收到的是普通消息，不是真正的 system role。
- **中断了也接得上。** 任务、轮次和回复保存在本地。进程中断后先核对已发出的消息再继续；发送结果不明时保留现场，不会自动重发。
- **内容留在本地，随时能搜。** 每轮 prompt 原文和回复的 Markdown 写入私有 SQLite 归档，`conversation search` 可以直接按中文子串检索。网页关闭、Chrome 停止，甚至项目目录删除后都能回读，也能导出一致性快照备份。
- **修改权留在本地。** 共享源码只读，代码修改和最终验收由本地 Agent 负责。

## 快速开始

当前支持 **Linux（x64 / arm64）和 macOS（Apple Silicon）上的 ChatGPT 网页版**，通过 CDP 控制 Google Chrome。需要 Git、本机 `PATH` 上的 `agent-browser`，以及能使用目标模型的 ChatGPT 账号。默认选择网页 Latest 的 Pro 模式，不锁定模型版本。

### 1. 安装

从 GitHub Release 安装独立可执行文件，不需要 Bun 或 Node：

```bash
curl -fsSL https://raw.githubusercontent.com/MarioJames/convorel/main/install.sh | bash
```

脚本会校验发布的 `sha256sums.txt`，安装到 `~/.local/lib/convorel`，并在 `~/.local/bin` 链接 `convorel`，不需要 sudo。Linux 需要 util-linux 的 `flock`，macOS 使用系统自带的 `lockf`。之后可以用 `convorel version --check` 检查新版本，用 `convorel upgrade` 升级；卸载只移除可执行文件，会话、偏好和已安装技能都会保留。

想从源码运行（Bun ≥ 1.3、Node ≥ 24）：克隆仓库后，把下文的 `convorel` 换成 `bun --no-env-file src/cli.ts`。

### 2. 初始化、登录并安装技能

```bash
convorel setup --workspace /absolute/path/to/your-project --agent codex
```

Convorel 会创建专用的 Chrome profile，打开 ChatGPT 等你登录一次；之后浏览器没在运行时，会自动拉起。使用 Claude Code 时把 `codex` 换成 `claude-code`，两个都装用 `codex,claude-code`；已有同名技能时会停下提示，不会覆盖你的修改。

几个常用选项：

- 不想让浏览器窗口打断工作：`convorel config set browser.headless true`。托管 Chrome 改为无窗口运行，需要登录时仍会打开窗口。
- 指定 profile 目录：`--user-data-dir /absolute/profile`，或者用 `convorel config set browser.userDataDir`。
- 用自己启动的 Chrome：改传 `--cdp PORT`。

模型和目标项目用 `convorel config set` 保存，只从配置文件读取。完整选项见[使用指南](docs/usage.md)。

### 3. 让 ChatGPT 读取本地代码（可选）

只连接浏览器时，ChatGPT 只能看到 Agent 写进请求里的内容。要让它直接读代码，需要按[代码连接指南](docs/usage.md#让-chatgpt-读取本地代码)配置官方隧道和 ChatGPT developer app。

### 4. 发起讨论

在 Agent 里使用 `$chatgpt-review`（见上文示例），或者直接用 CLI：

```bash
convorel conversation create --id first-question --prompt-stdin true \
  --type EXP --topic '内容哈希' <<'PROMPT'
请解释内容哈希如何帮助识别文件变化，并给出一个简短示例。
PROMPT
convorel conversation start --id first-question --run RUN_ID   # RUN_ID 取自上一步输出的 currentRun
convorel conversation wait --id first-question --run RUN_ID
convorel conversation result --id first-question --run RUN_ID
convorel conversation finish --id first-question --run RUN_ID
```

## 接入你自己的流程

`chatgpt-review` 是一个通用的送审技能：负责发起讨论、等待回复、读取结果和收尾。你的其他技能或团队流程都可以通过它调用 ChatGPT，并在自己的流程里决定何时送审、如何处理意见。也可以绕过技能，直接用 CLI 组织问答或讨论。

技能装在哪里由你决定：用 `--agent` 和 `--scope` 安装到 Agent 的技能目录，或用 `--dir PATH` 安装到任意目录。升级 Convorel 不会自动更新已安装的技能，需要对原安装位置运行 `convorel skills check` 和 `convorel skills update`。更新会保留本地修改，遇到冲突时停下，详见[技能安装与更新](docs/usage.md#安装与更新审查技能)。

Herdr 可用时可以增强后台等待，但不是前置条件。

## 使用边界

- **明确共享范围。** 只读服务限制在你配置的目录内，并过滤 `.env` 等敏感路径。普通源码里的秘密无法仅凭文件名识别，共享前仍需检查内容；获准读取的内容会发送给 ChatGPT。
- **保留已有工作。** 收尾时只关闭经过核验的自有空闲标签页，保留你的页面、浏览器登录态和历史记录。
- **如实面对网页变化。** 目前适配 ChatGPT 网页版；遇到登录挑战、页面改版或发送结果不明时，可能需要人工处理。已验证范围和已知限制见[验证记录](docs/validation.md)。

## 文档与贡献

| 文档                             | 内容                                           |
| -------------------------------- | ---------------------------------------------- |
| [完整使用指南](docs/usage.md)    | 安装、技能、代码连接、配置、会话恢复与内容检索 |
| [接入参考](docs/quickstart.md)   | 运行时、隧道与 CLI 的详细行为                  |
| [架构设计](docs/architecture.md) | 会话管理、内容归档、只读代码服务与技能的职责   |
| [安全说明](docs/security.md)     | 访问范围、敏感路径过滤和信任边界               |
| [品牌素材](docs/brand.md)        | 项目定位、品牌图与使用约定                     |
| [贡献指南](CONTRIBUTING.md)      | 开发检查、验证要求和贡献约定                   |

欢迎通过 [Issues](https://github.com/MarioJames/convorel/issues) 分享使用场景、反馈问题或提出建议，也欢迎提交改进。开发检查使用项目现有脚本：

```bash
bun install --frozen-lockfile
bun run check
bun run format:check
```

采用 [Apache-2.0](LICENSE) 许可证，复用来源见 [NOTICE](NOTICE) 和[第三方声明](THIRD_PARTY_LICENSES.md)。Convorel 是独立社区项目，与 OpenAI 没有隶属关系，也未获官方背书。
