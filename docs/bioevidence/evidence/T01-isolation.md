# T01 — 安装前 namespace 隔离证据

日期：2026-10-09（Asia/Shanghai）。任务：仅 T01，依据已审批 Plan/Tasks 与 T00。起点 HEAD：`a1254cc1a2d8787ae70c60d1df6662eea244019e`。状态：实现与安装前验证完成，待独立 judge 审批；未安装依赖、未执行实际 SDK、未启动应用、未提交 Git。

## 边界

所有源码读取、生产修改和合成 fixtures 只在本派生仓库 `work/bio-evidence`；计划/任务文档从本项目根 `outputs` 读取。未读取/修改原 Craft 源码目录、ZIP、真实 HOME、真实 `.env`、凭据、实验目录或 4090。测试读取生产源码文本；应用的 fs/os 由 Node VM 内存替身提供，模块 linker 只允许 built-ins、明确 mocks、纯 namespace/paths/guard 模块，不加载未安装的 SDK。

实际 Bun 子进程只执行固定 Bun 1.3.10 的 neutral 配置下纯 probe；没有运行原 preload、SDK 或 app。安装用途测试只是构造 frozen-install launch spec 和运行 pure namespace probe，**没有执行 `bun install`**。fixture 目录在 `.runtime/launcher-tests`；清理前验证 lexical resolved 路径和 realpath 均留在该 owned fixture 根内。

## 实际 Red → Green

最初生产源码未改时执行：

```powershell
node --experimental-vm-modules --test scripts/__tests__/bio-isolation.test.mjs
```

退出码 **1**，**0 pass / 4 fail**；四项均为已加载真实生产函数的行为失败，不是依赖导入失败：

1. interceptor 的 `CONFIG_FILE` 实际为假 HOME 的 `.craft-agent/config.json`，忽略明确 Bio override；fakeFS 记录导入期旧日志目录检查/创建，以及调用配置读取、错误持久化。
2. `BIOEVIDENCE_MODE=1` 没有 namespace 时导入成功，测试得到 `Missing expected rejection`。
3. Bio 模式下 `--debug`/`CRAFT_DEBUG=1` 仍使 `DEBUG=true`，raw diagnostic 可以写入假旧日志。
4. `getDefaultOptions()` 实际对假 HOME 执行：`existsSync(.claude.json.backup)` → `unlinkSync(backup)` → `readdirSync(fakeHome)` → `unlinkSync(.claude.json.corrupted.fixture)` → `existsSync(.claude.json)` → `writeFileSync(.claude.json, '{}')`。这是原修复逻辑的真实行为，仅作用于内存替身。

引入 resolver、Bio 日志禁用与 SDK HOME 环境后，同命令退出码 **0**，**4 pass / 0 fail**。随后增加真实消费者和子进程契约回归，最终执行：

```powershell
node --experimental-vm-modules --test scripts/__tests__/bio-isolation.test.mjs scripts/__tests__/bio-launch.test.mjs
```

首次交审前退出码 **0**，**23 pass / 0 fail**。这次由已授权 `require_escalated` 执行；固定 Bun 在普通 Windows 沙箱下两次报 `CouldntReadCurrentDirectory`。该环境故障没有算作 Red；映射 HOME/SDK 目录准备齐全后仍在普通沙箱报错，扩展执行成功。root 另独立复跑了新增 Electron bootstrap 测试前的版本：**22 pass / 0 fail / exit 0**。

扩展测试时有一次 **11 pass / 1 fail / exit 1**：fake `os` 缺少 `hostname` 导出，发生模块链接错误。补齐合成 hostname/userInfo 后 **16 pass / 0 fail**；这也是测试环境修复，不属于业务 Red。

最终另执行：

```powershell
git diff --check
$files = git diff --name-only -- '*.ts'
$files | node --input-type=module -e 'import{readFileSync}from"node:fs";import{stripTypeScriptTypes}from"node:module";const names=readFileSync(0,"utf8").trim().split(/\r?\n/).filter(Boolean);for(const file of names){stripTypeScriptTypes(readFileSync(file,"utf8"),{mode:"transform"});}console.log("Parsed changed TypeScript:",names.length);'
```

二者退出码 **0**；diff 无空白错误，**30 个改动 TypeScript 文件通过语法转换**。这不是完整类型检查，也没有执行转换后的 SDK 模块。

## 可观察契约

`packages/shared/src/config/namespace.mjs` 仅依赖 `node:os/path`，Bio 校验路径不调用 homedir 或文件系统。Bio 模式要求显式绝对 `BIOEVIDENCE_CONFIG_DIR`，存在的 `CRAFT_CONFIG_DIR` alias 必须一致；缺失、相对、不同 alias、旧 `.craft-agent`/数字实例目录拒绝。非 Bio 兼容行为保留在 resolver 中；本产品 entry points 与默认 bunfig 先要求 Bio launcher。

SDK 环境 helper 返回副本，并将 HOME/USERPROFILE、CLAUDE_CONFIG_DIR、PI_CODING_AGENT_DIR、APPDATA/LOCALAPPDATA、XDG、TEMP/TMP/TMPDIR 指向 namespace 内。构造前后父环境深等；不写 `process.env.HOME`、`process.env.CODEX_HOME` 或 shell 全局变量。子进程根不能被 session override 改掉，NODE/BUN hooks 不继承。launcher 在任何子进程（含 version probe）前建立 owned 的 HOME/SDK/XDG/temp 目录。

23 项验证覆盖：

- interceptor config/error 路径；缺 namespace 的导入在任何 fakeFS 调用前拒绝；session error/metadata 的外部目录拒绝。
- Bio debug/raw SSE sink 禁用；错误文件只存固定 HTTP 摘要；Electron 专用日志和 privileged audit 不包含合成 body/header/command marker。
- Claude config repair 仅扫描/写 owned SDK HOME，保留假旧 HOME backup/corrupted 哨兵。
- namespace alias、绝对路径、旧根拒绝；子进程 HOME/profile 与父环境不变。
- docs/release-notes/default workspaces/window state/secure credentials/permissions/browser prerequisites/config_validate/logout 实际调用路径。
- Pi 普通和 ephemeral options 的生产构造片段都提供明确 agentDir（VM 执行构造表达式，未导入或调用真实 SDK）。
- Electron bootstrap 在 fake Electron/fs 下设置三个 owned profile/log 根，且不修改宿主环境。
- neutral 默认 preload 哨兵不执行；安装用途环境不继承合成凭据或 hooks；实际 namespace probe 的 os.homedir 为受控子进程 HOME。假旧 `.craft-agent/log`、`.claude.json.backup`、`.corrupted` 内容与 mtime 保持完全不变。
- 缺 namespace 的仅 built-in/纯 resolver Node 子进程以 1 退出，不导入应用/SDK。

## 真实 IO 清单与修改

| 消费者 | 原行为 | T01 处理 |
| --- | --- | --- |
| shared interceptor-common | 硬码旧 config/log/api-error，导入 mkdir/rotate | resolver root；Bio 无日志导入 IO；安全错误摘要；session 路径校验 |
| shared unified interceptor/debug | curl 正文/响应 headers/body/raw SSE 和通用 debug | Bio 禁日志、raw SSE 与 curl details；debug flag 不能重新开启 |
| shared config/paths | CRAFT override 或旧默认 | 纯集中 resolver；Bio fail-closed |
| agent/options | 扫描/删除/修复真实 HOME 的 Claude config | 验证 child env 后只修复 SDK HOME；Claude/profile env 强制覆盖 |
| agent/pi-agent | process.env + session overrides 直接 spawn | spawn/credentials 前校验 namespace；最终环境用同一 helper |
| Pi server 普通/mini session | 普通分支可能没 agentDir；mini 无 agentDir | 两处明确 SDK agentDir；session/branch 路径校验；Bio debug 禁用 |
| agent/backend/factory | connection-test cwd/workspace 为 homedir | namespace 内 connection-tests 根 |
| agent/claude-agent | 从 HOME/.claude/debug 读取 raw debug | Bio 模式直接禁用该读取分支 |
| workspaces/storage、docs/index、release-notes/index、utils/logo | 各自硬码旧根 | 直路径 CONFIG_DIR 导入，避免 config barrel |
| secure-storage | 旧 credentials.enc 根 | 集中 CONFIG_DIR；文件 magic/加密派生兼容格式没有盲改 |
| permissions-config、prerequisite-manager | 动态旧权限根；硬码浏览器 docs | resolver root |
| skills/storage、skill_validate | 全局 HOME/.agents/skills | Bio owned global-skills 根；非 Bio 保留 |
| session-tools config_validate | 旧 app root | 纯 resolver |
| session-mcp-server updatePreferences | CRAFT override 或 workspace 祖先 fallback | resolver + 产品启动 guard |
| server/Electron messaging | HOME/.craft-agent/workspaces | resolver root |
| server auth logout/workspace slug | 旧 config unlink / workspace exists | resolver root |
| privileged broker audit | 旧日志根及完整 command/payload | resolver root；Bio 仅固定 event/timestamp |
| Electron logger/window-state | 旧根；debug payload logs | resolver；Bio通用传输关闭，专用日志仅 level/scope/time |
| Electron bootstrap/update cache | 默认 Chromium profile；OS updater cache | 先设 namespace 内 userData/sessionData/logs；cache lookup root |
| shared version/install | HOME/.local/share/craft 与 .local/bin | Bio versions/bin 在 namespace；非 Bio 兼容 |
| scripts/electron-dev | numbered folder 会把 CRAFT_CONFIG_DIR 改回旧根 | Bio 模式不执行 instance override |
| bunfig/runtime guard/launcher | 默认 preload 与不完整 SDK home mapping | 产品 guard 在 preload 前；neutral 始终无原 hook；完整 child namespace |

另一个真实 IO 消费者是生成资源 `apps/electron/resources/bridge-mcp-server/index.js`：旧 `.craft-agent/.../.credential-cache.json` 路径仍在 bundle 中，基线没有对应 `packages/bridge-mcp-server/src` 源码。root 已明确授权必要封口：Bio 模式在生成 bundle 顶部、任何启动或凭据/cache IO 前拒绝。测试只执行这个精确前缀 guard，证明后续 startup 不可达；**没有执行整个 bundle 或 SDK**。`base-agent.ts` 和 `backend/types.ts` 明确 Claude/Pi 默认不使用 bridge；runtime resolver 与 build copy 引用仍在，不伪称资源已经删除或重建。

不构成自主 IO 的旧路径注释、文档展示字符串、正则和文件格式兼容字面量没有全仓替换。历史 shell 安装脚本、品牌/deeplink/发布模板留到 T16；没有执行这些脚本。资料路径的权限/realpath/symlink 防御属于 T07/T08，T01 的 namespace 验证不冒充资料授权。

本次新增：namespace.mjs、bio-runtime-guard.mjs、Electron bio-bootstrap.mjs、bio-isolation.test.mjs、本证据文件。修改清单可由 `git diff --name-only` 与 `git ls-files --others --exclude-standard` 复核；没有改依赖版本或 lockfile。

## T02 必须接手的前置

T01 只满足安装前门槛。安装后必须在同一个固定 runtime/launcher 下执行实际 Claude/Pi SDK 导入与完整 interceptor 回归，观察 SDK 所有默认配置/profile/resource 自动发现路径，核实 CLAUDE_CONFIG_DIR 与 `.claude.json` 的实际版本契约。这里的 env/options 构造验证不能替代它。

只有安装后安全回归与合成秘密构建 Red→Green 都通过，才执行普通 typecheck/test/build 或应用入口。当前未验证：完整 TypeScript 类型、所有原回归、SDK 真正启动、Electron app、真实网络/模型、T02 构建秘密闭包。缺口不标成 PASS，也不在 T01 偷跑 SDK。旧 bridge 在 Bio 模式继续禁用，不能在 T02 自动解禁。

## 独立审批

2026-10-09 `/root/independent_judge` 针对 Windows 混合大小写 hook 复审，独立复跑得到 25 pass/0 fail/exit0，diff check 通过且父环境未变，给出 **PASS，授权提交 T01 并开始 T02**。本结论仅安装前隔离，T02 的实际 SDK、类型和构建门槛保持有效。

## 独立 judge REVISE 后的大小写修正

独立 judge 指出 `buildNamespaceEnv` 只删除大写 hook key；Windows 将保留的 `Node_Options` 当作 `NODE_OPTIONS` 解析，合成 probe 可以进入子进程。原始 23 项 PASS 不足以覆盖这条平台行为，以上记录保持为首次交审的事实。

新增两个 focused tests，生产修正前执行：

```powershell
node --test --test-name-pattern mixed-case scripts/__tests__/bio-launch.test.mjs
```

第一次 fixture 用 Windows 反斜杠放入 quoted NODE_OPTIONS，Node 参数解析去掉了反斜杠，报合成 hook 文件 `MODULE_NOT_FOUND`，子进程 1、marker=false；这是 fixture 参数转义错误，不算实际 hook Red。只把 owned 合成 hook 路径改用正斜杠，再运行同命令，退出码 **1**，**0 pass / 2 fail**：

- helper 返回的 child copy 留下 `Node_Options/bun_options/Claude_Code_Debug/Debug` 及 overrides 的另一组混合大小写字段。
- Windows 实际 Node 子进程执行 owned fixture 中的合成 CJS hook，写入 `hook-entered` marker，并以 **9** 退出；测试期望安全子进程正常退出，因此明确失败。hook 没有 SDK/网络/用户目录操作，只写 owned marker。fixture 清理仍先检查 resolved/real 路径。

生产修正：仅在 child env copy 上枚举全部 key，按 `toUpperCase()` 与 `NODE_OPTIONS/BUN_OPTIONS/CLAUDE_CODE_DEBUG/DEBUG` 受限字段集合比较，剔除所有大小写变体，包括 session overrides。父环境与 overrides 都做深等断言，不写任何宿主变量。

同一 focused command Green：**2 pass / 0 fail / exit 0**；真实 Node 子进程正常打印 `safe-child-entered`、exit 0，owned hook marker 未创建。接着复跑完整命令：

```powershell
node --experimental-vm-modules --test scripts/__tests__/bio-isolation.test.mjs scripts/__tests__/bio-launch.test.mjs
git diff --check
```

完整回归 **25 pass / 0 fail / exit 0**（已授权扩展执行 neutral Bun，仍无 SDK/app/import/install）；diff 检查 **exit 0**。本轮仅修改 namespace.mjs、bio-launch.test.mjs 与本证据文档；没有增加依赖或推进 T02。状态：修正完成，待 judge 复审。
