# 验证记录

## 当前验证：SQLite 内容归档与 Copy 捕获 Markdown

环境：Linux x64（WSL2 6.6.87.2）、Bun 1.4.2、Node 24.21.0、`bun:sqlite` SQLite 3.53.2（含 `ENABLE_FTS5`）、已登录的有头 Google Chrome + loopback CDP、agent-browser 0.34.0。

`bun run check` 通过 TypeScript 与 222 个测试（202 项既有全部保留 + `tests/archive.test.ts` 20 项新增），`bun run format:check` 通过。离线回归覆盖（20 项）：publish 幂等且生命周期改动 不产生内容漂移；重新生成回复追加不可变版本、旧版本仍可完整读回；rendered 副本不被选为回复正文；同一 rendered 轮次重新捕获到不同 Markdown 时仍会归档；正文未变时 run 元数据仍刷新；重复导入不写新内容但照实报告缺口；中文 trigram 命中、两字符退化为字面量扫描、恶意查询按字面量处理、非法 role/limit/版本 ID 拒绝；search 只覆盖每轮选定正文且不含被取代版本；coverage 四种状态；export 独立可读、发布文件 0600、暂存目录自清、checksum 等于原始字节 SHA-256、拒绝覆盖、拒绝只读库、拒绝 foreign 库（读写与只读两条路径）、拒绝符号链接；`--from` 读取改名后的快照文件；损坏任务文档被逐条报告而 `State.tasks()` 仍严格失败；archive/search/history/content/doctor 在无配置、无浏览器时可用以及 `--all false` 不扩大导入范围；Copy 页面脚本可被解析且拒绝越界消息 ID；`Conversation.capture` 的成功、仅记缺口、点击前页面被改写、点击后正文被替换、点击后仅控件换标签（等待后仍归档）、标签迟迟不恢复（按正文保留归属）、提交消息已不在页面等多种行为。

### 开发完成后的结果校验

以结果校验视角把交付交给 ChatGPT 复核（同一会话续谈，read-only MCP 读工作树，基线 `aa5344b`），裁定「存在偏移」：P1 架构、完成边界位置、中文检索、FULL/VACUUM 取舍和离线分派方向成立，但下列实现细节被确认偏移。全部按最小修正处理并补测试：

1. 缺 Markdown 时把 `rendered-text` 选成回复正文 → 选择器只认 Markdown，缺口显式为 `reply: null` + `pending`。
2. Copy 结果归属不足（仅比较渲染长度、多候选取最长、点击后不再复核、user 锚点缺失时 `-1 > index` 仍放行）→ 页面侧改为内容指纹比较、多份不同正文报 `COPY_AMBIGUOUS`、整个捕获共享一个截止时间；宿主侧点击后再读一次页面复核，提交消息必须仍挂载且早于目标回复。
   这一项的第一版修正被真实页面驳回：把「点击后再读」实现为再次要求 `final` 与整轮文本逐字节相等，而复制控件点下去会把自己换成另一个动作标签约两秒，使该轮在 `PAGE_SCRIPT` 里读成非最终态、正文却完全不变（实测 `final` 在点击后 0/500ms 为 false、1500ms 起恢复，渲染文本始终 8921 字符、hash 与保存值一致）。结果是每一次真实捕获都被误判为 `TARGET_CHANGED`。最终分层为：点击前用完整就绪条件（含 `final` 与逐字节 hash），点击后的归属只按正文 hash 判定，`final` 只做最多约 2.25 秒的有界等待，以便后续命令不接手半途页面；同时成功捕获会清除上一轮留下的 `markdownError`，避免旧错误被当成本轮缺口重复上报。
3. `content_fingerprint` 快路径连 Markdown 与 run 元数据一起跳过 → 去掉逐轮提前返回，靠 `addVersion` 按 hash 去重。
4. 回执契约不闭合（unchanged 报空 gaps 让 partial 变 stored、`capture` 恒退出 0、doctor 忽略 integrity、search 把 stats 命名为 coverage、旧版本正文无法读回、检索含被取代的 user 版本）→ 逐项修正，新增 `content --version`。
5. `fileHash` 先 latin1 解码再按 UTF-8 哈希，且 `scanTasks` 两次读文件可能配对不同内容 → 单次读取、按原始字节哈希。
6. `--from` 实际读的是该目录下的固定文件名、`verify()` 只看 `dbKind` 键是否存在、只读入口不校验版本、提前分派绕过共享根断言、`--all false` 会导入全部任务 → 精确文件路径、比对值并在读写两侧校验版本、写入类命令补 `assertPrivate`（读取类仍不依赖目录存在）、`--all` 严格布尔化；导出改为在自建的 0700 暂存目录内完成 `VACUUM INTO` 再以 0600 发布。
7. `observation` 把导入时间与保存的 branch 记成一次页面观测 → 该表在首次发布前删除，避免记录比证据更完整的观测历史；本地既有归档按 `archive --all true` 从任务文档重建（Markdown 本就同时存在任务文档里，重建前后 `markdownVersions` 与 integrity 一致）。`derived` 作为二次派生的占位保留，尚无写入方。

未采纳：把 Markdown 从任务 JSON 中移走（保留是为了捕获成功而导入失败时可补发布，且文档仍是唯一真值）；为「零依赖」再拆一层通用模型；本轮引入向量化、worker 或全页采集。自动完成路径未把归档 notice 打进命令输出，回执以库内 gap 与 `doctor`/`archive` 报告为准，不改既有命令输出结构。

### 实测证据

- FTS5 默认 `unicode61` 对中文子串 `防枚举` 命中 0 条，改用 `trigram` 后同时命中 user 与 assistant 两侧；不足三个码点的查询走 `instr` 扫描，仍返回结果。
- 同一条真实回复：Copy 按钮取得的 Markdown 14030 字节，页面 innerText 11123 字节，前者保留代码围栏、表格与行内结构，因此存储来源改为 Copy，DOM→Markdown 序列化器删除。
- 一个 8 轮会话的页面只渲染 5 条消息，证明 DOM 不是完整内容来源，也证明历史回填只能覆盖当前可见部分。
- 从既有任务文档导入 27 tasks / 64 runs / 23 conversations，0 失败；本轮另有 3 条真实回复由完成边界自动 Copy 捕获入库，最后一条（结果校验回复）为 `capture_status: captured`、`reply_format: markdown`，其渲染副本 8921 字符与 Markdown 11557 字符同时归档。`doctor --local true` 报告 5 个任务 `current`、其余 `markdown-incomplete`（历史轮次只有渲染文本），因缺口退出 2，两项完整性自检 `ok`。
- 真实页面上对 `capture` 回填路径做了两次端到端复核：修正前一次把已捕获的轮次误报为 `TARGET_CHANGED`（即上面那条回归），修正后同一调用返回 `unchanged` 且没有缺口，任务文档里的陈旧 `markdownError` 被清除，归档 `status: stored`、退出码 0。
- 用与发布流水线相同的 `bun build --compile` 参数产出 standalone 二进制，对 `VACUUM INTO` 导出后**改名**的快照执行 `conversation search --from`、`history`、`content --version`：`防枚举` 走 trigram、`会话` 走 literal-scan、旧版本正文可完整读回，全程使用空 `--config-dir`/`--state-dir` 且不接触 Chrome。
- 导出回执的 `sha256` 与系统 `sha256sum` 逐字符一致，文件模式 0600，导出目录内不残留暂存文件。
- 归档失败与捕获失败只产生 notice/gap：真实数据上 `conversation archive --all true` 因历史缺口退出 2、`conversation archive --id 不存在` 退出 1，`result()` 与投递状态未受影响。

限制：多进程并发写同一归档只由 `BEGIN IMMEDIATE` + `busy_timeout` 语义与单进程测试覆盖，未做真实并发压测；Copy 页面脚本的长度指纹与歧义分支只在测试中构造，未在真实页面注入竞态；OpenAI 平台改版后复制按钮选择器的稳定性只验证了当前页面；worker 常驻监听、把任务台账迁入数据库（P2）、按轮次删除归档内容均未实现。验收产物（导出快照、改名副本与临时编译二进制）保留在私有状态目录 `validation-standalone-20260921/`，不属于 MCP 允许根；改造前的旧 schema 归档改名为 `conversations-schema-v1.db` 保留在同一目录；共享 Chrome、登录态与既有任务数据未改动。

下文保留历史版本的验证记录，其中旧环境配置方式与命令名称不代表当前接口；当前使用方式见 usage.md。

## 2026-09-20：配置文件作为唯一配置来源

已移除 Convorel 运行时环境变量覆盖、安装目录 dotenv 加载及 import-env 命令，配置键统一为 model、project.url、tunnel.id 等语义名称。私有目录改由命令前的 --config-dir/--state-dir 指定，并通过 selfExec 显式传给后台与 MCP 子进程。系统 PATH/HOME、CI 的 GITHUB_SHA 及第三方进程协议所需变量仍按各自用途使用；敏感文件过滤规则保留。

本次 TypeScript 与全部 202 个测试通过；删除的是已废弃配置入口的专属测试，配置验证、密钥遮蔽、会话快照及进程行为覆盖保留。test:package、test:upgrade 和 test:install 均通过，包括 standalone 的自定义配置/状态目录、后台生命周期、MCP 重入、升级失败保护及持久数据保留。技能结构验证、39 个文档 shell 示例语法检查均通过。验收使用临时目录和本地 release fixture，测试进程及目录按归属清理。

下文保留历史版本的验证记录，其中旧环境配置方式与命令名称不代表当前接口；当前使用方式见 usage.md。

## 2026-09-20：独立可执行文件、偏好文件与发布流水线

`bun run dist` 用 `bun build --compile` 生成 `convorel-0.1.0-linux-x64.tar.gz` 与 `linux-arm64`（x64 主机交叉编译）及 `sha256sums.txt`，每个包含 `bin/convorel`、bun.lock 固定的 `agent-browser` 0.34.0 原生二进制和许可证文件；编译时关闭 dotenv 自动加载并内置 `--no-env-file`。`bun run test:install` 在临时 HOME 下通过：构建→`install.sh --dist-dir` 离线安装→`--version`/`version` 报告 standalone→`config set` 的 `mcp.roots`/`model` 被重入的 MCP 子进程与 `init` 读回→`doctor` 对不可达 CDP 报告 failed 而非崩溃→安装的技能文件与源码逐字节一致→篡改 `sha256sums.txt` 被 `CHECKSUM_MISMATCH` 拒绝→重装与卸载保留状态、偏好和技能。`bun run check` 199 项测试与 `format:check` 通过。

发布流水线审查发现并修正：`release.yml` 原先在 `bun run dist` 之后再跑 `test:install`，后者会清空 `dist/` 只重建本平台，导致 Release 只会带 x64 包；已调整顺序，并把发布权限收敛到 publish job、失败重跑改为覆盖上传、含 `-` 的 tag 标记 prerelease、Release 正文附安装命令与校验和。技能的 `convorel_cli` 辅助函数原先总是用 `bun --no-env-file` 执行 `CONVOREL_BIN`，与安装脚本产出的二进制不兼容；现按 `.ts` 后缀区分脚本与可执行文件。`install.sh` 补上文档已声明的 `CONVOREL_VERSION`。GitHub Actions 端到端（tag 触发、attestation、Release 创建）尚未在真实仓库运行，需要首次打 tag 时核对。

## 2026-09-20：并发调度改造——per-tab 锁与 tab 竞态管理

修复并发调度缺陷：此前 `Conversation.exclusive()` 对每个浏览器操作都抢同一把全局 `operation` 锁，且 `locked()` 抢不到即抛 `LOCK_BUSY`（不等待、不退避），导致一个 agent 在发送或 `wait` 轮询时，另一个 agent 的 `start` 被直接挡回、其编排层只能停下来等对方，而不是先在自己那一份 tab 上建任务、发 prompt。改造为按 task（等价按 tab，因 binding 为 1 任务↔1 target）串行：`task-<id>` 锁下不同任务并行；`registry` 锁只做「跨任务冲突检查+原子写入」这一纯文件临界区，保护会话 URL、tab binding、request key 的全局唯一性；`tabs` 锁覆盖末位 tab 的 keepalive+close check-then-act，防并发关到零 tab。`locked()` 增加有界等待（超时才 `LOCK_BUSY`，绝不清除活属主锁），保持 exactly-once 与不自动重发。`CONVOREL_SERIAL=1` 逃生开关退回单一全局 `operation` 锁，供无法稳定并行的 Chrome/CDP 环境。`status`/`list` 投影每个任务自有 `tab`（target/epoch/owned/closed）与 advisory `locked`；`recover-lock` 支持 `--task`/`--watch-task`/`--registry`/`--tabs`/`--name`。

验证：`bun test` 为 199 pass / 0 fail，含新增并发回归——一个 task 持有自身 tab 不阻塞另一 task 发送（旧代码会 `LOCK_BUSY`）、同任务第二操作有界等待后 `LOCK_BUSY` 且不越过发送边界、`CONVOREL_SERIAL=1` 令不同任务重新串行；以及 `state.ts` 层的有界等待获取、超时失败关闭且不抢占活锁、`isLockedActive` 对 absent/live/stale 的判定。既有 189 项（单-watcher 互斥、跨 tab 选择/歧义、发送与恢复语义、每操作释放 session）全部保留。本次仅覆盖离线 `FakeBrowser` 并发；真实登录 Chrome 上的多 tab 并行验收待执行。`git` 树内并存的偏好/配置改造（`env.ts`/`user-config.ts`/`config-command.ts` 及其测试）非本任务范围；本任务改动的文件自身类型检查通过。

## 2026-09-20：操作返回时释放会话 daemon

`bun run check` 通过 TypeScript 和 189 个测试。新增回归覆盖 conversation 操作成功与失败两条路径都释放会话，以及 `wait` 在每轮观察后释放。

`bun run test:browser --chrome /usr/bin/google-chrome` 连续通过 5 次，并在真实 Chrome 上按 `/proc` 环境标记核验本 namespace 的 daemon：操作期间存在、`release()` 后为 0；释放后用户标签页数量不变，下一条命令重新绑定同一 target 并读回原页面。另以 25 轮 `close` 后立即重新读取的连接竞争压力验证，无失败；单次 `release()` 约 130ms。会话级 `close` 只停止该 session 的 daemon，不关闭标签页，也不结束通过 `--cdp` 附加的浏览器。

真实已登录 Chrome（loopback 9222）上跑 `bun --no-env-file src/cli.ts doctor`：连接成功、UI 识别、模型读取为 `6 Pro`，结束后 `convorel-e7506102a182` namespace 没有残留 daemon，页面标签页全部保留。

## 2026-09-20：运行期残留回收

安装侧另有一个由手工 `--namespace convorel-org-recovery` 启动、存活两天的 daemon，不由本项目代码创建：它启动时未带 `--idle-timeout`，而默认空闲退出对 `--cdp` 附加的用户浏览器豁免。经会话级 `close --all` 回收，返回 `closed: 1`，用户浏览器和标签页不受影响。

sidecar 按同一判据回收：只处理 `convorel-*` 与本任务自建的 namespace，且要求 `.pid` 无存活进程、`.target` 记录的 CDP targetId 已不在任何可达 `/json/list` 中；取不到 CDP 端点时直接终止，不把"无法判断"当成"已失效"。共删除 41 个 namespace 目录和当前安装内 100 个失效 session 文件，保留仍绑定活标签页的 4 个会话。回收后复跑 `doctor` 通过且不再留下 daemon。其他工具自建的 namespace 未触碰。

## 2026-09-20：安装 .env 不再成为单测输入

`src/env.ts` 在进程环境未设置时回落到安装目录的 `.env`，因此本机配置了真实 `CONVOREL_PROJECT_URL`/`CONVOREL_PROJECT_NAME` 时，`bun test` 会以 92 个 `PROJECT_COMPOSER_UNVERIFIED` 类失败结束（CI 无该文件，掩盖了差异）。新增 `bunfig.toml` + `tests/preload.ts`，按文档规定的「进程环境（含空值）优先于安装 .env」把 6 个 `CONVOREL_*` 偏好固定为空，需要偏好的测试仍在自身内部显式设置。对照验证：移除 `bunfig.toml` 为 97 pass / 92 fail，恢复后 `bun test` 为 189 pass / 0 fail；`bun run check` 与 `prettier --check .` 通过。子进程路线不受该 preload 影响，`init.test.ts`、`tunnel-env.test.ts` 继续显式传入子进程偏好。

## 2026-09-18：项目内创建与首条消息后命名

`bun run check` 通过 TypeScript 和 187 个测试。回归覆盖项目专属输入框与 URL 校验、普通入口拒绝、首条消息发送后命名、URL 延迟、命名失败不重发、生成中通过独立观察页核验元数据，以及观察页被用户接管时保留页面。`test:browser` 在隔离的自带 Chromium 中通过，测试浏览器及 CDP 端口已释放；格式检查通过。

真实已登录 Chrome 的项目首页确认了项目专属 `New chat in <project>` 输入框。首个验收页遭遇 Cloudflare 验证，由用户手动完成后继续；两条合成验收会话均直接创建在指定项目，远端元数据证实项目 ID。第二条在首轮 `waiting` 时完成标题保存与远端核验，临时元数据观察页已关闭；回复完成后再次核验 `changed: false`，标题没有被后续自动命名覆盖。该会话未记录页面异常或 HTTP 4xx/5xx。验收会话和私有状态保留，任务自有标签页已释放；共享浏览器及其他会话不属于清理范围。

browser-harness 的独立 APP_URL 为 `file:///tmp/convorel-creation-validation/project.html`。真实 DOM 验证项目入口、拒绝普通输入框、只发送一次且未点击侧栏普通 New chat，截图、控制台和网络采证通过，无 artifact_errors。浏览器已关闭，无 dev server 或隧道；证据保留在本任务私有验收目录。合成页面证明定位与交互契约，真实站点兼容性以此次登录浏览器验收为限。

## 2026-09-18：已恢复草稿的发送前恢复

`bun run check` 通过 TypeScript 和 112 个测试；`test:browser` 在隔离的自带 Chromium 中验证 textarea、ProseMirror 多段落、原生删除输入事件、过期授权及聚焦时改稿保护，并通过文本节点读取回归。浏览器 fixture 无页面错误，精确关闭测试标签页及 Chromium，原有标签页保持不变。`test:package` 和 `format:check` 均通过。

真实已登录的普通 Chrome 新建页复现了 `fill("")` 返回成功但正文未清空：仅 contenteditable 的 `value` 属性变空，输入正文未变。与 [agent-browser 0.34.0 的 fill 实现](https://github.com/vercel-labs/agent-browser/blob/v0.34.0/cli/src/native/interaction.rs#L107-L167) 一致。新 `clear-draft` 按用户授权的完整备份匹配、持久备份、删除并读回确认空。原 prepared run 之后经 retry 和模型核验成功发送，resume 确认会话 URL 和用户消息；没有创建替代 task/run，没有改写已保存 prompt。大 prompt 填入后曾出现命令超时，页面已保留完整原 prompt；同一 run 的 retry 复用该草稿并只提交一次。

工作区 snapshot 与正文审查路径不同的情况由 `status --workspace` 明确报告。`start --workspace` 可显式指定新任务绑定，`rebind-workspace` 仅修正尚未发送首轮的元数据，不改变 prompt、全局配置或 MCP 允许根。已发送实例保留历史 snapshot，不用改 JSON 或重复请求规避。

以上验证证明本次页面结构上的恢复和发送边界；不保证未来 ChatGPT DOM 不变，也不将模型回复视为已读取全部代码的证据。共享 Chrome、登录态及持久任务记录保留，其他任务不变。

## 2026-09-18 — live web batch acceptance of twelve tools

One existing ChatGPT web conversation, using the configured 6 Pro model, invoked all twelve Convorel tools against a task-owned synthetic repository. The completed report records 33 MCP calls: 29 normal results and four expected errors. The remote interface reported evidence-v1; no tool was missing. Tree, glob discovery, text, literal search, Git status, log, commit details and version comparison were paginated to their terminal cursors. Both staged and unstaged patches were returned, and an already-deleted file was read from its historical commit. Native image inspection correctly identified the fixture's red left half and blue right half.

Independent local evidence matched the web reply's two commit SHAs, random file contents, whole-file/image hashes, staged/unstaged patch hashes, historical patch hash, historical blob ID and blob hash. Sensitive and ignored synthetic files returned ACCESS_DENIED, a missing file returned FILE_NOT_FOUND, and an unknown revision returned GIT_FAILED. The persisted final reply's SHA-256 was verified. This establishes real web invocation, beyond local SDK discovery or service readiness.

The fixture was small: this web run did not exercise large patch/message fragments, scan budgets, shallow clones or merge histories. It also exposed an identity distinction: read_file/read_image report the permitted root's workspaceId, while project-scoped tools report the project's workspaceId. Returned paths stayed inside the requested repository; callers must not assume those IDs are interchangeable. This acceptance records that semantic limitation without changing the interface.

The completed conversation's title and existing project were verified, and its owned page was closed. Synthetic fixture data and local verification processes were released after evidence capture; private request/result/oracle records, the shared signed-in Chrome and the existing Convorel tunnel remain. No user repository contents or browser drafts were changed. The web URL is https://chatgpt.com/g/g-p-6aa94760a174819191d12fd6fef4aee6-lobe-agent/c/6aabedca-ae40-83ea-b381-9871bd417973.

## 2026-09-18 — complete read-only evidence interface

The MCP interface now exposes twelve tools for project identity/capabilities, directory orientation, glob file discovery, scoped literal search, current text and image evidence, working-tree changes, commit history, commit details, version comparison and historical blobs. Structured directory entries and rendered text share tree. Strict output schemas are exercised by the real SDK client; images have native MCP content plus schema-validated metadata. Text/structured JSON is bounded to 64 KiB, image bytes to 1 MiB. Scan/depth limits, skipped files, clipped excerpts and line/file/patch/message continuations remain explicit.

`bun run check` passed TypeScript and 105 tests with 1,293 assertions. Real repository fixtures cover clean worktrees with recent commits, root/merge/shallow history, divergent direct/merge-base comparisons, historical deleted files, current/historical ignore policies, sensitive renames, invalid revisions, special filenames, binary/oversized files, schema validation, full reconstruction of long patches and commit messages, and refusal to run external diff/textconv. File-to-directory transitions revealed that literal Git pathspecs can expand descendants; both historical and live patches now select the exact permitted change using NUL-delimited raw records paired with standard-prefix patch blocks. A regression proves that hidden descendant contents are not returned.

Glob/search fixtures verify scoped discovery, matching-line pagination, context and file hashes, and explicit skipped/depth/clipping results. Image fixtures verify original bytes and hashes, native SDK image content, size bounds and inherited path/symlink policy. A read-only SDK acceptance against an existing permitted repository retrieved its known latest commit and a five-file patch summary while the working tree was clean; no source or Git state was changed there.

`bun run test:package` passed actual tarball installation, independent CLI invocation, isolated Codex/Claude skill installation and discovery of all twelve packaged tool schemas. Canonical skill validation, `bun run format:check` and `git diff --check` passed. Skills now choose evidence by question, pin historical revisions, distinguish absent results from incomplete scans, and request verification artifacts only when useful. No dependency index, remote execution, report registry or private-task-state sharing was added. These checks do not certify autonomous Agent decision quality or a client's cached tool definitions.

The live result review confirmed the bounded product scope and independently read source through the existing connector, explicitly observing concurrent edits and the older seven-tool service. Its findings were checked locally: a synthetic signed commit proved that repository log.showSignature/gpg.program settings could launch a verifier through log, so enumeration now uses rev-list; the marker regression passes without invoking the verifier. An oversized JSON-escaped first search result reproduced a non-advancing cursor; it now fails with SEARCH_ENTRY_TOO_LARGE. A 10,003-commit fixture proves continuation past the former offset ceiling. The already-fixed exact-patch boundary was also verified locally. No additional review loop or new platform layer was needed. Current ignore-policy changes can still invalidate cross-page completeness even at fixed commit SHAs; the caller must restart or disclose that evidence limit.

The existing Convorel user service was restarted against the updated source; native tunnel readiness returned ready and its MCP probe returned ok. A fresh SDK client using the same root configuration discovered all twelve schemas and workspace_info reported evidence-v1. This proves local service readiness and the source/tool contract, not refresh of an existing ChatGPT/Codex tool cache. The completed live review reply was persisted and its hash checked; title/project organization verified and its owned page was closed, with absence checked afterward. An earlier new-conversation attempt stopped before sending at DRAFT_CHANGED; that page and the shared Chrome remain intact with private ownership/release notes. No draft was overwritten or resent. The Git subtask pane, SDK/test processes and isolated fixture data were released; persistent review records and the requested running tunnel remain.

## 2026-09-18 — conversation recovery and result review

The send adapter now locates the unique submit control structurally inside the composer form, without relying on localized button text. Behavioral regressions reproduce and cover the previous rollback from a confirmed submitted message to `prepared`, observation failures before/after submission, bounded observation-only retries and CLI completion exit semantics. A read failure cannot authorize another Send. Local status exposes saved evidence and is not a live-health claim.

The disposable real-browser fixture passed structural submission with a Chinese label, exclusion of the same composer button after switching to a Stop action, overlay obstruction, exact target ownership, composer extraction and cleanup. Its profile/browser/controller were released, and the CDP port was verified unreachable. The fixture uses a synthetic `data:text/html` page, not ChatGPT; it does not prove live-site end-to-end compatibility.

A separate read-only inspection of the signed-in, headed Chrome page at `https://chatgpt.com/` confirmed `id="composer-submit-button"`, `data-testid="send-button"`, `type="submit"` and the surrounding composer form. That new diagnostic tab restored a historical unsent diagnostic draft; it was neither edited nor sent. The page was retained with owner/purpose/release conditions in private evidence rather than discarding the draft. No JavaScript page errors were captured; the request collector had no recorded network requests, so no general network-health claim is made. No dev server, tunnel, database or shared browser process was created or stopped for this inspection.

The bundled skill now has a bounded post-development result-review mode: compare goals and accepted architecture constraints with actual outcomes; inspect implementation only when needed. Canonical skill validation passed. This establishes valid packaging/instructions, not autonomous Agent decision quality.

`bun run check` passed TypeScript and 82 behavior tests, including real SDK stdio validation of all seven MCP output schemas, both workspace-info forms, Git results and tree filtering/depth/pagination/byte and scan limits. `bun run test:package` passed tarball installation, all skill references (including result review), isolated Codex/Claude installation and packaged MCP discovery/reads. `bun run format:check` passed.

The live continuation initially rejected the previous completed turn while its message IDs had rendered before the full reply body. A subsequent read proved the saved reply ID, SHA-256 and branch still matched. The bounded readiness wait on a newly reopened saved conversation now also waits for the saved reply body/hash and final marker; the existing exact-match guard still applies at its deadline. A regression covers IDs appearing first, partial body, delayed final controls and then successful continuation. The same pending follow-up request was then submitted once and its user-message identity confirmed; the failed preflight had not created or sent a new run.

The live result review completed on the exact new run. A separate CLI process retrieved the persisted 4,493-byte reply and its SHA-256 was verified. ChatGPT judged the implementation aligned with the requested scope and found no architecture-level rework blocker; it read the architecture document, result-review reference and MCP entry point, and explicitly relied on the supplied local test summary rather than claiming to run those tests. The approved boundary remains a conversation runtime plus a review skill and read-only code tools.

The currently connected MCP endpoint was independently observed still exposing the previous six-tool/flat-workspace-info interface. This change proves the new seven-tool source and packaged stdio behavior, not deployment of the live connector or disappearance of its cached output-schema warning. No shared tunnel was restarted and no connector permissions were changed. Diagnostic evidence and the review request/result remain in private Convorel state outside the shared roots.

Organization of the assistant-owned review conversation verified its title against the remote creation timestamp and its existing project identity. `finish` closed the exact completed review tab with no organization pending; a readback confirmed its absence. The MCP Agent pane, test processes and disposable data were released. The user's shared Chrome on loopback port 9222 and the separate historical-draft diagnostic page remain; no review watcher remains. APP_URL for the live adapter acceptance was `https://chatgpt.com/`.

## 2026-09-17 — bundled skill and lifecycle baseline

Environment: Linux, Bun 1.4.2, Node 24.21.0, installed Google Chrome and packaged agent-browser 0.34.0. No published npm package or hosted service is assumed.

## Local verification

- `bun run check`: TypeScript and 72 behavior tests passed. Coverage includes environment precedence and empty overrides, new-task snapshots versus existing-task preferences, future Latest Pro versions and slider ranges, model drift before Send, delayed controls, exact-message URL recovery, single-watcher ownership and cancellation, title-only organization, project identity checks before moving, partial organization progress, installation conflict preservation, and the existing MCP/state/workspace boundaries.
- `bun run test:package`: a real tarball was installed into paths containing spaces. The installed CLI ran from another working directory; bundled skill files and all references matched the artifact. The actual Skills CLI installed to Codex and Claude Code under an isolated HOME without prior init. Claude resolved to the canonical skill directory. Reinstallation rejected a personal edit without overwriting it. Packaged agent-browser and SDK stdio reads also passed.
- `bun run test:browser --chrome /usr/bin/google-chrome`: disposable headless Chrome passed target binding, no implicit extra tabs, pinned-target protection, composer extraction and Send-button obstruction checks. Tab count was 1 → 2 → 1; browser/controller and temporary profile were released, and its CDP port was verified unreachable.
- Canonical skill-creator validation, reference resolution, Prettier and `git diff --check` passed. These checks establish skill structure and installation, not autonomous Agent decision quality.

## Live ChatGPT evidence and limits

The boundary review used the user's signed-in account and configured project. The reviewer verified repository identity and read source through read-only MCP, distinguishing the baseline from concurrent edits. Its findings were checked locally: new-task-only preference resolution, optional Herdr hosting, task-level watcher exclusion, pre-send model recheck, pre-move project identity checks, partial organization evidence and nonzero organization failures were implemented. Historical-result API expansion and a new cancellation framework were kept outside this change.

The submitted review exposed a timing failure where a user message appeared before the persisted conversation URL. Recovery followed the original target and exact submitted message without resending. The full reply was persisted and consumed. Organization verified the remote creation timestamp, the built-in Shanghai date/title format and configured project; the completed owned review tab was closed with no pending organization. A reload initially returned metadata before the saved answer finished rendering; bounded readiness checking now preserves the exact answer/branch guard before continuing.

Default model selection was exercised on fresh, task-owned ChatGPT tabs. It verified the actual Latest selection, Power maximum and Pro semantics, then the closed model label. The observed version on this account was `6 Pro`; that version is not a product default. The diagnostic tabs were closed. A delayed model control observed on a fresh page was covered by a bounded readiness wait and a regression test.

A separate live no-project submission remained a draft with no uniquely observed submitted message. It is retained as `delivery_unknown`; it was not resent, overwritten, or treated as successful. The browser reported no JavaScript errors for that target, but this does not prove successful delivery or general network health. The exact task/run/target and diagnostic evidence are retained privately. No-project naming and preservation of an existing project are verified by behavior tests; a complete live no-project send/name/finish cycle is **not** claimed.

## Installation and cleanup

The bundled skill was installed locally for Codex and Claude Code and its complete contents and link target were verified. The previous personal skill was backed up outside all skill-discovery roots. The user-level Convorel executable resolves and runs from an unrelated working directory. The old skill source and install/catalog entries were removed from skill-foundry only after the replacement's installation checks passed. Private conversation history and credentials were preserved.

The coding-agent pane and review watcher lane were released. No app dev server, public tunnel, database, or shared browser process was created or removed. The signed-in shared browser and the single uncertain-delivery diagnostic draft remain for inspection. Private evidence records identify its owner, purpose and release conditions; no background watcher remains for that draft. APP_URL for the third-party adapter checks was `https://chatgpt.com/`; this is a CLI adapter change, not a local frontend release.

## Reproduce local checks

```bash
bun run check
bun run format:check
bun run test:package
bun run test:browser --chrome /path/to/installed/chrome
```

## 2026-09-18 — rejected-send recovery

Added offline fixtures reproducing optimistic user insertion followed by disappearance, then an explicit, run-bound recovery using operator-confirmed Cloudflare rejection metadata. Coverage checks unchanged task/run/prompt and previous result, durable old-user/attempt audit before one click, stale identity/evidence, missing or changed anchors, ownership/epoch/target drift, late marker/draft changes, legacy records, and transport failure without retry permission. CLI fixtures check required confirmation and reject waiting delivery before browser access.

`bun run check` passed TypeScript and all 151 tests; two additional focused regression tests passed afterward (legacy records/allowlisted audit and final composer recheck). No shared Chrome/CDP, task state, watcher, tunnel or service was accessed or modified. Fixtures use temporary state and release their resources. Live recovery and business-review completion remain with the parent operator. Automatic POST-response observation is outside this change; DOM-confirmed delivery still needs subsequent result verification.

The parent then found a completed-user rendering mismatch before any resend: code-comment indentation collapsed, and DOM text included a trailing `Show more` control. Recovery now validates the exact previous user ID and its unique run marker together with the existing reply ID/hash and full-branch check, while verifying the saved source hash. It does not compare rendered user text byte-for-byte, strip text strings, or change PAGE_SCRIPT/newline handling. TDD reproduced the rendering failure and missing marker-uniqueness guards; TypeScript and all 159 tests passed. The regression was refined with the parent's whitespace/Show more evidence and all six focused cases passed again. No live browser or task state was touched.

A further parent-side pre-send failure came from reselecting Latest despite the rejected run already having observed `6 Pro`. Recovery now passes that run's observed model to the first existing model verifier, falling back to the task/default policy only when absent. Maximum Pro power verification and the second verify-only call are retained; model.ts and PAGE_SCRIPT are unchanged. TDD reproduced the missing parameter preference; TypeScript and 95 conversation/model tests passed, covering saved-model preference, configured/default fallbacks and refusal of a failed final verification. The parent verified live power was already 4/4; this child used only fixtures.

## 2026-09-20 — 顶层进程管理、自定义 Skill 目录与升级

Linux x64、Bun 1.4.2。`bun run check` 通过 TypeScript 和 207 个测试；进程终止逻辑最终微调后，service/tunnel 的 5 个定向测试再次通过。`bun run format:check`、`git diff --check` 和 `bun run test:package` 均通过。

`bun run test:install` 使用隔离 HOME、配置、工作区和安装目录验证真实 standalone：`start/status/logs/restart/stop`、重复启动、`skills install --dir` 的完整资源与重复安装保护，以及安装、重装和卸载后的用户数据保留。升级验证已接入这一既有发布验收入口，也可用 `bun run test:upgrade` 单独执行；本地 HTTP release fixture 覆盖最新版检查、指定版本、同版本重装、旧版本保留、checksum 拒绝、路径及安装布局校验。安装器行为测试还验证激活失败时回滚两个链接和拒绝不安全归档；带空格、引号及反斜线的自定义路径通过独立升级验收。

进程行为测试覆盖并发启动的单实例约束、配置丢失后停止、身份不匹配时不发送信号、启动失败反馈、日志跟随与轮转，以及忽略 SIGTERM 的后代进程清理。测试使用替代 tunnel-client，没有连接真实云端；`status.running` 仅证明本地进程存活。没有操作共享 Chrome、真实安装或持久会话数据；测试进程、临时 release HTTP 服务及临时安装由验收脚本释放。此次为 CLI 变更，不涉及前端页面或浏览器验收。
