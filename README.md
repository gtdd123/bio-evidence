# BioEvidence

面向课题组的科研工作区，基于 Craft Agents 0.11.4 源码二次开发。公开文献可进入所选云端模型；私有实验材料通过本地预授权目录浏览、预览和批注。Web 与 Windows 桌面连接同一账户服务，共享科研会话、证据修订、引用报告和运行状态。

**当前是开发中的 0.1.0。** Windows x64 的合成数据链路已有真实运行证据；完整验收、真实 GPT 与生产环境 Europe PMC 公网验证仍待完成。源码存在或测试通过不等于科学结论正确。阶段记录见 [CURRENT_STATUS.md](CURRENT_STATUS.md) 和 [工程证据](docs/bioevidence/evidence/)。

## 已实现的首版链路

- 独立账号、个人空间、课题项目成员与资源隔离；桌面每个窗口分别登录。
- 文献检索适配器、PDF/JATS 读取快照、覆盖和缺页提示、选定原文片段。
- 证据表与引用报告的不可变修订、冲突保留、人工核对、CSV/Markdown 导出。
- 显式公开输入的 Agent 运行、进度持久化、取消、重试与重启恢复；官方 OpenAI 和 HTTPS 兼容接口配置。
- 私有目录只读索引、受限文本搜索、PNG/JPEG/普通 TIFF 指定帧预览和批注。资料目录须由部署管理员预授权。

细胞分类、模型训练、4090 部署、OCR、OME 多维映射和 BigTIFF 不属于当前首版。原 Craft 的任意 shell、MCP、浏览器、插件与旧 OAuth profile 未在 BioEvidence 科研入口开放；旧 Python/uv 文档工具套件不受此交付支持。

## 本地准备

本机验证版本：Windows x64、Node **24.13.0**、Bun **1.3.10**、Electron **39.2.7**。暂未验证其他系统和全新机器安装。

先自行获取对应平台的 [Bun 1.3.10 官方发行文件](https://github.com/oven-sh/bun/releases/tag/bun-v1.3.10)，解压后在仓库根目录执行。准备脚本只复制现有运行时，不下载软件，也不修改全局 PATH。

```powershell
node scripts/bio-prepare.mjs --bun "D:\tools\bun.exe"
node scripts/bio-launch.mjs install install --frozen-lockfile
```

依赖安装使用锁文件和隔离环境。内部 `@craft-agent/*` 包名保留以兼容源码结构。勿将密钥写进 `.env`：启动器会拒绝自动加载的环境文件。模型密钥在运行期通过管理员界面设置。

## 启动服务和 Web

先构建 Web，再在私人交互终端初始化管理员。密码由终端隐藏输入，不能放在命令参数或环境变量中。

```powershell
node scripts/bio-launch.mjs build run scripts/bio-renderer-build.ts web
node scripts/bio-launch.mjs runtime run packages/server/src/bio-account.ts init-admin --username admin
node scripts/bio-start.mjs server
```

默认打开 <http://127.0.0.1:9100>。没有默认账号或默认密码。使用自己的管理员账号登录，创建项目、会话，再导入公开 PDF 或手工整理证据。模型未配置时仍可使用手工链路。

终端按 Ctrl+C 会通过本地监督通道关闭服务。监督进程断开时，服务会按管道状态或心跳超时清理退出。15 秒兜底强杀记为失败，不算正常关闭。HTTP/RPC 没有关机接口。

账户、SQLite、加密凭据和运行记录保存在仓库 `.runtime/runtime/`。新增账号时先停止服务，避免同时争用权威数据库：

```powershell
node scripts/bio-launch.mjs runtime run packages/server/src/bio-account.ts create --admin-user admin --username student
```

随后重新启动服务，在项目成员界面授权。不要把整个运行目录上传到 GitHub。备份数据库和加密凭据时应在服务关闭后按同一 namespace 保留完整文件；不要只复制仍有 WAL 写入的数据库。

## Windows 桌面

```powershell
node scripts/bio-launch.mjs build run scripts/bio-electron-build.ts
node scripts/bio-launch.mjs build run scripts/bio-renderer-build.ts desktop
node scripts/bio-start.mjs desktop
```

在桌面登录页填写服务地址。桌面不内置服务和模型密钥，服务须先启动。源码客户端使用项目隔离目录；正式便携客户端使用独立的 `%APPDATA%\BioEvidence` 产品目录。

生成便携目录：

```powershell
node scripts/bio-launch.mjs build run scripts/bio-desktop-package.ts
```

命令打印本轮 `.runtime/build/deliveries/desktop-*/BioEvidence-win32-x64` 输出目录。整个目录需要一起保留，入口为 `BioEvidence.exe`。这是**未签名的便携目录**，尚无安装器、自动更新或 OS 协议注册。appId 为 `com.gtdd123.bioevidence`；不连接上游更新地址。Windows 警告或组织策略应由用户处理。

## 服务运行目录与部署

```powershell
node scripts/bio-launch.mjs build run scripts/bio-renderer-build.ts web
node scripts/bio-launch.mjs build run scripts/bio-server-package.ts
```

生成新的 `service-*` 目录，包含固定 Bun、服务/账号入口、解析及图像 worker、PDF.js、sharp/native、Pi SDK 依赖闭包和 Web 资产。`bio-delivery.json` 记录文件大小、依赖版本与自有运行文件哈希；它不是对整个依赖闭包的签名或安全认证。当前目录较大，裁剪体积属于后续优化。

把**整个目录**复制到目标 Windows x64 机器，准备同版本 Node，在其根目录执行上文的账号初始化和 `node scripts/bio-start.mjs server`。可先运行完全合成、零模型调用的资源检查：

```powershell
node scripts/bio-launch.mjs test run packages/server/src/bio-resources.ts
```

该检查验证 PDF/JATS、图像/TIFF 指定帧和 SDK 初始化；不代表真实模型调用成功。不要分发验证过程中生成的 `.runtime/` 测试数据。

远程服务需在 `.runtime/runtime/service.json` 显式设置 `host`、`port`、HTTPS `publicOrigin` 和 TLS；证书及私钥路径必须位于同一 namespace 内。默认只绑定本机回环地址。不要通过关闭 TLS 或绕过地址检查来修复网络问题。

私有材料授权写在同目录 `material-grants.json`，项目 ID 由管理员通过已授权的 `listSpaces` 接口取得；必须使用真实空间 ID。示例中的占位符需要替换：

```json
[
  {
    "id": "lab-materials-v1",
    "scope": { "kind": "project", "projectId": "REPLACE_WITH_PROJECT_ID" },
    "label": "实验材料",
    "rootPath": "D:/lab-materials"
  }
]
```

授权路径不能包含运行目录、凭据或系统敏感目录，也不能与服务 namespace 互相包含。已有授权 ID 的范围或路径不能直接替换；变更目录应配置新 ID。重启服务后在对应项目的资料页注册该授权目录。这里只读材料，预览和批注不修改原文件。

`Dockerfile.server` 是使用同一隔离入口的源码服务镜像配置。当前宿主未连接 Docker Linux daemon，**镜像构建、容器启动和 Linux 原生依赖尚未验证**；不能按已交付容器使用。远程 TLS、数据挂载和账户初始化仍须由部署者配置。

## 验证和来源

```powershell
node scripts/bio-validate.mjs
node scripts/bio-launch.mjs test test packages/shared/src/mcp/__tests__/validation.test.ts
```

首个命令仅验证声明的 BioEvidence 范围，运行 Node 隔离回归、科研及服务测试、工作区类型检查、Web/桌面构建和合成资源检查。它不代表保留的完整 Craft 测试套件通过。CI 采用同一入口；尚未在 GitHub 实际运行。旧 root release、失效开发/包装和同步秘密入口已关闭。

源码来源、继承与新增模块、未验证项见 [当前状态](CURRENT_STATUS.md)。本地导入来自 Craft Agents 0.11.4 ZIP；未核验其声称的上游提交和完整 Git 历史。上游版权、Apache-2.0 [LICENSE](LICENSE) 与 [NOTICE](NOTICE) 保留。本项目不属于 Craft 官方发行版。第三方依赖按各自许可证使用。
