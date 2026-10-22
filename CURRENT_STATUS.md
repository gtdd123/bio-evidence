# BioEvidence 架构演进与工程验收矩阵 (v1.0.0)

## 1. 核心产品与多端形态

- **科研服务端（Authority Server）**：统一承载多租户账号与项目 RBAC 权限、公开文献快照解析、证据矩阵与报告版本化修订、零信任输入边界检查及长任务运行队列。
- **多端共享工作台（Web / Electron / CLI / Headless）**：基于统一 RPC 传输层与 `Channel Map` 契约一致性校验，提供顶部模型路由切换、三级安全模式（`Safe / Ask / Allow-All`）及可折叠 `AgentEvent` 实时执行轨迹。
- **在线交互演示站（`dist-demo`）**：通过 `VITE_DEMO_MODE=true` 独立构建的免后端静态工作台，内置完整 U-Net 生物医学文献调研案例、证据矩阵、原文 UTF-16 精确引用锚定与 12 帧 16-bit 显微图像选帧预览，供外部访客快速体验。

## 2. 模型路由与零信任安全执行

| 模块维度 | 生产环境机制说明 |
| --- | --- |
| **OpenAI GPT** | 原生接入官方 Responses API，支持自定义模型 ID（如 `gpt-4o` / `gpt-4.1`）与 Token 请求预算控制 |
| **DeepSeek** | 原生内置官方 HTTPS Chat Completions 流式预设（`deepseek-chat` / `deepseek-reasoner`），支持一键切换 |
| **Lab Intranet GPU** | 支持课题组内网 HTTPS OpenAI-Compatible 推理节点（vLLM / Ollama），独立展示 Lab 算力分组 |
| **默认连接托管** | 支持从服务端环境变量自动初始化至管理员空间并由 `CredentialManager` 原子加密持久化 |
| **Safe 模式** | 只读沙箱模式，禁用外部写操作工具，仅对显式锁定的公开输入清单（Public Manifest）执行分析 |
| **Ask 模式（默认）** | 启用 `PreToolUse` 硬拦截，每次工具调用单独挂起并弹出人工审批卡片，超时/取消/拒绝即刻熔断 |
| **Allow-All 模式** | 自动放行白名单内的公开只读检索工具，同时继续强制执行底层输入边界与 RBAC 权限校验 |
| **AgentEvent 轨迹** | 完整记录并流式推送工具请求、审批决策、模型回执与产物结构校验状态，支持断线恢复与重跑 |

## 3. 自动化验收与契约回归

执行统一验证流水线 `node scripts/bio-validate.mjs`，全量 **491 项自动化测试 100% 通过（Exit 0）**：

| 检查套件 | 验收结果 |
| --- | --- |
| **Node 运行时与隔离测试** | **38 通过 / 0 失败 / 0 跳过** |
| **Bun 科研核心域、集成与契约测试** | **453 通过 / 0 失败**（覆盖 71 个测试文件） |
| **静态类型检查与多端构建** | **100% 通过**（Web / Electron / 静态 Demo 构建及 PDF、JATS、PNG、16-bit TIFF 选帧资源自检完成） |
| **前端代码规范（ESLint）** | **0 错误 / 0 警告** |
