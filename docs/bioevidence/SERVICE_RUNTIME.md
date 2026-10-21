# BioEvidence 生产服务运行与运维手册

本手册适用于 BioEvidence 生产服务端发布目录（基于 Node.js 24.13.0 与 Bun 1.3.10 构建），已内置 Web 科研工作台前端资产、PDF/JATS 文献解析引擎、多帧 TIFF 图像预览组件及大模型网关 SDK。

## 1. 运行环境自检

首次部署或升级后，可执行内置资源完整性自检（验证解析引擎、图像组件与 SQLite 运行环境）：

```bash
node scripts/bio-launch.mjs test run packages/server/src/bio-resources.ts
```

## 2. 生产集群网络与 HTTPS/TLS 配置（`service.json`）

生产环境部署时，请在 `.runtime/runtime/service.json` 中配置集群监听地址 `0.0.0.0`、对外访问域名 `publicOrigin` 以及受信任的 TLS 证书路径：

```json
{
  "host": "0.0.0.0",
  "port": 9100,
  "publicOrigin": "https://bio-evidence.lab.example.org:9100",
  "trustedProxies": ["10.0.0.1", "172.17.0.1"],
  "tls": {
    "certPath": "tls/server.crt",
    "keyPath": "tls/server.key"
  }
}
```

> **安全说明**：证书文件须存放在受控的 `.runtime/runtime/` 命名空间内部。系统默认开启严格的地址与代理边界校验，保障课题组内网与公网网关通信安全。

## 3. 账号初始化与服务启停管理

在服务端安全终端中初始化系统管理员账号（密码采用隐藏式交互输入并经 Argon2/Scrypt 哈希存储）：

```bash
node scripts/bio-launch.mjs runtime run packages/server/src/bio-account.ts init-admin --username admin
node scripts/bio-start.mjs server
```

启动后即可通过浏览器访问 `https://bio-evidence.lab.example.org:9100`（或配置的集群地址）登录系统。Windows 桌面客户端只需在登录界面填入同一服务地址即可实现双端实时协同。

新增课题组成员账号时，先通过 `Ctrl+C` 或进程管理器优雅停止服务，再执行：

```bash
node scripts/bio-launch.mjs runtime run packages/server/src/bio-account.ts create --admin-user admin --username researcher01
```

## 4. 实验室私有资料目录预授权（`material-grants.json`）

私有实验资料目录由运维管理员在 `.runtime/runtime/material-grants.json` 中统一预授权，并绑定至具体的个人空间或共享项目 ID：

```json
[
  {
    "id": "lab-materials-v1",
    "scope": { "kind": "project", "projectId": "proj_neuro_01" },
    "label": "实验显微图像与原始记录",
    "rootPath": "/mnt/lab-materials/neuro-2026"
  }
]
```

- **只读与防逃逸保护**：资料目录严禁位于服务运行命名空间内或包含符号链接（Symlink/Junction）越权跳转。系统对挂载目录严格执行只读访问，在线选帧预览（支持 PNG、JPEG 及多帧 TIFF 显微图像）与实验批注均不会修改原始实验文件。

## 5. 大模型网关接入与数据备份

- **大模型推理接入**：管理员登录后可在界面配置官方 OpenAI 兼容 HTTPS 接口或实验室本地 GPU 推理集群（如 RTX 4090 vLLM 节点）。API 密钥由服务端加密保存在运行期凭据库中，不写入源码或静态配置文件。
- **数据备份规范**：账号、SQLite 数据库（`research.sqlite`）、文献快照与证据修订记录均位于 `.runtime/runtime/`。请在服务优雅停机、WAL 日志完成 Checkpoint 落盘后对整个目录执行增量或全量备份。
