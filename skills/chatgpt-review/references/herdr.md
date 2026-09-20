# 可选 Herdr 等待增强

仅在 Herdr 实际可用、需要后台等待时读取。先加载当前环境已有的 `herdr` 技能；若没有该技能而 CLI 可用，读取 `herdr --skill`。遵循它的服务 lane 路由与生命周期，不复制路由脚本或框架、不写死用户目录、不自行新建状态库。

通过 `herdr pane current --current` 解析当前调用 pane，以实际返回结果判断可用性，不能依赖继承的 `HERDR_*` 变量或用户当前聚焦 pane。仅解析成功时使用 service lane；失败时使用宿主后台进程或分段 `conversation wait`，Herdr 不可用不阻断 Convorel。

为精确的 `CONVOREL_HOME`、task ID、run ID 启动一个等待者；启动前核对本任务已有监视进程，避免重复 watcher。保存返回的 lane/pane、进程/输出句柄及精确 cleanup 命令。创建 lane 或提交命令的结果不明时，先核对实际资源和进程；不能立即 fallback 再启动一个等待者。将已解析的 CLI 可执行参数、私有状态根显式传给该进程；shell 函数不会自动继承，含空格路径安全传参，不用 `eval`。

按当前 Herdr/宿主能力通知拥有该审查的 Agent，通知必须带 exact task/run 和输出位置。不要将 shell 命令注入一个正运行 Agent 的输入 pane。通知、pane idle、进程退出或等待超时均不等于审查答案；拥有者继续独立工作后读取 `conversation result --id ID --run RUN_ID` 核验完整结果。无独立工作时保持有界等待/读取输出，不能在通知机制未经核验时无限 idle，也不能将“已启动等待”作为最终交付。

状态询问不取消等待，未知发送结果不触发重发。Convorel 为同一 task 的整个 wait 生命周期持有 watcher 锁，`LOCK_BUSY` 不得触发另一个后端的等待进程。该 watcher 锁与浏览器锁均按 task 隔离：不同 task 的等待与发送各在自己的 tab 上并行，不会互相串行，也不会因其他 task 占用而收到 `LOCK_BUSY`；只有同一 task 被另一操作短时占用时，CLI 才退避有限等待并在超时后返回 `LOCK_BUSY`，绝不抢占活属主的锁。等待进程失败时先检查输出及精确 run 状态，确认旧等待者已结束后才恢复等待。正常消费结果并尝试组织/finish 后，用路由返回的 cleanup 命令释放本任务服务 lane；保留父 pane、调用 pane、共享浏览器和持久会话记录。清理失败只检查并重试该精确资源，不扩大关闭范围。
