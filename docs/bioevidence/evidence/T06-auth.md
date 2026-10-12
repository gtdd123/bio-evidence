# T06 — 统一账户、可信登录主体及关闭的启动面

日期：2026-10-12（Asia/Shanghai）。起点 `2cc0047`。状态：**独立阶段审批 PASS，允许进入 T07**。

## 实现与明确边界

Bun-only BioAuthService 使用真实 Bun.password Argon2id 保存密码摘要，公开账户 DTO 仅 id/username/administrator。username 为 3–64 位小写 ASCII 账号名（字母、数字、点、下划线、横线），新密码 12–1024 字符；不提供公开注册。首次管理员仅在空数据库由本地 CLI 建立；以后创建/启停需要当前有效的管理员用户会话。客户端传来的管理员布尔值不能授权。停用使用 revision CAS，保留至少一个启用的管理员。

登录发 32 随机字节的 opaque `bio1.` 用户凭据，数据库只保存 SHA256；默认绝对期限 24 小时。登录 hash 验证后再次比较当前用户 active/revision，防验证等待期间的停用/变更。每次认证从 SQLite 查询用户及 auth_sessions 当前状态；退出只撤销当前登录，停用撤销该用户所有登录，重新启用不复活旧凭据。重启保留未到期登录及撤销状态。失败登录走 dummy Argon2id 验证（格式非法/超长输入直接拒）；未知账号、错误密码、停用账号返回相同安全错误。

必要账号变更、拒绝创建、重复 bootstrap、登录 CAS 失败、退出、启停均记录安全 audit；不存密码、token、token hash、正文。当前账户管理是本地 CLI，不增加客户端账号注册或客户端自报角色接口。CLI 的数据库 writer authority 遵守 T04 单服务锁，运行服务时需先正常停止再离线改账号。

Web 的 POST /api/auth/login 只返回账户/期限，使用 HttpOnly、SameSite=Strict、Path=/ Cookie；HTTPS 用 __Host-bio_session + Secure，明文仅 loopback 用 bio_session。桌面主进程通过 POST /api/auth/token 获取同一账户的用户凭据；此接口拒带 Origin 或 Sec-Fetch-Site 的请求，未声明拒绝所有 Sec-Fetch-* 字段。GET /api/auth/session 和 POST /api/auth/logout 复验同一可信主体；退出清 Cookie，到期/撤销在最后复验发生仍是 401，存储未知错误才 503。Cookie 与 Bearer 冲突、重复用户 Cookie、旧 craft_session/shared server token 不回退授权。

AuthBoundary 使用显式配置或真实监听地址生成的公共 origin 校验 Host、浏览器 Origin、实际 socket TLS 和 peer IP。非 loopback 认证要求 TLS；明文 loopback 请求的 peer 也必须 loopback。代理仅信任显式 IP，X-Forwarded-Proto/Host 必须与已配置公共 origin 一致，不反射请求头，不信任任意来源的 forwarded headers。HTTP 不返回 CORS 放行，不缓存身份响应。

生产 Node adapter 在构造 Request/执行密码验证前限制 4096 bytes、最多 16 个并发读体，独立总期限默认 10s（测试只能缩短），socket 空闲期限不能替代总期限。未知路由、错误 method、带 body 的 GET 读前拒；adapter 层拒绝使用 Connection:close，传入 handler 后的认证响应保持安全，不承诺每个 401/400 都断 TCP。密码验证另限最多 4 个同时执行，使用实际 peer 的每 IP 10/分钟、全局 100/分钟限制；不使用 XFF 作为身份或限流来源。

WsRpcServer 的 UserAuthProvider 模式与旧 validateToken/validateSessionCookie 完全互斥。upgrade 校验同一边界；Cookie WS 要求同源 Origin。一个 socket 在异步认证期间收到第二握手会关闭；发 ack 前重新查询会话且不把已关闭 socket 加入 client map。可信冻结 Actor 仅注入服务端 RequestContext，来自 RPC args/握手的 uid/role 无效。RPC 前、等待结果后、事件、每条重连回放以及服务端能力查询/调用再次检查当前登录；到期/撤销不发送正文并清旧事件缓存。重连同时绑定 userId + authSessionId，换账户/换登录不会借用旧 clientId 的缓存。

共同 WsRpcClient 构造入口（Web/preload/remote workspace/connectToRemote 全部使用）在任何 socket 创建前解析 URL，拒绝远程 ws、假 loopback 名称、非 loopback IPv6、userinfo、query/fragments及关闭证书验证；仅真正 loopback 可用 ws，其余 wss 且验书。Electron 三处原 tlsRejectUnauthorized:false 改 true。浏览器 client 使用 same-origin Cookie、无 localStorage；桌面 HTTP client 只接受 HTTPS/真正 loopback，无旧共享凭据。两者不跟随登录重定向，网络请求默认 10s 超时，严格校验公开 DTO。

createBioAuthorityServer/Bio Bun startup 默认只有新账号 HTTP surface，WS handler 清单为空、旧 /api/auth/OAuth/legacy RPC 不可用。`bio-index.ts` 用 namespace 下 service.json（可无文件，默认127.0.0.1:9100）和 research.sqlite；TLS文件同时检查 lexical/realpath 边界。原 standalone server/index 在 Bio mode 明确拒绝旧共享 token 入口。新增 root scripts `bio:server` 和 `bio:account` 共用 runtime namespace，不打印共享 token/登录 token/TLS key。此 Bun-only能力不从 Node/Electron server-core 公共 barrel 导出。

**后续门槛：** 本阶段是关闭的账户服务，科研 RPC/HTTP/事件资源授权与 legacy channel 分类由 T07 注册；没有把工作区字段当授权。完整科研 SessionManager/run/projector 接线仍在 T14；桌面/Web登录界面与用户可观察研究工作流在 T15，Windows 分发/TLS实际部署配置在 T16。当前 main/preload/Web 构建成功不代表旧 Electron GUI 已改成科研登录产品；不能据此宣称整个平台或公开 GitHub 交付完成。

## 实际验证与修复记录

| 实际范围 | 结果 |
| --- | --- |
| account service 骨架 | **0 pass / 5 fail / exit1** |
| 真实 Argon2id + SQLite 会话实现 | **5 pass / 0 fail / 18 expects / exit0** |
| real loopback HTTP handler 骨架 | **1 pass / 5 fail / exit1** |
| HTTP 边界实现 | **6 pass / 0 fail / 28 expects / exit0** |
| 首个 WS fixture 错用不存在的 server.address | **1/5、exit1**，fixture 失败，不算生产 Red |
| 修正实际 ws://127.0.0.1:port 后旧行为 | **0 pass / 6 fail / exit1**：无可信 Actor、旧 token 回退、Origin、到期、晚到结果及跨账号缓存 |
| WS 首修 | **5/1、exit1**，拒 upgrade 时 fixture 的 once error listener 无法承接重复 error；保留生产拒绝行为、改 on error |
| 三个认证文件集成 | **17 pass / 0 fail / 55 expects / exit0** |
| 评判发现重复握手、最终 HTTP 复验及 replay 到期 | 三项各真实 **0/1→1/0、exit1→0**；握手 guard 曾误放 timeout 分支，已放 message 入口 |
| 生产 Node adapter + 封闭 factory + CLI + shared helper | **7 pass / 0 fail / 22 expects / exit0** |
| audit + TLS 首轮 | **6/1、exit1**，OpenSSL默认配置查找失败；不是 TLS/权限成功 |
| 明确只用 owned synthetic OpenSSL 配置 | native Node TLS **1/0、3 expects、exit0**：默认拒自签，显式测试 CA 后 HTTPS401/WSS用户认证成功 |
| slow-body 最初三次 Bun http-client fixture | **0/2、exit1**；Bun的未end客户端缓冲未实际发完整流，不能记为期限生产Red/Green；改用 native Node 持续小chunk后 **2/0、7 expects、exit0** |
| shared WS URL/TLS constructor | **0/2→2/0、8 expects、exit1→0**；没有外部连接 |
| 中间相关回归 | **150 pass / 0 fail / 465 expects / exit0**，20 files，23.32s |
| 最终相关回归（含重启登录撤销、native慢体、共同WS边界、cold metadata） | **161 pass / 0 fail / 494 expects / exit0**，23 files，27.03s |

最终相关命令：

```text
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__/research.test.ts packages/server-core/src/sessions/cold-session-metadata.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/research-core/tsconfig.json
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T06-bio-server.js
node scripts/bio-launch.mjs build run electron:build:main
node scripts/bio-launch.mjs build run electron:build:preload
node scripts/bio-launch.mjs build run webui:build
node --check .runtime/checks/T06-bio-server.js
git diff --check
```

所有 Bun 使用 pinned 1.3.10 + neutral launcher。真实密码仅 synthetic fixtures；真实 Native Node/OpenSSL child 使用隔离 env/owned临时文件，通过 stdin 传合成用户 token、不打印值，结束/清理前检查拥有目录真实边界。证书/私钥只在运行时生成，未提交源码或构建产物。CLI逻辑通过注入合成 secret 验证，不据此声称人工交互TTY/桌面登录UI已验收。

类型首轮 **exit2**：两个测试headers数组的联合可选属性，以及 TextDecoder utf8 标识；改为明确 headers 类型和标准 utf-8。随后新adapter URL参数（Request类型要求string）导致 server-core/server **exit2**，改为规范URL.href。最终 root typecheck:all **exit0**，包含 core/shared/server-core/server/session-tools-core/pi-agent-server/Electron/UI；WebUI与research-core独立命令均 **exit0**。没有降低strict或排除测试。

实际构建：Bio服务 **228 modules/0.72MB/exit0**；main **43.6MB/exit0、syntax verified**；preload **830.5KB+2.2KB/exit0、verified**；WebUI **exit0、1m33s**，原大chunk警告仍在，不改高阈值隐藏。Bio bundle `node --check` **exit0**。这些是构建证据，未启动真实GUI/model/4090。已知宿主凭据扫描 **exit0、source1792/artifacts1332文件、0 hits**：source排除.git/node_modules/.runtime/.tools/dist/.cache，选代码/配置/文档文本；artifacts覆盖Electron/Web/WA/Pi四个实际dist根及新Bio Bun bundle，包含source maps。仅输出计数/命中文件名，不输出值。没有改依赖版本或lock，也没有把 T02 原完整基线的延期问题改写为全绿。

独立评判复验：初始 auth19/0、production8/0、body2/0、WS URL2/0、audit+replay2/0，均 exit0；research-core/shared/server-core/server/WebUI 五包 types0。对应轮次范围不同，不能拼接成无重复的一个测试总数。`/root/t04_independent_judge` 最终文档/阶段结论 **PASS**，核对 root 最终161/0/494expects和构建记录，允许进入T07；审批仅覆盖T06。
