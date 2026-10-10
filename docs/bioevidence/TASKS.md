# BioEvidence 首版实施任务

版本：0.1.0

日期：2026-10-09（Asia/Shanghai）

状态：任务清单 2026-10-09 审批 PASS；T00–T02 已完成阶段审批 PASS，T02 完整原基线仍未全绿；T03 进入实施，其余未开始

依据：已批准需求、Constitution、Spec 0.1.0、Plan 0.1.0

## 执行与证据规则

人类已授权独立评判者审批文档，通过后直接实施。一个实现任务一个时点推进，使用 Red→Green→Refactor；评判者不写该任务代码。准备源码/工具、普通文档及低影响品牌修改采用校验和现有回归，不编造 Red。

每项任务记录实际命令、预期行为失败及原因、Green 结果、相关回归/类型/构建、文件差异、未验证项。前序契约未满足不启动依赖任务；环境失败先诊断，不算行为 Red。新文件路径只是批准修改范围，存在性及调用契约在准备和对应任务验证。

工作范围限 `work/bio-evidence`（独立派生仓库）、项目工具/合成 fixtures，以及本项目文档。原 ZIP、`work/craft-agents-oss-main`、其他项目、原 Craft 用户数据、真实实验目录与真实密钥保持不触碰。不得通过弱化已有检查、隐藏失败或不明文件覆盖来推进。

所有 Bun、SDK、测试、构建命令先经隔离 launcher。最初 neutral 配置不 preload 原 interceptor；安装前不加载未准备的 SDK，安装不启动应用。构建缺陷的 Red 只使用明确的合成秘密沙箱。首版不接 4090、不训练模型、不部署本地 LLM。

## 契约与依赖总览

| 契约 | 所属任务 | 后续使用 |
| --- | --- | --- |
| 固定快照、固定 Bun、neutral 执行环境 | T00 | 所有命令 |
| namespace/fail-closed/SDK 路径与安全日志 | T01 | 安装、测试、启动与子进程 |
| 干净构建环境与非秘密产物 | T02 | UI/桌面构建与交付 |
| Actor/Scope/Policy/Snapshot/Revision/Run DTO | T03 | 服务、协议、双端 |
| 事务仓储、版本、audit/outbox/projection journal | T04 | 身份、业务与恢复 |
| JSONL flush/安全替换/重建确认 | T05 | 会话持久化、运行 |
| 用户认证主体与会话生命周期 | T06 | RPC/HTTP/WS、事件 |
| 全通道资源授权与撤权/回放 | T07 | 全部科研与资料操作 |
| 预授权资料登记/分页/只读/关键词 | T08 | 资料界面与预览 |
| 受控帧预览与可终止解码 | T09 | 双端图片与连续帧 |
| 公开来源搜索/快照/缓存及来源层级 | T10 | 文献调研 |
| PDF/JATS 页/段落与覆盖 | T11 | 证据定位 |
| 证据/报告修订及引用/人工状态 | T12 | 生成、编辑和导出 |
| 公开 Agent 输入/工具/连接/辅助出口 | T13 | 科研运行 |
| 运行租约/取消/对账及 JSONL 投影 | T14 | 双端会话与端到端 |
| 共享登录/科研界面及两端 API | T15 | 真实界面验收 |
| 品牌/服务+WebUI/Windows 包装 | T16 | 运行交付 |
| AC 验证、独立审阅与必要收敛 | T17 | 发布证据 |
| 公开 GitHub 交付 | T18 | 用户最终目标 |

这是一条集成依赖序列。独立的只读事实核对和审阅可并行；不并行修改互相依赖的生产模块。模型/服务器配置缺口只影响对应真实验收，不阻塞不依赖它们的代码和测试。

## T00 — 准备固定派生源码和安全执行工具

**目标：** 得到可追溯、可恢复的独立代码副本与项目内固定运行时；任何后续命令不加载原 preload。

**范围：** 新 `work/bio-evidence`、来源记录、`.gitignore`、项目工具目录、neutral bunfig 与外部 Node/PowerShell launcher；不改业务或原始源码目录。

**输入/输出：** 输入 Plan 中 1877 文件基线与 ZIP 哈希；输出新 Git 基线、来源清单、Bun 1.3.10 路径/版本、neutral 配置与用途化环境。原 Git 配置不更改；新仓库作者使用用户公开 GitHub 身份，不复制简历联系方式。

**依赖：** 本清单审批通过。

**验证：** 检查目标不存在或属于本任务可证明的未完成准备；逐文件对比，记录 ZIP/文件哈希，确认原目录无修改。固定 Bun 只从官方路径取得并检查版本，不装到系统。launcher 的最小集成场景用本工作区测试 preload 哨兵，证明 neutral 不执行默认 hook、不继承业务秘密、不改变全局 HOME/CODEX_HOME。缺少固定运行时不静默改用全局版本。

**完成证据：** 来源/工具校验、Git 初始快照、无真实秘密或运行数据的 staged diff、neutral 哨兵验证；不要求准备操作伪造 TDD Red。

## T01 — 修正 preload 与 SDK namespace 隔离

**目标：** 所有应用/SDK/interceptor 的配置、日志和错误文件使用明确 BioEvidence namespace；缺失配置时先拒绝，不触碰原 Craft 目录。

**范围：** `bunfig.toml`、shared `interceptor-common.ts`/`unified-network-interceptor.ts`、config paths 与 SDK 启动路径、launcher；涉及隔离的硬编码逐项记录。

**输入/输出：** 输入 T00 neutral launcher；输出可验证的 namespace resolver、导入期副作用控制、配置/日志/错误文件安全路径与子进程环境。

**依赖：** T00。

**TDD：** 安装前 neutral/fake homedir/FS 测试先观察原实现写向假旧目录或忽略覆盖，再实现新 namespace；无 namespace 的 Bio 模式拒绝。安装用途 launcher 的环境及旧目录哨兵验证，不导入尚未准备的 SDK，不触及真实旧用户目录。日志只含允许字段，不能打印请求正文/头部秘密。

**完成门槛：** 安装前 neutral/fake FS、namespace、安装用途环境与旧目录哨兵均通过，即 T01 完成并允许 T02 在隔离环境安装。安装后的实际 SDK 导入和完整 interceptor/隔离回归属于 T02，不作为 T01 尚未完成的隐藏依赖。

**命令/证据：** neutral targeted tests、仅 built-in/已准备模块的子进程缺配置场景、环境白名单和旧目录哨兵未变。

**排除：** 不改用户全局配置、不读取旧凭据、不启动真实模型。

## T02 — 安装锁定基线并封闭客户端构建秘密

**目标：** 建立真实基线结果，移除根 `.env` 和 OAuth secret/telemetry 编译出口，之后才允许普通客户端构建。

**范围：** 基线安装、`scripts/electron-build-main.ts` 及其他发现的秘密 defines/env 加载、构建 launcher、跨平台 isolated runner、必要批准依赖/锁文件变更。

**输入/输出：** 输入已证明安全的启动环境；输出基线检查记录、安全构建配置、包锁和可重复 runner。新增 direct 依赖仅 Plan 已批准 fast-xml-parser 5.11.2；PDF.js 直接声明与既有锁版本对齐。

**依赖：** T00–T01。

**TDD：** 依赖安装后先完成实际 SDK 导入与完整 namespace/interceptor 回归，之后在只带合成 OAuth/API/服务秘密的 build 沙箱运行构建 Red→Green。原有编译路径产生标记是 Red，删除 secret define、根服务 `.env` 加载、关闭 telemetry 后构建各产物无标记为 Green。生产构建环境只接受非秘密字段；这两类安装后安全回归通过前不跑普通检查或应用构建。

**命令/证据：** fixed runtime frozen install（首次未改依赖）；approved lock 更新后 frozen 可重装；typecheck:all、webui:typecheck、原测试和 isolated 覆盖；安全 builder 产物检查只报文件/是否命中，不显示秘密。原基线失败和本任务失败分开记录。

**完成门槛：** 安装后实际 SDK/完整隔离回归与合成秘密构建 Red→Green 两类安全门槛通过后，才允许普通检查。普通基线的实际结果、必要修复与经批准的延期责任记录齐备，并获最终独立审批后才允许 T03；基线失败不能被忽略为已通过。

**2026-10-10 门槛补充（独立审批 PASS）：** T02 引入的回归与未归因失败不得延期。仅 Plan 第 18 节列出的已归因原 Windows/工具基线问题，经独立审批后可进入责任任务；完整常规结果保留 fail/error/exit 码。14 项模式路径夹具必须在 T13 **开始前**修复，不降低 realpath guard；Windows 退出、MCP 诊断、必要 Python runtime 和替代 CI/包装在 T16 **完成前**关闭。RPC/模型附件/BrowserPane 的相关修复分别在 T06/T13/T15 前回归验证。T17 重新跑交付支持范围全回归并关闭阻断，不把登记自动转为豁免。

## T03 — 建立科研领域与 runtime 协议契约

**目标：** 共享 Actor、授权范围、资料策略、快照/定位、修订、运行/事件与错误，避免前端和后端各自解释字段。

**范围：** 新 `packages/research-core`、shared protocol DTO/channels/events 与契约 tests；不加入 SQLite/文件/模型实现。

**输入/输出：** Actor 来自服务端；Scope 为 personal owner 或 project membership；Policy 为 public/restricted/unknown 且不由客户端自授。Snapshot 记录取得方式、coverage、blocks 和 provenance；Revision/Run 的 expectedRevision/lease/generation 明确；所有不可信输入 runtime 校验。

**依赖：** T02。

**TDD：** 伪造 actor/public、未知字段/标识、混合策略、缺失定位、错误修订与非法状态迁移拒绝；结构引用检查不声称语义科学正确。测试行为而非只断言类型对象存在。

**命令/证据：** `test:bio` 领域子集、research-core typecheck、shared 回归；说明新增契约版本。

## T04 — 实现事务元数据与完整投影 journal

**目标：** 以 SQLite 作为权限和科研业务权威，提供 CAS、audit/outbox 与可重建投影数据。

**范围：** Bun 服务侧 adapter、research-core repository interfaces、server-core 依赖注入、schema migrations 和 repository tests。

**输入/输出：** 实现 Plan 的账户/成员/归属/授予/来源/修订/运行/索引/审计表。projectionJournal 保存完整已提交消息或不可变内容引用及顺序/hash/opId；接口不向 Node/renderer 静态导入 bun:sqlite。

**依赖：** T03。

**TDD：** 修订与成员更新竞态只有合法事务提交；失败不产生成功 outbox；错误绑定和未知旧资源拒绝；journal 可以重建完整历史而非只有 ID。SQLite in-memory 与临时持久文件的 restart 验证。

**命令/证据：** repository tests/typecheck；迁移/备份/单写入者行为，数据与 runtime 文件忽略规则。

## T05 — 修复 JSONL flush、替换与重启对账

**目标：** flush 成功代表要求代数已持久化，失败传播；崩溃不丢唯一副本，并可按权威 journal 重建。

**范围：** shared `sessions/persistence-queue.ts`、`storage.ts`、必要 JSONL header 元数据、server projection service。

**输入/输出：** enqueue/debounce/flush 统一串行，flush 等前序/当前代数；写错误可观察；不预删目标；tmp 按 journal/hash/generation 对账；未知 tmp 保留/隔离。

**依赖：** T04。

**TDD：** debounce 已开始但 pending 清空时 flush 仍等待；write/rename 注入失败保留旧文件且 reject；旧正式文件+完整 tmp、中断替换、坏 tmp、重启从完整 payload 重建均验证；只有确认成功才标 projected，重复对账不重复消息。

**命令/证据：** persistence targeted、现有 sessions 回归、真实临时目录 rename/restart 检查；OS 限制明确标注，不用假通过替代。

## T06 — 实现统一账户和可信登录主体

**目标：** Web/桌面同账号身份，24h 默认到期、退出/停用失效，旧共享 token 不是用户身份。

**范围：** server auth service/HTTP endpoints、transport RequestContext、Web auth helper、初始化/账户管理 CLI、必要 bootstrap。

**输入/输出：** Argon2id 摘要、已持久化认证会话、可信 ActorSubject；cookie/bearer 解析同一身份。凭据和 signing material 在新 namespace，前端不收模型密钥。

**依赖：** T03–T05。

**TDD：** 正确/错误登录、到期、撤销、停用、伪造角色/uid、旧 server token、Cookie/Host/Origin 和不可信代理；身份事件后续内容拒绝。仅合成账号/密码。

**命令/证据：** auth service+HTTP/WS harness tests、typechecks；证实 TLS/loopback 规则与日志没有凭据。

## T07 — 覆盖旧/新 RPC、资源列表与事件撤权

**目标：** 个人/项目关系是真正服务端权限，每条可用通道都有规则，事件和回放不会绕过。

**范围：** server transport gate/push/replay、handler-deps、RPC 注册清单与所需旧 handlers、项目/个人空间视图、client capability 路由。

**输入/输出：** channel→action/resource resolver 与默认拒绝；资源从可信绑定解析，列表过滤；本人会话执行与成员可读分开；未知/不需要 legacy 功能明确禁用。

**依赖：** T06。

**TDD：** 三账号两项目直接 RPC、猜/换 ID、其他 workspace、原 raw file/share/settings/transfer 等绕过、已连接撤权、重连缓存复用另一身份、能力请求落错客户端；全部拒绝且没有正文。

**命令/证据：** transport/RPC/event 集成 tests、频道覆盖清单、shared protocol/两端类型；授权审计范围检验。

## T08 — 预授权资料入口、只读索引和关键词

**目标：** 负责人登记不能增加磁盘权，大目录逐批可浏览，原图不被上传/整批读取。

**范围：** rootGrant/config loader、MaterialsService metadata/index/list/text search、资料 RPC/HTTP 的资源绑定。

**输入/输出：** grant/rootId/fileId/relativeDir/cursor；自然名称排序的完成目录快照、默认100/上限200、变化使游标失效。文本解析预算与私有标签继承；index/notes 不写实验原文件。

**依赖：** T07。

**TDD：** 未授权登记、他项目父根、内部凭据目录、路径前缀/..、symlink/junction/打开替换拒绝；10,000 合成文件分页不读取原图；离线、变化、超预算与权限撤销；关键词不调用模型或外部服务。

**命令/证据：** materials tests、读写观测/目录前后核对；合成与真实4090状态分开。

## T09 — 图片、二维 TIFF 与连续帧预览

**目标：** 两端按需查看有权限的帧，预算/失败/超时不拖垮其他资料。

**范围：** sharp metadata/页选择接口、独立 decode subprocess、受控 file stream、frame descriptor/API 与现有预览 loader。

**输入/输出：** 资源ID/frameIndex/previewKind；256/2048 预览，256 MiB输入、50M像素、并发2、5秒初始预算；超时真实进程退出；原文件只读，下载不整文件base64。

**依赖：** T08。

**TDD：** PNG/JPEG/单/多页TIFF、有序文件、坏文件、超预算、文件消失、撤权中断传输；确认只处理所选帧，超时释放子进程/资源，不只reject等待。

**命令/证据：** 图像/进程退出/stream tests、metadata与原文件hash；不做视觉分类。

## T10 — Europe PMC 与来源快照

**目标：** 真实题录/摘要/开放全文获取，去重与缓存不跨权限/策略泄露。

**范围：** LiteratureProvider、固定服务URL与redirect/address guard、source/snapshot service、缓存与公开声明流程。

**输入/输出：** query/cursor/pageSize/signal、稳定标识、真实元数据、许可和可用性；immutable source revisions，取得失败保留摘要/题录，不声称正文已读。

**依赖：** T07。

**TDD：** 分页/空/限流/超时、混合标识去重、无ID不按标题强并、跨空间私有批注无复用、未知来源默认private、任意URL/内网访问拒绝。声明记录actor/time，内部复制不降级既有私有策略。

**命令/证据：** provider fake tests +实际少量公开检索；不下载整套数据、不向外部发实验查询。

## T11 — 页级 PDF/JATS 解析与实际覆盖

**目标：** 可回查的页/段落与未读取范围，不以解析成功冒充全文完整。

**范围：** PDF.js页级服务、JATS保序/locator服务、解析预算/取消与受控worker、snapshot blocks。

**输入/输出：** 原始字节或公开XML、取得方式、sourcePolicy；输出覆盖与block定位、缺口/失败。PDF25MiB/100页；XML10MiB/深度64/节点100k预算在解析过程中执行，禁止实体/外部解析；PDF文本总5M字符预算不假装全文。

**依赖：** T10；私有本地解析还依赖T08。

**TDD：** 纯/混合扫描、摘要PDF、加密/损坏/超页/字节、Unicode定位；JATS嵌套属性/顺序/实体/节点限额早停、不可解析表图记录缺口。没有云端OCR，所有样例为合成或许可公开片段。

**命令/证据：** parser targeted/typecheck、覆盖快照与定位人工核对；真实Node/Bun导入路径已通过隔离。

## T12 — 证据、报告、修订与安全导出

**目标：** 原文关系可回查；结构校验与科学审阅不混淆；多人/多端编辑不覆盖。

**范围：** EvidenceService/ReportService、repository事务、CSV/Markdown导出与状态规则；不写模型生成循环。

**输入/输出：** sourceSnapshot/block/quote/locator、expectedRevision、claim→evidenceRevision；新版重新核对/审阅，历史状态保留但不沿用，私有衍生策略不降低。

**TDD：** 错片段/定位/引用、真实但不支持结论的反例、用户需修改结果、已审阅版本改动失效、来源更新stale、并发CAS、导出公式中和/原HTML不执行、权限校验与审计。

**依赖/证据：** T11；service/revision/export tests，引用样例核对，领域/server typechecks。

## T13 — 公开 Agent profile 和严格模型连接

**目标：** 复用AgentBackend，但实际模型输入与所有helper/tools受公共资料白名单控制。

**范围：** BackendConfig/factory/BaseAgent/PreToolUse/Pi worker、输入Manifest builder、SDKresource loader、配置/凭据broker与辅助调用。

**输入/输出：** 服务端可信public InputManifest、当前授权和严格选定model；输出已验证结构的候选证据/报告事件。public run隔离目录不加载项目/祖先/全局AGENTS、MEMORY、插件或未分类Skills；工具不注册read/bash等通用能力。

**依赖：** T07、T11–T12。

**TDD：** private/mixed/unknown/被污染history、客户端假public、后端helper/自动title/压缩/临时Agent/来源激活、工具尝试私有读取及ask/allow-all覆盖均没有秘密或实验内容出口；所选连接失效零fallback；不能给compat起名local绕过。SDK最终观察输入不含合成私有标记，未知自动内容拒绝。

**命令/证据：** 模型/工具多出口fakes、实际worker契约、source/shared/subprocess回归与typecheck。live模型只用明确已配置凭据及公开样例，缺配置如实保留未验证项，不阻塞其他能力。

## T14 — 科研运行与投影、取消、重试和双端状态

**目标：** 有效租约只有一个，取消/撤权晚到响应不覆盖，恢复真实说明完成/中断。

**范围：** ResearchRunService、SessionManager挂接、outbox、投影journal、运行event DTO与renderer状态adapter。

**输入/输出：** runId/stepId/opId/generation、输入manifest/连接、持久化步骤和产物；兼容原AgentEvent/JSONL，不将已收事件当已落盘。

**依赖：** T05、T13。

**TDD：** 双端同时启动、取消/撤权中response晚到、client断连续看、进程崩溃与flush失败、DB提交/JSONL投影窗口、未明模型intent提示明确重试；重试不重复完成产物，用户修订不覆盖。执行授权绑定运行所有者和当前成员，而非冒用请求字段。

**命令/证据：** run/transport/restart故障集成tests、JSONL与DB结果对账、outbox接收和拒绝记录。

## T15 — 共享登录、项目和科研界面

**目标：** Windows桌面和Web同一业务界面完成公开调研及私有浏览。

**范围：** 共享renderer科研页面/登录及空间视图、CHANNEL_MAP/ElectronAPI/Web adapter、预览/editor/table/locales；主进程会话与本地chooser仅绑定本人窗口。

**输入/输出：** 已批准typed API，当前账号/项目/connection/model/coverage/revision/运行；目录资料与模型生成分别显示，无连接时仍可手工操作。

**依赖：** T09、T12、T14。

**TDD/验收：** 用户可观察登录/项目切换、论文选择、证据页定位、草稿/结构通过/人工审阅状态、冲突保留文字、目录预览/下一帧、cancel/retry。不同账号不残留上一个人的资源/草稿；真实API接口隔离失败反馈清楚。组件测试+浏览器实际操作+Electron thin-client实际运行，不能仅截图替代核心检查。

**命令/证据：** renderer targeted、webui/electron/shared types、Web与Electron构建，保存合成数据界面证据。

## T16 — 品牌、运行包与部署说明

**目标：** 可启动的BioEvidence双端与服务，不靠失效root build/release或旧Docker引用。

**范围：** productName/appId/scheme、统一branding/logo/icon/HTML、实际build/dist scripts、服务+WebUI资源组装、Dockerfile/启动说明与SDK/native资源。

**输入/输出：** appId拟`com.gtdd123.bioevidence`，新产品目录/图标、服务同端口9100、明确已测试系统与未验证包装。SDK资源保留兼容所需，工具/功能由profile限制。

**依赖：** T15。

**验证：** Windows build/thin-client启动、server+WebUI静态资源实际访问、产品目录与协议、秘密/遥测与源码来源扫描；Docker/其他OS若本机无法运行如实标明，不假装已构建。品牌/doc普通修改不加镜像tests，启动/资源加载有必要检查。

**排除：** 不安装系统工具、不部署到真实服务器、不发布网站。

## T17 — 完整 AC、独立审阅与收敛

**目标：** 29项AC逐条有实际证据或明确未验证原因，完成Spec审阅再做代码质量审阅，修复阻断。

**范围：** 所有已实现模块必要修正、tests、验证记录及文档状态；新增范围回到批准契约处理。

**依赖：** T16。

**验证：** 三账号撤权/事件、10000文件与frames、公开来源+PDF→证据→报告、两端同会话、cancel/restart、helper出口与fake秘密成品检查，固定Runtime类型/回归/构建。实际模型/真实4090独立标证据，缺信息不虚构PASS。

**完成：** 独立评判者检查Spec compliance，另做quality/一致性审阅；有阻断则修复再复审。产物记录exactcommands/exit/output摘要、diff范围、未验证与限制。可用的首版交付不能写成实际私有资料已接入或所有模型已验证。

## T18 — 公开 GitHub 交付

**目标：** 按用户既定授权把已审阅源码发布到`gtdd123/bio-evidence`并返回可用链接。

**范围：** 该项目Git历史/remote、已审README/来源/部署/演示/验证与必要公开元数据；不操作其他仓库或邀请他人。

**依赖：** T17，独立评判者发布审阅通过；若部分真实环境验收无法完成，必须由评判者明确批准标有对应限制的首版，不宣称全部AC满足。

**步骤/证据：** 实时核对账号与目标状态/写权限；连接器不能建仓库时使用已授权GitHub网页或现有标准Git路径建公开仓库，优先Git push；先确认待提交无原数据/密钥/简历。核对远端commit、README与源码可读，保存仓库URL及发布内容。若创建PR必按app规则附加PR artifact。

**外部缺口：** 所需登录/访问若不能从已有授权工具完成，代码和review先做完，再仅向人类请求该项缺失；不得使用评判批准虚构凭据或改发其他仓库。

## 任务状态记录

T00：准备与 neutral 校验完成；独立评判者复跑 4 pass/0 fail 并审批 PASS，授权 T01。证据位于派生仓库 `docs/bioevidence/evidence/T00-preparation.md`、`T00-validation.md`。

T01：独立评判者复跑 25 pass/0 fail/exit0，关闭 Windows 混合大小写 hook 旁路后审批 PASS。证据：派生仓库 `docs/bioevidence/evidence/T01-isolation.md`。

T02：2026-10-10 独立阶段审批 PASS；完整原基线尚未全绿，依 Plan18 责任门槛收敛。T03：进入实施。T04–T18 未开始。

实际每项完成后更新任务状态与其验证记录；文档/接口实质改变再次交独立评判者审批，普通执行证据作为审批记录保留，不形成无限递归的自我审批文档。
