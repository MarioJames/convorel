# 使用 Convorel 1.0

## 运行时与私有状态

通过 PATH 使用独立安装的 `convorel`，先检查 `convorel version` 和 `convorel ask --help`。源码方式用 Go 1.27.4 构建 `go build -o /absolute/bin/convorel ./cmd/convorel`，再调用其绝对路径；不依赖技能目录旁存在源码，不用 eval 拼接命令。技能安装不等于运行时安装。

入口为 `convorel [--config-dir PATH] [--state-dir PATH] COMMAND`，全局目录参数放在命令前。默认偏好文件是 `~/.config/convorel/preferences.json`，状态是 `~/.local/share/convorel`。已有任务必须沿用相同目录、ID 和配置 snapshot，后台等待者也一样。任务、诊断和内容数据库原地沿用；升级前停止全部旧进程。私有状态必须在 MCP 共享根之外。

普通有头 Google Chrome 使用专用持久 profile，通过 loopback CDP 直连。不要使用验收工具的 Chromium/profile，也不要另建控制器。初始化及登录：

```bash
convorel setup --workspace /absolute/project
convorel service install
convorel login
```

登录由用户在窗口完成，不代填凭据。外部 Chrome 用 `setup --workspace PATH --cdp http://127.0.0.1:PORT` 绑定，由用户负责启动和登录。不要擅自换 profile 绕过身份问题。daemon 管理自身 Chrome，默认无进行中轮次满 10 分钟后停止，下一次调用重新启动；等待回复期间不会闲置停止。

配置只从偏好文件读取，不接受模型环境覆盖。`config set project.url URL` 和 `config set project.name NAME` 成对设置。真实审查默认 Latest Pro（effort 5），测试验收用 Instant（`--effort 1`）。`config set model MODEL` 仅按明确选择设置。续谈保留原任务模型/项目 snapshot，不通过另建任务规避冲突。

MCP 的 `mcp.roots` 与任务 workspace 是两个独立边界。浏览器可用不代表代码访问已授权。隧道由 daemon 托管；不擅自扩根或启动重复隧道。`doctor --local` 只检查本地文件，`doctor` 检查浏览器连接，均不能证明远端已取得 MCP 访问。

## 发送和续谈

先 `list`，再 `status --id ID`/`history --id ID`，匹配同一需求、工作区和已有结果。已有 active run 继续等待，已有适用审查直接复用。新请求遵循 [review-prompt.md](review-prompt.md)，只提供目标、用户确认的约束、验收要求及必要的 revision、文件引用和验证摘要。Convorel 自动追加 workspace/tool 指引并保存原文、guidance snapshot 和最终 prompt，不自动粘贴源码。使用 stdin 直接发送，不建立 prompt 交接文件。

```bash
convorel ask --id ID --request-id decision-v1 --workspace /absolute/project \
  --type DES --topic '具体主题' --prompt-stdin <<'PROMPT'
本轮目标、已确认的方向、约束、验收要求和必要证据引用。
PROMPT
convorel wait --id ID --run RUN_ID --timeout-seconds 60
```

task ID 为 1–80 个小写字母、数字、`-` 或 `_`，以字母或数字开头，Weaver 主任务 ID（如 `m_f5fzpkyehi`）可原样作前缀；不合规则时返回 `INVALID_TASK` 并给出规则，改正 ID 后重发，此时消息尚未发送。`ask` 原子入库并发送，返回 `run`。`--request-id` 默认 initial，所有 key 都只在本 task 内唯一，不同 task 可以复用 `decision-v1` 这类名称；显式稳定 key 便于追踪。相同 task/request/input 幂等返回原轮，历史 key 也返回原轮而非当前轮。同一 task 内同一 key 换了输入返回 `REQUEST_CONFLICT`。CLI 回执丢失时先检查原 task，不换 key/ID 重建。

消费上一轮完整结果后：

```bash
convorel followup --id ID --request-id decision-v2 --prompt-stdin <<'PROMPT'
本轮完整新增说明及新证据。
PROMPT
convorel wait --id ID --run NEW_RUN_ID --timeout-seconds 60
```

`followup` 直接准备并发送，不需要第二条发送命令。它要求上一轮 complete，并核验已保存会话、前一轮身份和模型。上一轮已完成、后台命名仍在进行时，`followup` 排队等命名结束再发送（最多约 90 秒）；仍未结束则返回 `RUN_IN_FLIGHT`，消息未发送，稍后原样重试同一命令。入库后的 preflight 失败保留同一轮，不创建替代轮次绕过检查。

输入框里已有未发送的草稿时不会卡住：Convorel 先把草稿存进任务记录，换成本轮 prompt 发送，用完输入框后再放回原处（续谈和未发出时放回同一标签页，首次发送后放回新会话输入框）。`status.draft.state` 为 `saved`、`restored`、`conflict`（原处已有更新的草稿，不覆盖）或 `failed`，未放回前 `status.draft.text` 保留原文，需要时转告用户。以前某轮留下的 Convorel prompt 直接丢弃，不恢复。带附件的草稿无法备份，该轮以 `composer: draft has attachments` 停下，请用户处理后再 `retry`。

## 等待与恢复

命令 stdout 是单个 JSON 文档。退出 0 表示请求的结果成功；ask/followup 的 0 是确认投递，wait/result 的 0 是回复完成。退出 2 表示 pending、拒绝、未知投递或等待超时；退出 1 表示输入/终态/传输错误。`status` 成功读取可退出 0，即使报告的轮次仍 pending。

`wait` 返回 `reply.markdown`；完成不等后台命名。保存 task/run/URL 映射，通知和退出本身不能替代完整回复。等待进程被杀不影响 daemon 继续观察；可重新 wait 同一 run。精确历史轮次用 `result --id ID --run RUN_ID` 回读。没有独立工作时保持有界等待，不能启动后台等待后直接 idle。

| phase | 处理 |
| --- | --- |
| prepared | 没有已派发 POST；检查 preflight 后可显式 `retry --id ID --run RUN_ID` |
| rejected | 已确认非 2xx 拒绝；检查 deliveryFacts.postStatus 后可显式 retry |
| delivered | 已确认对应 input_message；等待回复 |
| delivery_unknown | 只观察同一轮；绝不重发 |
| complete | 消费精确回复，检查 archive/naming，安全 finish |
| failed/blocked/superseded/lost | 保留证据，核对状态；不自行授权发送 |

HTTP 200 单独不能证明送达。重试沿用原 run 的冻结 prompt/marker/hash。归档失败、捕获缺口、命名失败或超时都不授权重发。`diagnostics --id ID --run RUN_ID --limit N` 读取私有事件，不能据此扩大授权。

## 新版界面与识别失败

直连 CDP 和嵌入页面脚本只操作唯一可见、可编辑控件，隐藏表单不作为候选。模型菜单验证五档 effort：1 Instant，5 Pro。会话、项目、用户消息和助手回复身份各自核验；Markdown 来自目标助手回答的 Copy，不能用用户/代码块 Copy 代替。

`doctor --ui` 在恰好一个现有 ChatGPT 页面上检查 composer、send、modelMenu、effortSlider 和 rename；它不发送消息、不创建会话。缺失/禁用控件、多个候选、模型不匹配及登录障碍按实际回执区分。先核对已安装运行时版本，再检查加载与登录，不把选择器失效统称页面不可用。技能不写临时 CDP 控制器、不切低档规避真实审查模型要求、不移动已有会话绕过项目核验。

## 命名和收尾

`ask --type TYPE --topic TOPIC` 请求命名；`--language zh` 仅在用户明确要求中文时使用。标题 `MMDD｜TYPE｜Topic` 的日期来自会话 createdAt 转 Asia/Shanghai。TYPE 默认 FEA/DES/FIX/OPT/REL/EXP/DOC/RES。命名不改变项目归属或正文；主题不明则保留原标题。命名在后台运行，用 `status.naming` 检查 pending/running/verified/failed/not_requested，与回复和 archive 分开报告。

消费完整回复后 `finish --id ID --run RUN_ID`，检查 cleanup 与 naming。仍观察或命名时会拒绝释放，稍后重试。finish 核验回复未变化、输入框里没有本轮恢复之外的草稿和精确会话身份，仅关闭自有已完成标签页；失败保留证据，不因清理失败重发。保留远端会话、共享浏览器和登录态，清理本任务自有等待者或 lane。

## 版本同步

`convorel upgrade` 更新运行时；`convorel skills install --target /absolute/skills/chatgpt-review` 显式更新受管理且未修改的技能。保留用户定制，目标拒绝覆盖时先比较差异，不复制覆盖。运行时和技能升级分别核对版本及帮助；新指引不能用于未升级的运行时。
