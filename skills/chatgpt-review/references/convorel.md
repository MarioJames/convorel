# 使用 Convorel

## 解析 CLI 与私有状态

直接使用 `PATH` 中的 `convorel`（安装脚本默认链接到 `~/.local/bin/convorel`）：

```bash
convorel --help
```

源码方式可显式调用 `bun --no-env-file /path/to/convorel/src/cli.ts`。使用绝对路径，保留含空格路径的引号；不要 `eval`、拼接命令串或猜测技能的 `../../src/cli.ts`。缺少 CLI（源码方式还有 Bun）时报告前置条件；安装技能不等于安装 Convorel 运行时。

入口为 `convorel [--config-dir PATH] [--state-dir PATH] COMMAND`，全局目录参数必须放在命令前。默认偏好文件为 `~/.config/convorel/preferences.json`，默认状态目录为 `~/.local/share/convorel`。下文使用默认目录；已有任务使用自定义目录时，每次调用及后台等待进程均须在命令前传入同一组目录参数。

审查侧使用普通 Google Chrome 的有头窗口，通过 loopback CDP 连接。启动参数不得包含 `--headless`，登录 profile 与验收侧自带 Chromium 分开。Convorel 始终显式连接其已配置 CDP，不从 browser-harness 继承可执行路径、窗口模式或 profile；不得为审查修改验收侧 agent-browser 配置。

已有需求沿用其状态目录和配置目录。新绑定使用 MCP 允许根之外的持久私有目录，按用户授权的代码工作区和实际 loopback CDP 初始化：

```bash
convorel init --workspace /absolute/project --cdp 9222
```

Convorel 仅从偏好文件读取配置，不接受环境覆盖，不把个人配置写入技能。用 `convorel config set project.url URL` 和 `convorel config set project.name NAME` 成对设置项目；不要只提供其中一个或猜项目 URL。模型可选，默认 Latest + Power 末端 Pro；用户明确选择的模型通过 `convorel config set model MODEL` 配置。其他配置键为 `tunnel.id`（`tunnel_` 加 32 位十六进制）、`tunnel.apiKey`、`mcp.roots`（1–16 个绝对路径或 `~/` 路径的 JSON 数组）、`browser.executable`（`init` 保存的 agent-browser 绝对路径）、`browser.serial`（`true`/`false`）、`browser.actionIntervalMs`（默认 750，1–10000）、`browser.navigationWaitMs`（默认 1500，1–10000）、`locks.taskWaitMs`（正整数）、`release.baseUrl`（不含凭据、query、fragment 的 HTTP(S) URL）和 `diagnostics.enabled`（未设置或 `true` 时记录，`false` 关闭；其他值或偏好读取失败也关闭）。`diagnostics --task ID [--run UUID] [--fields LIST]` 读取私有诊断库，不打开浏览器，也不授权重试或重发。

新 task 保存配置 snapshot，续谈保留既有模型/项目；后续修改配置或重新初始化不会迁移旧 task。新任务显式使用 `create --workspace PATH`，避免默认工作区和实际审查对象不同。先用 `conversation status --id ID --workspace PATH` 核对绑定；不匹配时返回 `workspaceMismatch` 和退出码 2。仅未发送的首轮可用 `rebind-workspace --id ID --run RUN_ID --from-workspace OLD --workspace NEW` 修正元数据，原 prompt/run 保留。已发送或投递未知时检查原 prompt 的路径/revision 并继续同一 run；不改状态 JSON、不创建重复审查。工作区绑定不等于 MCP 允许根，也不会改写 prompt。`doctor` 仅验证本地 CDP/MCP，不证明 ChatGPT 已取得代码访问；不要擅自安装工具、扩大共享根或启动重复隧道。

## 准备和发送

先用 `conversation list`，再用 `conversation status --id ID` 匹配需求和工作区；已有 active run 继续观察，已有适用结果直接复用。

按 [review-prompt.md](review-prompt.md) 编写完整请求，补齐用户已确认的方向、实际决策、约束、项目路径/revision、文件引用、验证摘要和未决问题。先检查请求文本与引用，再通过 stdin 直接入库，不创建 `/tmp` 或其他 prompt 交接文件。Convorel 只附加关联 marker，不添加审查规则或源码。

```bash
convorel conversation create --id ID --prompt-stdin true --workspace /absolute/project --type DES --topic '具体主题' <<'PROMPT'
完整请求文本（包含用户已确认的方向和证据引用）。
PROMPT
```

`create` 只将任务、配置 snapshot 和完整首轮 prompt 原子写入私有 `STATE_DIR/tasks.db`，不访问浏览器。短文本也可用 `--prompt '文本'`，与 `--prompt-stdin true` 二选一。创建成功退出 0 只代表入库成功；保存返回的 `currentRun`，按 ID 执行：

```bash
convorel conversation start --id ID --run RUN_ID --workspace /absolute/project
```

`start` 从数据库取出精确轮次并执行，不再接收 prompt。配置项目时在项目的新建对话入口创建；消息与 URL 确认后立即命名，不等回复完成。重复 `create` 的当前 request key/正文幂等，冲突拒绝；若该 key 已属于历史轮次则返回 `REQUEST_RUN_SUPERSEDED` 和原 run ID，读取原轮结果，不把当前新轮误当成重试对象；重复 `start` 不重发已开始轮次，不自动重试失败。只有 `prepared` 的失败轮次可在检查后显式 `retry`。不能因为初次 CLI 回执丢失而换 ID 重建，先 `status --id ID` 找回已入库的 run。

消费上一轮完整结果后，以完整新增说明创建后续轮次，再按返回的新 run 执行：

```bash
convorel conversation followup --id ID --prompt-stdin true --request-id UNIQUE_KEY <<'PROMPT'
本轮完整新增说明。
PROMPT
convorel conversation start --id ID --run NEW_RUN_ID
```

`followup` 也只入库，要求上一轮已完成，执行时再次核验网页的旧轮次、草稿和模型。入库后检查失败保留同一 `prepared` 轮次，不能创建替代轮次绕过检查。

旧 JSON 任务仍可读取；执行前需要 `convorel conversation migrate --id ID`。先确认该任务旧 CLI 操作和等待者均已结束，迁移会拒绝持有中的任务/等待锁。迁移保留原 JSON 字节并记录 hash，重复迁移不覆盖数据库；若旧版本后来改写原文件，新版本报 `LEGACY_TASK_CHANGED` 并停止，须保留双方记录核对，不能手改 hash 或删文件规避。配置和锁仍用私有文件；`conversations.db` 继续是独立内容归档，归档失败不改变 `tasks.db` 的投递状态。不要让旧版本继续操作已迁移任务。

使用新协议前核对实际 CLI 的 `--help` 是否包含 `conversation create`；仅更新技能不代表运行时已更新。旧运行时应先升级，或显式使用已验证的新源码入口，不回退到临时 prompt 文件。

## 等待与恢复

默认使用宿主支持的后台进程并保留进程/输出句柄，或分段前台等待：

```bash
convorel conversation wait --id ID --run RUN_ID --timeout-seconds 60
convorel conversation status --id ID --run RUN_ID
convorel conversation resume --id ID --run RUN_ID
convorel conversation result --id ID --run RUN_ID
```

`wait` 大约每 60 秒观察一次。超时仅停止本地等待，不停止远端生成；检查返回状态，仍运行时继续监视。未启用 `browser.serial` 时，不同 task 的浏览器操作各在自己的 tab 上并行，不再因单一全局锁互相串行——一个 agent 等待回复不会阻止另一个 agent 先建自己的任务、发自己的 prompt；定时检查结果时各自争抢自己那一份已记录的 tab，读完即释放。同一 task 仅允许一个活跃等待者，CLI 用进程身份锁强制执行并固定原 run；重启前核对原进程是否已结束。同一 tab 被同任务另一操作短时占用时，CLI 退避并有限等待，超时才返回 `LOCK_BUSY`，绝不清除活属主的锁。SIGINT/SIGTERM 会唤醒本地休眠并释放锁。崩溃留下的锁仅在确认原进程身份已失效后恢复，不能因超时抢占：用 `convorel recover-lock --watch-task ID` 恢复等待锁，或按 `--task ID`/`--registry true`/`--tabs true`/`--name NAME` 恢复对应锁。`status`/`list` 的 `tab` 与 `locked` 字段显示每个任务自有 tab 及是否正被占用。等待期间继续独立工作；没有独立工作时分段等待直到完成或明确受阻，并及时报告实际状态，不把后台进程已启动当作交付完成。

Herdr 可用且确需增强时按 [herdr.md](herdr.md) 路由；无论收到何种通知，都须用同一 `--id`、`--run` 取得当前完整 `result`，不能以通知、退出码或最后可见的网页答案代替。

`resume` 观察和核对，不发送消息；首轮 URL 延迟时会补做已请求但尚未开始的命名。只有状态为 `prepared` 且已解决发送前错误时，才可显式 `conversation retry --id ID --run RUN_ID`，继续原来已保存的消息。它重新核验模型、页面和草稿；不得重试 `submitting`/`delivery_unknown`，不得覆盖变更后的草稿强行推进。未知发送或等待超时不能用新 ID 再发。

新建页恢复了旧草稿时，先读取并备份完整原文。仅用户明确授权删除该页草稿副本后，才使用 `conversation clear-draft --id ID --run RUN_ID --expected-draft-file /private/approved-draft.txt`。该命令只处理任务自有、无历史消息的新建页和未发送首轮；逐字核对草稿，持久保存备份，删除后实际读回确认。草稿已变、附件存在、页面身份不同或投递未知都会停止，不扩大到其他标签页。成功后再显式 retry 同一 run；命令成功回执不能代替空草稿、模型、页面和投递状态核验。

`status` 的 `summary` 区分已确认投递、发送结果未知和未尝试发送，并返回当前阶段、最近观察时间、观察错误和下一步动作。`status` 退出 0 只表示本地状态读取成功；`start`/`retry` 退出 0 表示已确认发送或已完成；`resume`/`wait` 仅回复完成且要求的命名已核验时退出 0，未完成或需处理时退出 2，参数/基础设施等异常可退出 1。不要仅凭退出码取代精确轮次的 `result`。`wait` 仅对观察失败做最多三次连续尝试，不自动重发；登录、页面身份或草稿等需处理的问题不会被当作临时读取失败反复尝试。

命名遇到首次改名交互之前的临时页面错误、元数据加载超时或 HTTP 429/5xx 时，`wait`/`resume` 自动恢复，总计最多 3 次，后两次间隔至少 5 秒、30 秒；重试次数与时间持久保存。`summary.organization` 单独报告核验状态、次数、错误与下一步，不把回复完成视为命名完成。侧栏暂未挂载目标时先使用绑定同一会话 ID 的顶部菜单，仍不可用才有限重试。保存标题前持久化阶段；保存结果不明时只重新读取元数据核验，绝不自动再次保存。权限错误、归属变化、编辑中断或核验仍不匹配时停止自动操作。观察页关闭回执丢失时按原 target 与浏览器身份对账，保留草稿/附件和被接管页面。`summary.organization.phase/recovery` 与 `summary.observerCleanup` 保留恢复依据。

监听同一轮回复持续 2 分钟无变化时，先检查会话身份、草稿和附件，再主动刷新原标签页并等待历史加载。刷新只恢复观察，不发送消息；刷新后按原用户消息 ID 判定完成、仍生成或已被后续消息取代。正常长时间思考不算失败，连续 3 次刷新失败则提示检查；`summary.completionProbe` 暴露停滞时间、刷新次数及错误。草稿和附件存在时保留原页并报告延期。`wait` 的总超时仍然生效。

仅首轮仍为 `prepared`、从未执行发送、且已记录的自有新建页确定丢失时，原任务的 `retry` 可重新创建页面（最多 2 次），继续同一个 run 与提示词。持久化会话暂时空白、用户消息已确认或投递未知，都不能作为重建并重发的证据。

浏览器动作默认间隔 750 毫秒，导航/新建页面后等待 1500 毫秒；同一 state root 的 CLI 共享节奏。用 `convorel config set browser.actionIntervalMs 1000`、`convorel config set browser.navigationWaitMs 2000` 可调慢，取值均为 1–10000 毫秒。只读观察不人为延迟；间隔不能保证避免平台风控，遇登录、验证码或权限问题须停止并报告。未知投递继续按原 run 观察，不重发；`wait` 超时报告保留投递状态与 `runState`。

## 命名恢复、消费与清理

命名在首条消息发送后完成。若返回的 `organization` 未核验成功，检查原因后在原任务显式重试命名；该操作也支持回复生成期间执行，不重发消息：

```bash
convorel conversation organize --id ID --run RUN_ID --type DES --topic '具体主题'
```

读取完整回复后，本地核对意见、记录取舍与证据限制，再释放页面：

```bash
convorel conversation finish --id ID --run RUN_ID
```

TYPE 默认英文代码；仅用户明确要求中文时为 `create` 或 `organize` 增加 `--language zh`，仍传英文 `--type` 代码。命名日期使用实际会话 `createdAt` 转 `Asia/Shanghai`，不能使用 `updatedAt`、本机当前日期或猜测日期。由 Convorel 按该固定命名时区处理，不自行改写 task snapshot。Topic 不重复项目名称；主题无法确定时保留原标题。只改会话标题并保留原项目归属；有成对配置时核验项目 ID，归属不符即报告错误，不移动会话。核验标题及适用的项目结果为 `verified: true`，发现不规范立即用相同规则纠正。

命名必须返回 `verified: true`；失败返回独立的 `organization.error`，不撤销已确认的消息投递、不自动重发；`organize` 失败返回非零退出码，并保留已核验的 rename/project 步骤状态，表示整体未完成；记录错误，仍对已核验完成的轮次尝试 `finish`。`organizationPending` 保留失败信息，不要求保留可释放的自有标签页。finish 只释放经过核验的自有页面，保留会话历史、配置、借用页面和登录态；不授权关闭其他页或共享浏览器。

单独释放任务自有等待进程/lane，记录保留对象和原因。提示词、run 映射、意见和回复留在 Convorel 私有状态或已有任务交付记录，不进入技能源码，不新增平行注册表。

## 取回历史内容

回读既往结论先查本地内容库，不为取回旧内容重新发送。区分三层结果：

- **轮次完成**：`state=complete` 表示已确认该轮回复完成；不保证 Copy 成功，也不保证 SQLite 写入成功。
- **Markdown 捕获**：`result` 中的 `reply.markdown` 是 Copy 得到的正文；没有 Markdown 时仅有渲染副本，不能冒充原文。缺失原因看 `reply.markdownError` 或 capture 的 `gaps`。
- **归档写入**：完成路径在返回的 `task.archive` 中提供 `ArchiveNotice`，本次 `summary`/wait 同步透传 `archive`；CLI `result` 也会补写本地归档并返回 `archive`。`stored` 表示本次写入无缺口，`partial` 表示有缺口，`failed`/`unavailable` 表示写入失败或不可用；查看 `error`、`gaps`（含 `runId`/`code`）和可用的统计字段。notice 不写入任务 JSON；纯本地 status 不能凭缺省字段证明刚刚重试过归档。

归档失败或不完整不改变 `state=complete`、`nextAction=result` 或完成命令的成功退出码；不能只看退出码判断资料完整。成功归档的 prompt、Markdown 和渲染副本在私有内容库（`STATE_DIR/conversations.db`）按不可变版本保留：

```bash
convorel conversation search --query '关键词' --limit 20
convorel conversation search --query '关键词' --task ID --role assistant
convorel conversation history --id ID --run RUN_ID
convorel conversation content --version VERSION_UUID
convorel conversation archive --id ID
convorel conversation archive --all true
convorel conversation capture --id ID --run RUN_ID
convorel conversation export --directory /private/snapshot
convorel doctor --local true
```

少于三个字符的查询退化为字面量扫描；检索命中只反映每轮当前选中的正文，命中里的 `format` 说明它是 Copy 得到的 Markdown 还是页面渲染副本。历史轮次可能只留有渲染文本而没有 Markdown：此时 `history` 的 `reply` 为空、`capture_status` 为 `pending`（coverage 为 `markdown-incomplete`），引用时必须说明这一缺口，不能把 `reply_rendered` 当作原文。`content --version` 可按版本 ID 读回任意正文，含已被取代的版本，用来核对旧引用。`capture` 只在原提交消息与目标回复都仍挂载、回复仍呈最终态且渲染 hash 与保存值一致时补齐，点击后还会再读一次页面按正文 hash 复核归属，内容变了就记 `TARGET_CHANGED` 而不归档；复制控件自身约两秒的换标签会被有界等待，不影响已按正文确认的归属。`--from PATH` 让 `search`/`history`/`content` 读取导出的快照（目录或改名后的文件均可），不依赖偏好文件、工作区或 Chrome；导出即全部已归档内容的副本，按敏感数据管理，不放进 MCP 允许根。内容库缺失或写入失败只影响可检索性，不改变投递状态，也不构成重发依据；显式 `archive`/`capture` 用退出码 1 表示归档失败、2 表示存在缺口。

恢复时保留原 task、run、状态根和已保存正文：

- `archive.failed/unavailable`：先解决所报告的目录权限、空间或 SQLite 问题，再执行同一 run 的 `resume` 或 `conversation archive --id ID`。已完成且无待处理命名的轮次，poll/resume 完全在本地重试归档；仍待命名时会访问原页面恢复组织操作并核验安全完成条件，但不重新 Copy、不替换已存回复。读回 `history`/coverage 核验结果；不要删库或改任务 JSON 排障。
- 缺 Markdown：`archive` 只能重建本地已有内容，不能补出未捕获的正文；确需原文时用同一 run 的 `capture`，它会严格核验原消息与回复。页面缺失、目标变更或 Copy 失败时保留缺口和渲染副本，不将最新网页答案冒认为该轮回复，也不重新发送问题。
- 当前选择缺正文但已有版本 ID：先 `content --version VERSION_UUID` 读取不可变版本，保留证据；不要因为 `history.reply` 为空就认定原文已删除。`archive` 补写后再核对当前选择。
- 页面入口或模型核验失败：`doctor` 成功只证明本地 CDP/MCP，不能代替真实项目入口、模型或远端 MCP 访问核验。仅 `prepared` 且原目标仍可验证时按上文 retry；投递未知或原 target 丢失时不猜测替代页、不新建 ID 绕过保护。

## 接续已有会话

优先复用已有 Convorel task。只需要旧内容时用 `search`/`history` 读回，不绑定也不打开会话。只有历史记录明确提供同一需求的会话 URL 和精确 user message ID，且没有旧监视者仍处理该轮时，才可绑定：

```bash
convorel conversation attach --id ID --url VERIFIED_URL --user-message VERIFIED_MESSAGE_ID
```

attach 不发送；保存其新 run ID 后走正常流程。不能从“最近可见答案”推断 message ID，不能复制旧私有 JSON 充当 Convorel 状态。保留历史档案；已打开的页面视为借用，缺少身份或提交结果证据时报告缺口，不创建替代会话。

## 运行时与技能版本同步

`convorel upgrade` 只升级运行时并提示检查技能，不自动同步已安装副本。用**升级后的可执行文件**、原安装目标显式检查：

```bash
convorel skills check --agent codex --scope user
convorel skills update --agent codex --scope user
# 自定义安装根目录（其中包含 chatgpt-review）
convorel skills check --dir /absolute/custom-skills
convorel skills update --dir /absolute/custom-skills
```

项目范围沿用 `--scope project --cwd /absolute/project`；多 Agent 沿用原 `--agent codex,claude-code`。每个安装根分别检查，不扫描或改动其他项目。`check` 只读，返回基线与内置版本、文件差异、本地修改和冲突；`current` 表示已接收当前内置版本，可仍有已保留的本地定制。`check` 非 current 退出 2；`update` 有冲突/无基线/未安装时退出 2，操作异常退出 1。

新安装的 `.convorel-skill.json` 记录内置版本和文件 SHA-256，更新按旧基线、本地文件、新内置文件比较：仅本地改动保留，仅上游改动应用，双方改动同一文件且结果不同时整次拒绝更新。先读取 `conflicts`，保留定制副本，再人工协调；没有强制覆盖参数，不删 manifest 规避冲突。

旧安装没有基线且并非完整匹配当前内置资源时，返回 `unmanaged`，不会猜测差异来源。取得可信的**真实旧版本 bundled skill 目录**后，用 `--baseline-dir /private/old-release/skills/chatgpt-review` 加到 check/update 命令，审核结果再更新。该路径直接指技能目录；不可拿当前定制目录充当旧基线。若旧版本不可确定，保留原安装，在独立临时目录用 `skills install --dir PATH` 导出新版供人工比对；不能把它冒充旧版本。

更新在目标旁暂存完整目录，再切换目录；普通切换失败会回滚旧树。崩溃或回滚失败会留下 `.chatgpt-review.convorel-lock`，后续命令停止并给出路径。先读 `owner.json` 并确认原进程已结束，保留 `previous`/`staged` 与当前安装供核对：目标不存在且 previous 完整时可把 previous 恢复为原 canonical；目标仍存在时先核验其 manifest 与内容，不覆盖它。人工恢复并核验完毕后才清理该次锁目录，不因超时清锁，不删除唯一恢复副本。两次目录 rename 之间存在短暂路径空窗；更新期间避免其他 Agent 读取或编辑该技能，已加载旧指引的会话需要重新加载技能或开新会话。
