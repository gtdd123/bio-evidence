# BioEvidence 当前工程状态审计

**T18 公开源码预览准备中（2026-10-20）：** 用户最新明确要求美化 README 并上传 GitHub，现依 PLAN22 推进 `gtdd123/bio-evidence` 公开源码交付。新增品牌横幅、真实合成界面截图、启动说明、架构及验证状态；未新增业务功能。公开前检查本地全部可达 Git 历史、文件清单、敏感模式和文档资产，独立评判终审 PASS，批准源码预览发布；建仓库、推送与远端核对尚待执行。此次源码开发预览不等于 T17 全阶段通过，AC05/22 与真实环境责任继续保留。见 [T18 发布记录](docs/bioevidence/evidence/T18-publication.md)。

**T17 本机验收进行中（2026-10-20，尚未阶段 PASS）：** T16已本地提交`6243b25`。扩展支持范围回归435 pass/0 fail、Node36/0，类型/构建/资源检查exit0；最终空状态和真实公开PDF导入路线已执行。最新桌面测试副本与实际Web页面完成U-Net公开PDF→页定位/证据→报告→同修订正文核对，全程模型调用0；资料空空间已明确提示“尚未接入”。默认EuropePMC生产适配器仍因本机DNS解析到198.18.x.x被地址保护拒绝，AC05未通过；用户确认本机目前没有可用模型连接，AC22真实调用未验证。本轮修正及29项状态记录已独立通过规格/质量/文档审查，批准保存本地checkpoint；T17全阶段与T18公开GitHub交付尚未完成，不改成全部通过。见[T17验收记录](docs/bioevidence/evidence/T17-acceptance.md)。

**T16 独立阶段 PASS（2026-10-20）：** 已实现受控服务启动/退出、BioEvidence 品牌、Windows 未签名便携目录及包含真实解析/图像/SDK 资源的 Bun 服务目录。统一科研回归318/0、类型与构建 exit0；后续目录检查修复最终 Node36/0、MCP8/0。最终仓库外资源/合成账户及受控停止、实际包双窗口/上传/私有 TIFF 帧/导出、已知秘密与标记扫描均通过，独立 Spec→质量→文档一致性及阶段审查均 PASS，授权提交后进入 T17。模型请求为0，账号TTY和原生chooser未手工验收；Docker daemon 不可连接，容器/Linux 未验证。真实 GPT、生产文献公网、完整 AC、真实数据与公开 GitHub 交付仍归 T17–T18，当前不能称课题组安装即用。见 [T16 证据](docs/bioevidence/evidence/T16-delivery.md)。

**恢复开发后的更新（2026-10-17）：** 用户已明确恢复开发。T13、T14 已独立审批 PASS，T14 提交为 e8ad838。T15 已实现 Web/Electron 共用科研界面、专用桌面薄客户端、快照/修订发现接口、模型配置、私有资料/帧/批注、持久运行详情及身份/草稿/CAS 边界。真实浏览器与 Electron39 双窗口已运行，合成 PDF→证据→报告→人工核对/导出、三账号隔离、授权合成撤权清屏/恢复草稿和并发批注均有实际证据；模型执行使用明确替身，真实模型请求为 0。相关回归 402 pass/0 fail；后续纯客户端受影响范围 88 pass/0 fail，分开记录，不相加为一次。独立主体及追加修复 Spec/代码质量、四文档一致性与 T15 阶段均已 PASS，下一步推进 T16 运行包与部署。正式包装/Windows 遗留、生产 Bun 公网文献、真实 GPT、完整 AC 和公开 GitHub 仍待 T16–T18；还不能称课题组安装即用。见 [T15 阶段记录](docs/bioevidence/evidence/T15-shared-ui.md) 与 [T14 阶段记录](docs/bioevidence/evidence/T14-research-runs.md)。

以下保留的是恢复开发前的审计快照，Git 数字和暂停约束属于当时状态，不代表随后修改后的工作区或仍要求暂停。

审计日期：2026-10-15（Asia/Shanghai）。对象：本地 `work/bio-evidence` 工作区。

**结论：目前是有历史运行证据的科研后端基础，加上尚未完成集成的 AI 模块；尚未达到课题组可直接使用的科研 Agent 平台。** 已有正式源码入口跑通过不调用模型的资料、证据和报告链路。当前 T13 模型模块未提交、未接入正式入口，T14 运行管理、T15 科研界面、T16 交付包装、T17 完整验收及 T18 GitHub 交付均未完成。

本轮暂停新增功能。仅阅读源码、Git、既有文档及日志，并新增本报告；没有修改源码、安装依赖、重构、删除文件、执行新测试或构建、启动服务、提交或推送代码。以下测试数字来自历史记录，不是本轮复跑。未有真实执行证据的项目明确列为**未验证**。

## 1. 审计依据与判定口径

- 需求与任务：[SPEC](docs/bioevidence/SPEC.md)、[PLAN](docs/bioevidence/PLAN.md)、[TASKS](docs/bioevidence/TASKS.md)、[领域术语](CONTEXT.md)。任务文件的阶段 PASS 与实际产品可用性分别判断。
- 源码重点：正式服务入口、RPC 注册与授权、资料/文献/快照/产物服务、T13 新模块、Web/Electron 接口、启动与构建脚本。
- 历史证据：`docs/bioevidence/evidence/` 中的阶段记录，以及本机被忽略的 `.runtime/checks/` 日志。日志存在不表示当前全部代码通过过该项检查；不同时间、范围的测试数量不相加。
- Git：本轮实际执行只读的状态、差异、文件清单、分支、远端、最近提交和基线比较。没有连接 GitHub 查询远端仓库状态。
- “已实现”指相应后端或基础模块存在，且有历史专项证据；不等于科研界面可操作、当前工作区重新验证通过或完整发布通过。
- 当前服务是否正在运行、真实用户数据、4090 服务器数据及部署环境均未检查。没有读取真实实验材料来替代验收。

## 2. 功能现状

### 2.1 已实现的后端与基础模块

| 能力 | 当前实现与证据 | 实际边界 |
| --- | --- | --- |
| 隔离启动与配置 | 项目固定 Bun、用途化 launcher、新 namespace、环境白名单、构建秘密出口收敛；T00–T02 有专项证据 | 当前完整分发与所有原基线检查尚未通过 |
| 科研领域与存储 | `research-core` 契约；SQLite 用户/空间/资源绑定/修订/审阅/审计/outbox/projection journal；T03–T04 | 有 Run 数据结构和底层操作，不表示完整运行服务已实现 |
| 会话持久化基础 | JSONL 队列 flush、替换、失败传播及 journal 重建相关基础；T05 | 尚未接通科研 Agent 运行到 SessionManager 的完整投影与恢复 |
| 账号、项目与资源权限 | 账号 CLI、认证会话、个人空间/项目成员、HTTP/WS 授权、撤权及回放限制；T06–T07 | 没有完成供同学使用的共享登录与项目界面 |
| 本地实验资料入口 | 预授权目录、只读索引、分页、关键词检索、批注；T08 | 基于合成目录验证；真实大目录及 4090 数据接入未验证 |
| 图像与连续帧预览 | PNG/JPEG、受支持普通 TIFF 帧及部分 16 位灰度预览；受限子进程、原文件授权流式下载；T09 | OME 多维映射、BigTIFF、subIFD 金字塔明确不支持；大规模真实数据未验证 |
| 来源与读取快照 | 题录/摘要/来源选择、不可变来源记录、PDF/JATS 有预算解析及定位、覆盖与缺页记录；T10–T11 | 正式文献公网适配器存在环境阻断；未实现 OCR、图像内容理解或任意论文全文获取 |
| 证据与报告 | 服务端创建/保存/历史修订、引用结构校验、人工核对、来源变化提示、受控 CSV/Markdown 导出；T12 | 历史启动链路由测试程序操作；不含 AI 自动生成或科研编辑界面。结构合法不代表科学论断正确 |

T12 正式入口历史运行记录显示：373 个通道中，37 个业务通道启用、1 个受范围约束事件、3 个后续能力通道未启用、332 个旧通道禁用。大量继承代码存在，不代表这些能力已经在 BioEvidence 中开放。

### 2.2 部分实现

| 能力 | 已存在部分 | 未闭合部分 |
| --- | --- | --- |
| 文献检索 | Europe PMC 适配器、受范围约束的搜索/选择/缓存与测试 | 当前 Bun 正式适配器真实公网 DNS/TLS 仍未通过，不能称在线检索交付完成 |
| 模型连接 | T13 连接元数据、管理员配置服务、授权选择 broker、密钥存储接口与模块测试 | 未组装真实 CredentialManager；正式服务/RPC/界面没有配置入口。当前测试使用内存密钥存储 |
| 公开科研输入 | 显式公开声明、读取片段白名单、不可变输入清单、当前权限与来源头检查、预算 | 有任何 projection journal 历史的会话当前均保守拒绝；尚无逐次运行的公开历史来源证明，重复运行链路未闭合 |
| 科研 Agent 执行 | 复用 Pi SDK 循环、受限公开工具、独立 worker、factory 公共科研 profile、候选输出校验 | 未接正式入口、没有真实外部模型生成证据、没有完整运行生命周期与持久化集成 |
| 双端共享 | 原 Craft Web/Electron 框架、传输层及新增认证 helper | 没有完成 BioEvidence 登录、项目、来源、证据、报告、运行界面；不能宣称桌面/Web 科研会话已经可用 |

### 2.3 尚未实现或尚未交付

- 正式科研 RPC 发起模型调用，并经过持久运行管理、可见结果与人工保存形成完整闭环。
- T14 RunService：运行 intent/租约、取消、退出与重启对账、SessionManager 投影及 outbox 集成。已有底层原语不能替代该服务。
- T15 共用科研界面与桌面薄客户端集成。
- T16 BioEvidence 品牌、准确 README/部署入口、完整 Windows/Web 交付及 worker/资源包装验收。
- T17 支持范围完整回归、真实性能验收、真实 Europe PMC 与模型服务验收；当前完整工作区验证。
- T18 公开 GitHub 交付。本地无 remote；本轮未查询 GitHub，不能仅凭本地状态断言云端仓库是否存在。

细胞分类、训练/推理、4090 接入及本地大模型部署是已确认暂缓的研究方向，不是本次平台工程必须补做的功能。

## 3. Craft Agents OSS 继承与本项目改动

来源为用户提供的 Craft Agents 0.11.4 ZIP。原始 1,877 文件逐文件比对证据见 [T00](docs/bioevidence/evidence/T00-preparation.md)。本地初始导入提交为 `a89f39f6b1368c808d84918e64e70d78d48a2aeb`。ZIP 声明的上游提交未完成远端核验；这是本地源码导入，不能描述为保留完整上游 Git 历史的 fork。

| 模块 | 来源判定 | 本次变化/复用方式 |
| --- | --- | --- |
| `apps/electron`、`apps/webui`、`packages/ui` | 主要继承 | 保留 React/Electron/Web 框架；修改 namespace、启动/构建和部分兼容问题；新增认证桥接。科研业务界面尚未完成 |
| `packages/shared/src/agent`、`packages/pi-agent-server` | 继承并修改 | 复用 backend/factory/BaseAgent、Pi SDK 运行方式；修改隔离、子进程等；T13 新增公共科研 profile，仍在工作区 |
| `packages/server-core/src/transport`、原 SessionManager | 继承并修改 | 加入可信 Actor、通道授权、事件撤权/回放约束；科研 Run 与会话投影尚未完成集成 |
| shared 配置、凭据、日志、JSONL persistence | 继承并修改 | 新 namespace、环境/日志边界、flush/安全替换、恢复基础等；已有凭据管理实现尚未接入 T13 连接服务 |
| 原 MCP、skills、浏览器、自动化及通用 Agent 工具 | 继承保留 | BioEvidence 正式权限 profile 大量禁用旧入口；不可按原 Craft 功能表计算科研平台完成度 |
| `packages/research-core` | 本次新增 | 科研领域、策略、引用/修订/运行 DTO、仓储接口、协议与校验 |
| `packages/server-core/src/research` | 本次新增 | SQLite 权威服务、认证、授权、资料/预览、文献/解析/快照、产物；T13 输入/连接/worker/executor 尚未提交 |
| `packages/server/src/bio-index.ts`、`bio-account.ts` | 本次新增 | BioEvidence 账户权威服务入口及账号管理 CLI |
| `scripts/bio-*`、中性配置及文档 | 本次新增，兼有原脚本修改 | 固定运行时、隔离测试/构建/启动、证据与需求文档；旧构建脚本也有安全及兼容修改 |

本轮实际比较：当前已跟踪 1,990 文件；相对初始导入，在已跟踪范围内修改 100 文件、新增 113 文件、删除 0 文件。另有 16 个未跟踪 T13 文件，不包含在上述差异中。此为文件来源统计，不是功能完成率。

根 README 仍以 Craft Agents 为主，`package.json` 仍是 `craft-agent` / `0.11.4`。LICENSE/NOTICE 等上游来源信息保留；品牌和部署说明尚未收敛。原 `packages/server/src/index.ts` 在 Bio 模式明确拒绝启动，要求改用 `bio:server`，不能把旧 README 启动方式当作本平台可运行说明。

## 4. Git 快照

写入本报告前的实际快照：

- 分支：`main`；HEAD：`64afd7062abc10c1bee2579bcbc9db9302ab7ab9`。
- 暂存文件：0；已跟踪修改：8；未跟踪文件：16。
- 已跟踪工作区差异：71 行增加、7 行删除；不包含未跟踪文件的内容。
- 远端：未配置。没有执行 commit、push 或远端操作。
- Git 提示无法读取宿主全局 ignore 文件；仓库状态和仓库 `.gitignore` 已读取，不能据此宣称覆盖所有宿主忽略配置。

### 4.1 已修改的 8 个文件

```text
packages/research-core/src/contracts.ts
packages/research-core/src/index.ts
packages/research-core/src/repository.ts
packages/server-core/src/research/sqlite-repository.ts
packages/shared/src/agent/backend/__tests__/factory.test.ts
packages/shared/src/agent/backend/factory.ts
packages/shared/src/agent/backend/types.ts
packages/shared/src/agent/base-agent.ts
```

### 4.2 未跟踪的 16 个 T13 文件

```text
packages/research-core/src/public-research.ts
packages/server-core/src/research/model-connections.test.ts
packages/server-core/src/research/model-connections.ts
packages/server-core/src/research/public-input.test.ts
packages/server-core/src/research/public-input.ts
packages/server-core/src/research/public-model-executor.test.ts
packages/server-core/src/research/public-model-executor.ts
packages/server-core/src/research/public-model-worker.test.ts
packages/server-core/src/research/public-model-worker.ts
packages/server-core/src/research/public-pi-http.test.ts
packages/server-core/src/research/public-pi-protocol.ts
packages/server-core/src/research/public-pi-runtime.test.ts
packages/server-core/src/research/public-pi-runtime.ts
packages/server-core/src/research/public-pi-worker.ts
packages/shared/src/agent/backend/__tests__/public-research.test.ts
packages/shared/src/agent/backend/public-research.ts
```

本轮唯一新增文档为本文件；因此交付后的未跟踪文件应在以上 16 个之外另加 `CURRENT_STATUS.md`。

### 4.3 最近 8 次提交

以下时间均为 +08:00。

| 提交 | 时间 | 内容 |
| --- | --- | --- |
| `64afd70` | 10-15 11:13:12 | Windows plans 模式测试使用自有目录夹具 |
| `b600679` | 10-15 11:08:44 | 版本化证据/报告及安全导出 |
| `66fce9c` | 10-14 10:59:14 | 有界文档解析与授权读取快照 |
| `9c1f810` | 10-13 21:48:22 | 有范围约束的文献选择与不可变来源 |
| `d39405d` | 10-13 11:21:50 | 有界图片预览与授权文件流 |
| `0870a6b` | 10-13 10:42:27 | 只读资料入口与有界检索 |
| `38b625e` | 10-12 21:54:32 | 科研 RPC/事件授权 |
| `11dd8e4` | 10-12 13:03:22 | 用户认证与受认证保护的服务 |

`.tools/`、`.runtime/`、`.fixtures/`、数据库、日志、私有数据和导出等受忽略规则保护；它们不是可直接随 Git 交付的运行环境。既有完整日志保留在本机，不因本报告而公开。

## 5. 运行和测试证据

### 5.1 历史实际执行结果

| 记录 | 实际结果 | 能证明什么 / 不能证明什么 |
| --- | --- | --- |
| T02 完整常规基线 `.runtime/checks/T02-regular-serial-3.log` | 4,920 pass / 1 skip / 17 fail；4,938 tests，373 files，exit 1 | 明确未全绿；不能把后来的局部修复算术扣减为新的完整结果 |
| T12 最终相关 `.runtime/checks/T12-final-regression.log` | 97 pass / 0 fail / 1,136 expects，7 files；阶段记录 exit 0 | T12 当时相关实现通过；不覆盖最新 T13 |
| T12 较早广相关回归 | 299 pass / 0 fail，42 files，exit 0 | 早于最终摘要/防伪/预算修改；不能替代最终全面回归 |
| T12 正式源码入口 `.runtime/checks/T12-startup.log` | startup、认证 RPC、预览/下载、上传/解析/快照、证据、报告、人工核对、CSV/Markdown、列表读取均 true；阶段记录 exit 0 | 真实本机服务与解析子进程链路，使用合成资料；没有调用模型，没有科研 UI 验收 |
| T12 类型/构建/扫描阶段记录 | 最终领域/server-core/server/Web 类型 exit 0；服务 bundle 247 modules、0.91 MB、语法 exit 0；当时已知宿主秘密匹配扫描无命中 | 限当时版本与扫描范围；单入口 bundle 不等于 worker/Windows 安装包完整可用 |
| T13 前置 Windows 夹具 | 修改前 430 pass / 14 fail；修改后 444 pass / 0 fail / 532 expects，exit 0；独立复验通过 | 关闭明确的 14 项夹具门槛；不改写 T02 全量失败记录 |
| `.runtime/checks/T13-backend-green.log` | 38 pass / 1 skip / 0 fail，2 files | 当时 factory 相关回归；早于后续别名和 BaseAgent 检查，不是 T13 最终结果 |
| `.runtime/checks/T13-runtime-current.log` | 10 pass / 0 fail / 52 expects，3 files | 当时输入、SDK 隔离、worker 专项；SDK 测试使用受控模型流 |
| `.runtime/checks/T13-profile-worker.log` | 4 pass / 0 fail / 26 expects，2 files | 公共 profile 限制与真实子进程终止/清理；不证明真实模型生成 |
| `.runtime/checks/T13-http-contract.log` | 2 pass / 0 fail / 16 expects，1 file | 默认 SDK Responses/Chat Completions 适配器经截获 fetch、合成 SSE 验证 URL/模型/认证/store:false；没有外网请求 |
| `.runtime/checks/T13-input-executor.log` | 10 pass / 0 fail / 41 expects，2 files | 公开输入与候选校验；没有自动保存，早于最新连接相关改动 |
| `.runtime/checks/T13-connections-green.log` | 3 pass / 0 fail / 17 expects，1 file | 连接授权/元数据/合成密钥行为；使用内存 KeyStore，不是生产凭据集成 |

T13 各专项日志互相重叠，运行时点不同，不合并为“总计通过”。已有阶段文档只记载 T13 前置门槛 PASS；**没有 T13 整体最终审批 PASS**。

### 5.2 明确失败及未关闭问题

| 问题 | 真实证据/当前状态 | 影响 |
| --- | --- | --- |
| 原完整基线 17 fail | T02 日志明确 exit 1；之后 zsh 和 14 项 Windows 夹具分别修复，完整基线没有重新执行证据 | 不能宣称原 Craft 基线全绿，也不能推算当前剩余失败数 |
| Windows SIGTERM smoke | `shuts down cleanly on SIGTERM` 失败；既有归因为 Bun Windows kill 行为与 POSIX 预期不同 | 受控关闭与 flush 不能靠该失败场景宣称通过；T16 门槛保留 |
| MCP 缺命令诊断 | `returns a clean command not found message for ENOENT` 失败，实际为 Connection closed 等 | 错误分类/提示仍待 T16 收敛 |
| Python 工具链 | 0 tests / 8 setUpClass errors，Python exit 5、外层 exit 1；缺 win32-x64 uv.exe/PATH uv | 原文档工具测试未通过；不能写“8 个测试通过” |
| 原 CI/包装脚本缺入口 | T02 记录 i18n、Electron validate 等引用缺失脚本 | 原有脚本名存在不等于可用交付流程，T16/T17 尚未关闭 |
| Europe PMC 正式公网 | OS DNS 曾返回非公网 `198.18.0.69` 而被拒绝；诊断替换公开地址后仍见 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` / `ECONNREFUSED` | Bun 默认适配器尚未通过。PowerShell 请求成功只证明另一网络路径可达，不替代正式实现通过 |

T13 开发过程也有真实失败并随后在专项范围修复，包括覆盖枚举不匹配、历史投影未阻断、测试配置缺失等；它们不是当前已确认仍失败的项目。历史类型错误修正不能代替最新完整类型检查。

### 5.3 当前工作区的未验证项

- 最新 T13（尤其新增 connection 实体/仓储变更后）的完整类型检查、相关广回归、构建、秘密扫描与正式入口集成：**未验证**。
- 当前完整 Craft 测试、完整 lint、支持范围完整 CI：**未验证**。
- 真实 GPT 官方服务、任意兼容服务、真实凭据存取与实际计费调用：**未验证**。截获 HTTP 契约及 worker inspect 不能替代它们。
- 连接测试名包含“staged key 清理”，但当前 stale revision 用例在 staging 前即拒绝；await 写密钥后并发 CAS 失败、撤权与崩溃清理：**未验证**，不宣称已有缺陷复现，也不宣称已覆盖。
- 真实大目录性能、多引用大快照的耗时/内存、真实显微格式、跨机器会话及安装包：**未验证**。
- 本轮没有启动服务；当前进程、端口和持续运行状态：**未验证**。

## 6. 最小可运行链路与阻断

### 6.1 有历史证据的最小后端链路

```text
隔离 launcher / Bio namespace / 固定 Bun
  → bio-index.ts + SQLite + 合成账号登录
  → HTTP/RPC 上传合成 PDF，或读取预授权合成资料
  → 解析 worker → 读取快照与定位
  → 人工内容创建证据 → 创建报告 → 人工核对状态
  → CSV/Markdown 导出 → 读取列表与版本 → 受控停止
```

证据是 T12 的正式源码入口启动程序与日志，相关实现已提交于 `b600679`；HEAD 另含 Windows 测试夹具提交。此链路**不需要模型、GPU 或公网文献检索**。当前包含 T13 改动的工作区是否仍可重复跑通，本轮未验证。

已存在的入口是 `bio:server`（经 `scripts/bio-launch.mjs` 启动 `packages/server/src/bio-index.ts`）和 `bio:account`。首次运行仍需项目固定运行时/依赖与自有 namespace、账号及所需资料预授权；本轮没有检查所有前置条件是否仍完备，也没有尝试启动。

### 6.2 用户预期的科研 Agent 链路

```text
登录/选择项目与公开来源
  → 明确模型连接 → 公开输入清单 → 公共科研 Agent / worker
  → 持久运行与候选 → 人工确认保存 → 版本化报告与导出
  → Web / 桌面访问同一服务
```

阻断按依赖排列：

1. **没有正式 T13 接线。** `bio-index.ts` 仍只组装 T12 及之前的服务；没有实例化 ResearchConnectionsService、PublicInputService、PublicModelWorkerService、PublicModelExecutor。`rpc-profile.ts` 没有连接管理/模型候选请求入口；START_RUN/CANCEL_RUN/GET_RUN 仍未注册。
2. **没有生产凭据集成与模型实测证据。** 连接模块可独立测试，不等于用户能够配置并调用官方或兼容模型。
3. **没有完整运行与会话闭环。** executor 只返回候选并写开始/结束审计；不自动保存，不提供完整运行 intent/租约/恢复/投影。现有历史投影保护会保守拒绝继续使用有投影的会话，不能通过删除保护来补齐流程。
4. **没有科研 UI。** Web 仅有认证 helper 接口，原 Craft 页面不能替代已禁用的旧 RPC；桌面/Web 共用科研流程尚未验收。
5. **在线检索路径受环境阻断。** 对“从 Europe PMC 搜索开始”的链路是阻断；对自有合成 PDF 或明确公开 PDF 的导入链路不是必需条件。
6. **当前集成与交付证据不足。** 最新未提交代码没有整体类型/构建/回归结果，worker 和依赖的正式包装尚未完成。

另有静态审计缺口：worker/runtime 多数 SDK、HTTP 及子进程异常统一为 `BIO_MODEL_UNAVAILABLE`，认证、限流、超时等 Spec 错误细分尚未闭合。这是源码观察，不是本轮执行失败。

## 7. 剩余任务优先级

P0 的判定目标是“首版供课题组实际使用并最终公开交付”；不表示本轮获准执行。

| 级别 | 剩余任务 | 完成证据/范围 |
| --- | --- | --- |
| P0 | 固定当前 T13 工作区范围并完成当前版本验证与独立审批 | 不丢弃未提交文件；最新类型、相关回归、构建、扫描与一致的阶段记录。现有专项 PASS 不替代此门槛 |
| P0 | 完成 T13 生产凭据与正式请求入口、错误细分 | 实际调用被选择的连接；权限变化/私有输入拒绝；并发密钥失败场景；受控真实官方与兼容模型验收 |
| P0 | 完成 T14 运行管理及会话投影 | 开始/取消/失败/重启恢复、租约与投影一致性；来源可证明的公开历史；无自动科学确认 |
| P0 | 完成 T15 最小科研界面和双端接入 | 登录、项目、来源/快照、证据/报告、运行状态及人工保存/导出，由实际界面访问同一服务 |
| P0 | 关闭 T16/T17 既定交付门槛 | Windows 受控关闭、MCP 诊断、Python/CI 支持范围与缺入口收敛；worker/资源完整包装；准确启动说明；代表性数据及完整支持范围回归 |
| P0 | 正式 Europe PMC 公网验收与完整端到端验收 | 在正常 DNS/受信 CA 的目标环境验证生产适配器，不关闭现有网络检查；真实服务与界面证据 |
| P0 | T18 公开 GitHub 交付 | 核对最终公开内容、来源/许可证、配置模板与文档；独立评判通过后再提交/推送。当前尚无本地远端配置 |
| P1 | 大目录与多引用性能优化 | 以代表性测量决定索引/缓存；当前存在同一大快照重复解析的性能观察，未完成规模验收 |
| P1 | 连接运维与界面易用性 | 明确配置创建者停用、管理员接管、旧密钥保留/清理策略；完善操作反馈与空状态 |
| P1 | 解析/格式兼容拓展 | 在实际课题组需求下补格式、覆盖提示和容错；先保留明确支持范围 |
| P2 | 细胞图像分类/训练推理、本地 LLM、4090 计算集成 | 已确认暂缓，不纳入首版科研平台最小闭环 |
| P2 | 任意通用工具、复杂自动化及更广科研流程 | 需要另行明确数据边界与验收目标，不为复用原 Craft 代码而自动开放 |

## 8. 下一步最小修复方案（仅建议，未执行）

**第一步只恢复工程确定性，不增加业务功能：**

1. 保留当前 8 个修改与 16 个新增 T13 文件，明确以 HEAD 加当前工作区为待验证对象；不回滚、不清理、不自动提交。
2. 先做最新 `research-core` / shared / server-core / server / Web 类型检查与已有 T13 专项；仅修复本轮改动引入的可复现编译/行为问题。之后按实际影响跑科研相关回归和现有正式入口构建，不用旧日志替代。
3. 使用既有 T12 合成资料启动程序复验“登录 → PDF → 快照 → 人工证据/报告 → 导出 → 停止”，避免把公网和模型配置同时引入基础链路诊断。若失败，记录具体环节再做最小修复。
4. 对当次最终差异和真实结果进行独立评判；未执行项继续标记未验证。完成后再决定恢复 T13 集成，不能用模块测试通过直接宣告平台可用。

**随后才是集成开发，不能混称已完成的修复：** 首先围绕一个明确公开的合成 PDF、一个明确选择的模型连接、一份经校验的候选完成受控服务验证，接入真实凭据存储和正式调用边界；不自动保存或人工确认。T14 持久运行与 T15 最小界面按既定依赖继续，最后再完成公网、包装和发布验收。此路径不需要细胞分类、GPU 或扩展通用工具。

以上仅为审计后的最小推进建议。**当前暂停开发的指令继续有效，本报告不触发修复、安装、测试或发布。**

## 9. 独立评判

报告提交前已由独立评判 agent `/root/t11_independent_judge` 进行只读事实预审：确认 T13 未提交且未接线、模型测试使用合成流/截获请求、真实凭据与并发失败场景证据不足、T12 PASS 不覆盖当前工作区。评判未编写本轮源码，也未运行测试、构建、服务或网络。

报告全文最终审批：**PASS**（2026-10-15，`/root/t11_independent_judge`）。按评判意见将 OME 多维映射、BigTIFF、subIFD 金字塔修正为明确不支持，评判已复核。该审批只针对审计报告准确性，不批准恢复开发、测试或发布。
