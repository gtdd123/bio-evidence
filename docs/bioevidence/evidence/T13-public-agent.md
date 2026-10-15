# T13 — 公开科研 Agent、严格连接与受控模型出口

日期：2026-10-15。状态：独立 Spec、代码质量及文档一致性审批 PASS。范围为批准的 T13，不含 T14 持久运行、T15 科研界面或发布。

## 实现与边界

- 复用既有 AgentBackend/factory 和 Pi SDK `createAgentSession` 循环。新增 `public-research` profile；factory 的普通、resolved、fromConnection 入口均先走该 profile，BaseAgent 不接受它。会话仅使用一次服务端 input capability，不接受附件、私有工作目录、来源激活、分支、压缩或辅助模型调用；标题为确定性文本。
- PublicInputService 从当前授权仓储构造不可变输入清单，包含明确公开问题、已选公开来源的固定片段及授权公开证据。发送内容白名单不含账号/会话私有标题、资料路径、任意历史或项目记忆。摘要覆盖保留为摘要，发送片段与读取快照覆盖分别说明。
- 每个 block/evidence 加入前累计最终 JSON 的字符和 UTF-8 字节预算，最大 32,000 字符，并按所选模型窗口和输出预算保守估算。超限立即拒绝，不读取后续证据/快照；权限证明只保留逐项 hash。SDK 每次实际模型调用还检查完整 system/messages/tools 上下文，包括新产生的 assistant/tool 消息；预算失败即使被 SDK 转为错误消息，也恢复固定 `BIO_MODEL_BUDGET`。
- 每次生成使用独立子进程与自有目录，环境为白名单。SDK resource loader、SessionManager、SettingsManager/AuthStorage 均显式构造，关闭祖先/项目/全局 AGENTS、MEMORY、扩展、Skills、自动发现历史、压缩和自动重试。仅注册 `get_public_block` / `get_public_evidence`，返回本次白名单内容；实际出站前与工具调用前后重新授权。
- worker 默认 120 秒、最大 180 秒，父进程限制输出 2 MiB/64 帧；超时、取消和 close 等待实际子进程退出并清理自有目录。固定错误帧只传允许的代码，拒绝额外正文。当前 worker 服务并发上限为 1。
- 官方连接固定为显式 OpenAI API-key 配置，模型名来自配置；兼容连接要求明确 HTTPS 地址及 Responses/Chat Completions API。模型、连接、版本或权限变化即停止；不使用 workspace/global 默认连接或环境密钥补足。SDK 请求设置 `store:false`、禁重试，最终模型上下文不携带 SDK cwd。
- 正式入口现已组装 ResearchConnectionsService、PublicInputService、PublicModelWorkerService 和 PublicModelExecutor，复用 Bio namespace 下真实 CredentialManager；凭据懒初始化。新增 typed `listModelConnections` / `saveModelConnection` RPC，服务端当前管理员才能配置，普通成员只能列出其当前获授权空间中的启用连接。
- 配置记录与当前配置者绑定；返回模型列表/状态，不回显 apiKey 或 credentialId。请求及响应均检查当前权限；响应与权威视图完整比较，旧修订、伪造正文和撤权后回放拒绝。配置失败/拒绝有必要审计，不含密钥或正文。配置创建者停用后连接不可用，其他管理员不能自动取得其配置所有权；接管和旧密钥清理属于后续运维收敛。
- 密钥采用独立 UUID staging 引用，DB CAS 只切换成功版本，失败仅清理本次暂存密钥。真实加密文件改为同目录独占临时文件、完整写入/fsync、rename 替换；失败清空未提交缓存，保留旧文件。单进程读改写不在中途 await，避免首次并发写入丢失另一项。DB 与加密文件并非跨存储原子事务，进程崩溃可能留下未引用的加密密钥；不自动删除旧活动引用，也未声称突然断电验收通过。
- 模型认证失败、限流、超时、不支持、取消、不可用及输入预算采用固定安全错误；不返回提供商原始正文。错误分类已使用安装的 Pi 0.80.6 默认 SDK 适配器和截获 HTTP 响应验证。
- Executor 通过 factory 公共 profile 返回严格结构的证据/报告候选。未知引用/伪造人工核对字段拒绝，摘录不匹配保留 pending；结果始终 unreviewed，不自动保存或确认科学结论。生成仍是内部服务，不提供绕过 T14 intent/租约的裸计费 RPC。

## 本轮实际 TDD 与修正

审计前已有 T13 profile/input/SDK/worker/executor 雏形。本轮先复验当前工作区，再对独立审阅指出的缺口补充行为测试；历史模块数字没有合并为一次完整执行。

| 检查 | 实际 Red/诊断 | 修正后证据 |
| --- | --- | --- |
| 初始当前专项 | 56 pass/1 skip/1 fail/1 error；SDK inspect 触及默认 5 秒测试超时 | 单独诊断 3/0，构造约 2.4 秒；正常构造用例改 20 秒测试预算，100ms 超时/取消故障用例继续独立验证 |
| 当前类型 | `RequestInfo` 未定义 TS2552；后续正式入口回调参数形式错误 TS2559 | 改为实际 fetch 参数类型、PublicInputService 传 `{currentActor}`；后续类型通过。两项均为实现/测试修正，不伪称业务 Red |
| 模型错误分类 | 输入 HTTP+连接两文件 9 pass/14 fail；不同状态原来均返回不可用 | 与 worker 相关 26/0/114 expects；两种 SDK API 的 401/403/429/408/504/400/404/503 均经截获响应验证，单次请求无回落 |
| worker 超时分类 | 2 pass/1 fail，期望 timeout，实际 unavailable | 最终 worker 4/0/15，含取消、close、真实退出、固定错误帧及额外正文拒绝 |
| 加密替换失败 | 0 pass/1 fail；原实现直接覆盖，无替换失败边界 | 凭据相关 7/0/38：真实 CredentialManager 加密读回、磁盘无合成明文、写后 CAS 竞争/账号停用清理、rename 故障后旧文件/缓存/重新打开一致 |
| 正式连接 RPC | 0 pass/1 fail，真实 `CHANNEL_NOT_FOUND` | RPC+协议 5/0/151；三账号授权、真实加密存储、响应遮罩、旧响应/撤权拒绝与拒绝审计 |
| 输入累计预算 | 7 pass/2 fail，实际读取了超限后的 must-not-read 证据/快照 | 输入+executor 12/0/47；在继续读取前以预算错误停止 |
| SDK 后续上下文窗口 | 1 pass/1 fail，工具后仍继续模型请求并完成 | 输入/SDK/HTTP 29/0/131；第二次超限时 stream 调用计数保持 1 |

对应日志为忽略的 `.runtime/checks/T13-resume-*.log`。连接 stale revision 原用例只证明 staging 前拒绝，已准确改名；新增真实 await 写 key 后的竞争及停用用例证明后续清理，不再靠测试名推断覆盖。

以上六组新增行为 Red 的实际命令分别为：

```text
node scripts/bio-launch.mjs test test packages/server-core/src/research/public-pi-http.test.ts packages/server-core/src/research/model-connections.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/public-model-worker.test.ts
node scripts/bio-launch.mjs test test packages/shared/src/credentials/backends/secure-storage-atomic.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/model-connections-rpc.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/public-input.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/public-pi-runtime.test.ts
```

## 最终验证

以下命令均真实执行；通过结果只覆盖所列范围。

```text
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/research-core/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server-core/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server/tsconfig.json
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__ packages/server-core/src/sessions/cold-session-metadata.test.ts packages/shared/src/agent/backend/__tests__/factory.test.ts packages/shared/src/agent/backend/__tests__/public-research.test.ts packages/shared/src/credentials/backends/secure-storage-atomic.test.ts
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T13-bio-service.js
node --check .runtime/checks/T13-bio-service.js
node scripts/bio-launch.mjs test run .runtime/checks/T13-startup.ts
node .runtime/checks/T13-scan.mjs
git diff --check
```

- 根八包、领域与 Web 类型均 exit0，日志 `T13-resume-verified-*-types.log`；这些结果早于最后输入/SDK 预算修正。最后修正后的受影响 server-core/server 类型均 exit0，见 `T13-final-core-types.log`、`T13-final-server-types.log`。
- **最终广相关 384 pass / 1 skip / 0 fail / 12,652 expects / 52 files / 75.47s / exit0**，`T13-final-regression.log`。保留的 skip 是原 backend dev/dist host-root 场景。较早广相关 383/1skip/0 早于最后 SDK 窗口修正，不作为最终结果。
- 服务入口构建 **3,332 modules / 10.75 MB / exit0**；语法检查 exit0，见 `T13-build.log`。
- **正式源码入口实际启动与停止 exit0**，见 `T13-startup.log`：公开合成 PDF → 解析快照 → 保存/列出真实加密连接 → 构造公开输入 → 拒绝无效认证 → 实际独立 SDK worker inspect；同时复验 T12 私有目录预览/原文件下载、私有 PDF → 快照 → 人工证据 → 报告 → needs-changes → CSV/Markdown → 列表/get。停止后 modelProcesses=0。
- 当前实际通道数 **375：39 enabled、1 scoped-event、3 disabled-unimplemented、332 disabled-legacy**。START_RUN/CANCEL_RUN/GET_RUN 仍未启用，留给 T14。
- 已知宿主秘密匹配扫描 **1 个模式；源码 1,860 文件、产物 1,332 文件，hitFiles 均空/exit0**，`T13-scan.log`。阶段文档新增后最终扫描源码 **1,861** 文件、产物 **1,332** 文件，仍无命中/exit0，`T13-final-scan.log`。产物范围含当前服务 bundle 及已有客户端/子进程产物；该匹配检查不等于全面秘密或依赖漏洞审计。
- `git diff --check` exit0。无新增依赖/lock 修改，没有访问真实实验材料、原 Craft 用户凭据或 4090。测试、构建和 SDK 进程均经项目固定运行时/隔离入口。

启动与扫描脚本为本机忽略的合成验证程序，不是正式分发命令；可随源码复验的模块与 RPC 行为保留在仓库测试中。源码入口通过与单 bundle 构建均不替代 T16 worker/native/PDF.js 资源包装。

## 尚未验证及后续责任

- 所有 HTTP 契约请求均为截获 fetch/合成 SSE 或错误响应；实际 worker inspect 只构造 SDK、不发模型请求。**真实 GPT 官方/兼容模型调用及计费：未验证**，没有借用宿主凭据。
- T14 负责持久运行 intent/租约、取消/重启对账、SessionManager/JSONL/outbox 投影与结果保存。当前有任何未分类 projection 历史的会话仍保守拒绝公开模型输入；需建立可信公开运行来源，不删除保护来放行。
- T15 科研登录/项目/来源/证据/报告/运行界面、T16 包装和 Windows 原遗留门槛、T17 完整原基线/性能与生产 Europe PMC 公网、T18 GitHub 均未完成。
- 当前没有重新执行完整原 Craft 基线或独立全量 lint；T02 的失败记录继续保留。没有将本阶段 384 项相关回归当作全量原测试通过。

## 独立审阅

`/root/t11_independent_judge` 未参与编写本阶段代码，已只读预审并指出正式入口参数、累计输入预算和 SDK 后续窗口三项问题，均已修正并提供真实证据。最终依序完成 Spec → 质量 → 四文档一致性审批 **PASS**，允许进入 T14。评判读取实际日志、源码和文档，本轮未独立重跑测试；审批不等于真实模型、双端界面或发布通过。
