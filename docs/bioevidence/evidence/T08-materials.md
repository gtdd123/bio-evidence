# T08 — 预授权本地资料、目录索引与关键词

日期：2026-10-13（Asia/Shanghai）。状态：独立文档与T08阶段审批 PASS。

## 实现与授权边界

部署负责人在服务自身命名空间的 `material-grants.json` 保存严格 JSON 数组：`id/scope/label/rootPath`。此文件不是账号或 RPC 可写配置。缺文件代表没有资料预授权；清单大小上限1 MiB、1000项，拒绝目录链接重定向。首次启动先建立账号/项目，再按其真实标识授予目录并重启服务。修改路径、空间或标签需新 grantId，不能原地改变已登记的授权；移除清单项停用对应入口访问。

负责人只能按 grantId 登记相对目录，客户端不接受 rootPath/actor/policy。跨空间的宽父根覆盖另一个窄根时拒绝配置；确需共享完全相同物理根，必须分别明确授予。路径拒绝绝对/驱动器/流/控制字符、`..`、凭据与平台状态目录、symlink/junction及前缀兄弟越界；登记、索引、页读取和文本打开均检查实际路径。原文件内容只读，索引和备注只保存在服务 SQLite。资料、批注和搜索结果始终 restricted。

服务的所有资料操作复验当前账号、项目成员及 grant。生产入口还按 authSessionId 复验有效会话；异步打开前后、批次和输出阶段均复验。所有19个当前科研请求启用统一 gate；通道359项中，19 enabled、1 scoped-event、7后续功能未启用、332 legacy禁用。资料新增10个严格 typed 请求，不注册旧 raw-file、transfer、share 或 OS bridge。HTTP `/api/materials/:rootId` 的 root/directory/index/annotation 元数据读取与 RPC 共用当前权限和返回绑定，认证/同源/TLS边界复用 T06，输出 no-store；不提供原图下载或预览字节。

## 目录与搜索行为

默认全局单扫描任务，同目录请求合并等待；只遍历指定目录层级。200项一批，默认每目录100000项、30秒；`service.json.materialBudgets` 可配置受验证预算。批次记录实际进度，失败记录 budget/offline/changed；重启遗留 indexing 显示 interrupted。只有 complete 代次可分页；默认100、最大200，自然数字名称稳定排序。游标绑定 root/目录/代次，目录变化或页内文件签名变化要求刷新。旧完成与旧批次不能覆盖新代次。

关键词匹配当前入口根目录的名称、平台备注/标签，以及预算内的 UTF-8 TXT/MD/CSV/TSV/JSON 正文；下级目录按层级浏览，可独立登记为入口检索，不进行隐式递归。PDF文本解析属T11。默认文本每文件256 KiB、最多64个文件/16 MiB、搜索2秒、最多64匹配；返回 truncated、实际读取计数、跳过的大文件/格式/编码计数。时间检查覆盖非文本项与异步操作后；不会调用模型或第三方服务。

读取绑定完成索引的签名，再比较打开对象 dev/ino/size/mtime/ctime；读取后复验打开对象、路径、目录及代次。不把搜索期间改写的文件当原快照。没有使用Windows原生路径句柄锁；测试验证检测到的打开替换和内容变化拒绝输出，不宣称可阻止拥有本机文件写权限的恶意进程安排所有瞬时竞态。时间预算在文件操作之间检查，不声称能强制中断停滞的内核文件操作；独立可终止图像解码在T09实现。

## 实际 Red 与修复

- 初始骨架：1 pass/3 fail/7expects，缺少登记/索引/搜索行为；首次实现4/0/17。
- 搜索部分状态与索引CAS/打开保护：3 pass/5 fail/10071expects，确认结果无partial标记、旧完成未拒绝及打开替换没有保护。错误消息断言校正后重跑2 fail，仍分别是未抛异常与错误接受替换，不把断言错误当行为Red。Green8/0/10080。
- 独立实施审查发现同页后续文件修改、名称检索、配置预算/失败状态缺口；真实复现3 fail/3expects，修复后5/0/21（含真实RPC）。单扫描、图片元数据时间预算、备注/标签和失败进度一并补齐。
- 新RPC两项Red均 CHANNEL_NOT_FOUND；HTTP Red为404；接线后真实账号RPC/HTTP通过。离线入口Red为错误丢失元数据读取，保留入口后通过。备注Red缺持久化方法，补齐修订与只读保存后通过。
- 清单测试首跑错误消息断言写错、Windows文件symlink EPERM；均为夹具/环境失败，不作行为Red。改用Windows实际目录junction后2/0/6。

## 命令与观测证据

所有Bun命令经固定1.3.10与neutral launcher；以下命令已实际执行，日志在忽略的 `.runtime/checks/T08-*`，没有真实实验数据或模型请求。

```text
node scripts/bio-launch.mjs test test packages/server-core/src/research/material-grants-config.test.ts packages/server-core/src/research/materials-service.test.ts packages/server-core/src/research/materials-rpc.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__ packages/server-core/src/sessions/cold-session-metadata.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs test run bio:typecheck
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T08-bio-service.js
node scripts/bio-launch.mjs test run .runtime/checks/T08-startup.ts
node .runtime/checks/T08-scan.mjs
```

- 最终资料三文件：**22 pass/0 fail/10129expects/19.76s/exit0**。之后新增RPC批注编辑角色/跨入口文件标识及HTTP跨站验证，单独RPC最终4/0；需要独立评判复跑最终候选。
- 广相关：**205 pass/0 fail/11751expects/28files/72.93s/exit0**。之后新增实际关闭重开SQLite的持久化测试，单独1/0/3expects；不把新增测试悄悄计入前一数字。
- 一万合成PNG：自然顺序50页、每页不超过200，10000项全遍历，资料服务文件打开观测为0；最终该用例17.14s。原图未解析或复制。备注和文本用例验证原文件正文未改写。
- root八包类型、Web类型、纯research-core类型均exit0。首轮类型检查有两处测试类型失败，修正后重跑通过。运行命令不使用不支持的 `bio-launch x`，早期一次错误调用不算类型通过。
- 最终实际Bun服务构建 **235 modules/0.79MB/exit0**。实际 `startBioServer` 从自身配置读预授权、启动监听、登录态RPC登记/索引及HTTP目录访问均exit0；输出仅合成统计与上述359项通道分类，没有token/密码/私有路径。
- 已知宿主秘密扫描：最终源码1806文件、已有构建及新服务1332文件，hitFiles均空，exit0；没有输出秘密值。无依赖或lock变化。diffcheck通过。

## 范围与审批

变更只涉及研究领域契约、Bun资料服务/持久化、共享协议与实际服务接线、三组合成测试、目录忽略及领域语言。没有重跑完整原Craft基线或关闭T02延期门槛，没有完成图片预览、UI操作、模型、真实4090接入或GitHub发布。没有临时原图或实验内容提交到Git。

独立评判者 `/root/t08_independent_judge` 正式审批 **PASS，无阻断项，允许进入T09**。独立复跑资料三文件22/0/10129expects/18.36s，新增权限测试所在RPC文件4/0，research-core类型exit0；核对实现、证据、CONTEXT术语及任务状态。评判只读、未修改文件，要求修正最终扫描统计1806并记录审批状态，明确无需再次审批。
