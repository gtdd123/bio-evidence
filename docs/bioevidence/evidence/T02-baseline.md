# T02 — 锁定安装与构建安全基线

日期：2026-10-09 至 2026-10-10（Asia/Shanghai）。起点：`889e47e335cc0bc22ea8bfb1bc0a6c1020515148`。状态：**2026-10-10 独立阶段审批 PASS，允许进入 T03；完整原基线仍未全绿**。

## 已通过的安全门槛

1. 首次原锁 frozen install 失败：`lockfile had changes, but lockfile is frozen`。原归档锁还含三个实际不存在的 workspace。最小候选删除这些及独占闭包，将 root/CLI 的 `@types/bun: latest` 固定到原锁的 `1.3.6` / `1.3.14`。2026-10-10 独立评判者 `/root/t02_independent_judge` 只读比较确认 2048 项留用记录完全不变、20 项删除、0 项新增，批准此修正。此结论只批准重装，不是 T02 完成。
2. 恢复时上次进程 ID 已不可读取；SDK 文件存在不能充当安装成功证据。重跑 `node scripts/bio-launch.mjs install install --frozen-lockfile`：固定 Bun 1.3.10，**exit 0，6 packages installed，28.07s**。
3. 安装 prepare 的 husky 将 repo-local hooksPath 改成 `.husky/_`。已恢复 `.git/hooks`，install-purpose 环境固定 `HUSKY=0`；没有更改全局 Git。后续获批新增依赖重装实际输出 `HUSKY=0 skip install`。
4. `node --test scripts/__tests__/bio-sdk.integration.test.mjs` 最终 **1 pass / 0 fail / exit 0**。探针真实导入 Claude SDK 0.3.220 / Pi 0.80.6，修复自有 `.claude.json` BOM，读取并 flush 自有 Pi auth/settings，构造实际 Pi session 后 dispose。Claude 真实 query 构造到受控 spawn extension，记录最终 namespace 环境后停止，**没有执行 native CLI、没有模型请求**。旧 HOME 哨兵不变，父环境只比较布尔结果。
5. `node --experimental-vm-modules --test scripts/__tests__/bio-isolation.test.mjs scripts/__tests__/bio-launch.test.mjs scripts/__tests__/bio-sdk.integration.test.mjs`：**26 pass / 0 fail / exit 0**。
6. 完整 9 个 interceptor 定向文件：首次 **63 pass / 5 fail / exit 1**，原因是原 schema fixture 写到旧 Craft HOME 路径，而生产实现读取 namespace；将 fixture 改为 `CONFIG_DIR`、全部原断言保留后，**68 pass / 0 fail / exit 0**。此 fixture 错误不充当新生产行为 Red。

SDK 探针第一次错误地同步读取 Pi 的异步写入，增加实际 API 的 `await settings.flush()` 后正确验证。第二次断言比较 process.env 特殊对象与普通复制，失败输出意外展开宿主环境凭据；root 已通知用户轮换，改为普通复制的 `isDeepStrictEqual` 布尔断言。**本文件和源码不记录凭据值**，此错误不算业务 Red，也没有复用这些宿主凭据。

## 合成秘密真实构建 Red → Green

命令：`node --test scripts/__tests__/bio-build.integration.test.mjs`。

最初 fixture 缺少 interceptor 入口、Vite `--config` 与 launcher 保留参数冲突，三项未实际完成构建；只修 fixture 后重跑，实际生成主进程 CJS、两个 Vite 客户端 JS/map，**0 pass / 3 fail / exit 1**，分别命中 main.cjs 与两个前端 JS 的合成标记。这是有效 Red；只输出生成文件数量及命中文件名，不打印值。

修正：主 builder 不读取根 `.env`，client defines 仅固定空 OAuth/telemetry 字符串；五个子 Bun 命令使用 pinned executable + inline neutral config，环境重新按非秘密字段白名单构造。preload/renderer builder 同样收敛，renderer 清理验证 resolved/real 路径。两个真实 Vite 配置使用 `envDir: false` / `envPrefix: []`。主/renderer Sentry disabled。旧开发/打包脚本不能继续读取旧 dotenv 或编译 OAuth 值；不执行它们的上游发布入口。

同一命令 Green：**3 pass / 0 fail / exit 0**，实际产物数量 2 / 3 / 3，全部 `markerHitFiles: []`。Vite fixture 使用真实生产配置环境策略和真实 Vite 引擎；简单 JS fixture 不运行 React/Babel plugins，不能代替完整应用构建。

## 依赖与普通检查（安全门槛之后）

Plan 已批准的 direct dependencies 放在服务端 `packages/server-core`：fast-xml-parser **5.11.2**，pdfjs-dist **5.4.296**（原锁已有 PDF 版本）。`node scripts/bio-launch.mjs install install --lockfile-only` **exit 0**；再 frozen install **exit 0，13 packages installed，26.52s**。新增 parser 引起 5 个同名 hoist 记录变化及 12 个 nested/新增记录。独立评判逐边比较 **4144 条旧依赖/optional 解析不变**，AWS parser 5.2.5、三个 5.7.3 闭包及 integrity 保留；新增实际版本均属于批准的 5.11.2 闭包。PDF 保持 5.4.296。实际 Node createRequire 核对 direct parser 5.11.2/MIT 与 AWS parser 5.2.5/MIT。

| 实际命令 | 观察结果 |
| --- | --- |
| `node scripts/bio-launch.mjs test run typecheck:all` 首次 | exit 1，原归档缺 tsconfig.base.json |
| 同命令第二次 | exit 1，继承 root strict/noUnchecked 后两个原测试数组访问有 10 处错误 |
| 同命令第三次 | exit 1，Pi 内三处确定边界的索引/捕获需要明确类型 |
| 同命令第四次（session 67849） | **exit 0**；补 base 只 extends 原 root strict，没有降低选项；保持所有原断言 |
| `node scripts/bio-launch.mjs test run webui:typecheck` | **exit 0** |
| `node scripts/bio-launch.mjs build run electron:build:main` | **exit 0**；session MCP 4.64MB、Pi 27.1MB、interceptor 62.7KB、WA 6.0MB、main 43.6MB；node syntax verification passed |
| `node scripts/bio-launch.mjs build run electron:build:renderer` | **exit 0**，5605 modules，81s；有原 bundle 大小/outDir 提示 |
| `node scripts/bio-launch.mjs build run webui:build` | **exit 0**，5260 modules，78s；有原 bundle 大小/outDir 提示 |

以上是构建/类型证据，**没有启动应用，也不代表账号、科研功能或用户验收已经实现**。

## 常规与 isolated 回归仍在收敛

原 POSIX find/loop 改为 Node 跨平台 runner `scripts/bio-tests.mjs`。常规范围 apps/packages（原 scripts 无 Bun suite），4 个 Node suite 单独 Node 执行；5 个原 `.isolated.ts` 各进程执行。首次常规和 isolated 诊断曾并发共享 test namespace，不能作为权威最终结果。现 launcher 的每个实际 test invocation 使用不同的自有 UUID 目录；runtime/install/build 的持久路径不因此改变。完成前须**串行**复跑并记录全部结果，保留失败。

首次常规诊断：`node scripts/bio-tests.mjs --regular` **4813 pass / 1 skip / 122 fail / 1 error / exit 1**，4936 tests / 373 files / 201.86s，忽略目录中的完整日志 `.runtime/checks/T02-regular.log`。Windows 路径 fixture、namespace 子进程 env、旧 mock、服务 smoke 等失败不能忽略成 PASS。

已定位修复并实际验证：

- startup migration 子进程完整用 buildNamespaceEnv 映射，而不是只改两个别名或禁 guard：原 16 fail 最终 **16 pass / exit 0**。其他 8 个原 fixture 按同样契约修正；首轮 51 pass / 3 fail，后续正在定向收敛。
- permissions migration 原 fixture 在仍为 cwd 的目录执行 rm，Windows EBUSY；先恢复 cwd，确认临时路径 resolved/real 在自有父目录，再删除。
- UI language 的 eval 使用未转义 Windows 路径；改 JSON.stringify 路径，原幂等性断言不变。
- 每个 thinking level 用两个真实 subprocess 的单项集成测试预算设 30s，其他超时不变，所有 level 断言保留。
- prerequisite isolated 的 docs/skill 路径与 config fixture 修正；旧 browser_snapshot/open 已不是实际 browser_tool，测试转为真实注册名、依旧要求严格前置阅读，待最终完整复跑。
- branch rollback isolated 补真实 config 部分 mock：**3 pass / exit 0**。
- 客户端 basename 按本机分隔符解析服务端路径的真实缺陷：相同 `use-working-directory-state.test.ts` 独立 Red **10 pass / 4 fail / exit 1**；仅 basename 同时处理两种分隔符，Green **14 pass / 0 fail / exit 0**。不改文件授权。

## 后续实际收敛结果（2026-10-10）

- Node 四套：`node scripts/bio-tests.mjs --node` **29 pass / 0 fail / exit 0**，包含 SDK 和真实合成构建测试。
- 五个 isolated 各独立进程：`node scripts/bio-tests.mjs --isolated` **112 pass / 0 fail / exit 0**（notifications 2、branch rollback 3、annotations 3、pretool 70、prerequisites 34）。
- 常规串行第一次：**4822 pass / 1 skip / 113 fail / 1 error / exit 1**，184.39s；第二次：**4883 pass / 1 skip / 52 fail / 1 error / exit 1**，187.55s。旧 fixture 留下 CRAFT_SESSION_DIR，使子 namespace 与会话目录不匹配，改为对子进程显式清空此字段后收敛；保留生产 namespace guard。
- 最新完整串行：`node scripts/bio-tests.mjs --regular`，日志 `.runtime/checks/T02-regular-serial-3.log`：**4920 pass / 1 skip / 17 fail / 0 error / exit 1**，4938 tests / 373 files / 213.81s。这不是全绿。
- session-validation/bundle 两文件 **52 pass / 0 fail / exit 0**；sandbox-env/path-validation 两文件 **19 pass / 0 fail / exit 0**。前者保持遍历/定位安全断言，仅统一 native/POSIX 预期；后者显式区分空环境与 launcher owned XDG，并使用真实 Windows temp 平台参数。
- CLI 原套件 **13 pass / 0 fail / exit 0**。精确 local WebSocket helper 与实际客户端探针证明错误帧正常到达；Bun 1.3.10 rejects.toThrow matcher 阻塞该用例。改为显式 await/catch，保留 Error 类型和原消息断言，finally destroy，不改生产 RPC、不增加超时。OpenSSL 不可用时原 TLS 用例会提前返回，因此不声称完整 TLS 已验收。
- 连接刷新原 **7 pass / 1 fail**，原因是用例没有创建 pi_compat 模型配置；补真实 owned config 与明确 supportsImages=true 模型并恢复配置，原 8 项通过。
- transform_data 原 **6 pass / 2 fail**：实际 stderr 指出 owned tmp 位于 type:module 仓库内，Node .js 的 require 不可用；node 片段改 .cjs 后原 8 项通过。与 Bun/Python 分别使用原扩展，路径边界保护不变。
- BrowserPane 原 **67 pass / 9 fail**。旧 Craft deep-link、did-create-window 无 event 参数、toolbarView 的 readiness/send/retry 与旧 window fixture 不一致，修正夹具。真实 finalizer 再次执行 cleanup 未 catch，异常阻止实例删除；逐项捕获后继续清理/删除。Windows llm-tool 附件名 split('/') 的真实缺陷改为同时识别两种分隔符。BrowserPane、build-call-llm、spawn-cwd、spawn-tilde、Darwin profile、project storage 六文件最终合计 **136 pass / 0 fail / exit 0**；其中 BrowserPane 76 项全通过。
- regular-3 唯一未分类 zsh 用例之后独立诊断：原 fixture 将 Windows native backslash 放进 shell wrapper。改为已支持的 escaped double quote + forward slash，保持真实目录和原 allow 断言；`node scripts/bio-launch.mjs test test packages/shared/tests/mode-manager.test.ts --test-name-pattern 'Codex-style zsh write to plans folder'` **1 pass / 443 filtered / 0 fail / exit 0**。不是生产解析 Red；完整 regular 的 17 fail 记录不倒改为 16。
- preload、resources、assets 实际构建各 **exit 0**；preload bootstrap 814.9KB/browser 2.2KB 且 syntax checks passed。root 候选源码 1897 文件及实际产物 1554 文件扫描合成标记/已知宿主凭据值 **0 hits**，不打印值；独立评判六个产物根 1777 文件 marker 扫描同样 0。两个扫描范围不同，不能合并为一项计数。
- Python 原八模块经 owned 环境、bundled Python 实际执行：**0 tests / 8 setUpClass errors / Python exit 5（外层 exit 1）**。原因是原归档缺 win32-x64/uv.exe 且 PATH 无 uv。没有安装全局 runtime，没有计为通过。

## 剩余基线、责任与硬门槛

| 原失败组 | 归因与影响 | 收敛责任 |
| --- | --- | --- |
| Windows 模式 14 项 | 原测试写死不存在 C:/Users/test、Balin 等根；现有 nearest-real-ancestor guard 正确拒绝这些虚构目录 | T13 **开始前**改真实 owned 根，保留原 allow/deny、case/wrapper 断言；不放松生产 realpath guard |
| Windows 服务 SIGTERM 1 项 | Bun Windows kill(SIGTERM) 强制结束，原 POSIX exit 0 期待不成立；不能据此声称 graceful flush | T16 **完成前**提供可用的受控关闭路径并实际验证 |
| Windows MCP 缺命令 1 项 | SDK 经 shell 运行不存在命令，返回 Connection closed 及系统错误而非 ENOENT；失败成立但提示分类不准确 | T16 **完成前**明确命令不存在诊断，不能删原消息断言 |
| Python 8 errors、CI/包装缺入口 | 固定 runtime 缺失；旧 CI 引用缺失 i18n 脚本，Electron validate 引用缺失脚本，旧发布脚本不可用 | T16 **完成前**实现并验证支持范围的真实入口/依赖；明确不支持工具，不假报通过 |

Plan 第 18 节与 Tasks T02 补充记录同一关闭门槛。T17 必须完整重跑交付支持范围，关闭遗留阻断；登记不是豁免。T02 本次新引入 namespace/构建回归已收敛，未归因失败不得进入 T03。

## 未验证与最终审批

最终类型第一次发现合成连接 fixture 使用了不存在的 ModelProvider=openai，**exit 2**；改为原枚举 pi 后 `node scripts/bio-launch.mjs test run typecheck:all` 最新 **exit 0**，没有降低检查。`node scripts/bio-launch.mjs test run webui:typecheck` 最新 **exit 0**。`node scripts/bio-tests.mjs --node` 最新 **29 pass / 0 fail / exit 0**；`--isolated` 五个独立进程最新均 **exit 0，共 112 pass / 0 fail**。

实际修复后 `node scripts/bio-launch.mjs build run electron:build:main` 重建最新 **exit 0**，包含新 BrowserPane/附件实现，main.cjs syntax verification passed。原完整 renderer/Web 构建已经通过，此后未改其生产 UI 逻辑，不重复声称新 UI 验收。`git diff --check` 已通过，最终文档更新后再检查。

真实 native CLI/模型调用、真实 4090、双端 UI、科研 AC、GitHub 创建/上传都未执行。

最终补充：`node scripts/bio-launch.mjs test run test:shared:all` 三个子套件均 0 fail、外层 **exit 0**（最后 config 套件 84 pass）；最新扫描覆盖候选源码 **1901 文件**、实际产物六个根 **1554 文件**，已知宿主凭据值 **0 hits**，含真实 messaging-whatsapp-worker/dist，不显示值。文档更新后 `git diff --check` **exit 0**。延期 Plan/Tasks 与仓库副本已同步，Constitution/Spec 副本与已批准原文一致。

2026-10-10 `/root/t02_independent_judge` 最终只读审批 **T02 阶段 PASS，允许按修订计划进入 T03**，同时批准 Plan 第18节、Tasks T02 门槛及此记录；独立复扫1777产物合成marker零命中。审批不把完整基线4920/1/17/0或Python0/8改写为通过。

提交过程补充：首次 `git diff --cached --check` 对新加入的四份批准文档报 Markdown 两空格硬换行，**exit 1**；root 误继续产生本地提交 `03d3253`，不记为检查通过。随后把硬换行改为空行，内容逐字规范化比较不变、双副本同步，实际 `git diff --check` **exit 0**，独立评判批准格式及审批元数据修正。修正另存提交，保留原记录。
