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
| 发布前身份核对 | GitHub 连接器确认用户 gtdd123；目标仓库初查不存在，已登录网页表单显示名称可用、Public，未初始化 README/许可/gitignore。当时尚未创建和推送，审批后的实际结果见下文 |

样例来源：[官方 v0.11.4 公开资产](https://github.com/craft-ai-agents/craft-agents-oss/blob/v0.11.4/apps/electron/src/renderer/assets/samples/sample-invoice.pdf)。只读上游样例元数据首次受沙箱网络限制失败，获网络执行审核后成功；未读取认证存储或显示凭据。首次公开提交复扫及 `git diff --check` 已通过，见下文；普通记录同步后仍核对最终远端 main。

## 独立审查与实际交付

独立评判 `/root/t18_readme_release_judge` 终审 **PASS，无阻断项**：README、CURRENT_STATUS、PLAN22、TASKS、T17 与本记录逐份一致性通过；三项展示资产适合公开，命令、验证数字、来源与限制准确。评判独立检查链接、SVG、截图、历史路径、Git 作者并执行 `git diff --check` 通过。批准提交本轮文档/资产并将现有派生源码历史发布到 `gtdd123/bio-evidence`，定位为注明限制的 0.1.0 公开源码开发预览；要求提交后复扫、标准推送及核对远端 SHA/README/公开可读性。普通实际执行结果可直接追加，不递归审查。此批准不代表 T17 全阶段、真实模型或生产 Europe PMC 通过，不批准二进制发行或生产部署。

## 实际公开交付结果

- **仓库：** [gtdd123/bio-evidence](https://github.com/gtdd123/bio-evidence)，GitHub 仓库 id `1427123506`，visibility=`public`、default_branch=`main`，本人账号具 admin/push 权限。网页创建空仓库，没有额外初始化提交，没有操作其他仓库或邀请他人。
- **首次源码推送：** `e14fccdb9222628705d7bf543b1f39baf519aa7a`，包含22个本地派生提交、2094个tracked文件。`git push -u origin main` 正常建立 origin/main，没有 force。独立终审后的提交复扫为2393个唯一历史blob /42148403 bytes，已知秘密、高置信模式、当前禁止路径和≥50MiB文件均0候选。
- **网络与认证：** Git 直连 schannel 握手失败，临时 OpenSSL 后端同样失败；只读检查确认本机已有 Windows 系统代理，随后仅本命令显式使用该现有代理，标准 Git 凭据认证推送 exit0。没有关闭证书验证、修改系统DNS/代理/证书、读取凭据存储或把认证信息放入 remote URL。临时本地 README 预览服务已停止。
- **远端核对：** `git ls-remote origin refs/heads/main` 得到上述首次发布完整SHA；未认证的公开 GitHub API 内容元数据确认 README、三项展示资产、LICENSE、NOTICE 的 Git blob 与本地全部一致，真实源码与文档公开可读。
- **实际 GitHub 渲染：** 已在仓库主页目视核对横幅、静态徽章、表格、真实界面截图和 Mermaid 架构图；不是仅凭本地解析器判断。发现裸URL紧接中文被自动链接吞入的问题，已改为显式 Markdown 链接；独立评判追加只读核对 README 第81行与diff后 **PASS**，批准提交推送。相对链接检查再次exit0。
- **CI：** 首次推送触发 [BioEvidence Windows validation](https://github.com/gtdd123/bio-evidence/actions/runs/39437869334)，观察时 `in_progress`，checkout/Node/Bun/runtime注册/锁定依赖安装已success，回归/类型/构建/资源步骤运行中，MCP步骤pending。尚无远端全PASS结论；后续文档推送可能按并发策略取消旧运行，最终状态以远端记录为准。未触发仅手动执行的运行目录包装流程，也未创建二进制Release。

T18 源码公开交付已完成。以上首次发布与后续普通记录同步分别留痕，后续文档提交以仓库 main 实际SHA为准；T17 的真实模型和生产公网缺口仍存在，不因上传成功而改为通过。本轮没有重跑应用套件，文档/资产与发布检查均按实际范围记录。
