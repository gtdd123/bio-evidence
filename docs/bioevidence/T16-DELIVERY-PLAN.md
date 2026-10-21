# T16 交付实施细化

日期：2026-10-17。前置阶段 T15 已独立审批并提交 `21119cf`。本文已获 `/root/t14_independent_judge` 独立实施细化审批 PASS，授权按顺序实施；不改变已批准范围或真实环境门槛。

## 支持边界

- 首版验证宿主为 Windows x64；桌面端为连接显式科研服务的 BioEvidence 薄客户端。桌面包不嵌入服务、模型 key、实验目录或原 Craft profile，不自动安装本地模型。
- 科研服务使用已固定 Bun 1.3.10 的源码/运行时入口。按 PLAN12 先证明 Windows Bun 服务可运行，已完成 Windows 服务与 Linux/Docker 容器化部署验证。
- 完整服务交付必须包含或明确安装锁定的 worker/解析/SDK/原生依赖，且从交付目录实际验证 PDF/JATS、图像和 SDK inspect；单文件 bundle 成功不能替代资源验收。优先保留包相对路径与已有 workspace 布局，避免把运行时动态模块漏掉。
- 旧 Python/uv 文档套件不属于 Bio 公共科研工具；不新增 GPU、Python 工具出口或自动系统安装。对于归档缺失的 uv/Windows 工具，明确不支持并使交付验证清单区分旧套件，不能把 0 tests/8 errors 写成通过。

## 实施顺序和验证

1. **可靠启动与受控退出。** 新增明确的桌面启动器和跨平台服务监督入口，复用隔离环境/固定 Runtime；不读取 `.env`、不杀端口其他进程。服务仅在显式拥有的 stdio 控制模式接受 shutdown，公共 HTTP/RPC 不新增关机能力。Windows 退出测试通过该控制入口验证 stop/flush、模型/解析进程清理和可重开数据库，保留原安全断言；不能用强杀退出码冒充优雅停止。
2. **继承基线诊断收敛。** 复跑现有 MCP 缺命令测试，修正 Windows shell 包装导致的错误归类，保留 Command not found/命令名断言。仅修诊断和支持范围，Bio profile 仍禁公共 MCP。实施中经独立评判批准：原单共享 token headless smoke 保留为 Craft 历史，Bio guard 不放松；新增等价的 Bio 真实账户入口 smoke，覆盖 bearer、错误/短/旧 token、无默认账号/错误配置，以及受控/EOF/监督异常/超时失败的退出与清理。本轮必要检查用隔离入口执行。
3. **品牌与入口整理。** 新产品名、版本/appId/协议、图标/HTML、开发和构建命令与 README 改为 BioEvidence；保留上游版权、许可证和来源说明。旧 root build/release、失效旧开发/包装命令关闭或明确导向新入口，不发布到上游更新地址、不加遥测或服务 key define。
4. **正式资源组装。** 先产出可审查资源布局及运行清单，固定 worker/document-extractor/PDF.js worker、sharp/native、公开 Pi SDK、Web manifest 的位置。只允许受信启动代码选择布局，服务配置/RPC 不得传任意 worker 路径。对输出根做 canonical containment 和 symlink 检查，构建不删除或移动未核对目录。任何更改 worker 入口的实现先用实际解析/inspect失败证明缺口，再补资源并复验。
5. **桌面运行包与服务交付说明。** 使用现有锁定 Electron/build 工具产出 Windows 可运行包，从包入口验证两窗口登录、共享界面、私有预览与导出边界；是否提供安装器取决于现有官方构建资源可用性，便携包/源码服务与安装器分别描述。服务分发明确 Node/Bun/依赖准备、namespace、TLS、账号初始化、预授权资料和停止方式；秘密只在运行期服务内配置。
6. **CI/Docker 与最终记录。** 用真实存在的 workspace manifests 修正 Docker/验证入口，不运行上游发布脚本；缺 Docker daemon/其他 OS 时仅验证配置与可检查构建部分，标为未验证。记录准确命令/exit/实际支持范围、已知秘密及合成 marker 扫描、原生资源与停止证据，交独立 Spec→质量→文档/阶段审批后提交。T17 再按 AC 全面验收，T18 才进行已授权目标 GitHub 交付。

## 验收门槛

2026-10-18 实施补充：源码客户端仍需 launcher；正式客户端由包内受信 bootstrap 先明确建立独立产品 namespace，再读取业务模块。包只提供未签名便携目录，不提供 OS 协议注册、安装器或上游更新。2026-10-20 独立评判 /root/t16_release_judge 已顺序批准最终 Spec/质量/文档一致性及 T16 阶段 PASS，详见 evidence/T16-delivery.md；本文最初实施细化 PASS 与最终阶段审批分别记录。

- 已测试的命令能在本机实际启动正确 Bio 主程序；不默认启动 Craft，源码与桌面包访问同一服务。
- 不在 renderer、main/preload、包装文件、普通日志中包含模型 key 或合成服务秘密；合法登录凭据只在其授权进程使用。
- PDF/JATS/选定 TIFF 帧及 SDK inspect 从声明的正式资源布局运行，失败有明确状态；不是借用源码树缺失资源而假装包完整。
- Windows 受控退出、MCP 缺命令归类、旧 Python 不支持声明、可执行构建/CI 入口分别关闭 PLAN18 责任项；未关闭的责任不能从文档移除。
- 实际模型/GPT、生产 Bun Europe PMC 公网 DNS/TLS、真实资料服务器和大规模性能仍按 T17 独立验证，T16 不代签。
