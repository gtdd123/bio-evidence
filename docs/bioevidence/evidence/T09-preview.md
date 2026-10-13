# T09 — 图片、二维TIFF、连续帧与只读传输

日期：2026-10-13（Asia/Shanghai）。状态：独立文档与T09阶段审批 PASS。

## 完成范围

新增独立 Bun 图像子进程，复用已固定 sharp0.34.5。输入是二进制 stdin，输出是严格元数据与有界PNG；没有实验路径或正文进入 argv/诊断，没有SDK、模型、网络或文件路径解码。子进程环境只保留必要系统变量并套用BioEvidence命名空间，stderr不转发；sharp禁缓存、原生并发1。原根路径只保留在服务端受控资料边界。

输入默认256 MiB、单帧5000万像素、最多2个处理任务、子进程5秒，均可在服务自身 `service.json.imageBudgets` 配置并受上限验证。缩略图最长边256，查看预览最长边2048，不放大小图。输出PNG上限20 MiB。预算/格式/坏图/超时/繁忙/不可用分别有明确状态，不伪造已解码信息。Sharp在读取元数据后才用页级像素上限解码；相关接口依据[官方构造器文档](https://sharp.pixelplumbing.com/api-constructor/)及[元数据文档](https://sharp.pixelplumbing.com/api-input/)，同时核对本地0.34.5类型与实际库行为，未升级依赖。

普通PNG、JPEG、II/MM单页二维TIFF、16-bit灰度TIFF和普通多页TIFF均有真实合成验证。frameIndex为0开始的所选页，pages来自实际元数据；有序文件沿用T08自然名称与fileId分页，不推断时间或细胞身份。TIFF只遍历有界IFD元数据，不读取其他页像素；坏第二页像素不影响第0页预览。OME多维映射、BigTIFF和subIFD金字塔明确不支持；循环IFD、坏描述或目录与超预算有明确结果。预检预算10万IFD、100万tag entry、描述64 KiB。

## 资料与传输授权

`MaterialsService.openFile/fileEntry` 使用rootId、relativeDir、完成generation、opaque fileId解析真实索引和路径；受控句柄校验路径、打开对象与签名，不暴露路径字段。只读原文件传输每块最多64 KiB，在读前、读后及交付前复验当前授权、索引代次、路径和文件对象。循环结束、失败、取消均关闭句柄。没有整文件base64原文件下载；预览所选原文件在256 MiB以内读入受控进程，其他原图不打开。

`MaterialPreviewService` 在读取前限制全服务并发，源文件变更或账号失效后的晚到解码结果拒绝输出。子进程超时、客户端取消与服务关闭使用真实SIGKILL并等待exited，实测PID不存在；关闭后不再接受解码任务。服务停止先关闭网络与预览，再关闭SQLite。

共享 typed RPC `research:v1:getMaterialImage` 接受上述资源引用及kind/frameIndex。统一gate逐项绑定root/file/generation/kind/frame；返回前再次校验资料。HTTP同源认证入口 `/api/materials/:rootId` 提供 image元数据、preview PNG和download原文件；只接受严格资源参数，不接路径/URL。沿用T06当前会话、Host/Origin/TLS边界。PNG与原文件均按块复验授权和源绑定，尊重backpressure；错误若已发响应头，销毁连接，不向原文件尾部附加JSON。响应no-store/nosniff，下载为attachment。

真实服务目前360项通道：20 enabled、1 scoped-event、7后续功能未启用、332 legacy禁用；旧任意路径文件/分享/OS bridge保持禁用。资料与图像响应始终restricted，不提供视觉分类、GPU或私有LLM出口。

## 实际Red与修复

- PNG/JPEG与预算骨架：0 pass/2 fail/2expects，status始终unavailable。子进程实现后PNG/JPEG通过；测试把未知格式当损坏PNG的断言有误，改为未知格式unsupported和带PNG头的损坏样例invalid，之后3/0/35。
- TIFF作者子项只修改worker和新TIFF测试：最初5/1/75，真实OME被错当普通帧ok。加入有界目录预检后9/0/99；合并decoder12/0/134。16-bit灰度是已有能力验证，新增后单TIFF10/0/123，没有编造Red。
- 受控流Red两项均缺openFile；实现后首个通过，第二个错误使用seedUser更新账号，属夹具错误。改用真实账户停用事务后2/0/9，确认后续块拒绝并关闭句柄。
- 资源预览Red 0/1，未接入解码；接入选定文件与索引签名后1/0/8，并补选定源打开观测与原文件未修改核对。
- HTTP预览Red为400（路由未接入），接线后1/0/8。真实8 MiB原文件下载首批到达后撤销成员，后续body读取失败且未完整送达：1/0/4。共享RPC真实codec恢复Uint8Array并成功解析PNG：1/0/9。
- 服务关闭Red为缺close；测试补finally取消确保失败也回收自身进程，再次同一缺行为Red。实现后1/0/4，确认子进程退出及禁止新任务。

## 已执行验证

固定Bun1.3.10/neutral launcher，合成账号/目录/图像，无实际实验原图或模型请求。日志位于忽略的 `.runtime/checks/T09-*`。

```text
node scripts/bio-launch.mjs test test packages/server-core/src/research/image-decode.test.ts packages/server-core/src/research/image-tiff.test.ts packages/server-core/src/research/material-file.test.ts packages/server-core/src/research/material-preview.test.ts packages/server-core/src/research/materials-rpc.test.ts
node scripts/bio-launch.mjs test test packages/server-core/src/research packages/server-core/src/transport/__tests__ packages/server/src/bio-account.test.ts packages/shared/src/auth/__tests__/bio-client.test.ts packages/shared/src/sessions packages/research-core/src packages/shared/src/protocol/__tests__ packages/server-core/src/sessions/cold-session-metadata.test.ts
node scripts/bio-launch.mjs bootstrap run typecheck:all
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p apps/webui/tsconfig.json
node scripts/bio-launch.mjs test run bio:typecheck
node scripts/bio-launch.mjs build build packages/server/src/bio-index.ts --target=bun --outfile=.runtime/checks/T09-bio-service.js
node scripts/bio-launch.mjs test run .runtime/checks/T09-startup.ts
node --check .runtime/checks/T09-bio-service.js
node .runtime/checks/T09-scan.mjs
```

- 最终专项 **27 pass/0 fail/232expects/5files/20.26s/exit0**，包含取消/关闭真实进程、二维/逐页/16-bitTIFF、源变更和账号停用后的晚到结果、每块权限以及RPC/HTTP。
- 广相关 **228 pass/0 fail/11941expects/32files/104.36s/exit0**。随后补16-bit、关闭及codec内容断言/最新生产close改动，最终专项重新通过；不悄悄改写前一回归数字。
- 首轮server-core类型失败为两处测试Buffer泛型比较，改为逐字节equals结果断言后exit0；root八包、Web、纯research-core类型通过。最终root八包再次验证exit0。
- 服务构建 **238 modules/0.81MB/exit0**，node syntax exit0。实际源码 `startBioServer` 从部署预授权启动，经登录RPC生成选定帧缩略PNG并读原文件流，内容一致，停止资源正常；仅输出统计与上述360通道分类，exit0。
- 首次秘密扫描源码1814文件、构建1332文件，hitFiles均空/exit0。增加本证据文档后最终源码1815文件、构建1332文件，hitFiles均空/exit0；只比较已知宿主秘密并输出计数，不打印值。无依赖/lock变化。

## 审批范围与未完成项

T09修改领域/typed协议、Bun受控文件与图片服务/worker、共享RPC/HTTP及服务入口、合成测试和本证据。独立评判者此前只读复跑decoder/TIFF12/0/134，以及文件/预览/RPC12/0/64，未发现阻断，但不代替正式候选审批。

没有新的完整原Craft基线验证、真实4090原图、模型调用或双端UI操作。Windows路径/文件操作保留T08说明的限制；操作间可以复验时间/身份，不能强制中断停滞的内核文件读取。图像解码的独立进程5秒限制有真实终止证据。源码入口worker定位已验证；直接bundle不会自动复制worker，T16必须验证交付包的worker/native资源定位，不能将本次build当作该项交付PASS。

独立评判者 `/root/t08_independent_judge` 正式文档、实现及任务状态审批 **PASS，无阻断项，允许进入T10**。独立最终复跑27/0/232expects/18.33s，领域协议类型exit0；验证真实进程关闭、逐页/16-bit解码、晚到与撤权拒绝、RPC PNG内容及HTTP中断。评判未修改文件，仅要求记录审批状态，明确无需再审批。
