# T05 — JSONL flush、安全替换与权威日志恢复

日期：2026-10-12（Asia/Shanghai）。起点 `a2b7dc6`。状态：**独立阶段审批 PASS，允许进入 T06**。

## 实现及集成边界

legacy SessionPersistenceQueue 的 debounce/flush 共用每会话串行 writer。enqueue 克隆数据；flush 捕获要求代数和取消 epoch，等待已从 pending 取走的活动写入，取消前的 flush 不可由新 epoch 确认。flushAll 包括活动写入和已记录失败，等待全部结束后报错。失败保留可观察状态，新 enqueue 可以重试。后台 timer 和原未 await 的 SDK 回调捕获 rejection，只记录固定安全错误码；已 await 的 flush 不吞错误。

watcher cancel 可随即 enqueue 替代数据；会话删除使用 discardAndWait，先阻止再入队、作废旧代数并等待旧 writer，随后才删除目录，防止删后复活。签名分活动和已提交两份，活动签名供 watcher 抑制自写事件，失败不制造新的已提交签名。启动没有此前签名时保留本地标题；曾提交后发现外部元数据变化时保留外部字段，消息及计算字段仍取当前入队快照。旧 helper 测试错误描述的启动条件已改为仅验证 merge helper，真实 queue 集成用例验证实际规则。

同步 JSONL writer 与异步 queue 均使用独占创建的 UUID 临时文件，写入并 fsync、关闭后 rename 覆盖正式文件，不预删正式文件，也不重用未知 tmp。Windows 实际覆盖成功已验证；共享占用/替换失败时拒绝且保留旧文件和完整临时副本。listSessions 不再删除 tmp。此处没有声明 Windows 目录项 fsync 或电源断电保证。

Bun-only SessionProjectionService 增加权威 journal→JSONL 内部能力。新 journal 是 **完整 stored-snapshot**，保存完整 createSessionHeader 头（SESSION_PERSISTENT_FIELDS）、完整 StoredMessage JSON（type、可选 timestamp、工具、annotations 等）和空消息历史。每个 entry 独立完整，不把多个快照拼接；同 ID 内容更新、同操作重试、单调 generation、SHA256 均校验。此前 T04 role 格式数组显式标为 legacy-runtime；没有完整 header 时拒绝重建/确认，不伪造丢失的 SDK/连接等字段，不把 role 强转为 type。

投影仅用服务端提供的 workspace binding 选文件，拒绝提交头路径与 binding 不符。全 Bio namespace 的 realpath 校验之外，trusted workspace 下 sessions/sessionId、正式文件及 tmp 的每个已有组件必须处于其预期物理位置，拒绝指向同 namespace 其他目录的 junction。读写前和替换前重新检查；授权要求当前会话所有者、当前用户及当前写权限。读取正文的恢复方法不是客户端 RPC。

对账取最后一个完整快照：正式文件精确匹配则核对并同步；匹配的完整 tmp 可提升；坏/未知 tmp 保留；未知正式文件先独占复制到 quarantine 再从 DB 重建。只有核对实际完整文件、最新 operation/generation/hash 且 fsync 后，才标 projected。替换失败、替换后确认前中断均保持可重试；重复恢复不追加重复消息。

**尚未接线的边界：** journal 服务当前未接入科研 SessionManager/startup。legacy queue 和 projector 各自串行，T14 必须为同一科研 JSONL 选择单一权威写入入口，不能同时使用两条写链。完整产物 + run 终止 + journal 的组合事务仍属于 T14。账号/请求身份入口属于 T06/T07。当前没有产品端到端保存、模型、UI 或 GitHub 发布验收。

## 实际 Red 与 Green

| 范围 | 实际结果 |
| --- | --- |
| 可注入 writer 后，原 queue 行为 | **1 pass / 4 fail**：flush 提前返回、错误吞掉、入队引用突变、listSessions 删除唯一未知 tmp；日志 T05-queue-red.log。该 PowerShell 命令最后 tail 覆盖了进程 exit，故不把 shell exit0 记为测试成功 |
| queue 首修，同五项 | **5 pass / 0 fail / 11 expects / exit0** |
| snapshot journal/service 空骨架 | **1 pass / 5 fail / exit1**：完整快照接口尚未实现；没有环境/导入失败冒充行为 Red |
| snapshot journal/service 实现，同六项 | **6 pass / 0 fail / 30 expects / exit0** |
| queue + research 相关集成首轮 | **66 pass / 0 fail / 194 expects / exit0** |
| 加纯领域、协议及 cold-session 回归 | **108 pass / 0 fail / 343 expects / exit0** |
| 独立评判指出取消 epoch 与同 namespace 越会话 junction，新增负向复现 | **16 pass / 2 fail / 62 expects / exit1** |
| 修复上述两个缺口 | **18 pass / 0 fail / 64 expects / exit0** |
| 最终相关回归（另加 tmp junction 保留拒绝） | **111 pass / 0 fail / 350 expects / exit0**，12 files，4.79s |
| 独立评判要求增加其他 editor、撤权中 writer、并发 save 的负向证据 | 首两轮 **12 pass / 1 fail / exit1**：fixture 用错项目修订，随后试图撤销不可撤销的创始负责人；不把 fixture 失败当生产缺陷 Red |
| fixture 改为项目负责人 Bob、会话所有者 Alice 是可撤销 editor，保留创始人保护规则 | projection **13 pass / 0 fail / 55 expects / exit0**；其他 editor 只能读、撤权阻止替换/确认、并发旧代数拒绝/新代数落盘全部通过 |
| 补齐权限/并发测试后的最终相关回归 | **114 pass / 0 fail / 360 expects / exit0**，12 files，4.69s；T05-regression-approved-candidate.log |

最终命令：

```text
node scripts/bio-launch.mjs test test packages/shared/src/sessions packages/server-core/src/research packages/research-core/src packages/shared/src/protocol/__tests__/research.test.ts packages/server-core/src/sessions/cold-session-metadata.test.ts
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/shared/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server-core/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/research-core/tsconfig.json
git diff --check
```

测试通过 pinned Bun 1.3.10 neutral launcher，在独立拥有的 synthetic Bio namespace/SQLite/JSONL 中执行。清理验证真实路径仍在拥有的 namespace 内。故障通过确定性 writer/rename 注入，不宣称这等同于真实 OS 崩溃；T04 真实 child SIGKILL/PID 接管原测试仍纳入回归并通过。Windows junction 与 rename 覆盖则为实际文件系统行为。

中途误用不存在的 launcher purpose `check` 两次 **exit1**，类型检查未运行；改用已有 bootstrap purpose。第一次修复后的 shared/server-core 类型检查均 **exit0**。最终 research-core/shared/server-core 三包类型检查均 **exit0**。

增加权限测试后 server-core 类型检查曾 **exit2**：Bun expect 要求同一静态类型，JsonValue[] 与 StoredMessage[] 的完整 JSON 比较参数不兼容。将预期值明确 JSON 序列化为 journal 的实际格式，保留全部字段断言；修复后的 `T05-server-types-corrected.log` 命令已观察 **exit0**。

未扩大依赖或变更 lock。仅本任务代码、相关合成测试及证据文档；没有全量旧基线、UI/build/模型/4090 或公开 GitHub 交付声明。T02 尚未全绿的原基线门槛保持原记录，由既定后续任务关闭。

markProjected 是可信 projector 的内部确认方法，不能注册为允许客户端声称“我已保存”的 RPC。只读评判先复跑 queue/research **68/0、198 expects、exit0**，补权限场景后再独立复跑 **72/0、211 expects、exit0**，9 files，2.05s。独立取消 race 得 oldFlush rejected/newFlush resolved，三个包类型检查及 diff check 均 exit0。`/root/t04_independent_judge` 最终文档与阶段结论 **PASS**，允许进入 T06；审批仅覆盖本阶段，后续集成边界保持。
