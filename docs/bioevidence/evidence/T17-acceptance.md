# T17 完整验收记录

日期：2026-10-20（Asia/Shanghai）。前置提交 `6243b25`（T16 独立阶段 PASS）。**本阶段尚未完成，不标全部 AC 通过，也不授权 T18 发布。** 用户本轮明确使用本机验收，目前没有可用模型连接。

## 验证口径

下表的“合成范围已验证”指当前支持范围内有真实执行的确定性测试、正式服务或双端场景证据；它不表示真实科研数据、真实模型、其他系统或科研结论已通过。引用 T06–T16 是明确的历史证据，本轮重跑单列记录，既不拼接测试数量，也不假称旧 GUI 录像是本轮新执行。所有实验数据均为合成数据，未访问4090。

## 29 项 AC 对照

| AC | 当前结论 | 可复核证据与限制 |
| --- | --- | --- |
| 01 | 合成范围已验证 | auth-service/http/transport/node/tls、bio-smoke；T15三账号及双端登录/注销；T16实际最终包双窗口。停用、绝对过期及旧事件拒绝为真实服务/确定性测试 |
| 02 | 合成范围已验证 | sqlite-repository、authority-server、rpc-profile及T15 Alice/Bob/Charlie两个项目场景；个人与项目授权分别核对 |
| 03 | 合成范围已验证 | 伪造资源/Actor与旧共享token、materials-rpc/HTTP、documents-http、bio-smoke；不能靠客户端字段授权 |
| 04 | 合成范围已验证 | authority-server撤权/订阅、material-preview解码期间停用；T15用户明确授权的临时Bob撤权清屏、草稿保留及恢复记录；本轮未再次撤销成员 |
| 05 | **未通过真实公网门槛** | provider/service故障与分页契约有测试；本轮生产默认适配器真实请求失败，DNS为198.18.0.125，地址保护拒绝。没有绕过DNS/TLS，不能用PowerShell或替身代签 |
| 06 | 合成范围已验证 | literature-provider/service/rpc、source-snapshots与不可变来源修订；去重限定scope/policy，冲突、缺字段和私有记录不混用；真实在线抓取依赖05 |
| 07 | 合成范围已验证 | PDF解析定位、documents-http公开声明、public-input与执行出口测试；T15/T16真实合成PDF上传及页码/片段。没有将未声明或私有PDF发给云端 |
| 08 | 合成范围已验证 | pdf-extractor实际字节/页数边界、加密/损坏/纯图像/混合页、取消与无脚本/URI执行；document-parse实际子进程超时/输入预算 |
| 09 | 合成范围已验证 | PDF摘要仍为页定位、混合页缺口、部分文本预算、JATS正文覆盖；T15 UI显示合成PDF1/2页已读，不补造全文 |
| 10 | 合成范围已验证 | contracts、artifacts-service/rpc、T15证据定位与人工核对；不匹配片段保存为pending，不自动科学确认 |
| 11 | 合成范围已验证 | artifacts-service的结构有效但科学论断未审阅反例、缺块/缺关联、人工needs-changes；结构与科学判断不混淆 |
| 12 | 合成范围已验证 | artifacts-service、sqlite持久化、UI草稿/批注CAS；T15过期保存保留文字、显式合并、历史修订/审阅失效及重启 |
| 13 | 合成范围已验证 | CSV公式/Markdown HTML与链接转义、导出授权/审计；T15浏览器真实CSV/MD下载，T16实际文件导出（OS chooser使用替身） |
| 14 | 合成范围已验证 | materials-service万文件用例真实创建10000项、50页、每页≤200、自然排序；openFile观测为0，搜索图像不读正文；不是4090真实目录性能 |
| 15 | 合成范围已验证 | image-decode真实PNG/JPEG、image-tiff大小端/16位灰度/2帧选帧，material-preview源文件前后/绑定；T16最终包真实第2帧。复杂OME/BigTIFF/subIFD明确拒绝 |
| 16 | 合成范围已验证 | material-file/service与image-decode故障/离线/签名变化/取消/预算测试；失败不发布旧或未授权预览；真实大图集合未验证 |
| 17 | 合成范围已验证 | material-grants-config、material-file/service/rpc、HTTP与预览；越权、敏感目录、父路径、namespace互含和链接拒绝。T16额外修复真实launcher/bootstrap祖先重定向 |
| 18 | 当前支持范围已验证 | 空空间增加“尚未接入资料目录”提示，只在成功空列表且非loading/error时显示；个人空间/项目均适用。最新实际桌面UI验证空空间显示、有登记资料的项目不显示，截图已查看。loading/error由源码显式条件保证，本轮未另做UI网络故障注入。未连接4090，文档始终区分合成与真实资料 |
| 19 | 合成范围已验证 | public-input、model-connections、public-model-executor/runs以及rpc-profile；私有/混合历史或产物限制不随清空选择/改标识解除 |
| 20 | 合成范围已验证 | Node隔离、rpc-profile全通道默认拒绝、public-pi-runtime受控工具与SDK worker环境；旧shell/分享/MCP/辅助出口禁用及合成标记拒绝；不是对外部手工复制的保证 |
| 21 | 合成范围已验证 | 私有推理拒绝且模拟多连接出口计数为0；未配置可信本地模型，不回落官方/兼容/全局默认；未部署本地模型 |
| 22 | **真实调用未验证** | official/compatible配置、权限、SDK inspect、HTTPS受控假服务、错误/能力/取消契约有证据；用户目前无可用连接，实际官方GPT及兼容公网调用均为0 |
| 23 | 已知模式及合成范围已验证 | auth/授权错误、public-input/worker/审计，T16压力237件、1940源码/122编译文本/2桌面二进制/30服务自有文件清单扫描无命中；仅已知宿主秘密与指定标记，不是全面审计，vendor内容未扫描 |
| 24 | 当前支持范围已验证 | T15 Web与Electron使用同服务同身份/会话/证据/报告/运行；T16包重读持久运行与私有帧。T17最新桌面包测试副本创建真实公开论文报告，另开无桌面preload的实际Web页面，以同一账号发现并显示完全相同报告正文；共享typed API及主进程限制一致 |
| 25 | 合成范围已验证 | research-runs/service/rpc、public-model-worker真实子进程；并发启动、取消/撤权中晚到结果、generation/opId与CAS；T15 UI实际取消 |
| 26 | 合成范围已验证 | JSONL/SQLite持久化、projection/research-run-service故障注入和重启/显式重试；T15断连读回及完成投影，T16实际持久运行；不称自动重放不明模型副作用 |
| 27 | **公开PDF导入路线已验证** | 本轮使用arXiv官方U-Net v1 PDF，固定公开研究问题，经实际上传/解析→第5页短片段→证据→报告→导出→Web同修订正文核对跑通。上传/创建由实际桌面IPC测试驱动执行，Web为真实页面，不称人类逐项填表。报告保持unreviewed、模型调用0；不是在线检索+模型生成路线，AC05/22仍未通过 |
| 28 | **待最终公开交付** | T16已审README/独立部署说明、NOTICE/LICENSE、品牌和Windows运行包/来源记录；T18尚未执行，GitHub仓库/远端提交未核验，不能写已公开交付 |
| 29 | 合成范围已验证 | sqlite-repository/authority/rpc-profile/material/artifact/connection/run成功与失败审计、空间授权与body/key剔除；artifact-rpc明确拒绝保存/导出的审计用例。平台管理者不自动读别人数据审计 |

## 本轮执行与观测

- `node scripts/bio-validate.mjs`：将既有入口扩展到双端UI、transport/auth/protocol/i18n、公共profile、密钥原子替换、JSONL持久化/队列、纯领域类型和包装脚本严格类型。`T17-validation-final.log` 实际Node36/0；科研与客户端435 pass/0 fail/12911 expects/66files/144.60s；八包/domain/Web/包装脚本类型、Web/桌面renderer/main/preload构建及五类资源检查全部完成，BIO_VALIDATION_EXIT=0。此前420项为补齐4个核心文件前的独立批次，不拼接。不是完整原Craft回归。
- `node scripts/bio-launch.mjs test run .runtime/checks/T17-live-public.ts`：实际生产默认EuropePmcProvider，OS DNS为198.18.0.125，64ms返回unavailable，exit1。没有替换解析器、注入公网IP或关闭TLS；尚未到真实HTTPS成功。
- `node scripts/bio-launch.mjs test run .runtime/checks/T17-reference-performance.ts`：内存SQLite、2160012字节合成快照、100条引用记录，均指向同一快照/block-0的相同18字符片段；报告5条证据各重复20次。不是100篇论文或100个不同片段。PERF_EXIT=0，六操作见下表。首次夹具漏authSessionId而被严格契约拒绝（exit1），修正夹具再测，不是产品Red。
- 最后细化空状态的loading/error条件和个人空间文案后，Electron/Web各自类型再次exit0（`T17-electron-final-types.log`、`T17-web-final-types.log`）；i18n65/0/84expects/175ms/exit0（`T17-empty-locale-final.log`）。首次新增键插入顺序有误，既有排序检查58 pass/7 fail；修正顺序后通过，没有放松断言。文案/空状态为低影响展示修正，未添加与实现镜像的测试。`T17-lint-final.log`在最终条件和文案修改后再次33文件/0errors/0warnings、LINT_EXIT=0。
- `node .runtime/checks/T17-pressure-build.mjs`：最后双端/main/desktop包重建，desktop-F6KdrC、237件产物（含ASAR/exe）均无注入的合成构建秘密标记，PRESSURE_EXIT=0。实际运行后`T17-desktop-inventory-final.log`只读核对ProductName=BioEvidence、FileVersion=0.1.0.0及exe/ASAR哈希仍与正式清单相符，exit0。renderer仍有>500KB警告。服务后端未改动，不重新声称生成了新服务分发目录；T16运行目录证据仅作为对应历史引用。
- `node scripts/bio-launch.mjs test run .runtime/checks/T17-native-package-prepare.mjs`，随后 `node .runtime/checks/T17-native-package-launch.mjs`：最终测试副本jupzAQ仅增加包装驱动/改package main，正式exe/main/preload/HTML字节不变；实际当前源码服务、最新Web资产、2个桌面窗口与另1个Web窗口，`T17-native-current.log` NATIVE_EXIT=0。空/非空资料状态、合成私有帧/上传/导出和真实公开PDF路线均通过；没有手工操作原生chooser，也没有逐个手工填写UI表单。
- 首轮`T17-native-final.log` exit1是在Web同报告正文断言后capturePage报“display surface不可用”，不是业务Red。改用offscreen后功能断言exit0，但Web截图仍为0字节，**未将其作为有效截图或视觉验收证据**。桌面空状态截图`T17-desktop-empty.png`为62867字节，已实际查看。新驱动初次`node --check`字符串转义失败并修正，仅属被忽略的检查脚本。
- `node .runtime/checks/T17-scan-final.mjs`：最终构建后扫描，1个已知宿主秘密模式；1941源码文本、122编译文本、最新ASAR/exe2件，以及未改变的T16服务自有文件/清单30件均无命中，SCAN_EXIT=0。vendor文件内容未扫描，非穷尽审计。
- 新旧本机合成服务均经owned控制通道停止；最终`T17-service-proof-final.log`为BIOEVIDENCE_STOPPED=0、stopped code0、SERVICE_PROOF_EXIT=0。克隆已停止的原合成库到新namespace，未改动原库或真实用户资料。

## 真实公开PDF的固定演示

来源为[U-Net官方arXiv记录](https://arxiv.org/abs/1505.04597v1)与[原始PDF](https://arxiv.org/pdf/1505.04597v1)。经PowerShell正常HTTPS下载1648684字节，SHA256=`a3172b2124f38e260dc2c7ed968d87c31bc94dbc19a42a7ab3dcbd7534319c44`，实际解析8页，平台快照contentHash与下载文件一致。这里只证明公开PDF导入，不将该下载替代生产EuropePMC适配器。未确认再分发许可，不提交论文全文。

固定问题为“U-Net论文如何说明数据增强在有限标注条件下的作用？”。驱动只选第5页的一个短原文片段，写入人工整理的中文论断及局限/缺失信息；未生成新科学结论，证据和报告均为structure-valid、unreviewed。公开报告导出原件保留在忽略目录`.runtime/checks/T17-public-unet-report.md`，没有模型或人类科学审批。

`T17-public-demo-result.json`记录快照`9a544482-f35f-408d-be74-6e051eaa1ec8`、证据`97abf60e-eb07-4507-bfff-112949967e13`、报告修订`00312f5b-2eb1-4223-b271-c80b49ea0ccc`/revision1。Bob桌面读取同一证据/报告，Alice的实际Web页面发现并显示完全相同markdown；两者均使用当前服务授权，不注入renderer bearer。公开PDF、合成账号、测试驱动、原始日志及导出均只保留本机，不随源码提交。

## 重复引用性能观测

以下为前述内存合成库基准，独立于U-Net公开论文演示。

| 操作 | 耗时ms | snapshot正文读取次数 | RSS变化bytes |
| --- | ---: | ---: | ---: |
| createEvidence100 | 438 | 200 | 119799808 |
| evidenceView100 | 182 | 100 | -1032192 |
| exportEvidence100 | 404 | 200 | -16949248 |
| createReport5x20 | 194 | 100 | -10723328 |
| reportView5x20 | 175 | 100 | 4386816 |
| exportReport5x20 | 355 | 200 | 10579968 |

进程观测峰值maxRSS=341188KiB；单次本机测量，含运行时/SQLite开销，RSS变化受GC影响，不能解释为确定的每次分配量，也不是负内存消耗。多次读取同快照确有成本；未增加跨请求缓存或跳过授权，预算仍然有效。缓存优化列P1，真实大规模性能未验证。

## 剩余任务与最小后续动作

- **P0：** 在本机正常公开DNS/受信TLS环境重跑默认EuropePMC检索/摘要/XML；用户未来在服务端配置可用模型后验证官方/兼容的实际公开请求；完整T17及发布审阅后才执行T18。AC18空状态、AC27真实公开PDF导入路线已在本机关闭；模型和生产公网门槛没有因此免除。本轮未修改系统DNS、代理或证书设置，未读取外部凭据文件，也未借用宿主密钥执行模型或服务请求；扫描仅在内存比对已继承的已知秘密模式，不显示或保存其值。
- **P1：** 有预算的单操作重复快照读取优化、renderer分包、约1GB服务闭包裁剪；原生TTY/OS文件对话框手工验收、新机器安装及CI远端验证按交付声明分别补证据；Docker/Linux明确仍未验证。
- **P2：** 真实4090资料接入、复杂显微图格式/更大规模实验索引、本地LLM/GPU/细胞分类、安装器/签名/自动更新。既有非目标未扩大。

尚未请求实际模型，没有模型名/费用或模型科学回答可以报告。完整阶段审批仅覆盖T00–T16；T17全阶段因AC05/22尚未完成，不提前标PASS，也未执行T18。

## 当前进展的独立审批

2026-10-20 `/root/t16_release_judge` 对当前空状态修正、验证范围扩充与进展文档顺序给出**规格符合性 PASS、代码质量 PASS、文档一致性 PASS**，批准同步普通记录后本地checkpoint提交。评判只读核对源码、差异和原始日志，并独立执行只读`git diff --check` exit0；没有重跑测试/GUI、修改源码或安装依赖。本结论限定本次进展，**不是T17阶段PASS**，没有免除AC05/22或授权提前T18发布。
