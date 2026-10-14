# T11 — 页级PDF、JATS正文与不可变读取快照

日期：2026-10-14（Asia/Shanghai）。状态：独立Spec compliance、quality及文档一致性审批PASS，可进入T12。

## 实现及覆盖含义

复用锁定PDF.js5.4.296与fast-xml-parser5.11.2，无依赖/lock变更。纯research-core增加文档预算、结果与上传元数据契约；Locator的JATS段落保留安全合成paragraphId，以及可选原始elementId/sectionId（最多4096 UTF-16字符）和章节标题。原始XML编号只是展示和回查信息，不是授权/URL/文件路径。

PDF只接受字节副本，输入不被转移或修改；禁止eval、PDF动作执行、XFA、外部字体/CMap/WASM、自动范围/流加载，无云OCR。逐页以streamTextContent限制文字，保存页码及最多200000字符的块，避免拆断UTF-16代理对。每页都有read/no-text/failed/unsupported；图像或空页不跳过，坏页保留其他页结果。文字上限达到后，之前完整页保留，其余明确failed/budget，coverage为partial；超过字节/页上限可直接budget。加密、损坏与取消有明确失败。包含摘要文字的PDF仍按真实页码记录，不自动当摘要或整篇已读。

JATS在建立保序树前扫描字节、字符、深度和节点，限制属性/文本/标记节点；标准五种XML转义及合法数值字符只解码一次，CDATA保持字面内容。DTD、自定义实体、非法字符、重复属性、坏XML及外部样式表指令拒绝。仅忽略已核对的EuropePMC媒体元数据指令：cloudpmc-path/cloudpmc-bucket/size/disp-level/image-server-status及original/scaled的height/width；这些值从不解释、获取或加入证据。未知指令仍拒绝。此兼容处理来自实际公开API样例的结构核对，不开放任意资源加载。

JATS单位来自唯一article/body中的段落与章节标题，保持阅读顺序、原始编号与章节归属。**full只指body中支持的文本结构已全部覆盖**，不包括front摘要/back或论文所有语义；图片、表格、公式及未知内容都有unsupported gap，因此此类正文为partial。无body返回unsupported，已有摘要不被伪造全文替换。正文最多10000覆盖单位/块，单段最多200000字符，章节标题最多1000字符；超预算拒绝，不截断后宣称full。引用定位使用实际保存文本的UTF-16区间，不冒充原始XML字节偏移。

## 进程、上传与授权边界

DocumentParseService运行一个独立Bun子进程，输入为JSON元数据+二进制stdin，结果为严格JSON（最多64 MiB）。没有实验路径/正文进argv或诊断；子进程环境过滤并使用BioEvidence隔离命名空间，禁库诊断、stderr不转发，不导入Agent/模型/网络能力。父进程校验格式、文字预算和Snapshot覆盖一致性，不接受伪造的完整覆盖或错误页码。超时、取消及close实际SIGKILL并等待退出；进程忙时不排无限队列。

默认预算：PDF25 MiB/100页、总5000000字符；XML10 MiB/深度64/节点100000；解析子进程30秒。`service.json.documentBudgets`可在契约上限内调低。上传读取另有同配置的绝对时间和字节预算；超出头部长度提前413，分块读取也执行预算。同步提取器自己的时间检查不代替父进程终止。受控资料读取仍受T08 Windows内核操作不能强制中断的限制；每块和解析后复验源对象，不能把逻辑检查说成操作系统路径锁。

SourceSnapshotService限制一条解析/获取流水线，使用当前账号、成员与会话所有者执行权限。外部获取、受控文件读取、解析完成及结果交付后重查授权；PDF导入的会话版本变化、原文件变化、账户失效时晚到结果拒绝；OA获取/解析后复查当前公开会话和所选source，普通会话改名不会单独使OA结果失效。来源/快照/会话选择在SQLite事务内共同提交；快照插入失败整体回滚。输入字节捕获为自有副本；哈希绑定实际输入，策略继承来源。

PDF上传入口是认证POST `/api/research/sessions/:sessionId/pdf?expectedRevision=...&declaredPublic=true|false`，body为application/pdf。严格参数不接受policy/path/URL。浏览器cookie要求同源Origin，桌面Bearer沿用TLS/Host/Origin边界；每块重查身份。默认私有，明确公开声明才记录actor/time；已知私有字节不能被标签晋升。原PDF只在受控内存中读取，不写回原文件、不保存上传原件；持久化内容是受控SQLite里的来源哈希与文本快照。双端操作界面在T15实现。

新增typed RPC `readSourceText`读取已选的public EuropePMC OA来源，原始XML解析成功才写新JATS快照；获取/解析失败保留旧摘要。每次读取有新snapshotId，旧快照不改。`importMaterialPdf`只接grant派生rootId/fileId/generation/relativeDir与会话版本，登记及解析后的来源/快照均restricted，不提供公开声明参数。普通文件仅所选PDF读取；实际原文件和目录签名在读后、解析后及RPC交付前复查。正式入口接入HTTP+RPC；停止先关闭网络/上传，再终止和等待解析流水线、预览，最后关闭SQLite。

## TDD与实际证据

全部自动样例为自有合成PDF/XML/目录/账号，不读取简历、4090或真实实验资料。两个实现agent只写各自PDF/JATS两文件，独立评判未参与实现。日志位于忽略的`.runtime/checks/T11-*`。

```text
node scripts/bio-launch.mjs test test packages/server-core/src/research/pdf-extractor.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/jats-extractor.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/document-parse.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/source-snapshots.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/documents-http.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/pdf-extractor.test.ts packages/server-core/src/research/jats-extractor.test.ts packages/server-core/src/research/document-parse.test.ts packages/server-core/src/research/source-snapshots.test.ts packages/server-core/src/research/documents-http.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__ packages/server-core/src/sessions/cold-session-metadata.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs test run bio:typecheck
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T11-bio-service.js
node scripts/bio-launch.mjs test run .runtime/checks/T11-startup.ts
node --check .runtime/checks/T11-bio-service.js
node .runtime/checks/T11-scan.mjs
```

- PDF初始行为Red为unsupported而非ok；首次Green1/0/6。文字预算/200k块边界Red修复后最终PDF12/0/45；Unicode字体和坏页的两处夹具差异已修正，未将夹具错误作为实现Red。stream取消须传Error，PDF.js内部assert问题已收敛。
- JATS初始Red0/3；CDATA Red7/1及原始`]]>`语法Red11/1后均修复，作者最终12/0/54。独立预审发现原ID丢失，root Red0/1后修复为13/0/56；真实公开XML的惰性PI兼容Red0/1后JATS14/0/60。
- 进程骨架Red0/2/unavailable；实现后第一轮1/1因父端Snapshot投影含未知status字段，修正后2/0/7。后加活跃close、实际PID退出、并发/输入预算和错误覆盖拒绝。
- 快照接缝Red1/1，缺解析保存；修复后两项通过。随后增加解析后CAS、文件改变/账号停用拒绝、真实快照插入失败全事务回滚。原撤权骨架测试会因未实现错误也通过，单独不作为行为Red证据；实际延迟解析与后续状态测试证明已运行该路径。
- 上传/RPC初始Red0/3：HTTP503与能力禁用；接线后3/0/18。预算头测试首次使用Bun http客户端被改成Content-Length0而422；改为raw TCP发送真实大长度后413。独立评判另用真实chunked超预算收到413并关闭连接。
- 最终专项 **39 pass/0 fail/157expects/5files/4.25s/exit0**，含真实默认worker解析PDF/JATS、UTF16、覆盖、原标识、进程退出、上传认证/预算、晚到拒绝、事务与不可变历史。
- 广相关 **288 pass/0 fail/12241expects/40files/102.17s/exit0**；早于最后PI兼容和父端超输出分类，之后最终专项重新通过，不混合数字。
- root八包类型exit0；Web、pure-domain类型exit0。最初类型失败为测试Actor自引用与fetch替身缺preconnect类型，已修复；最后PI兼容及输出预算分类后server-core与server类型复验均exit0。没有新lint独立命令或完整原Craft基线重跑。
- 服务构建245modules/0.87MB/exit0。源码正式入口真实启动、认证资料预览/下载、私有PDF上传→真实子进程→快照保存→getSnapshot RPC、停止均通过/exit0；364项通道：26enabled/1event/5后续/332legacy禁用。最终构建语法exit0；秘密匹配扫描源码1835文件/构建1332文件，hitFiles均空，exit0；git diff --check exit0。

## 真实公开格式与未完成验收

系统PowerShell从[EuropePMC官方开放XML](https://www.ebi.ac.uk/europepmc/webservices/rest/PMC10551030/fullTextXML)取一篇公开样例，经标准输入传给默认受控解析子进程，仅输出覆盖统计，未公开保存整篇XML/文本。输入94948字节（PowerShell管道增加末尾换行），实际 **ok/partial，85 units、69 read、16 gaps、69 blocks**。媒体元数据指令值没有读取或输出。该实验只证明此公开格式解析兼容；T10生产Bun默认提供器公网DNS/TLS仍未通过，T17发布阻断保持不变。

没有OCR/图表语义解析、全文科学核对、细胞分类、模型调用或真实实验接入。字节/文字/结构预算和当前权限检查有实际证据，不声称OS级文件锁或全部文献格式兼容。JATS白名单以外的PI/DTD仍可能拒绝，已有摘要可继续回查。Windows源码入口已验证；T16必须组装并实测document-worker、PDF/JATS提取模块与PDF.js内部worker/native/字体依赖定位，直接入口bundle不自动复制这些资源，不能拿当前build冒充交付包装通过。双端UI、证据/报告编辑和运行循环仍按后续任务开发。

独立评判 /root/t11_independent_judge 最终PASS：39/0/157expects/4.89s；领域/server-core/server类型exit0；实际正式入口上传、受控解析、快照RPC和停止exit0；语法、diff及任务镜像一致性通过。T10公网、T16包装及后续界面/完整原基线门槛保持未完成。
