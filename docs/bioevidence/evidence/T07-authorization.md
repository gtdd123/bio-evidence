# T07 — 个人/项目范围、全部通道分类及实时授权

日期：2026-10-12（Asia/Shanghai）。起点 `11dd8e4`。状态：**独立阶段审批 PASS，允许进入 T08**。

## 实现与边界

纯协议增加空间列表、创建项目、成员列表/邀请/修改，以及 scoped audit；仍复用 Craft typed RPC/transport。实际 Bun startup 安装 research profile 后才 listen。生产开启9个账户范围业务请求（空间、项目、成员、会话创建/读取/分页、审计）；7个声明好的文献/证据/报告/运行请求等待后续任务，当前不注册。真实通道清单共349条：9 enabled、1 scoped-event、7 disabled-unimplemented、332 disabled-legacy，见 T07-channel-coverage.md。未知通道也默认拒绝；误注册 legacy handler 被拒，安装profile前已有非批准 handler 被移除。所有原 client/OS bridge capabilities 当前禁用，客户端广告不授予权限，后续若需启用必须明确 actor/window/resource 绑定。

空间列表仅本人个人空间与当前 active 项目关系，管理员不因此读取别人个人数据或未加入项目。创建项目绑定当前用户为负责人；成员变更只允许当前项目 owner，保护不可移除的创始 owner，邀请按明确账号名解析当前启用用户，不列全系统账号。创建科研会话绑定当前用户，viewer不可创建/执行，editor/owner可创建本人会话；源记录必须同 scope，policy从服务端来源合并，没有来源的空会话本身不含材料。**空会话 public 不意味着可空上下文调用云模型**，T13仍要求非空、真实解析的public引用。初始sourceIds当前只用于权限/taint合并，完整选文献状态/运行关联在T10/T14接入，不声称已完成双端完整会话。

repository提供 metadata-first scope/resource授权：先可信binding和当前账号/成员权限，再读必要owner/sessionId authority字段，执行/cancel要求本人会话，execute additionally write；cancel保留当前viewer本人的read+owner能力。列表先按scope筛选，稳定ID游标且每页最多200。evidence/report逻辑ID可从head解析实际记录；未知legacy资源没有binding则拒。

统一 gate 必须建立在用户认证上。每个已开启请求严格校验单一typed参数，在handler前按真实scope/action解析；等待返回后再次校验当前角色和结果归属。Session/snapshot/run getter核对请求ID/真实binding/scope；新会话核对owner、binding、请求scope/name/revision；项目创建核对当前权威space；成员列表核对指定项目当前roster；会话列表还核对请求scope，不能混入另一个已授权项目。未来SEARCH/SAVE结果也预设相同scope与实体绑定规则，业务注册仍在后续任务。auth过期/退出由T06拒绝，项目权限变化则安全BIO_ACCESS_DENIED，不发送晚到正文。

已绑定资源的授权成功/失败审计归实际scope，未知binding的global记录不带猜测private resourceId。新增readAudit仅个人owner或项目owner可读，每页最多200，含sequence/actorId/time/action/outcome/resourceId，不含正文/密码摘要/token。返回audit按scope+具体sequence再次查询权威白名单，防合法但不同scope的日志误配；global账户/service audit未开放新的客户端读接口。

事件只允许严格ResearchEvent安全元数据（禁止body/apiKey等额外字段），同时解析真实资源和真实会话binding并核对scope/关联。初次发送前、缓存保留/权限变更、重连前及每一条回放都复验。缓存授权参数从已序列化JSON取新副本，publisher对象突变不能使旧data冒用新的scope。成员变更主动清live/disconnected不再允许的事件；混合scope留下稀疏seq时记录authorizationInvalidated，重连stale并不回放缓存，要求持久状态刷新。此标志保守保留至新的client identity，避免遗忘已剔除的序号；不宣称优化了所有重复刷新。原client仅warn seq gap的逻辑不能代替明确stale。

**仍未验收：** ResearchEvent当前仅状态元数据，真实运行/消息投影/outbox编排在T14；T08/09资料HTTP范围、T10/11文献/快照、T12修订、T13所有模型/工具/helper出口、T15页面和账号切换清本地状态仍是后续门槛。当前科研Bun服务封闭profile不能代替未来真实GUI/模型验收；旧Electron界面转换为thin client仍在T15。本阶段没有GPU、细胞分类或GitHub交付声明。

## 实际验证与审阅修复

| 范围 | 实际结果 |
| --- | --- |
| profile空骨架，三账号/两项目/旧通道 | **1 pass / 3 fail / exit1**：正向API未注册，所有legacy已关闭 |
| 可信repository和8项请求首修 | **4 pass / 0 fail / 676 expects / exit0** |
| 共同gate、role-loss await、cache/object mutation/clientcap | **10 pass / 0 fail / 691 expects / exit0** |
| 独立评判发现错scope列表响应及global授权audit | **0/2、3expects、exit1** |
| 独立评判发现混合scope缓存预清后seq缺口未stale | **0/1、1expect、exit1** |
| 修复三项后的定向结果 | **3/0、7expects、exit0**；一次patch将创建结果检查误置request分支，宽泛toThrow产生假通过，立即读代码纠正，并将负向要求精确Research access denied，完整正向回归确认 |
| scoped audit及原事务回归 | **32/0、758expects、exit0** |
| 项目创建/邀请/roster/audit页、共享协议与原事务 | **38/0、829expects、exit0** |
| profile完整15项（含上述误置纠正及精确拒绝） | **15/0、711expects、exit0** |
| 广相关首次（含全部protocol/routing、auth/transport/storage/session） | **184/0、1584expects、25files、62.77s、exit0** |
| 最终相关（含foreign audit响应负向与exact audit白名单） | **184/0、1585expects、25files、40.32s、exit0** |

最终相关命令：

```text
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__ packages/server-core/src/sessions/cold-session-metadata.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/research-core/tsconfig.json
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T07-bio-server.js
node --check .runtime/checks/T07-bio-server.js
git diff --check
```

固定Bun1.3.10、neutral launcher、自有synthetic账号/资源/目录；没有真实学生数据或外部模型调用。原事务失败回滚、Windows真实single writer/crash接管、TLS验证等纳入相关回归。root typecheck:all及WebUI首轮均exit0；最终root typecheck:all、WebUI和纯research-core三项也均exit0。新实际Bun service构建 **230 modules/0.74MB/exit0**，node syntax exit0。当前没改UI产品代码，不重复声称新UI操作验证；没有全量原基线全绿或T02延期门槛已关闭的声明。

声明/仓储/transport/新profile与其合成tests以及两个本阶段证据文档为修改范围，无新依赖或lock改动。`/root/t07_independent_judge` 最终两文档和阶段结论 **PASS**：独立19/0/770expects/2files/12.31s/exit0，核对最终184/0/1585expects、通道349分类、类型/构建/扫描记录及diffcheck。允许进入T08；评判未修改文件，审批仅覆盖T07。此前评判agent出现用量异常后，账号查询ordinaryUsageAllowed=true，改由此新独立评判完成，没有把未完成的审批当通过。

最终已知宿主凭据值扫描 **source1797/artifacts1332文件、0 hits、exit0**；与T06相同文本扩展和四dist根范围，当前Bun bundle换为真实T07产物。只输出计数/命中文件名，不输出凭据值。
