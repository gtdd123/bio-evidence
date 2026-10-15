# T12 — 证据、报告、不可变修订与安全导出

日期：2026-10-15。状态：独立阶段审批PASS。范围仅为已批准T12，不含模型循环、双端编辑界面或对外发布。

## 行为与边界

- 证据保存主张、事实摘要、局限、缺失信息，以及授权快照的block/UTF-16区间/原文。片段不符、块缺失或未核对题录冲突保存为pending；不存在或无权读取的快照拒绝保存。结构正确但不支持科学主张的反例仍为unreviewed，系统不自动判定科学结论。
- 报告保存研究问题、材料范围、局限、缺失信息和claim→具体evidence revision映射。推断有明确标记。自由编辑正文而不匹配映射时为pending；未填字段保留为空，导出提示待补充。未绑定资源的本地草稿属T15界面，不伪造服务端引用。
- 每次保存生成新record ID，业务ID不变，expectedRevision做CAS。旧正文/引用和既有审阅保留，新版重新结构核对、审阅归零。每个内容修订只允许一次人工结论；需改变结论时建立新内容修订再审阅。题录核对是独立的source revision确认，仅承认该题录冲突已由人核对，不覆盖题录/快照，也不替代科学审阅。仓储拒绝来源payload直接携带metadataReview，防止自授核对状态。
- 来源刷新不改旧snapshot；读取返回当前来源变化、证据新修订及未核对题录提示。有效策略合并产物、快照和当前来源策略，后来限制来源后，旧公开产物也按restricted处理。人工内容默认restricted，明确public声明记录操作者/时间且要求全部依据当前有效public；私有/未知历史不能借编辑降级。保存产物同时原子提高session策略，不改变session所有者或执行权。
- 项目editor可编辑/核对同项目产物；viewer只读/导出。个人空间、项目当前成员、账号状态在请求和返回处核验。保存返回必须与权威存储完全一致且revision=expectedRevision+1；人工审阅后的旧缓存和同空间伪造内容拒绝。事务连同审计/outbox提交，沿用T05/T07的失败回滚。
- 产物操作审计使用固定操作名；空间来自真实binding/head，不信任客户端scope。创建、保存、题录确认、审阅和导出的同步操作整体放在事务边界，失败回滚后留下failed/denied审计；RPC请求前置拒绝也记录明确操作。未知资源不向全局审计写入猜测ID。审计只有操作者/资源/动作/结果/时间，不含正文、引用或导出内容。
- CSV中和公式前缀，逐格引用/转义；Markdown中和原HTML及不可信链接语法。导出含原文、定位、题录标识、快照格式/取得方式、覆盖与缺页说明、hash/时间/许可、结构与人工状态。文件名仅系统ID，无用户路径。返回仅供已授权客户端保存，不产生共享链接或外部访问。
- 产物输入/单项读取、报告依赖累计与导出采用8MiB字节预算；报告最多10000条引用。导出逐段预算，依赖逐项处理，不先合并巨量正文。证据逐条处理快照，不保留100份全文副本。列表每页1–200条，只返回SQL提取的300字符内摘要，不加载引用和正文；业务ID游标限定session，权限仍实时核验。

领域DTO新增保持纯TypeScript/Zod，未引入数据库/文件/网络依赖。存储使用原v1实体与reviews表，无破坏迁移。新增9个RPC并启用原有2个save：正式入口373项通道中37enabled、1 scoped-event、3后续能力未启用、332 legacy禁用。所有模型/工具能力仍未接线。

## TDD及可复验命令

样例均为自有合成PDF、引用、账号和项目，不读取简历、实验数据或4090。日志为忽略的`.runtime/checks/T12-*`。

```text
node scripts/bio-launch.mjs test test packages/server-core/src/research/artifacts-service.test.ts packages/server-core/src/research/artifacts-rpc.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research/artifacts-service.test.ts packages/server-core/src/research/artifacts-rpc.test.ts packages/server-core/src/research/sqlite-repository.test.ts packages/server-core/src/research/literature-service.test.ts packages/server-core/src/research/rpc-profile.test.ts packages/research-core/src packages/shared/src/protocol/__tests__/research.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__ packages/server-core/src/sessions/cold-session-metadata.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/research-core/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server-core/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/server/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs test run .runtime/checks/T12-startup.ts
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T12-bio-service.js
node --check .runtime/checks/T12-bio-service.js
node .runtime/checks/T12-scan.mjs
git diff --check
```

- 初始Evidence行为骨架Red0/2，修复后2/0/9；报告/导出行为Red2/3后5/0/22。pending题录与不可变审阅经历Red5/2、部分修复6/1，最终收敛。来源题录核对骨架Red0/1；首次实现缺RevisionSchema import是实现错误，修复后相关41/0/151。
- RPC初始Red0/1、能力CHANNEL_NOT_FOUND，接线后相关9/0/59。依次补充导出来源、研究范围/推断/缺失信息、受限策略、巨量依赖预算和列表摘要。
- 独立评审指出save回放权威校验不足，新增测试Red9/1/57，伪造正文实际未抛错；补权威完整比较及新修订号后，两文件11/0/78/1342ms。后续评审实测来源可自授metadataReview，作者回归Red10/1/63；修复为只有独立reviews行能产生核对状态。
- 独立评审发现服务提前拒绝和导出缺明确操作审计，新增真实行为Red10/2/62后，补事务操作边界Green13/0/88/1041ms。真实RPC审计断言最初失败是只读默认首100条的夹具问题，改为取降权前序列后的分页；不算产品Red。
- 最终相关 **97 pass/0 fail/1136expects/7files/13.79s/exit0**。含13项产物/RPC行为、原仓储/文献服务/权限profile、纯领域及协议契约。
- 广相关 **299 pass/0 fail/12347expects/42files/79.53s/exit0** 与root八包类型exit0，均早于最终摘要/防伪/预算修正；不合并为最后一次回归。最后修正以最终相关、类型及独立复验为准。
- 正式源码入口真实启动：认证、私有目录预览/原图下载、私有PDF上传→默认解析子进程→保存快照→证据→报告→人工needs-changes→CSV/Markdown→列表/get→停止，exit0；实际通道数373/37/1/3/332。无模型请求。
- 最终领域、server-core、server和Web四项类型均exit0。最终服务构建247modules/0.91MB/exit0、语法exit0；秘密匹配源码1840文件/构建1332文件，hitFiles均空/exit0；git diff --check exit0。未暂存范围为7个既有源码文件、4个新增产物源码/测试文件与本阶段文档，均属T12。

## 保留门槛

没有运行全量原Craft基线，不宣称该基线已全绿；无新增lint独立检查。T10正式EuropePMC公网DNS/TLS尚未通过，仍为T17发布阻断。T16受控解析worker/依赖定位与正式Windows包装仍待完成；源码启动和单入口bundle不是包装通过。T13模型调用、T14运行/投影、T15双端界面、T17验收和T18公开GitHub均未完成。

独立评判另留非阻断性能观察：多条引用重复指向同一大快照时会重复解析该快照。当前引用数/字节预算与顺序处理已验证；T17代表性多引用验收需观察时间和内存，必要时增加单操作内有预算的缓存，不把当前单元测试宣称为大规模性能验收。

独立评判`/root/t11_independent_judge`正式PASS：Spec compliance、质量、文档一致性均通过；独立最终97/0/1136expects/11.38s/exit0，领域/server-core/server类型exit0，实际正式源码入口完整链路与停止exit0、语法和diff通过。评判只读未参与编写；保留上述后续门槛。
