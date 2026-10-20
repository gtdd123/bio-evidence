# T16 运行与交付证据

日期：2026-10-18–20（Asia/Shanghai）。前置提交 `21119cf`。最终运行、打包、扫描已完成，**独立 Spec→代码质量→文档一致性及 T16 阶段均 PASS**。以下只记录实际观察；T17/T18 的真实环境与发布门槛保留。

## 交付实现

- `bio-start.mjs` 复用隔离 launcher 的准备步骤，明确选择科研服务或 Bio 桌面入口。服务为 Bun 1.3.10 运行目录，桌面为 Electron39.2.7 Windows x64 薄客户端；没有制作 Windows 原生服务 exe。
- 仅在受信启动参数 `--control-stdio` 下接收有界本地 heartbeat/shutdown。正常、重复、EOF、无心跳、监督进程突然结束与挂住子进程均有测试；服务清理后再报告停止，15 秒强杀明确失败。没有 HTTP/RPC 关机接口。
- 产品名/0.1.0/appId、SVG/PNG/ICO、窗口与可执行文件版本资源改为 BioEvidence；版权和原许可证保留。客户端不调用上游更新或遥测，旧默认启动/包装/发布入口关闭或导向 Bio。原始未启用的 Craft 源码仍保留。
- 源码桌面仍必须使用隔离 launcher。正式包由受信 bootstrap 在读取业务模块前明确建立 `%APPDATA%/BioEvidence` namespace；继承的模型/钩子环境被过滤，包内 Electron 禁 RunAsNode、NODE_OPTIONS 和 CLI inspect，并限定从 app.asar 加载。namespace 和 profile 子目录不得经 symlink/junction 重定向。
- 服务组装保持 package 相对结构：主程序、账户和资源检查入口，以及 document/image/Pi workers；PDF/JATS 提取、PDF.js 内部 worker、sharp/native、Pi SDK 以现有安装版本和依赖闭包保留。workspace 内不同版本的嵌套依赖没有扁平化替换。清单列大小/版本，自有运行文件另列 SHA256；不把它称为整个闭包的签名认证。
- 打包输出只新建于经 canonical/symlink 检查的 `.runtime/build/deliveries`；启动器也在首个 mkdir 前检查全部运行目录和现存祖先，不递归覆盖、清空或删除旧交付目录。Windows 桌面产物是未签名便携目录，OS 协议注册、安装器和自动更新尚未提供。
- README 提供准备、构建、账户初始化、服务/桌面启动、停止、资料授权及已验证范围。CI 使用实际存在的 workspace 和同一验证入口；Docker 改为同一隔离源码服务，不使用旧共享 token 或上游发布流程。

## 实际命令与结果

所有 Bun 命令均经项目 Node launcher；以下路径均相对仓库根目录，独立运行目录例外。

| 检查 | 实际命令/观察 | 结果与边界 |
| --- | --- | --- |
| 初始 shutdown Red | `node scripts/bio-launch.mjs test test packages/server/src/bio-shutdown.test.ts`；`T16-shutdown-red.log` | 原入口不处理监督通道，两项超时失败；之后实现协议与关闭流程 |
| shutdown/lifecycle/lease | `T16-supervisor-final.log` 对应四文件测试 | 9 pass/0 fail/20 expects，包含管道保持打开但无心跳的真实服务超时 |
| 正式入口与 Node supervisor | `node scripts/bio-launch.mjs test test packages/server/src/bio-smoke.test.ts packages/server/src/bio-supervisor.test.ts` | 增量记录 7 pass/0 fail/26 expects；最终套件已包含移除裸 PID 强杀后的 fixture 自退与子进程自退出断言 |
| MCP Windows 兼容 | `node scripts/bio-launch.mjs test test packages/shared/src/mcp/__tests__/validation.test.ts` | `T16-mcp-final.log`：8 pass/0 fail/28 expects/32.87s，MCP_EXIT=0；包含缺 PATH 命令及 quoted PATH 正例。Bio 仍不开放 MCP |
| Node 隔离与构建回归 | `node scripts/bio-tests.mjs --node` | 最新 `T16-node-final-20261020.log`：36 pass/0 fail/18.21s、NODE_EXIT=0，含真实启动命令的两项 junction 拒绝；此前统一验证中的 33 项与 bootstrap 修复后的 34 项是历史批次，不相加 |
| 科研/入口与统一验证 | `node scripts/bio-validate.mjs` | `T16-validation-final-run.log`：318 pass/0 fail/12265 expects/48 files/154.60s，随后八个包及 Web 类型检查、Web/桌面 renderer 和 main/preload 构建、合成资源检查均完成，BIO_VALIDATION_EXIT=0。后续修改为 bootstrap/launcher 的前置目录检查及独立部署说明，受影响 Node 36 项另行全跑；不是完整 Craft 套件 |
| 包装脚本严格类型 | `node scripts/bio-launch.mjs bootstrap run tsc --noEmit --module esnext --moduleResolution bundler --target esnext --types bun,node --allowJs --esModuleInterop --skipLibCheck --strict scripts/bio-desktop-package.ts scripts/bio-server-package.ts scripts/bio-electron-build.ts` | exit 0。原工作区 typecheck 不包含 scripts，因此单独检查 |
| shared/server 类型 | 固定 launcher 下 `tsc --noEmit -p packages/shared/tsconfig.json`、server 同式 | 均有 exit 0 记录；最终统一 typecheck:all/Web 也通过 |
| 源码资源检查 | `node scripts/bio-launch.mjs test run packages/server/src/bio-resources.ts` | PDF/JATS、PNG、TIFF 第 2 帧像素和 SDK inspect 全部 passed；liveModelRequests=0 |
| 服务目录组装 | `node scripts/bio-launch.mjs build run scripts/bio-server-package.ts` | 最新 `T16-service-final-20261020b.log`：service-w23SCm、480 个依赖、43481 文件、SERVICE_PACKAGE_EXIT=0，约 1GB，含最终 launcher。核对工作区边界后移至 `outputs/T16-runtime-proof/service-w23SCm` |
| 部署说明后处理与完整性 | `node .runtime/checks/T16-refresh-runtime-readme.mjs` | 只将最终 SERVICE_RUNTIME.md 刷新为新运行目录 README.md，并更新该条清单大小/SHA；`T16-runtime-inventory-final.log` 核验全部 29 个自有哈希文件、最终 launcher 与源码相同。未对 vendor 全部字节取哈希，后续所有最终运行均使用此刷新后的目录 |
| 仓库外资源 | 在 service-w23SCm 根目录执行 `node scripts/bio-launch.mjs test run packages/server/src/bio-resources.ts` | `T16-resources-current.log`：PDF/JATS/PNG/TIFF 选帧/SDK inspect 五类 passed，0 模型请求、RESOURCES_EXIT=0；该目录祖先不包含源码 node_modules |
| 打包账户与 writer 释放 | `node .runtime/checks/T16-account-runtime-proof.mjs` | `T16-account-runtime-current.log`：新 namespace 下调用包内 accountCommand 初始化管理员、真实 HTTP bearer 登录/拒绝无效 token、受控停止0、停止后新建账号全部通过，ACCOUNT_EXIT=0。密码读取器为合成替身，没有手工验收终端隐藏输入 |
| 桌面便携包与构建压力 | `node .runtime/checks/T16-pressure-build.mjs`，内部经 launcher 配置执行 main/两端 renderer/desktop-package 四次构建 | `T16-pressure-final.log`：最新 desktop-0RHAui、PRESSURE_EXIT=0，237 个产物文件（含 ASAR/exe）无合成构建秘密标记。包脚本实际读回 fuses；最终 `T16-desktop-inventory-final.log` 由 Get-Item.VersionInfo/Get-FileHash 只读核对 ProductName=BioEvidence、FileVersion=0.1.0.0、exe/ASAR 与清单哈希一致，exit0。renderer 仍有 >500KB chunk 警告，列 P1 |
| 实际最终包 UI | `node scripts/bio-launch.mjs test run .runtime/checks/T16-native-package-prepare.mjs`，再 `node .runtime/checks/T16-native-package-launch.mjs` | `T16-native-prepare-current.log` / `T16-native-package-current.log` 均 exit0。副本 If18Wg 仅替换 package main/添加驱动，正式 exe/main/preload/HTML 字节不变；isPackaged=true、双窗口、独立产品 namespace、4 条持久运行、无 renderer bearer、公开 PDF 上传、私有 TIFF 第2帧、真实文件导出均通过。截图 T16-desktop.png 已实际查看 |
| 原样包启动观察 | `node .runtime/checks/T16-package-launch.mjs` | 原样 desktop-0RHAui 进程由 Sky 实际观察到标题 BioEvidence 的窗口，之后正常退出 code0/signal=null（T16-package-pristine.log）；取窗口图时 Sky kernel 异常，不据此宣称手工完整 UI 验收 |
| 最终运行包服务生命周期 | `node .runtime/checks/T16-service-proof.mjs`，包外合成资料+克隆已停止合成数据库 | `T16-service-current-proof.log`：真实监听 127.0.0.1:59071；最终包 UI 完成后由 owned 通道停止，BIOEVIDENCE_STOPPED=0、code0、SERVICE_PROOF_EXIT=0。不修改原合成库或真实资料 |
| 已知秘密与夹具标记扫描 | `node .runtime/checks/T16-scan-final.mjs` | `T16-scan-final.log`：1 个已知宿主秘密模式；1940 源码文件、122 编译文本、最终 ASAR/exe 2 件、服务自有文件+清单30件均无命中，SCAN_EXIT=0，清单无私有运行目录。未扫描 vendor 全部内容；不是穷尽秘密审计 |
| TS/TSX lint | 既有忽略检查驱动 `T15-lint.mjs` 选择本轮文件 | `T16-lint.log`：33 文件、0 errors/0 warnings；MJS 另由 Node 回归实际运行 |
| 运行时准备 | `node scripts/bio-prepare.mjs --bun D:/node/node.exe`，再传已存在的固定 Bun | Node 被拒绝 exit1，现有 Bun1.3.10 复制/登记成功 exit0。没有网络下载或依赖安装 |
| Docker | 实际执行 `docker version --format '{{json .Server.Version}}'` | exit1，dockerDesktopLinuxEngine 命名管道不存在。**未执行** docker build/run，Linux native 和容器均未验证 |

构建没有安装新依赖或访问模型。上表的 `.runtime/checks/` 驱动和原始日志保留本机，不随源码公开；相关结果由独立评判者读取核对。最终 `git diff --check` 另随审批记录。

## 失败、修正和验证口径

1. Windows 子进程 SIGTERM 不等于优雅停止。原 Craft 单共享 token smoke 保留历史，本 profile 不支持该入口；新增 Bio 真实账户入口 smoke 验证持久账户 bearer、错误/短/旧共享 token 拒绝、无默认账号/公开 bootstrap、错误配置拒绝及受控退出。此映射此前独立评判已批准，没有放松旧入口 guard 或原 MCP 断言。
2. 监督进程突然退出的初版只生成清理证明，独立评判指出尚未证明自退出。现在先在验收 deadline 内确认子进程不存在，再收尾；测试不按裸 PID 强杀。fixture 自退为 30 秒 exit2，晚于 8/18 秒验收 deadline，不能使错误通过。
3. 包组装初次暴露 import-only exports、workspace 嵌套依赖路径和包内相对资源问题，使用构建器真实解析结果及原始依赖位置收敛。不能以 bundle 文件存在推断原生依赖齐全。
4. 运行包首次启动失败来自测试设置：把资料放进 namespace、随后尝试改写已有不可变授权。按原规则将合成资料放在独立目录，并保留原授权、增加新授权 ID 后启动通过。没有修改生产目录保护或数据库授权规则。
5. Node24.13 `cpSync` 在本机准备 Electron 验证副本时以系统状态码异常退出；改用固定 Bun 下逐项、拒绝 symlink 的测试拷贝。ASAR 初次比对还使用了错误的 `/` 路径，按 Windows 分隔符修正。二者是测试驱动问题，不算产品 Red。首个未带驱动的隐藏 GUI 进程达到监督时限后被停止，不能据此声称原样包已通过手工 UI 验收。
6. 旧 rcedit 无法读取中文路径副本，使用已安装且锁定的 builder 资源库编辑新 exe，并实际读取版本及 fuse 结果；没有另下工具。产物明确未签名。
7. 桌面测试后发现输入法组件在源码树字面 `%SystemDrive%` 目录写入两个缓存。未读取内容，将该本轮目录移动到被忽略的 `.runtime/quarantine`；不进入提交。OS 白名单补充 SystemDrive，保留模型/钩子秘密过滤；其与输入法写入的因果为推断，后续复验另记。
8. 独立评判指出 profile 子目录检查无法阻止更上层 appData junction 先被 mkdir；实际 bootstrap Red 复现后，统一预查全部现存祖先再创建。随后评判又指出真实 packaging 命令先经过 launcher，helper 单测不覆盖其提前写入。新增真实 Node CLI 两个 junction 回归，Red 实际产生外部 build/cache/tmp、sdk/tmp；修复后 Green12/0，最终 Node36/0。最新服务包含此修复，最终桌面测试后字面 `%SystemDrive%` 目录不存在。

## 继承基线与剩余责任

- 原 MCP 缺命令诊断已修复，quoted PATH 正常命令未被误判；POSIX 仅保留原 PATH 字符、不剥引号，未在其他 OS 实机运行。
- 原 Python/uv 八组 smoke 仍是历史 0 tests/8 setup errors；Bio 入口与交付不依赖这些工具，README 和命令明确不支持，不称原套件全绿。
- CI YAML/源码 Docker 配置可本地读取和核对，GitHub Actions、全新机器安装、Linux/Docker 实际执行尚未验证。
- 真正的官方 GPT/兼容端点、正式 Bun Europe PMC 公网 DNS/TLS、完整 AC、大量实验文件和引用性能仍归 T17。细胞分类/GPU/4090 模型部署继续暂缓。
- 包 UI 用合成账号/文件和已保存的合成运行。文件 chooser/save dialog 是测试替身，实际有界读取、HTTP 上传、解析、预览和保存是真的；没有手工操作原生 OS 对话框。没有请求真实模型，也没有接入真实实验资料。
- 所有运行输出、合成数据库、测试副本和原生截图原件保留在本机忽略目录，仓库外运行验证目录亦含测试后 namespace，不能直接当无数据发行包分发。已知秘密/标记扫描已完成；正式 GitHub 发布内容、完整 AC 与最终审批仍须完成。

## 独立审阅记录

2026-10-20 `/root/t16_release_judge` 在只读检查源码/diff、批准契约与原始日志后，顺序给出正式 **Spec PASS、代码质量 PASS、文档一致性 PASS、T16 阶段 PASS**，授权同步状态并本地提交后推进 T17。评判独立只读核验仓库外最终运行目录全部29个自有哈希、最终 launcher 与源码一致、README 与 SERVICE_RUNTIME 一致，复核 `git diff --check` exit0；没有声称独立重跑自动测试或 GUI。两处先写后查的目录重定向问题已修复，完整性/替身/真实环境的边界均保留。T17 公网/模型/完整AC和T18发布不在此PASS内。
