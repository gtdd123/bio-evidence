# T10 — 公开文献、来源修订与选择

日期：2026-10-13（Asia/Shanghai）。状态：本地实现、证据文档及责任门槛已获独立审批PASS，可进入T11。生产适配器公网验收保留明确发布门槛，见末节。

## 完成范围

EuropePmcProvider 接受检索词、游标、每页数量、取消信号，返回实际题录、摘要、文章许可和开放全文可用性。record 使用确定 provider 标识，openText 只接受 PMC 标识并返回原始 XML；JATS 解析和全文覆盖属于 T11。缺字段不补造；isOpenAccess 只表示可用性，不能据此认定允许再分发。许可未取得时保持 unknown。

网络入口固定 `https://www.ebi.ac.uk/europepmc/webservices/rest/`。查询参数编码，record/PMC 标识受限，不接受外部 URL、授权头或重定向。生产使用原生 HTTPS，IPv4 DNS 全部结果须通过公开地址检查；实际 socket 的 lookup 固定到已核验地址，TLS 仍验证原域名。IPv6、内网、回环、链路本地、测试地址等拒绝。当前 IPv4-only 是明确实现限制。默认响应 10 MiB、请求全程 30 秒，在 `service.json.literatureBudgets` 可调低；预算覆盖 DNS、连接及响应读取。HTTP 429、超时、超预算、无效输入和服务不可用使用固定安全错误；不把网络原始错误或内容发给客户端。取消/超时销毁原生请求；不改宿主代理或信任设置。

搜索只产生临时候选，不批量写入来源或自动选中。候选票据绑定账号、认证会话、科研会话与原始取得时间，15 分钟到期；客户端拿到的是隔离对象，不能通过修改候选污染服务端事实。查询缓存按授权范围、public策略、词、游标、页大小隔离，15 分钟到期，最多64页/16 MiB；候选最多5000项/16 MiB，先淘汰旧项。当前权限和会话策略在外部请求前后及结果交付前检查；restricted/unknown会话不发文献查询。

用户选择候选后，同范围、同策略按规范化 DOI/PMID/PMCID/providerId 查找来源，不按标题合并，也不复用私有记录或批注。多个来源身份相撞时返回明确冲突候选，不自动合并。变化形成新 recordId、稳定 sourceIdentityId、revision/predecessorId，旧来源与旧快照不可覆盖；冲突元数据字段被保留标识。新抓取缺少摘要时不继承旧摘要，不生成虚假的新取得摘要。未变元数据复用已存来源。同范围来源头扫描上限10000项/16 MiB，超限明确失败。

选择来源、实际摘要快照、会话 selectedSourceIds、审计及 outbox 处于同一 SQLite 事务，过期会话版本或后续写失败全部回滚。快照使用实际摘要内容哈希和取得时间，coverage 始终 abstract，不因提供器宣称有全文就称已读。一个来源家族的新修订替换会话中的选定旧修订；历史引用仍指向旧快照。用已有来源创建会话也会保存选择关系，并从真实来源继承策略。

PDF 来源登记是仅供后续上传/解析阶段使用的服务端字节接缝：最多25 MiB，记录内容哈希；默认restricted，明确公开声明记录actor/time，许可仍unknown。同范围同哈希同策略复用来源；已知私有字节不能靠公开标签晋升。内部复制只复用同范围已有来源并继承其策略，不能接客户端policy。此处不保存原始PDF、不声称解析成功；实际上传、格式验证、解析与页级快照属于T11。

共享认证RPC新增选择/getSource，启用search/getSnapshot；默认服务入口接入EuropePMC。搜索和选择使用会话所有者执行权限，结果再次校验当前授权与权威记录。未接入文献能力的profile仍默认禁用这些功能。没有新增模型调用、实验外发、依赖或SQLite schema迁移。双端操作界面在T15完成。

## 实际验证

固定 Bun1.3.10 launcher。所有自动测试用合成元数据/账号/PDF字节；未访问4090或实际实验材料。日志在忽略的 `.runtime/checks/T10-*`。

```text
node scripts/bio-launch.mjs test test packages/server-core/src/research/literature-provider.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/literature-service.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/literature-rpc.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/literature-provider.test.ts packages/server-core/src/research/literature-service.test.ts packages/server-core/src/research/literature-rpc.test.ts packages/server-core/src/research/sqlite-repository.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__ packages/server-core/src/sessions/cold-session-metadata.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs test run bio:typecheck
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T10-bio-service.js
node --check .runtime/checks/T10-bio-service.js
node .runtime/checks/T10-scan.mjs
node scripts/bio-launch.mjs test run .runtime/checks/T10-startup.ts
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server-core/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server/tsconfig.json
```

- 源修订Red为原record可覆盖以及竞争修订约束未实现；Green2/0/4expects。
- 提供器guard Red3/2/20expects，私网与预算错误成功返回；实现后5/0/45expects，覆盖固定URL/分页/空结果/缺失字段/原始XML、地址、ID、重定向、限流、超时、取消与字节预算。
- 选择服务骨架Red0/4；实现后4/0/20。PDF声明初次因缺方法失败，不作为行为Red；完整接口骨架实际Red为明确unavailable，随后5/0/26。
- 真实认证RPC Red为search通道尚未注册；接线后与服务共6/0/33。用WebSocket登录、创建、搜索、选择、读取来源与摘要，并拒绝伪造policy；后补已有sourceIds创建会话持久化。
- 相同PDF重复登记Red为两个不同recordId；修复后复用。独立预审指出的候选引用污染、缺摘要新时间和创建会话丢选择已修复并有回归。
- 最终专项 **39 pass / 0 fail / 161 expects / 4 files / 982ms / exit0**；包含多来源冲突、跨空间缓存/私有来源隔离、到期与认证变化、PDF私有晋升拒绝、会话写失败时来源/快照/outbox整体回滚。
- 广相关 **246 pass / 0 fail / 12071 expects / 35 files / 111.68s / exit0**。这次运行早于最后PDF去重、来源头字节预算与新增三项验证；后续最终专项通过，未将数字混合计算。
- 首轮类型失败为测试未缩窄selected/conflict联合及可选摘要断言；修复后root八包、Web、纯research-core均exit0。最后配置接线/新增测试后server-core与server类型再次exit0。服务构建241modules/0.84MB/exit0；语法exit0。
- 实际源码startBioServer启动、登录RPC、选定图像PNG、HTTP原文件下载和停止均通过/exit0。362项通道：24 enabled、1 scoped-event、5后续未启用、332 legacy禁用。没有将此启动测试当作生产适配器公网通过。
- 最终宿主秘密匹配扫描：源码1822文件、构建1332文件，hitFiles均为空/exit0；只输出计数，不打印秘密值。git diff --check exit0。无依赖/lock变化。此次没有独立lint命令、双端UI验收或完整原Craft测试重跑；依既定T15–T17门槛收敛。

## 公网验证与发布前责任门槛

实际少量公开请求只用了论文PMID37794110：[官方core API](https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=EXT_ID%3A37794110%20AND%20SRC%3AMED&format=json&resultType=core&pageSize=1)、[开放XML](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC10551030/fullTextXML)。系统PowerShell验证取得MED:37794110、PMC10551030、DOI10.1038/s41597-023-02540-1、2023年、isOpenAccess=Y；开放XML94946字节包含article。未公开保存整篇文章，也未将这些bytes记成已解析全文。

**生产Bun适配器真实公网尚未通过。** 当前宿主OS DNS将www.ebi.ac.uk解析成198.18.0.69，地址检查正确拒绝。诊断只读DoH查询得到公开A193.62.193.80；只在忽略的诊断脚本中注入该地址，TLS仍报UNKNOWN_CERTIFICATE_VERIFICATION_ERROR/ECONNREFUSED。期间发现并修复原生lookup对`all:true`回调形式的兼容问题；之后仍是证书/网络限制。生产不注入地址、不关闭验证、不自动fallback。PowerShell成功仅证明官方服务可用，不能代替生产适配器成功。

独立评判批准：T10本地实现进入后续开发，**公网适配器验收保持未完成，归入T17发布阻断项**。负责人为当前项目开发/部署执行者；在正常公开DNS与受信CA的目标部署环境使用正式生产默认适配器实测题录、摘要和开放XML，保存无秘密证据，失败则不能通过T17或宣称平台可发布。该门槛不豁免运行能力，也不阻塞不依赖公网的T11解析开发。原Craft完整基线仍有既定未闭合问题，不宣称全绿。

独立评判者 /root/t08_independent_judge 最终审批PASS：独立复跑39/0/161expects/820ms，领域类型exit0。三项预审问题已修复，无新增代码阻断；生产Bun公网仍是T17发布阻断，不允许降低DNS/TLS检查。
