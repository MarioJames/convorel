# 使用 Convorel

## 解析 CLI 与私有状态

优先使用显式 `CONVOREL_BIN`，它是 CLI **脚本文件路径**，不是命令串；以 `bun --no-env-file "$CONVOREL_BIN"` 调用。不设置时从 `PATH` 查找 `convorel`。可在当前 shell 使用以下函数，后文 `convorel_cli` 均指这次解析结果；后台进程需传递同一可执行参数，不依赖 shell 函数跨进程继承。

```bash
convorel_cli() {
  if [ "${CONVOREL_BIN+x}" = x ]; then
    if [ -z "$CONVOREL_BIN" ] || [ ! -f "$CONVOREL_BIN" ]; then
      echo 'CONVOREL_BIN 必须指向可读取的 CLI 脚本' >&2
      return 1
    fi
    bun --no-env-file "$CONVOREL_BIN" "$@"
  else
    command convorel "$@"
  fi
}
convorel_cli --help
```

使用绝对脚本路径，保留含空格路径的引号；不要 `eval`、拼接命令串或猜测技能的 `../../src/cli.ts`。缺少 CLI/Bun 时报告前置条件；安装技能不等于安装 Convorel 运行时。查看实际安装包的 CLI 帮助和接入文档，不读取代码工作区的 `.env` 来找运行配置。

审查侧使用普通 Google Chrome 的有头窗口，通过 loopback CDP 连接。启动参数不得包含 `--headless`，登录 profile 与验收侧自带 Chromium 分开。Convorel 始终显式连接其已配置 CDP，不从 browser-harness 继承可执行路径、窗口模式或 profile；不得为审查修改验收侧 agent-browser 配置。

已有需求沿用其 `CONVOREL_HOME`。新绑定使用 MCP 允许根之外的持久私有目录，按用户授权的代码工作区和实际 loopback CDP 初始化：

```bash
convorel_cli init --workspace /absolute/project --cdp 9222
```

Convorel 从进程环境、其次从**安装根** `.env` 读取 `CONVOREL_MODEL`、`CONVOREL_PROJECT_URL` 和 `CONVOREL_PROJECT_NAME`；同名进程变量即使为空也优先，不回退到文件。不加载调用目录/代码工作区的环境文件、不展开其中变量，不把个人配置写入技能。项目 URL/name 必须成对；不要只提供其中一个或猜项目 URL。模型可选，默认 Latest + Power 末端 Pro；用户明确选择的模型通过 `CONVOREL_MODEL` 配置。

新 task 保存配置 snapshot，续谈保留既有模型/项目；后续修改环境或重新初始化不会迁移旧 task。新任务显式使用 `start --workspace PATH`，避免默认工作区和实际审查对象不同。先用 `conversation status --id ID --workspace PATH` 核对绑定；不匹配时返回 `workspaceMismatch` 和退出码 2。仅未发送的首轮可用 `rebind-workspace --id ID --run RUN_ID --from-workspace OLD --workspace NEW` 修正元数据，原 prompt/run 保留。已发送或投递未知时检查原 prompt 的路径/revision 并继续同一 run；不改状态 JSON、不创建重复审查。工作区绑定不等于 MCP 允许根，也不会改写 prompt。`doctor` 仅验证本地 CDP/MCP，不证明 ChatGPT 已取得代码访问；不要擅自安装工具、扩大共享根或启动重复隧道。

## 准备和发送

先用 `conversation list`，再用 `conversation status --id ID` 匹配需求和工作区；已有 active run 继续观察，已有适用结果直接复用。

将完整请求写到私有 UTF-8 文件，按 [review-prompt.md](review-prompt.md) 补齐实际决策、约束、项目路径/revision、MCP 可读取路径、验证摘要和未决问题。代码审查补相关文件的 `路径:起始行-结束行` 引用和审查问题，默认通过 MCP 读取，不内嵌仓库源码；结果校验采用 [result-review.md](result-review.md) 的目标与实际结果对照。检查最终文件。Convorel 只附加关联 marker，不添加角色、项目路径、源码包或审查规则。

```bash
convorel_cli conversation start --id ID --prompt-file /private/request.md --workspace /absolute/project --type DES --topic '具体主题'
```

创建时提供明确的 TYPE 和 Topic；主题无法确定时省略命名参数并保留原标题。配置项目后，Convorel 进入该项目的专属“新建对话”输入框并核验入口，不在普通对话中创建后移动。首条消息与持久化 URL 确认后立即重命名，不等待回复完成；生成期间用临时只读观察页核验远端创建时间和保存结果，不刷新发送页。

保存返回的 `currentRun`、观察到的会话 URL 和状态根。传输层每次发送前核验模型/页面。重复同一请求不会重发，冲突的请求 key/内容失败。

消费并整理上一轮完整结果后，有实质新证据或未解决阻断项时继续同一会话：

```bash
convorel_cli conversation followup --id ID --prompt-file /private/followup.md --request-id UNIQUE_KEY
```

followup 文件包含该轮所需的完整新增说明；沿用已保存 URL 和历史，以返回的新 `currentRun` 监视，不能继续读取上一轮结果充当本轮回复。

## 等待与恢复

默认使用宿主支持的后台进程并保留进程/输出句柄，或分段前台等待：

```bash
convorel_cli conversation wait --id ID --run RUN_ID --timeout-seconds 60
convorel_cli conversation status --id ID --run RUN_ID
convorel_cli conversation resume --id ID --run RUN_ID
convorel_cli conversation result --id ID --run RUN_ID
```

`wait` 大约每 60 秒观察一次。超时仅停止本地等待，不停止远端生成；检查返回状态，仍运行时继续监视。不同 task 的浏览器操作各在自己的 tab 上并行，不再因单一全局锁互相串行——一个 agent 等待回复不会阻止另一个 agent 先建自己的任务、发自己的 prompt；定时检查结果时各自争抢自己那一份已记录的 tab，读完即释放。同一 task 仅允许一个活跃等待者，CLI 用进程身份锁强制执行并固定原 run；重启前核对原进程是否已结束。同一 tab 被同任务另一操作短时占用时，CLI 退避并有限等待，超时才返回 `LOCK_BUSY`，绝不清除活属主的锁。SIGINT/SIGTERM 会唤醒本地休眠并释放锁。崩溃留下的锁仅在确认原进程身份已失效后恢复，不能因超时抢占：用 `convorel_cli recover-lock --watch-task ID` 恢复等待锁，或按 `--task ID`/`--registry true`/`--tabs true`/`--name NAME` 恢复对应锁。`status`/`list` 的 `tab` 与 `locked` 字段显示每个任务自有 tab 及是否正被占用。等待期间继续独立工作；没有独立工作时分段等待直到完成或明确受阻，并及时报告实际状态，不把后台进程已启动当作交付完成。

Herdr 可用且确需增强时按 [herdr.md](herdr.md) 路由；无论收到何种通知，都须用同一 `--id`、`--run` 取得当前完整 `result`，不能以通知、退出码或最后可见的网页答案代替。

`resume` 观察和核对，不发送消息；首轮 URL 延迟时会补做已请求但尚未开始的命名。只有状态为 `prepared` 且已解决发送前错误时，才可显式 `conversation retry --id ID --run RUN_ID`，继续原来已保存的消息。它重新核验模型、页面和草稿；不得重试 `submitting`/`delivery_unknown`，不得覆盖变更后的草稿强行推进。未知发送或等待超时不能用新 ID 再发。

新建页恢复了旧草稿时，先读取并备份完整原文。仅用户明确授权删除该页草稿副本后，才使用 `conversation clear-draft --id ID --run RUN_ID --expected-draft-file /private/approved-draft.txt`。该命令只处理任务自有、无历史消息的新建页和未发送首轮；逐字核对草稿，持久保存备份，删除后实际读回确认。草稿已变、附件存在、页面身份不同或投递未知都会停止，不扩大到其他标签页。成功后再显式 retry 同一 run；命令成功回执不能代替空草稿、模型、页面和投递状态核验。

`status` 的 `summary` 区分已确认投递、发送结果未知和未尝试发送，并返回当前阶段、最近观察时间、观察错误和下一步动作。`status` 退出 0 只表示本地状态读取成功；`start`/`retry` 退出 0 表示已确认发送或已完成；`resume`/`wait` 仅完成时退出 0，未完成或需处理时退出 2，参数/基础设施等异常可退出 1。不要仅凭退出码取代精确轮次的 `result`。`wait` 仅对观察失败做最多三次连续尝试，不自动重发；登录、页面身份或草稿等需处理的问题不会被当作临时读取失败反复尝试。

## 命名恢复、消费与清理

命名在首条消息发送后完成。若返回的 `organization` 未核验成功，检查原因后在原任务显式重试命名；该操作也支持回复生成期间执行，不重发消息：

```bash
convorel_cli conversation organize --id ID --run RUN_ID --type DES --topic '具体主题'
```

读取完整回复后，本地核对意见、记录取舍与证据限制，再释放页面：

```bash
convorel_cli conversation finish --id ID --run RUN_ID
```

TYPE 默认英文代码；仅用户明确要求中文时为 `start` 或 `organize` 增加 `--language zh`，仍传英文 `--type` 代码。命名日期使用实际会话 `createdAt` 转 `Asia/Shanghai`，不能使用 `updatedAt`、本机当前日期或猜测日期。由 Convorel 按该固定命名时区处理，不自行改写 task snapshot。Topic 不重复项目名称；主题无法确定时保留原标题。只改会话标题并保留原项目归属；有成对配置时核验项目 ID，归属不符即报告错误，不移动会话。核验标题及适用的项目结果为 `verified: true`，发现不规范立即用相同规则纠正。

命名必须返回 `verified: true`；失败返回独立的 `organization.error`，不撤销已确认的消息投递、不自动重发；`organize` 失败返回非零退出码，并保留已核验的 rename/project 步骤状态，表示整体未完成；记录错误，仍对已核验完成的轮次尝试 `finish`。`organizationPending` 保留失败信息，不要求保留可释放的自有标签页。finish 只释放经过核验的自有页面，保留会话历史、配置、借用页面和登录态；不授权关闭其他页或共享浏览器。

单独释放任务自有等待进程/lane，记录保留对象和原因。提示词、run 映射、意见和回复留在 Convorel 私有状态或已有任务交付记录，不进入技能源码，不新增平行注册表。

## 接续已有会话

优先复用已有 Convorel task。只有历史记录明确提供同一需求的会话 URL 和精确 user message ID，且没有旧监视者仍处理该轮时，才可绑定：

```bash
convorel_cli conversation attach --id ID --url VERIFIED_URL --user-message VERIFIED_MESSAGE_ID
```

attach 不发送；保存其新 run ID 后走正常流程。不能从“最近可见答案”推断 message ID，不能复制旧私有 JSON 充当 Convorel 状态。保留历史档案；已打开的页面视为借用，缺少身份或提交结果证据时报告缺口，不创建替代会话。
