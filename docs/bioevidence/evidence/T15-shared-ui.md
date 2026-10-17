# T15 — 共用科研界面与桌面薄客户端

记录日期：2026-10-16 至 2026-10-17（Asia/Shanghai）。实现、后补修复、四文档一致性和 T15 阶段均已独立审批 PASS。未完成 T16 包装、T17 全部 AC 或 T18 GitHub 交付。

## 实现与继承边界

- 新增 `apps/electron/src/renderer/bio/` 共用科研界面，Web 与专用 Electron 入口挂载相同 BioApp。包含登录、空间/会话、文献/读取快照、证据/报告修订与人工核对、公开 Agent 运行、私有资料/选帧/批注、成员和模型连接配置。保留原 Craft renderer 源码，Bio 入口不挂载原 Craft App。
- 复用 Craft 的 React/i18n、基础控件与 TanStack 表格、typed channel map、WS client、原 SessionManager/科研服务；新增 Bio host/controller、专用 main/preload 和构建配置。没有把原浏览器、shell、MCP、分享或通用 Agent 工具重新开放给科研界面。
- 新增只读快照目录、产物修订历史和管理员完整非秘密连接配置 API。cursor 绑定确切 source/产物族，响应经过当前授权与权威值核对；模型 key 仍留在服务凭据层。管理员按已知连接 ID 载入，可修改 disabled 连接；本阶段未新增全局连接管理目录。
- 同端口 UI 只提供有界、固定 manifest 和 SHA-256 核对过的 index/assets；不暴露配置、任意文件或 sourcemap。`/api/config` 要求当前认证；新 Bio UI 还必带预期 sessionBinding，服务端核对已提供的绑定，既有兼容客户端仍可不带。静态入口本身不含业务资料。服务启动时固定资产快照，重新构建后需重启服务。
- Browser cookie 的非认证 sessionBinding 固定到当前客户端身份，配置/当前账号/上传/注销和 WS 重连均核对；带绑定的注销不清除新 cookie。Electron 每个窗口独立 bearer，仅主进程保存；renderer 只有结构化业务 DTO，无通用 invoke、Node、原 preload API 或 bearer。
- 区分编辑产物、执行本人会话、取消本人运行、管理资料的能力。成员可读共享来源/产物，不因此取得别人的会话输入/执行权。运行详情显示持久步骤、所选片段来源准备数量、明确的未知请求/用量状态及确切产物修订回链。
- 草稿仅在当前窗口内存，按服务 origin/账号/资源隔离，4 MiB/100 项预算；容量满明确报错，不静默淘汰旧稿。发起运行前必须成功保留带 operationId 的冻结提交；不能保留则不发请求。关闭或重载窗口不保证未保存稿恢复，已保存资源和运行从服务重新读取。
- 批注草稿固定 file/generation 并携带原 baseRevision。新保存修订不会自动重基；刷新可对照最新内容，明确合并/放弃才切换基准。证据和报告保留修订/CAS，结构有效与人工核对分别显示。
- 新增 270 个 `bio.*` 文案，中文/英文，其他五个既有 locale 显式使用英文回退内容。没有安装新增依赖。

## 测试驱动与实际发现

各记录是不同执行，不相加为一次结果。缺模块诊断不计为产品行为 Red。

| 场景 | 实际失败/诊断 | 修复与验证 |
| --- | --- | --- |
| UI 发现接口、HTTP 入口、typed namespace | 新通道 denied、首页 404、缺 research namespace | discovery 3/0/23 expects，HTTP 1/0/17，proxy 1/0/3 |
| cookie 身份绑定与 dispose | 原账号上下文会接受新 cookie，queued restore 可重连；7 项中 4 项失败 | binding/controller 7/0/35；评判独立复跑相同 7/0/35 |
| WS URL 约束 | 绑定 query 被旧 URL 校验拒绝 | 3/0/15，仍拒绝额外/重复 query、凭据及不安全远端明文 |
| 权限按钮与拒绝通知 | capabilities 缺模块是诊断；拒绝后通知丢失是真断言失败 | 角色与 controller 9/0/32，随后补成功 listSpaces 移除/降权通知；后者先有缺导出诊断，再行为 Red 4/1/7 |
| Electron 错误类别 | 实际 contextBridge 丢失 Error.code | 改为 plain `{ok,result/errorCode}`，renderer 重建固定 ResearchError；真实双窗口复验 |
| HTTP 错误类别 | 所有 403 误归 BIO_ACCESS_DENIED，PDF budget 非 2xx 丢结构状态 | HTTP 2/0，DTO+HTTP 3/0/9；保留固定公开 BIO 错误，不回显原路径/正文 |
| 摘录选中 | React 18.3.1 的既有 Textarea 不转发 ref，选择 0–59 仍未启用摘录 | 读取 onSelect.currentTarget；实际浏览器选中/加入/证据定位通过 |
| 批注并发 | revision 分键但没有批注历史 UI，会使旧稿无法找回 | 固定 file 草稿与原 CAS；2 项模型测试及真实并发界面核对 |
| 草稿满额 | 旧实现不拒绝新内容，会淘汰原稿；真实 Red 1/1/8 | 原子检查容量并明确拒绝；最终客户端回归覆盖旧稿保留 |

早期 Electron 类型失败来自测试 fetch mock 缺 Bun `fetch.preconnect` 类型及批注测试夹具缺 policy，分别修为显式 unknown cast 和真实 restricted policy；没有放宽生产契约。早期 lint 为 9 警告，随后稳定 reload/补完整订阅依赖；最终 33 文件 0 错误/0 警告。自定义 useResource 的显式资源依赖有一处带原因的局部 exhaustive-deps 注释，不关闭项目规则。

## 实际浏览器与原生验证

使用真实 `startBioServer` 源码入口、SQLite、认证/RPC、PDF worker、图像 worker、产物/运行服务。只使用隔离 `.runtime/test/05333c05-2d47-4442-bae5-3f4eaa5f0e6a` 和合成目录；未访问真实实验资料或 4090。

模型边界：夹具仅在测试进程中替换 worker.run，生成确定性候选或模拟超时/取消；**真实模型请求为 0**。这证明 UI 编排/持久化链路，不能替代 T13 SDK 测试或真实 GPT 验收。

1. Web Alice 登录、选择项目/会话、读取两页合成 PDF。第 1 页有文、第 2 页无文本，界面如实显示部分读取 1/2。选择 UTF-16 0–59 原文，保存证据、定位 exact quote、人工核对与 v1 历史；真实导出 CSV。
2. 结构化报告映射确切证据修订，人工核对后真实下载 Markdown；报告可回到证据及原文。CSV/MD 实际落地于本机检查目录并核对内容，不是截图库。
3. 后端并发保存 v2 后，用旧 v1 保存返回 BIO_REVISION_CONFLICT，保留包含 `<script>` 字面文字的未存稿，不作为 HTML 执行。
4. 确定性运行模拟失败并显示不明请求；仅明确重试生成一个完成运行与文件投影。另一次 slow 运行由 UI 明确取消，保持 cancelled，不自动重发。共享持久记录共 4 条，其中首条 BIO_INPUT_INVALID 是夹具使用错误 callId 的准备失误，不能算产品故障或真实模型失败。
5. 私有会话问题/确认/启动不可用；资料可索引、读取真实 TIFF 元数据 48×32/2 帧，界面实际显示第 2 帧。实验内容未自动加入公开输入。
6. Alice/Bob/Charlie 三账号和两个项目：Bob 只见所属 Synthetic Lab，Charlie 只见 Isolated Lab。新标签退出 Alice 后登录 Bob，旧 Alice 视图清空为登录，未冒用 Bob。Bob 不读取 Alice 窗口未保存的批注/标签。
7. 自动审批两次拒绝合成成员撤权；用户随后明确授权在上述临时库撤销 Bob/Synthetic Lab 并恢复。实际撤权清空旧项目/私有视图，显示固定“权限变化、草稿保留”提示；恢复成功 ack 后，Bob 原批注/标签稿仍在。没有修改真实成员权限。
8. 最新批注实现实际验证：Alice 留存原基准草稿，独立测试 API 的 Bob 从 revision 1 保存为 2。Alice 保存触发真实冲突；刷新后可展开 Bob 新内容，同时保留 Alice 文字/标签；明确合并后保存，并刷新确认新内容。`T15-note-concurrent.log` 记录服务端并发修订，初次夹具错误使用 browser login 取 token 的失败已更正为现有 desktop helper，不算产品失败。
9. Electron 39.2.7 使用真实专用 main/preload/bio.html 和共享 renderer，两个独立窗口 Alice/Bob，核对主进程持有 bearer、禁用原 API、共享 4 条运行、完成投影、私有 TIFF、窗口归属、注销互不影响和仅保存非秘密 origin。原生 chooser **以应用 API 替身提供合成路径**，实际有界读文件/HTTP 上传/导出写文件；**没有人工操作 Windows 原生文件对话框**，也不是安装包验收。

本机原生截图为 `.runtime/checks/T15-desktop.png`；导出为 `T15-ui-evidence.csv`、`T15-ui-report.md`、`T15-native-report.md`。这些与含测试配置的临时运行记录均被忽略，不提交测试账号、私有正文或凭据。

## 最终命令与可复核记录

仓库测试文件可重复执行；`.runtime/checks/` 中 UI/native orchestration 夹具是本机测试环境，不随源码发布。T17 仍须补完整交付演示与支持范围验收。

```powershell
node scripts/bio-launch.mjs test test packages/research-core/src packages/server-core/src/research packages/server-core/src/transport/__tests__/user-session-url.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/protocol/__tests__ apps/electron/src/transport/bio-client.test.ts apps/electron/src/transport/bio-http.test.ts apps/electron/src/transport/bio-api.test.ts apps/electron/src/main/bio-window-access.test.ts apps/electron/src/renderer/bio/capabilities.test.ts apps/electron/src/renderer/bio/drafts.test.ts apps/electron/src/renderer/bio/desktop-host.test.ts packages/shared/src/i18n/__tests__
node scripts/bio-launch.mjs test test apps/electron/src/renderer/bio apps/electron/src/transport/bio-client.test.ts apps/electron/src/transport/bio-api.test.ts apps/electron/src/transport/bio-http.test.ts packages/shared/src/i18n/__tests__ packages/shared/src/protocol/__tests__/research-run-state.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/electron/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/research-core/tsconfig.json
node scripts/bio-launch.mjs build run scripts/bio-electron-build.ts
node scripts/bio-launch.mjs build run scripts/bio-renderer-build.ts web
node scripts/bio-launch.mjs build run scripts/bio-renderer-build.ts desktop
node .runtime/checks/T15-lint.mjs
node .runtime/checks/T15-native-launch.mjs
node .runtime/checks/T15-scan.mjs
git diff --check
```

- `T15-final-regression.log`：402 pass/0 fail/12,797 expects，55 文件/154.56s/exit0，早于最后纯客户端通知/批注/预算修正。其后受影响范围 `T15-final-ui-regression.log` 为 88 pass/0 fail/163 expects，10 文件/356ms/exit0；不合并为一次 490 项。
- `T15-final-all-types.log`：原八包 exit0，早于最后纯客户端修正；最后冻结提交容量保护后 Electron/Web 单独复验，`T15-final-electron-types.log`、`T15-final-web-types.log` 均 exit0。`T15-final-domain-types.log` exit0。无错误的 tsc 日志为空，exit0 来自真实命令完成结果。
- Web 260 modules，约 1.34 MB JS；桌面 renderer 251 modules，约 1.31 MB JS。两端构建成功但仍有 chunk 大于 500 kB 警告，未消除或隐藏；不等于完整正式分发包已构建。
- 用户中断后一次 native 收尾复验连接超时；核对原 owned 服务 PID 已不存在、同一端口拒绝连接，保留 `T15-native-interrupted-fixture.log`。恢复同一临时夹具后 `T15-native-final.log`/result.json 再次 PASS/exit0；未修改登录条件或延长断言使其通过。最终受控停止 ack 为 `stopped:true`，owned launcher 已退出，匹配该隔离 namespace 的 Node/Bun/Electron 运行进程为 0；不等于 T16 原 Windows 全部服务退出门槛已关闭。
- `T15-final-scan.log`：宿主秘密模式 1 个，源码 1,917 文件/构建物 124 文件，命中为空，三个合成 UI 标记也无命中/exit0；不是全面凭据、依赖漏洞或供应链审计。包含本阶段文档，最后审阅记录更新后再核对。

## 未验证与后续责任

- 真实官方 GPT、兼容公网模型和准确 token/费用未验证；不显示默认 usage 为实际零费用。
- Europe PMC 生产 Bun 适配器公网 DNS/TLS 阻断仍属 T17 发布门槛，未通过前不宣称在线文献检索已交付。实际检索 API 的替身/契约证据与公网成功分别判断。
- 未完成正式 Windows 安装包、document/PDF.js/image/native worker 分发验收、原生 chooser 人工操作、全量原 Craft 套件/CI、Docker/其他 OS；T02 Windows 退出/MCP/Python 工具遗留仍按 T16 责任收敛。
- 未连接真实资料服务器、进行大规模实验数据/多引用性能验收或本地模型部署。本轮没有 GitHub 推送。
- 模型配置按已知 ID 管理；全局连接目录、更小前端包体、更多语言翻译可后续优化。没有把这些当作已实现。
- 本阶段无数据库 migration。回退前先停止 Bio 服务并保留 namespace 数据；旧 UI 不应自动重放任何运行或不明请求。

## 独立审阅

`/root/t14_independent_judge` 独立只读审阅，先发现并推动修复角色能力混用、运行细节缺失、撤权提示丢失及同类会话输入接线；批注修复后顺序给出 Spec PASS、代码质量 PASS。实际独立复跑 19 pass/0 fail/66 expects，5 文件/283ms/exit0。草稿预算/冻结提交保护追加复核后，再独立执行 14 pass/0 fail/57 expects，4 文件/220ms/exit0，不把两次执行合成一个数字。其余作者 GUI/原生记录未由评判重做。2026-10-17 最终给出追加 Spec PASS、质量 PASS、四文档一致性和 T15 阶段审批 PASS，授权本地提交并推进 T16。真实环境和正式包装门槛保留。
