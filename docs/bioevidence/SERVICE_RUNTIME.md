# BioEvidence 服务运行目录

这是 Windows x64、Bun 1.3.10 的服务运行目录，包含 Web 界面和解析/图像/模型 SDK 资源。它不是 Windows 原生服务 exe，不包含桌面客户端、真实账号、模型密钥或实验资料。需要另备 Node 24.13.0；保留整个目录及层级，无需在此目录安装依赖。

先运行合成资源检查（不调用模型）：

```powershell
node scripts/bio-launch.mjs test run packages/server/src/bio-resources.ts
```

在私人交互终端初始化管理员，按提示隐藏输入密码，再启动服务：

```powershell
node scripts/bio-launch.mjs runtime run packages/server/src/bio-account.ts init-admin --username admin
node scripts/bio-start.mjs server
```

访问 http://127.0.0.1:9100，用刚创建的账号登录。没有默认密码。桌面客户端需要另行启动并填写同一个服务地址。未配置模型也能手工导入 PDF、整理证据和引用报告。

按 Ctrl+C 关闭服务。监督通道丢失也会触发清理；超时强杀记作失败。新增账号时先停止服务，随后执行并按提示输入管理员密码和新密码：

```powershell
node scripts/bio-launch.mjs runtime run packages/server/src/bio-account.ts create --admin-user admin --username student
```

账号、凭据、数据库和运行记录位于 `.runtime/runtime/`。不要公开或随软件分发该目录。只在服务关闭、数据库 checkpoint 后备份完整 namespace；不要复制仍有 WAL 写入的数据库。资源检查生成的 `.runtime/test/` 也不属于发行内容。

远程访问必须在 `.runtime/runtime/service.json` 显式配置监听地址、HTTPS publicOrigin 及 namespace 内 TLS 文件；默认只监听回环地址。下面的域名和证书路径是占位示例，必须替换为自己的受信证书与实际路径。不要关闭 TLS 或绕过地址保护。

```json
{
  "host": "0.0.0.0",
  "port": 9100,
  "publicOrigin": "https://research.example.org:9100",
  "tls": {
    "certPath": "D:/BioEvidence-service/.runtime/runtime/tls/server.crt",
    "keyPath": "D:/BioEvidence-service/.runtime/runtime/tls/server.key"
  }
}
```

私有资料由部署管理员在同目录 `material-grants.json` 预授权，绑定真实个人/项目空间 ID，随后由有权限的账号在资料页注册。项目 ID 可由管理员通过已授权的 `listSpaces` 接口取得；示例占位符必须替换：

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

资料目录不能位于 namespace 内、包含 namespace 或经过 symlink/junction，也不能使用凭据/系统敏感目录。已有授权 ID 的路径或范围不能直接替换，变更时使用新 ID。材料只读，预览和批注不修改原文件。当前支持 PNG/JPEG 与受支持的普通 TIFF 帧，不支持 OME 多维映射、BigTIFF 和 subIFD 金字塔。

管理员登录后在模型配置界面添加官方或兼容连接；密钥只在运行期保存于服务端，不写入源码、此说明或交付包。未配置模型时可先走手工链路。

本机已验证合成 PDF/JATS、PNG/TIFF 指定帧及 SDK 初始化；真实 GPT、生产 Europe PMC 公网、真实资料和大规模性能尚待独立验收。Linux/Docker、安装器及全新机器安装未验证。结构与引用校验不代表科学结论正确，产出仍需人工核对。

源码源自 Craft Agents 0.11.4 ZIP，完整上游 Git 历史未核验。许可证及来源见随附 LICENSE、NOTICE 和各依赖许可证。
