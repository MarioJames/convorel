# Convorel 全链路健壮性审计（2026-09-23）

审计对象：`dd89d7fd5101dd4402846ec0a1d425b2f0cd8681`，源码版本 0.3.0。本机已安装 CLI 为 0.2.5，不能用旧版运行结果证明当前源码可用。初始审计仅检查与复现，不修改实现，不发送 ChatGPT 消息。后续修复验收见文末；下面问题描述保留审计时的事实。

严重程度：P1 表示可能损失数据、干扰用户工作、突破访问边界或使主要流程不可用；P2 表示特定条件下结果失真、恢复失败或诊断不足。下面“已复现”均注明边界：真实子进程、真实本地 MCP、浏览器替身或确定性交错，不把模拟结果称为真实远端验收。

共确认 16 项：8 项 P1、8 项 P2。高优先级集中在误删/误关、锁失效、私有访问边界和安装诊断不可用。

## 已确认问题

### R01 · P1 · doctor 与四入口 MCP 契约脱节，setup 随之失败

- 位置：`src/cli/doctor.ts:125`、`src/cli/init.ts:65`。
- 触发：对当前源码运行普通 `doctor`；`setup` 最后也会运行它。
- 实际：仍调用已移除的 `workspace_info`。用真实 stdio MCP、仅替换浏览器边界复现，输出 `localMcp.status=failed`、`MCP_INFO_FAILED`，返回 1。服务器健康也失败。
- 预期：调用当前 `capabilities`，验证公开工具契约与返回结构；诊断与安装消费者应覆盖真实 server。
- 证据：`doctor-repro.ts`。这是本轮四入口变更的明确集成遗漏。

### R02 · P2 · 项目身份依赖易变标题，准备状态检查缺少重试和可定位诊断

- 位置：`src/browser/chatgpt/project.ts:32`、`:41`，`src/conversation/submission.ts:262`，`src/storage/diagnostics.ts:129`。
- 触发：URL 的项目 ID 正确、唯一编辑器可编辑，但标题仍在加载或项目已改名。
- 实际：检查只读取一次，严格比较显示标题；`Loading project` 与改名都抛 `PROJECT_COMPOSER_UNVERIFIED`，记录为 `UNCLASSIFIED`。复现两种标题各一次读取即失败。
- 真实页面核查：新开任务自有项目页，首次取样尚无编辑器，约两秒后编辑器与标题均就绪，随后三次通过；自有页已关闭。**本次没有重现此前两次失败，也不能据此断言此前失败的唯一根因。**
- 预期：项目 URL ID 作为身份依据，编辑器与新会话状态作为就绪依据；对可恢复加载状态有界等待，分别记录失败条件，标题作为辅助证据。
- 证据：`project-contract.ts`、`project-repro.ts`、`project-evidence.jsonl`。真实页面只读，没有填草稿、选择模型或发送。

### R03 · P1 · 元数据观察页清理会关闭正在进行的新用户工作

- 位置：`src/conversation/organization.ts:116`、`:133`。
- 触发：任务自有观察页仍在原会话 URL，用户已在该页提交新一轮，草稿为空、无附件，但正在生成。
- 实际：清理只检查 URL、草稿和附件，不检查生成中或新增用户轮次。真实 `Conversation.poll` 配合浏览器替身复现，`generating=true` 仍执行关闭。
- 预期：页面最初属于任务，不代表之后仍可丢弃；关闭前核对当前活动与会话分支。
- 证据：`state/repro.ts` 的 `observer-closes-new-user-generation`。

### R04 · P1 · 观察页关闭失败后的重试可关闭最后一个标签页

- 位置：`src/conversation/organization.ts:90`、`:118`、`:133`，`src/conversation/release.ts:59`。
- 触发：仅有主页面和观察页；第一次观察页关闭报错，主页面随后成功关闭；下次轮询再次清理观察页。
- 实际：观察页清理不走跨任务关闭锁和最后一页保活；主页面已标记关闭，角色转移也不再生效。替身复现标签页数量 `2 → 1 → 0`。
- 预期：所有关闭路径遵守统一的最后一页保护和串行约束，含失败后的补偿路径。
- 证据：`state/repro.ts` 的 `observer-closes-last-tab-after-failed-cleanup`。未在用户 Chrome 上执行危险关闭实验。

### R05 · P1 · recover-lock 的检查与删除间存在竞争窗口

- 位置：`src/storage/state.ts:247`。
- 触发：恢复者 A 最后读取旧锁后，恢复者 B 移除旧锁，新持有者取得同名锁；A 随后删除路径。
- 实际：第二次读取 token 仍不能让随后 `unlink` 成为原子操作。确定性交错复现后，两个写入者可同时进入临界区，原持有者退出时报锁文件不存在。
- 预期：恢复与获取共享可证明的互斥协议，不能用“再读一次”替代原子所有权校验。
- 证据：`state/repro.ts` 的 `recover-lock-deletes-new-live-owner`。这是通过覆写读取边界注入合法调度的确定性复现，未声称自然竞争压力测试已经命中。

### R06 · P2 · 含重复 run ID 的任务源可串写另一任务的归档选择

- 位置：`src/archive/projection.ts:336`。
- 触发：两个不同 task 的源记录含相同 run ID，例如复制、修复或损坏的任务源。普通创建使用 UUID，本次没有证明正常创建会生成重复 ID。
- 实际：`on conflict(run_id)` 更新内容版本选择，却不校验所属 task。真实 SQLite 复现两个导入均为 `stored`，alpha 历史返回 beta 回复，beta 无历史且 coverage 为 incomplete。
- 预期：导入遇到跨任务身份冲突应拒绝并回滚，不能污染已归档任务。
- 证据：`state/repro.ts` 的 `cross-task-run-collision`。夹具中的回复均为合成文本。

### R07 · P2 · 回复 A → B → A 后，版本选择与取代关系不一致

- 位置：`src/archive/projection.ts:143`。
- 触发：重捕获回复先变化，再恢复到之前相同内容。
- 实际：命中已知内容即提前返回；选中的 A 仍标记 superseded，未选中的 B 反而未标记；再捕获 C 时记录其取代 B。真实 SQLite 已复现。
- 预期：明确区分内容去重与版本事件；当前选择和版本历史语义应一致，不能仅复用内容 ID 而跳过状态转换。
- 证据：`state/repro.ts` 的 `recapture-reversion-inconsistent-version-history`。

### R08 · P1 · 卸载会递归删除自定义 prefix 中非安装器所有的文件

- 位置：`install.sh:121`、`:156`。
- 触发：安装到已有非空 `--prefix`，或对未经验证的目录执行卸载。
- 实际：安装保留原有文件，卸载直接删除整个 prefix。真实安装脚本配合离线假发行包和哨兵文件复现：安装与卸载均退出 0，非安装器文件由存在变为不存在。
- 预期：按所有权清单删除受管发行文件，未知内容保留；不能将可指定的 prefix 等同于可整树丢弃。
- 证据：`runtime/repro-uninstall.ts`、`runtime/main-uninstall.json`。主审已独立复跑；只有本次创建的临时哨兵被删除。

### R09 · P2 · 普通命令的超时不保证调用结束

- 位置：`src/process.ts:28`、`:30`，`src/command.ts:8`。
- 触发：子进程创建继承 stdout/stderr 的后代，直接子进程被终止后，后代继续持有管道。
- 实际：200 ms 超时仅杀直接子进程；约 1.1 秒后 Promise 仍 pending，终止夹具后代后才返回。等待 EOF 无独立上限，会拖住调用方与持有的锁。
- 预期：有明确的受管进程树生命周期；超时后既有界回收，也结束输出读取并报告超时原因。
- 证据：`runtime/repro-process.ts`、`runtime/main-process.json`，真实子进程，主审已复跑。此项针对通用命令执行器，不等同于 MCP Bubblewrap 沙箱超时失败。

### R10 · P2 · 隧道客户端自行退出后，遗留后代被状态记录遗忘

- 位置：`src/service/tunnel.ts:162`、`:173`，`src/service/service.ts:273`。
- 触发：客户端创建同组后代后自行异常退出，未走主动停止信号分支。
- 实际：原 CLI 加假客户端复现退出码 23；后代仍活，`status` 却返回 `running=false/client=null`，`stop` 返回 `stopped=false`，无法补救。退出记录已清掉客户端身份。
- 预期：所有退出分支执行自有资源回收，或保留准确身份并显式报告未清理。不能仅凭可能复用的旧 PGID 盲杀。
- 证据：`runtime/repro-tunnel.ts`、`runtime/tunnel-2JELuR/result.json`。外部客户端为夹具，未启动真实公网隧道；后代已经按身份核验后清理。

### R11 · P2 · 不同配置键并发写入会丢失已成功返回的更新

- 位置：`src/config/preferences.ts:181`、`:184`。
- 触发：多个进程对同一配置文件执行读、修改、整份发布。
- 实际：8 个独立进程写 8 个不同合法键，三轮全部成功，原始复现分别只保存 2、2、1 个键。原子文件替换保证文件完整，不保证读改写事务正确。
- 预期：配置目录的跨进程互斥覆盖整个读改写过程，或冲突明确报错，不能静默撤销其它成功更新。
- 证据：`runtime/repro-preferences.ts`、`runtime/preferences-ae3ZrX/result.json`、`runtime/main-preferences.json`。主审已独立复跑；配置值均为合成夹具。

### R12 · P1 · 私有目录保护只检查一个包含方向

- 位置：`src/workspace/access.ts:124`，`src/mcp/server.ts:23`。
- 触发：将私有状态目录的较深子目录误配置为 MCP 允许根。
- 实际：只拒绝“私有目录在共享根里”，未拒绝“共享根在私有目录里”。真实 MCP SDK 配合临时状态树复现，允许根为 `state/executions/reports` 时 capabilities 成功，artifact 返回其中的合成私有记录。
- 预期：私有目录与共享根不能在任一方向重叠，含 canonical path；启动即拒绝。没有声称未经配置的远端调用者能自行扩大 roots。
- 证据：`mcp/repro.ts private-root`、`mcp/main-private-root.log`。主审已复跑；较浅的 `state/executions` 已被另一检查拒绝，不能据此推断所有子目录都受保护。

### R13 · P1 · Git 对象内部链接没有受到存储根校验

- 位置：`src/workspace/git.ts:95`。
- 触发：Git 的顶层 gitDir/common/objects 均在允许根，但内部对象文件是指向根外的符号链接。
- 实际：校验只覆盖这三个目录及 alternates。临时仓库将一个合法对象移到根外并链接回来，公开 `exec` 的 `git_read_file` 仍读出对象内容。
- 预期：Git 实际读取的数据源也必须符合允许根及链接策略；不能仅校验父目录。这里证明的是根外 **Git 对象** 可读，未证明可以读取任意格式的根外文件。
- 证据：`mcp/repro.ts git-object-link`、`mcp/main-git-object-link.log`，主审已复跑；没有读取真实私有对象。

### R14 · P1 · 异常 ignore 内容与 Git 语义不一致，未拒绝读取

- 位置：`src/workspace/workspace.ts:150`、`:175`。
- 触发：`.gitignore` 含 NUL 字节等未校验内容。本次夹具为 `private.txt` 后跟 NUL 及后缀。
- 实际：Git 的 `check-ignore` 确认该文件被忽略，Convorel 使用的解析结果却放行；artifact 和 exec/read_file 均返回哨兵内容。
- 预期：策略文件异常或无法保证语义时应拒绝访问，不能静默减弱本项目承诺的 ignore 边界。
- 证据：`mcp/repro.ts nul-ignore`、`mcp/main-nul-ignore.log`，真实 Git 与 MCP，主审已复跑。

### R15 · P2 · 合并冲突会使默认 Git diff 读取失败

- 位置：`src/workspace/git-patch.ts:42`。
- 触发：工作树存在合并冲突，选中的文件输出 combined diff。
- 实际：解析器只接受 `diff --git`，真实 Git 冲突夹具中 `git status` 正常返回 `UU`，默认 `git diff` 却返回 `GIT_INVALID_PATCH`；显式选择其它普通文件仍可读取。
- 预期：至少返回明确的冲突状态与可用证据，而不是将合法 Git 输出报为无效补丁；如支持 combined diff，需独立解析其契约。
- 证据：`mcp/repro.ts conflict`、`mcp/main-conflict.log`，主审已复跑。

### R16 · P2 · memory 取消调用后仍可遗留后端的子进程

- 位置：`src/mcp/memory.ts:68`、`:79`。
- 触发：配置的 memory 可执行程序启动子进程，调用随后取消。
- 实际：隔离后端复现取消后约 16 ms 返回 `MEMORY_BACKEND_FAILED`；等待 200 ms 后直接后端已退出，子进程仍 sleeping，同时 `active` 已释放。重复调用可能积累后代。
- 预期：取消和超时回收本次调用所拥有的进程资源；常驻服务需有明确独立生命周期。此处与 R09 的“等待管道不返回”不同：调用返回了，但资源未回收。
- 证据：`mcp/memory-cancel.ts`、`mcp/memory-cancel-confirm.log`。复现使用合成后端，未证明当前真实 ov 程序一定产生该行为；遗留夹具进程已清理。

## 覆盖范围与实际验证

| 环节                           | 本次检查/验证                                                                | 结果与限制                                                                   |
| ------------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 安装、升级、卸载、技能分发     | 阅读安装布局、校验、切换回滚、技能冲突合并；离线假发行包执行原始安装与卸载   | R08；未实测公网下载中断、安装瞬间 SIGKILL、ARM64                             |
| 配置、CLI、诊断                | 路由及帮助契约检查，真实 stdio MCP，独立进程并发写配置                       | R01、R02、R11                                                                |
| 浏览器连接、项目页、模型、发送 | 阅读 CDP/target 绑定、模型选择、发送前检查、投递不确定性；真实项目页只读取样 | R02；没有发送消息，未完成远端审查端到端验收                                  |
| 等待、恢复、命名、捕获、清理   | 阅读状态机与失败分支；真实协调器配合浏览器替身、注入关闭失败                 | R03、R04；未在真实浏览器上复现破坏性关闭                                     |
| 状态锁、归档、检索、导出       | 确定性交错锁恢复；真实 SQLite 导入、历史及版本选择                           | R05–R07；未做磁盘满、断电及实际多进程锁恢复压力测试                          |
| 普通子进程、服务、隧道         | 真实后代持管道；原 CLI 加假 tunnel-client 执行异常退出/status/stop           | R09、R10；未启动公网隧道或验证官方客户端全部退出行为                         |
| MCP 四入口及 workspace/Git     | SDK 工具调用、真实 Git 临时仓库、路径与策略异常夹具                          | R12–R15；拒绝管道/展开/越界路径/任意脚本的正常负向校验通过                   |
| 受控构建与测试                 | 实际 Linux Bubblewrap：构建、非零退出、1 秒超时、超时后再次构建              | 成功返回，exit 7 正确保留，挂起命令被终止且下次可执行；`.env` 未进入构建输入 |
| memory、artifact、capabilities | 范围过滤、越界 URI、坏 JSON 后恢复、文本分页、四入口发现                     | R16；常规边界可用，memory 使用隔离假后端，不能证明真实服务持续健康           |
| 工程验证                       | 当前源码执行 `bun run check`                                                 | 类型检查通过；326 tests / 36 files / 2966 assertions，0 失败；耗时约 69 秒   |

现有浏览器集成测试主要在真实 Chrome 中加载本地 HTML 夹具。它能验证脚本与浏览器交互，但不能证明当前 ChatGPT 线上 DOM、账号状态或投递流程可用。此次真实项目页从加载态转为就绪，不能反向解释过去失败时的全部条件。

沙箱未配置进程树总内存 cgroup 配额，是已知资源隔离限制；本次没有通过耗尽宿主内存验证它，也不把未执行的压力实验算作已复现缺陷。网络、文件系统和权限隔离不能替代总资源上限。

输出限制另已验证：16,000 字节输出截到 8,192 字节并标记 `outputLimited=true`；1,100,000 字节输出触发 SIGKILL，随后再次构建成功。图片正常读取、非法分页参数、超大图片、链接/硬链接/越界文件拒绝也已验证。证据为 `mcp/boundaries.log`。

## 证据、复核与资源

- 私有证据根：`/tmp/convorel-robustness-zb1zdb85`。报告中的脚本及日志均相对此目录；这是本机保留的诊断材料，不是仓库随附的测试文件。脚本使用当前仓库绝对导入路径，每次运行建立新的临时夹具。
- 主审独立复跑了状态/归档五个案例、普通命令超时、卸载、配置并发，以及 MCP 四个边界案例；隧道案例复核原 CLI 调用、结果和精确进程清理记录。
- 一次性脚本中故意触发的异常不计作测试套件失败；各项预期来自数据保留、事务、资源生命周期或访问策略契约。初版夹具错误也未列为项目缺陷。
- 真实 Chrome 仅新建一个任务自有项目标签页并读取状态，已关闭该页；未关闭用户原有标签页、浏览器或 profile，未改会话、模型或草稿。没有启动 dev server，APP_URL 不适用；没有声称完成前端控制台/网络验收。
- 最终 `/proc` 核查没有本审计夹具进程，MCP transport 均已关闭，无遗留监听或沙箱临时目录；三个自有 Herdr 工作标签页已关闭，主会话标签页保留。清理证据为 `final-cleanup.json` 与 `mcp/audit-final-check.json`。
- 失败夹具、临时 SQLite、合成配置及运行日志保留，由本审计任务负责；释放条件为相关缺陷修复复验、证据不再用于排障。持久用户数据、公共配置和已安装 CLI 均未改动。

## 综合判断

问题分布在模块交界和失败补偿路径：公共契约变了但消费者未变，原子文件写入被当成事务，历史页面所有权被当成当前可关闭性，进程 leader 退出被当成整组退出，顶层路径校验被当成所有实际数据源校验。测试全部通过与上述缺陷同时成立，因此当前结果不能认定为全链路健壮性验收通过。

## 修复验收（同日）

用户授权全部修复后，基于 `a26ca44` 实现以下变更。全部 16 项均已有对应回归；下面结果来自集成后的主工作区，而非仅汇总分支测试。

| 问题        | 修复行为                                                                                                                   | 主要回归证据                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| R01         | doctor 调用 capabilities 并核对四入口及 roots 身份；安装验收核对公开契约                                                   | `tests/cli/doctor.test.ts`、真实 standalone 安装验收                         |
| R02         | 项目身份按 URL ID，标题仅诊断；等待唯一可编辑输入框，拒绝禁用/只读状态与历史消息，细分错误                                 | `tests/browser/project.test.ts`、submission、真实 ChatGPT 成功投递           |
| R03/R04     | 主页面与观察页共用关闭锁及最后一页保活；核对用户轮次与活动；在操作节奏等待结束后再次核验                                   | `tests/conversation/organization-cleanup.test.ts`、release、browser/pacing   |
| R05         | 获取、发布、释放与恢复共用 OS 支持的 SQLite mutex；原子发布完整 owner 记录                                                 | `tests/storage/lock-recovery.test.ts`、sync-lock：真实恢复进程交错与 SIGKILL |
| R06         | 跨任务 run ID 冲突拒绝并回滚整个归档事务                                                                                   | `tests/archive/projection.test.ts`                                           |
| R07         | 重选旧内容时恢复活跃状态、取代上一选择；保留内容创建时的历史边                                                             | 同上，Markdown 与 rendered-text 的 A→B→A→C                                   |
| R08         | 按有版本标记的所有权清单及指纹卸载；未知/修改文件保留，只删除空目录                                                        | `tests/distribution/install-ownership.test.ts`、安装/升级验收                |
| R09/R10/R16 | 普通命令、memory 与 tunnel 共用活跃 session anchor；父进程死亡、取消、超时及异常退出均处理后代与输出；清理失败保留隧道身份 | `tests/process.test.ts`、`tests/service/service.test.ts`                     |
| R11         | 配置互斥覆盖完整读改写，而非只原子替换文件                                                                                 | `tests/config/preferences.test.ts`：8 进程、8 键、3 轮                       |
| R12         | 私有目录与共享根双向 containment 检查，含 canonical path                                                                   | `tests/workspace/robustness.test.ts`：真实 MCP                               |
| R13         | 每次 Git 观察校验对象树的符号链接、硬链接及特殊文件；扫描有界，失败即拒绝                                                  | 同上：真实 Git 与 MCP                                                        |
| R14         | 当前及历史 ignore 策略严格校验 UTF-8、NUL、控制字符；异常返回 POLICY_UNREADABLE                                            | 同上：畸形策略拒绝、正常 BOM/CRLF                                            |
| R15         | 未合并文件提供明确冲突及 base/ours/theirs index stage 证据；普通文件仍返回 patch                                           | 同上：真实冲突、普通文件、解决冲突后路径                                     |

集成验证：

- `bun run check`：类型检查通过，**390 tests / 44 files / 3361 assertions，0 失败**。
- `bun run test:browser --chrome /home/mocha/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`：真实 Chromium 本地夹具通过，`pageErrors=[]`，标签页 `1 → 3 → 1`，自有浏览器与 adapter 已释放。这是 DOM/交互验证，不等同于线上全部异常路径。
- `bun run test:package`：真实 tarball 安装、技能分发与 SDK stdio 通过。
- `bun run test:install`：Linux x64 standalone 构建、安装、升级与失败保留、配置转发、doctor、服务启停、校验和拒绝及卸载数据保留通过。首次验收揭示残留的 12 工具断言，已改为精确核验四个公开名称后重新通过。
- `bash -n install.sh`、修改文件格式检查、`git diff --check` 通过。

边界与资源：没有改动公共配置、用户数据库或已安装 0.2.5 CLI，没有发布或重启共享隧道。旧安装缺少所有权清单时保留并拒绝自动覆盖；新锁协议不能与未参与协议的旧进程并发共享状态根。归档修复约束后续导入，不猜测修复既存污染数据。SQLite mutex 文件必须永久保留同一 inode，不能作为 stale lock 删除。

进程管理面向受管、合作的子进程；主动新建 session 的独立 daemon 不属于这一清理范围，Linux PID 身份检查也不是 pidfd 原子信号保证。Git 元数据检查和浏览器关闭前读回不能抵御持续并发的恶意文件替换或将外部用户操作变成事务；Bubblewrap 仍没有进程树总内存 cgroup 配额。未实测 ARM64、公网下载中断及断电。

修复证据位于私有目录 `/tmp/convorel-fix-ydrf54qe`，包括失败/通过日志、导出的三个 worker bundle 与交接记录；由本修复任务保留用于复核，释放条件为不再需要排障或追溯。三个自有 Herdr 标签页、CoW 工作区及基线已回收；没有删除用户持久数据，原审计证据保留。

审查意见处理：通过 chatgpt-review 使用普通有头 Chrome/CDP，在同一 task `convorel-robustness-20260923` 完成机制审查，首轮 run `5ad99d90-871d-4a13-ad14-5d3c1719d78b` 已捕获 Markdown，归档 `stored` 无 gap。采纳原子 owner 发布、pacing 后最终核验、doctor 语义契约、textarea 禁用/只读判定意见，均补回归。审查者在并行集成中读到的旧 State/process/installer 版本不作为最终实现证据；结果核对已提交完整集成版本说明。新增全量选择事件表、恶意文件系统隔离和 pidfd 原子信号不在这次最小修复内，相关边界已明确；不以审查认可替代本地测试。项目 composer 的默认 5 秒为轮询预算，单次 browser 命令另受 25 秒 transport 超时限制，不保证硬 5 秒返回。

最终结果审查 run `f3ae62fe-d417-4de3-a549-a182829604f7` 返回“符合目标”，定点复核最终实现后无新增阻断项或实质偏移；Markdown 已捕获，归档 `stored`、无 gap。审查仅只读复核，不代替本地验证。

真实审查页面已通过修复后的 finish 释放：`closed=true`、`organizationPending=false`、`replyChanged=false`。共享 Chrome/CDP 9876、用户原有标签页、登录 profile 和会话记录保留；无 dev server，APP_URL 不适用。
