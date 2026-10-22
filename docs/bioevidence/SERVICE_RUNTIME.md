# BioEvidence 部署与运行

平台包含独立科研服务、Web / Electron 客户端及纯静态演示包。科研服务采用单实例 SQLite 写入，数据目录必须位于本机持久磁盘；不要让多个服务同时写同一运行目录。

## 本机启动

准备 Node.js 24 和 Bun 1.3.10，安装锁定依赖并构建 Web：

```bash
node scripts/bio-prepare.mjs --bun "/path/to/bun"
node scripts/bio-launch.mjs install install --frozen-lockfile
node scripts/bio-launch.mjs build run scripts/bio-renderer-build.ts web
node scripts/bio-launch.mjs runtime run packages/server/src/bio-account.ts init-admin --username admin
node scripts/bio-start.mjs server
```

管理员密码至少 12 位，通过隐藏式终端输入。服务默认监听 `127.0.0.1:9100`，浏览器打开 `http://127.0.0.1:9100/login`。保持服务终端运行；停止时使用 Ctrl+C，等待进程完成资源关闭。

新增账号需要先停止服务，再通过管理员身份执行：

```bash
node scripts/bio-launch.mjs runtime run packages/server/src/bio-account.ts create --admin-user admin --username researcher01
```

## 模型配置

管理员可在「模型连接配置」中选择 OpenAI GPT、DeepSeek 预设或 HTTPS OpenAI-compatible 服务，填写模型 ID、API Key 和授权空间。

| 配置 | 协议与地址 |
| --- | --- |
| OpenAI GPT | Responses / `https://api.openai.com/v1` |
| DeepSeek 预设 | Chat Completions / `https://api.deepseek.com/v1` |
| 自定义与 Lab | HTTPS 基础地址 + Chat Completions 或 Responses |

环境初始化使用 `.env.example` 中列出的服务端变量。初始化只创建缺失的默认连接，归属现有活跃管理员的个人空间；项目成员使用前，需要管理员为项目配置授权。也可使用当前服务端凭据库中以 `openai-default` / `deepseek-default` 命名的显式凭据槽初始化。已有记录和凭据库跨重启保留。更换密钥或模型配置通过管理界面完成。

模型 ID 是供应商协议参数，不代表账户一定拥有该模型。可用 ID 由部署方填写；连接保存后发起一次公开输入研究任务，检查实际回执。绿色状态仅反映最近五分钟对应连接修订与模型的成功请求。

端点要求 HTTPS。对仅支持 HTTP 的 vLLM / Ollama 服务，在课题组网络中配置 HTTPS 反向代理。Lab 标签用于展示部署位置，输入分类与权限规则继续生效。

## HTTPS 访问入口

推荐在同机反向代理终止 TLS，应用仍监听回环地址。`.runtime/runtime/service.json` 示例：

```json
{
  "host": "127.0.0.1",
  "port": 9100,
  "publicOrigin": "https://bio.lab.example.org",
  "trustedProxies": ["127.0.0.1"]
}
```

代理保留对外 Host，传递正确的 `X-Forwarded-Host` / `X-Forwarded-Proto`，支持 WebSocket Upgrade。只把实际代理的 IP 加入 `trustedProxies`。不要注入通用 `Forwarded` 头。

也可使用服务内置 TLS：在 `service.json` 配置 `tls.certPath` / `tls.keyPath`，证书文件须位于运行目录内。远程登录要求 HTTPS；是否允许公网连接由服务器防火墙、反向代理和课题组网络策略共同决定。

Linux 服务管理器可通过仓库外的 `EnvironmentFile` 注入模型变量，设置工作目录为仓库绝对路径，并运行 `node scripts/bio-start.mjs server`。运行用户需要读取代码与依赖、写入 `.runtime/runtime/` 的权限。构建和测试环境不继承模型密钥。

## 资料目录

运维在 `.runtime/runtime/material-grants.json` 预授权真实目录，再由界面注册到对应空间：

```json
[
  {
    "id": "lab-materials",
    "scope": { "kind": "project", "projectId": "replace-with-project-id" },
    "label": "实验显微图像与记录",
    "rootPath": "/mnt/lab-materials"
  }
]
```

资料目录使用绝对路径，必须位于运行状态目录之外。应用按授权范围只读索引与预览，批注单独持久化。浏览器访问的是服务器上已授权的资料，不能直接浏览访问者电脑上的任意目录。

没有配置真实资料时，界面提供独立合成示例；示例不会创建磁盘授权，也不向模型发送实验资料。

## 静态公开演示

```bash
node scripts/bio-demo-build.mjs
node scripts/bio-demo-serve.mjs
```

本机预览地址为 `http://127.0.0.1:5176`。将 `apps/webui/dist-demo/` 的内容发布到静态托管即可；相对资源路径支持子路径。无需运行科研服务，禁止把正式运行目录或密钥文件复制到静态站点。

静态演示包含公开论文元数据、短节选和合成图像。轨迹、耗时、模型路由及审批是明确标注的预置交互，批注仅在当前页面保留。演示构建不包含正式认证和 WebSocket 客户端；本地预览服务还设置 `connect-src 'none'`。

## 备份与检查

服务停止并完成数据库关闭后，备份整个 `.runtime/runtime/`，包括数据库、凭据库及其加密配置、快照和会话投影。原始实验目录单独按课题组策略备份。升级前保存一致性备份，并在独立目录验证恢复。

```bash
node scripts/bio-validate.mjs
node scripts/bio-launch.mjs test run packages/server/src/bio-resources.ts
```

容器构建入口为 `Dockerfile.server`。部署时显式挂载持久运行目录、配置正确的目录所有权、HTTPS 入口和只读实验卷；容器不自带管理员密码或模型凭据。
