# T04 — 权威事务元数据与完整投影日志

日期：2026-10-10 至 2026-10-11（Asia/Shanghai）。起点 `aacf521`。状态：**2026-10-11 独立阶段审批 PASS，允许 T05**。

## 实现与边界

纯 TypeScript research-core 定义仓储及只读依赖上下文；SQLite 适配器显式放在 `server-core/src/research`，与 Plan 的 Bun startup 侧一致保持 **仅 Bun 可导入**。没有从 server-core 的 Node/Electron index/exports 导出 adapter；Bun startup 将在后续服务阶段显式注入。当前没有启动产品服务器或把内部方法注册为客户端 RPC。

SQLite v1 创建 users/authSessions、spaces/projects/members、资源 binding/entity/head、部署 root grants、资料/目录索引、snapshot blocks、运行租约/steps/intents、完整 projection journal、audit/outbox 与单服务 writer authority。资料登记/索引、HTTP 认证、真实运行编排由后续任务实现，表存在不算业务完成。

外键、WAL、immediate 短事务和参数绑定开启。每次事务核对当前服务 writer nonce、用户启停与当前成员角色；客户端 actor 仍必须由 T06/T07 的可信认证入口产生。管理员不因管理身份读取其他个人数据，项目审计仅负责人可读。资源 scope/会话 owner 保持绑定；策略可增加 taint，不能降级。revision head CAS 保证同预期版本仅一次提交；snapshot/evidence/report 内容修订不覆盖旧 recordId。

新证据/报告通过通用 put 保持未审阅；专用 human review 绑定当前 head/版本、当前操作者和时间，审阅独立存储，旧版本保留旧审阅。已校验 report 不依赖 pending evidence。通用 run put 只创建 queued；专用运行事务比较 workerId、generation、expiry、所有者和当前权限。终止移除 lease，取消代数增加，晚到写入拒绝；数据库 partial unique index 限一会话一条 active run。

需业务事件的 actor 变更（put/project/member/review/run）与成功 audit/outbox 同事务；seedUser 仅是可信 bootstrap，账户业务审计由 T06 接入。journal append 与 audit 同事务，当前不发业务 outbox。失败不留下成功记录，失败/拒绝另写必要安全审计，审计不存正文/密码摘要/密钥。projection journal 保存完整受权消息 JSON、顺序、operationId、generation、SHA256 和投影状态；重复相同操作幂等，不同 payload 冲突。兼容 user/assistant/tool/error/status/info/warning/plan/auth-request 角色，保留 attachments/annotations/toolInput/toolResult/turnId 等 JSON 字段。

**事务组合边界：** 当前独立 metadata / review / run / journal 方法各自原子；完整产物 + run 终止 + journal 组合提交仍是 T14 编排门槛。T05 实现投影确认/JSONL 对账，不把当前 journal 持久化当成 JSONL 已保存。

## 真实 Red 与修复结果

| 实际范围 | 结果 |
| --- | --- |
| 首个可执行 Map 骨架，仓储七项 | **0 pass / 7 fail / exit 1**；越权、无 binding、CAS、audit/outbox 与完整投影的行为失败 |
| 真正 Bun SQLite 实现后，同七项 | **7 pass / 0 fail / exit 0** |
| 加失败审计、taint 升级、null journal、通用 run 绕过 | **8 pass / 4 fail / exit 1**；outbox 真实 RAISE(ABORT) 故障注入已通过，四个新行为缺口真实失败 |
| 修复拒绝读审计、单调策略、消息形状与专用运行入口 | **12 pass / 0 fail / exit 0** |
| 独立评判补充所有权、审计职责、依赖结构、不可变审阅；新增用例 | **18 pass / 0 fail / exit 0** |
| 加合法 worker completed 与运行 outbox 失败回滚、四个磁盘场景 | 首轮 **21 pass / 2 fail / exit 1**：Windows cleanup EBUSY 与 child fixture neutral 配置误名；未改写为全绿 |
| child 配置改为实际 scripts/bunfig.bio-bootstrap.toml | 单独真实 kill/crash 接管 **1 pass / 3 filtered / 0 fail / exit 0** |
| 显式 statement finalize + strict close 的诊断轮 | **14 pass / 9 fail / exit 1**，发现 close 最后一条可选链 query 未被 tracker 捕获，database locked；未隐藏错误 |
| 最后释放查询同样进入 tracker | 磁盘重开定向 **1 pass / 0 fail / exit 0**；最终全套 **23 pass / 0 fail / 72 expects / exit 0**，591ms，完整日志 `.runtime/checks/T04-final-tests.log` |

所有 Bun 均由 `node scripts/bio-launch.mjs test test ...` 的 pinned 1.3.10、自有 namespace 执行。仓储 suite 19 项，磁盘 suite 4 项；只有合成消息/账号/hash。没有读取真实实验材料或使用模型。

## 磁盘与故障证据

- 初始空 SQLite 0→1 前在自有 namespace 写只增不覆盖的 serialized backup；未知 legacy table 或 newer schema 拒绝且原 legacy 数据仍在。
- clean close/reopen 后完整消息、tool/annotation 内容与账号持久化存在，backup 可见；清理前核对 resolved/real 路径在自有 namespace。
- 同文件与同目录 junction alias 的第二 writer 均拒绝，第一 writer 可继续读。已有路径 canonicalize 为 realpath；SQLite service_instance 原子 authority 避免 filename.lock 别名问题。
- 受控子 Bun 进程真正持有该数据库，输出 READY 后第二 writer 拒绝；仅 SIGKILL 此测试创建的子进程，等待退出后，SQLite immediate 事务验证旧 PID 不再存活再接管，原会话仍在。这个场景与 clean close/reopen 分开记录，不计为 graceful Windows SIGTERM 验收。
- 活 PID（含 PID 复用）或无法确认的 liveness 保守拒绝，不盲抢；跨机器共享 SQLite 数据集不是支持的部署方式。
- cached statements 显式 finalize，close(true) 检查实际释放；没有吞 cleanup/关闭失败、没有删断言。Bun neutral 路径错误、fixture enum 推宽和删除必选字段类型错误是环境/夹具问题，不算产品 Red。

## 依赖、类型及未验证

仅 server-core 直接依赖已存在的 research-core workspace；lockfile-only **exit 0**，随后 frozen install **exit 0，1 package / 85.97s，HUSKY=0**。外部依赖版本/integrity 未变。

独立评判曾验证 research-core 类型 **exit 0**；server-core 首次仅三处 fixture enum 推宽报错，给 Source/shared fixture 明确类型后通过。root 最终 `bio:typecheck` **exit 0**，最终 server-core 全包 `tsc --noEmit -p packages/server-core/tsconfig.json` **exit 0**；独立评判完整复跑23项同为 **23/0、72expects、exit0**。

真实 HTTP/WS 身份与事件授权、JSONL flush/recovery、资料/模型/双端 UI、4090 与 GitHub 都未完成验收。T02 已登记基线债务继续按 Plan18 关闭；T04 不能当成整个科研平台已交付。

最终合并 `node scripts/bio-launch.mjs test run test:bio`：**59 pass / 0 fail / 209expects / exit0**（领域、共享协议、真实仓储/磁盘4文件，801ms）。`git diff --check` **exit0**。独立评判最终完整仓储复跑 **23/0、72expects、521ms、exit0**，两包类型均通过。正式阶段审批仍待给出。

2026-10-11 `/root/t04_independent_judge` 最终批准此文档与 **T04 阶段 PASS，允许 T05**，独立复跑23/0且两包类型通过；授权、CAS、租约、回滚、完整日志、单写入者及真实崩溃恢复阻断均关闭。上段待审批为交审时历史状态，本段为最终结论。
