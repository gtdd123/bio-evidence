# T18 — README 与公开源码开发预览

日期：2026-10-20。目标：`https://github.com/gtdd123/bio-evidence`，公开源码；不发布二进制 Release、网站或生产服务。

## 用户授权与交付范围

用户最新明确要求“给这个项目README做好看点，然后都发到github上面吧”。按 PLAN22 更新源码交付顺序：先公开明确标有限制的 0.1.0 开发预览，保留 T17 真实模型及生产 Europe PMC 的验收缺口，不将 T17 标为全部 PASS。用户既定要求的独立文档评判继续执行。

本轮仅调整 README、展示资产和状态/任务记录，没有修改应用源码或安装依赖。README 包含品牌 SVG 横幅、静态状态徽章、两张实际 Windows 合成界面截图、能力与继承归属、快速启动、数据流、数据边界和真实验证状态。高级部署引用现有 SERVICE_RUNTIME.md。Apache LICENSE/NOTICE 保留；来源仍表述为 Craft 0.11.4 源码 ZIP 本地导入，没有冒充经核验的完整上游 Git fork。

## 实际检查与证据

本机原始检查输出位于被忽略的 `.runtime/checks/T18-*`；以下是实际执行摘要，未把未执行的测试记为通过。

| 检查 | 实际结果与边界 |
| --- | --- |
| 初始 Git 状态 | `main`，HEAD `f9cd6a1`；21 个本地提交、2090 个 tracked 文件、无 remote；开始本轮前工作区干净 |
| 全部可达历史内容扫描 | `node .runtime/checks/T18-git-audit.mjs`：2384 个唯一 blob、41874994 bytes；1 个继承环境已知秘密模式只在内存比对；已知值及选定高置信 GitHub/OpenAI/Slack/Google/AWS/私钥模式 0 候选，无 ≥50MiB blob。不是穷尽秘密审计 |
| 公开文件范围 | 当前 tracked 禁止路径 0；独立评判补查 `git log --all --format= --name-only`，运行目录、依赖、私有资料、简历、凭据等仅匹配允许的 `.env.example`；历史作者/提交者为 gtdd123 noreply。没有公开真实用户目录、实验材料或运行数据库 |
| 继承样例 PDF | 唯一历史 PDF 是原有 `assets/samples/sample-invoice.pdf`。使用现有 pdfplumber 提取两页并实际渲染、目视核对两页；未发现用户实验材料。通过 GitHub 官方内容元数据核对 v0.11.4，远端与本地 Git blob 同为 `947f036ab7425a444aa54d52dc12e36cccc69ae2`；保留公开上游演示资产，不上传另行下载的论文全文 |
| 展示资产 | 既有 sharp 渲染 SVG 并目视检查，无裁切/重叠；SVG 自包含，无脚本、foreignObject 或外部资源。两张 PNG 均 1683×1079，来自 T17 真实合成界面截图，目视无凭据、真实资料或论文页 |
| Markdown 与链接 | `node .runtime/checks/T18-readme-check.mjs` exit0，16 个相对文件目标与 7 个显式锚点有效；独立评判另行核对 28 个 Markdown/HTML 目标均可解析 |
| 排版验证边界 | 已生成本地 Markdown HTML，实际浏览器访问本地预览超时，未将其记为通过；GitHub 实际渲染待推送后核对 |
| 应用测试 | 本轮文档/资产修改未重跑应用套件；README 的 435/0、Node36/0、类型/构建/资源及实际 PDF 链路来自 T17 当日已有执行记录。真实模型请求 0，生产 Europe PMC 未通过，其他系统/新机器未验证 |
| 发布身份 | GitHub 连接器确认用户 gtdd123；目标仓库初查不存在，已登录网页表单显示名称可用、Public，未初始化 README/许可/gitignore。创建和推送待独立公开范围审查后执行 |

样例来源：[官方 v0.11.4 公开资产](https://github.com/craft-ai-agents/craft-agents-oss/blob/v0.11.4/apps/electron/src/renderer/assets/samples/sample-invoice.pdf)。只读上游样例元数据首次受沙箱网络限制失败，获网络执行审核后成功；未读取认证存储或显示凭据。公开前将对最终提交复跑历史扫描和 `git diff --check`。

## 独立审查与实际交付

独立评判 `/root/t18_readme_release_judge` 终审 **PASS，无阻断项**：README、CURRENT_STATUS、PLAN22、TASKS、T17 与本记录逐份一致性通过；三项展示资产适合公开，命令、验证数字、来源与限制准确。评判独立检查链接、SVG、截图、历史路径、Git 作者并执行 `git diff --check` 通过。批准提交本轮文档/资产并将现有派生源码历史发布到 `gtdd123/bio-evidence`，定位为注明限制的 0.1.0 公开源码开发预览；要求提交后复扫、标准推送及核对远端 SHA/README/公开可读性。普通实际执行结果可直接追加，不递归审查。此批准不代表 T17 全阶段、真实模型或生产 Europe PMC 通过，不批准二进制发行或生产部署。

GitHub 创建、标准 Git 推送、远端 main SHA、公有可读性及 README 实际渲染目前尚未执行，不能记为发布成功。实际结果随后作为普通执行记录补入；若认证缺失则明确阻断，不改发其他账号或覆盖已有仓库。
