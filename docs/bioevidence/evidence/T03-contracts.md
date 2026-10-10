# T03 — 科研领域与运行时协议契约

日期：2026-10-10（Asia/Shanghai）。起点：T02 和文档格式修正提交 `7b70e80`。状态：**独立审批 PASS，允许进入 T04**。

## 实现范围

新增纯 TypeScript `@bio-evidence/research-core`，复用已锁定的 Zod 4.3.5；没有 SQLite、文件、进程或模型适配实现。科研主体、个人/项目范围、成员职责、资料策略、来源、读取快照、定位、证据/报告修订、运行及事件有共同契约。客户端请求仅接受严格白名单字段和资源标识，actor、policy、管理员标记及任意 URL 不能作为客户端自授权限输入。

核心规则包括：管理员不自动读其他个人空间；失效/错误项目成员和只读写入被拒绝；restricted/unknown 随组合保留，会话清空选择不降低限制；云端上下文需要服务端解析的公开资源清单。来源/快照同 ID、范围与策略必须一致，未读页、缺失页、重复定位不成为全文；精确片段校验只返回结构状态，不授予科学审阅。修改证据创建新修订并重置结构与人工状态，旧对象不变；过期 revision、矛盾时间和终止运行复活被拒绝，取消/中断使 generation 失效。

`CONTEXT.md` 为术语表，只记录科研概念，不承载技术实现或额外产品范围。

## 真实 Red → Green

| 命令/范围 | 结果与原因 |
| --- | --- |
| `node scripts/bio-launch.mjs test test packages/research-core/src/contracts.test.ts` 初始可执行函数骨架 | **4 pass / 13 fail / exit 1**；能实际调用，失败是未拦伪造字段/越权/混合策略/坏覆盖/错引用/非法迁移，非缺模块或环境错误 |
| 严格契约实现后，同命令 | **17 pass / 0 fail / exit 0** |
| 新修订时间/状态矛盾用例 | **18 pass / 1 fail / exit 1**；旧代码接受 createdAt 早于上一修订。补时间一致性及 active/queued 元数据规则后通过 |
| `node scripts/bio-launch.mjs test run test:bio`（首个集成 Green） | **24 pass / 0 fail / exit 0**，20 领域 + 4 既有协议集成 |
| `node scripts/bio-launch.mjs test run bio:typecheck` 首次 | **exit 1**；合成 snapshot fixture 的 enum 被 TypeScript 推宽为 string。仅给 fixture 明确 ReadingSnapshot 类型，未降低检查 |
| 同类型命令，修 fixture 后 | **exit 0** |
| 原 routing + channel-map-parity 两文件 | **10 pass / 0 fail / exit 0**，新增通道共同分类，原客户端映射不受影响 |

## 与既有协议集成

`RPC_CHANNELS.research` 共用唯一的 v1 声明；科研通道属于受控服务，归为 remote eligible，仍走现有 transport。shared protocol 导出同一 DTO/请求 validator，已有 BroadcastEventMap 和 ErrorCode 增加对应类型。每个新可调用通道都有 runtime 校验，事件是范围/资源/修订的通知，不夹带正文或模型密钥，错误保持固定安全信息。

这里增加的是契约与通道声明。服务器 handler、真实认证、资源查询和事件授权将在 T04–T07 集成；客户端科研方法和界面在 T15 扩展既有 API facade。没有以此声称当前用户可登录或两端科研流程已实现。

## 依赖与验证边界

`node scripts/bio-launch.mjs install install --lockfile-only` **exit 0**；后续 frozen install **exit 0，2 packages installed，11.17s**，HUSKY=0。锁仅新增 workspace、shared 的 workspace 依赖和 workspace 包记录；没有新增或改动外部版本/integrity。

暂定技术上限：标识 1–64 个 ASCII 字母数字/下划线/短横线，内部页/段落序号；PDF 页数沿用 100 页规格，正文 block 200,000 字符、单位/块最多 10,000，来源/运行选择最多 1,000。超限必须明确失败或在解析阶段记录部分覆盖，不得截断后宣称全文。题录缺字段保持缺失；定位 offset 使用保存文本的 JavaScript UTF-16 索引。两端科研 handler 未开放前没有协议升级兼容负担；后续新增接口遵守 version 与闭合校验。

## 独立评判 REVISE 与补强

独立评判用 Node 纯契约探针发现同一 JATS paragraph 被计入两个已读单位、pending evidence 被 confirmed、无引用 report 被双重通过。补原可执行用例并加入运行租约与会话 owner 缺失的验证，实际 **21 pass / 5 fail / exit 1**（26 领域测试）。没有将 schema 缺口当作环境失败。

补强：JATS paragraphId 不重复；ArticleLicense 显式保留 unknown，公开策略与再分发许可独立；HumanReview 含 reviewerId/time/revisionId/revisionNumber，confirmed 要求结构有效且绑定当前修订，pending 草稿仍可保存；report 每项 claim 对应确定 evidenceRevisionIds，结构通过的 Markdown 来自同一主张映射，未经映射的自由编辑仍是 pending；会话 owner 与项目可见性分开；运行携带非秘密租约主体/runId/generation/expiry，过期完成被拒绝，终止移除租约。执行还需写入权限，所有者有读取权时可停止自身运行。

修后首次科研/协议 **31 pass / 0 fail / exit 0**；增加草稿、错误修订绑定、未知许可/不安全许可链接和租约元数据反例后 **34 pass / 0 fail / exit 0**（30 领域 + 4 协议）。类型检查指出租约已必选却对 intersection 作 delete 的 fixture 错误，改为解构排除；最终 `bio:typecheck` **exit 0**。此 fixture 类型错误不算行为 Red。

此前根 `typecheck:all` 已 **exit 0**，Web 真实构建 **exit 0**，1m4s，有原 bundle 大小提示；评判补强后的最终相关复验在下方追加。真实身份、持久化、云端请求、4090、科研 UI 和 GitHub 尚未验收。T02 已归因基线债务继续依 Plan18 门槛收敛，不计为本任务 Red 或隐含豁免。

## 最终复审收敛与检查

评判再次发现多行标题能把未映射结论藏进 Markdown 标题。实际 **34 pass / 2 fail / exit 1**（标题与纯空白正文），复用单行、非空白 ReportTitleSchema 于记录与 SAVE_REPORT，正文/摘录仅拒纯空白并保留原文本后，最新 `test:bio` **36 pass / 0 fail / exit 0**（32 领域 + 4 协议，137 expects）。自由 pending Markdown 仍可保存。

补强后的根 `typecheck:all` **exit 0**；最终 `bio:typecheck` **exit 0**；原 routing/map parity 再验 **10 pass / 0 fail / exit 0**。完整 Web 在补元数据后再次 **exit 0，46.41s**；随后标题补强未改变客户端字段类型，最终核心 browser bundle 实际 **exit 0，80 modules / 0.49MB**。latest full Web 构建与 latest core bundle 分别记录，不将前一次 Web 产物假称含后一次标题修正。

最新已知宿主凭据扫描：候选源码 **1912 文件**、六根实际应用产物 **1562 文件**，均 **0 hits**，不显示值。独立核心 browser bundle 在忽略的 `.runtime/checks`，不属于该六根扫描计数。锁仅增加 workspace 关系，保留外部版本与 integrity。最终阶段独立结论尚待给出；未进入 T04。

最终补充：标题补强后 `typecheck:shared` **exit 0**，`bio:typecheck` **exit 0**，`git diff --check` **exit 0**。2026-10-10 `/root/t02_independent_judge` 给出 **T03 阶段 PASS，允许进入 T04**，同时批准 CONTEXT 与此证据；独立纯契约复探确认旧阻断拒绝、合法报告和草稿仍可保存。上段“待给出”为交审时状态，此段为最终结论。T04/T14 仍须对 workerId、generation 和当前权限做实际事务检查。
