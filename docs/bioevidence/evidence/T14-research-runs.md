# T14 — 持久科研运行、取消、恢复与双端状态

收敛日期：2026-10-16。状态：独立 Spec、代码质量、五文档一致性及 T14 阶段审批均 PASS。T15 科研界面尚未接入。

## 实现与存储边界

- 正式入口启用 `startRun/getRun/cancelRun/listRuns`。请求明确包含模型、公开问题、快照片段、证据、purpose、会话预期修订和 operationId；公开声明不能省略。同一请求重放返回原运行，改正文或范围复用 operationId 会冲突。响应 gate 也核对完整持久指纹，取消响应必须符合终止状态和代数递增。
- 复用 v1 数据库的 run_steps、run_intents、租约和单会话活动运行唯一索引，无新增依赖或 schema migration。单进程模型执行并发 1，最多保留 32 个当前执行/排队项；其他会话可排队，同会话不能并行启动新操作。
- prepare 步骤持久保存严格白名单 modelInput、完整问题/片段范围、公开输入 manifest 和连接指纹；getRun 返回可核对的输入，不回显 API key、credentialId 或 SDK 环境。模型输入仍限 32,000 字符，prepare 记录最多 256 KiB。
- Pi SDK 每次实际发送前，经 child→parent 检查通道同步持久化 call intent，再放行网络请求；回执单独确认。每次运行最多 4 次 SDK 调用，必须顺序发送。发送记录保存失败时不出站；取消、网络中断或重启留下的未确认请求标为 unknown，不自动重发。
- 正式服务为已接受运行构造独立 executionInputs/connection broker；每次由持久运行所有者、当前账号/项目权限、租约、代数及冻结输入重新检查。客户端注销、登录到期或断线不取消已接受任务；账号停用和成员撤销能使执行中断并停止 worker。
- 校验后的候选先成为可复用 model-result 完成步骤。产物修订、完成步骤、运行终态、outbox 和完整会话 journal 在同一数据库事务提交。新生成内容使用 generated-public-context 来源声明且保持 unreviewed，不自动确认科学结论。
- `retryOfRunId` 必须由客户端明确提交为新操作。输入与连接指纹一致时可复用已保存候选；原运行已有完整产物则引用准确的原修订，不重复生成产物、不覆盖后来的人工修订。输入或连接改变时不会把旧候选冒充新结果。
- SessionManager 增加科研专用 snapshot/reconcile/event 接口，正式入口挂接既有 SessionProjectionService；不调用旧 workspace/automation 初始化。沿用完整 StoredSession、JSONL 原子替换、校验和及未知临时文件保护。
- 数据库已提交而文件写入失败时，运行可完成且明确 projectionPending；启动及周期维护分批对账最新待写完整快照，受当前账户/项目权限限制。撤权时保留 pending，恢复权限后再对账，不借过期登录或绕过权限写文件。
- `projectionStatus` 区分 none/pending/projected/covered。只有前后 journal 均有已完成运行、manifest 和产物原文 hash 证明，最新快照已确认落盘、同会话/工作区且包含前序完整消息逐字前缀时，前序运行才能显示 covered。保留每个物理快照自己的 projected 回执，避免误报永久 pending。
- 服务启动将遗留 queued/running 标 interrupted，保留已完成步骤、产物和 unknown 请求；不恢复网络执行。取消先写终止状态与新代数，再 abort；迟到结果不能提交。
- outbox 仅发布范围化元数据，发布标记不等于客户端持久接收；重连重新查询权威状态。未知历史仍拒绝进入公开执行，可信会话历史也不拼入模型上下文。历史检查最多 1,000 条/8 MiB，单次完成快照最多 1,000 消息/1 MiB。
- 共享 ResearchRunStateAdapter 使用现有传输，只查询运行页和选中运行；事件只触发重新读取。断连/关闭后的迟到响应丢弃，撤权清空缓存，重连不会调用 startRun。页大小 20，单响应预算 2 MiB；T15 再连接实际 renderer。
- 正常停止与部分初始化失败共用依赖有序的资源清理；某一步失败仍清理后续 worker、解析服务和数据库，最后报告固定安全错误。真实 writer lock 重新取得已有测试证据。

## 实际行为诊断与修正

下表不是把不同时间的检查相加为一轮测试。缺模块/缺 API 的初始输出只说明实现入口缺失，不冒充已验证的产品行为失败。

| 项目 | 实际诊断/行为 Red | 修正证据 |
| --- | --- | --- |
| 每次 SDK 发送先记账 | T14-model-intent-red：16 pass/3 fail，缺发送先后顺序且忽略记录失败 | model-intent-green：25 pass/0 fail/118 expects，3 文件 |
| 创建/重放/活动互斥 | run-create-red：缺 beginResearchRun API，0/3，属于入口缺失诊断 | run-create-green：3/0/12 |
| call intent 与重启 | run-intents-red：缺记录 API，3/2 | run-intents-green：5/0/22 |
| 明确重试 | retry-auth-red：候选重试请求尚不支持，5/1；真实认证到期与账号撤销用例已通过 | retry-recovery-green：14/0/65，含真实持久库重开 |
| 复用已完成产物 | completed-retry-red：新建了不同产物 ID；7/2，另一失败为恢复入口尚未实现 | runs-integration：17/0/90 |
| 后续完整快照覆盖前序 | covered-projection-red：前序错误保留 pending，10/1 | covered-projection-green：24/0/106，含原完整投影文件回归和重启 |
| 完整资源清理 | cleanup-red 为缺模块导入诊断，不能计为产品行为 Red | cleanup-green：2/0/3，双关闭失败仍释放真实 SQLite 锁 |
| renderer 状态 | client-state-import-diagnostic 为缺模块诊断 | client-state：3/0/9，事件/撤权/断连迟到与重连只读 |

`research-runs-rpc` 使用真实 WS 认证客户端、实际隔离子进程、原 Pi SDK 和生产 worker 协议；仅测试 wrapper 将 HTTP 替换为合成 SSE。覆盖提交端注销后另一登录继续读取、跨用户拒绝、响应指纹与取消代数、发送记录失败无 HTTP、元数据事件隔离及进程退出。首次执行因测试预期把换行错误写成字面转义而失败，已修正夹具；不把该失败记作产品行为 Red。

## 最终命令与证据

日志位于本机被忽略的 `.runtime/checks/`；源码中的测试和本文可随仓库交付。未执行项目不记通过。

```powershell
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/server/src/bio-lifecycle.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__ packages/server-core/src/sessions/cold-session-metadata.test.ts packages/shared/src/agent/backend/__tests__/factory.test.ts packages/shared/src/agent/backend/__tests__/public-research.test.ts packages/shared/src/credentials/backends/secure-storage-atomic.test.ts
node scripts/bio-launch.mjs test test packages/shared/src/protocol/__tests__/research-run-state.test.ts
node scripts/bio-launch.mjs test test packages/shared/src/protocol/__tests__ packages/shared/src/agent/backend/__tests__/factory.test.ts packages/shared/src/agent/backend/__tests__/public-research.test.ts packages/server-core/src/research/research-runs-rpc.test.ts packages/server/src/bio-lifecycle.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/research-core/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server-core/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T14-bio-service.js
node --check .runtime/checks/T14-bio-service.js
node scripts/bio-launch.mjs test run .runtime/checks/T14-startup.ts
node .runtime/checks/T14-scan.mjs
git diff --check
```

- `T14-final-regression.log`：405 pass/1 skip/0 fail，12,761 expects，56 文件/101.20s/exit0；早于共享客户端适配器新增。`T14-client-state.log` 独立 3/0/9，不将二者写成一次 408 项执行。适配器导出后的 `T14-final-adapter-regression.log` 为 56 pass/1 skip/0 fail/625 expects，7 文件/25.68s/exit0，包含共享协议、SDK factory/public profile、真实研究 RPC 和关闭故障回归。
- `T14-all-types.log` 原八包检查 exit0，早于最后覆盖/清理/适配器改动；`T14-final-core-types.log` 在覆盖修正后 exit0，`T14-final-server-types.log`、`T14-domain-types.log`、`T14-web-types.log` 在生命周期清理后 exit0。适配器导出后重新执行八包类型检查，`T14-final-all-types.log` exit0；独立 Web 检查 `T14-final-web-types.log` exit0。
- `T14-build.log`：最终适配器导出后 3,520 modules/16.29 MB，构建及 Node 语法检查均 exit0；不是完整 worker/PDFjs/原生依赖分发证明。
- `T14-startup.log`：真实源码入口的连接配置、公开 PDF 输入、SDK inspect、原私有图片/PDF→证据/报告→人工核对/导出链路通过；376 channels，43 enabled/1 scoped-event/0 future/332 legacy 禁用；停止后模型进程 0。未在该 smoke 发送模型请求。
- `T14-final-scan.log`：已知宿主秘密匹配 1 个模式，源码 1,871 文件/产物 1,332 文件，命中为空/exit0，含适配器、本文和最终服务产物。`git diff --check` exit0。匹配检查不等于全面秘密或依赖漏洞审计。

## 未验证、后续责任与回滚

- 真实官方 GPT/兼容公网模型未验证；测试 HTTP 替身不能作为提供商验收。真实浏览器与 Electron 同业务界面尚属 T15，不能把两条 WS 连接称为双端界面验收。
- T02 原 Windows 完整基线未全绿，T16 的受控进程退出、MCP 缺命令诊断、Python 工具与正式包装/CI 责任保留。T10 生产 Bun Europe PMC 公网 DNS/TLS 仍是 T17 发布阻断。
- 本阶段没有运行完整原 Craft 测试套件或全量 lint，没有证明突然断电、真实大规模实验资料或 4090 部署。未访问真实实验材料，未配置真实模型密钥，无 GitHub 推送。
- 当前没有提供逐 token UI 进度或真实 token/费用账单；StoredSession 的 usage 默认数值不是实际消耗测量。T15 不应将其展示成已确认的零成本。
- 没有 schema migration；回退源码前应先停止服务并备份 Bio namespace 的数据库和 JSONL。旧代码不能把新增运行记录视为可自动重放任务；未知模型请求始终要求明确新操作。

## 独立审阅

前任独立评判 `/root/t11_independent_judge` 已顺序给出后端 Spec PASS、代码质量 PASS，未写实现代码；其反馈推动指纹/取消响应绑定、完整输入、重试产物复用、启动对账、covered 与完整资源清理修正。会话中断后，新的独立评判 `/root/t14_independent_judge` 只读复核主体及适配器，顺序给出 Spec PASS 和质量 PASS，无 Critical/Major 阻断；独立复跑适配器 3/0/9/849ms/exit0，其余仅核对作者日志。非阻断建议为 T15 接线时补选中运行切换、分页和 2 MiB 拒绝边界测试。2026-10-16 该评判核对最后日志后，给出五文档一致性与 T14 阶段审批 PASS，授权进入 T15。不虚构评判重新运行全部测试。
