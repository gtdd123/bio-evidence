# T19 — 资料三栏工作台

日期：2026-10-21。基线 ec368ad。范围：SPEC UI01、PLAN23、TASKS T19；其他 UI02–06 尚未实现，本记录不代表四项建议全部交付。

## 实现与边界

MaterialsPanel 复用既有授权目录、分页索引、图像解码与批注 API，重排为文件浏览/选帧预览/科研批注三栏。目录登记和本地文本检索折叠，减少重复信息占用；窄屏顺序堆叠。选中图像后按元数据加载首帧，可直接输入帧号；右侧显示服务端批注修订并保留已有 CAS/草稿冲突处理。

新增 MaterialPreviewController 只管理单文件修订的请求版本与对象 URL。切帧先清除并释放旧 URL，过期响应不分配 URL，不同 root/file/generation/frame 的响应不能显示。组件卸载时关闭控制器，延迟返回不能更新旧视图。服务端授权、范围、解码预算没有放宽，未增加依赖或接入真实实验目录。

本阶段实机验证为真实应用服务与 Electron39 加载的真实 Web renderer，账号/目录/12页TIFF全为合成夹具。没有配置或调用真实模型；此截图没有作为 README 的公开显微样例。模型配置仍由用户在产品管理员页面完成，保存成功不等于连通性成功。

## 实际验证

| 命令/操作 | 实际结果 |
| --- | --- |
| `node scripts/bio-launch.mjs test test apps/electron/src/renderer/bio/material-preview-state.test.ts`，stub阶段 | 首次受沙箱 mkdir EPERM 限制，未算Red；获执行审核后实际运行 **0 pass / 5 fail / exit1**，缺少请求、loading/URL管理和帧范围拒绝行为，符合预期Red |
| 同一预览文件及 `material-note-draft.test.ts` | **8 pass /0 fail /27 expects /2 files /495ms /exit0**，覆盖乱序、清屏、URL释放、卸载、拒绝/不可用、范围与响应身份匹配，以及原批注冲突 |
| `node scripts/bio-launch.mjs test test apps/electron/src/renderer/bio packages/shared/src/i18n/__tests__` | **81 pass /0 fail /137 expects /7 files /615ms /exit0**，前端状态与字典键/插值/排序回归 |
| `node .runtime/checks/T19-lint.mjs` | 最终3个改动的 TS/TSX 文件 **0 errors /0 warnings /exit0** |
| `node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json` | 首次与最终布局检查均exit0 |
| `node scripts/bio-launch.mjs build run scripts/bio-renderer-build.ts web` | 最终构建 **exit0 /5.21s**；保留既有>500kB chunk警告，未放宽阈值 |
| `node scripts/bio-launch.mjs build run scripts/bio-renderer-build.ts desktop` | 最终构建 **exit0 /5.37s**，同样保留chunk警告 |
| `node scripts/bio-launch.mjs test run .runtime/checks/T19-material-server.ts` + `node .runtime/checks/T19-material-launch.mjs` | 新临时namespace中的真实服务；最终GUI **exit0**，宽屏三栏同排、真实首帧自动加载、第3/12帧、点击保存后等待服务返回v1；640px窄屏三段堆叠且无横向溢出，模型请求0 |
| `git diff --check` | exit0 |

原始脚本、输出摘要/截图位于忽略目录 `.runtime/checks/T19-*`。最终实际 GUI 结果文件为 `T19-material-result.json`，截图 `T19-material-wide.png` 已目视核对。没有用单元测试或截图替代模型、公开文献公网、真实4090或生产部署验收。

## 验证过程中的失败与修正

- 最初 locale helper 使用 localeCompare 导致已有键顺序改变；已按仓库脚本规范改回字典键默认排序，最终每个locale仅新增10个必要键，parity全部通过。
- 第一版GUI脚本的批注按钮/标签匹配不准确，只证明布局与选帧，不能证明保存；已改为精确命中并断言操作成功，同时等待服务端批注修订。两次后续等待v1超时，诊断发现测试服务启动时缓存的是旧静态资产，不含新增修订显示；没有将这些失败记为通过。只停止自建合成服务并在新namespace加载最终构建后，最终完整GUI通过。应用静态资产仍按启动时校验的不可变内容服务，没有为热更新降低完整性检查。
- T19测试不使用原生文件选择器、真实模型或真实实验数据；最终资料读写由正常账号鉴权与授权目录RPC执行。旧测试服务与最后验证服务均已按各自runId受控停止，进程exit0；没有删除用户文件。

## 独立审批

上游 SPEC/PLAN/TASKS 的本轮扩展已由 `/root/t19_independent_judge` 独立终审 PASS。随后该评判顺序给出 **T19规格符合性 PASS、代码质量 PASS、文档一致性 PASS及阶段 PASS**，批准继续 T20；独立复跑预览/批注两文件 **8 pass /0 fail /27 expects /154ms /exit0**，`git diff --check`通过，并目视核对实际合成截图。评判首次沙箱mkdir EPERM未算行为失败，获自动执行审核后复跑成功。普通审批/执行记录直接同步，不递归审批自身。
