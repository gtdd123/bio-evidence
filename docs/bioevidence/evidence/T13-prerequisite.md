# T13 前置门槛 — Windows 模式测试目录

日期：2026-10-15。状态：独立审批PASS。任务来源为已批准Plan18、Tasks T02：T13开始前关闭14项Windows路径夹具失败。

只修改`packages/shared/tests/mode-manager.test.ts`。原测试假定本机存在`C:\Users\test`与`Balin`目录，真实nearest-real-ancestor保护因路径不存在而拒绝。改为每组独占UUID临时目录，保留PowerShell Out-File/Set-Content、大小写差异、双层包装、转义/未转义引号和原拒绝断言。来自真实问题的原始双反斜杠命令保留，仅替换目标plans目录到自有真实目录，并断言替换生效；其中作为普通文本的示例路径不作实际访问。

建立目录只限fixture；清理先确认resolved与real目标位于当前临时目录下且前缀属于本测试，再递归删除。没有执行被测写入命令，只检查生产授权函数。生产路径/模式校验代码零改动，未禁用realpath、链接或遍历保护。

```text
node scripts/bio-launch.mjs test test packages/shared/tests/mode-manager.test.ts
node scripts/bio-launch.mjs bootstrap run tsc --noEmit -p packages/shared/tsconfig.json
git diff --check
```

同一完整文件修改前 **430 pass/14 fail/531expects/444tests/36.70s/exit1**，修改后 **444 pass/0 fail/532expects/444tests/30.55s/exit0**。失败名单恰为T02已登记14项；此前zsh用例继续通过。此为夹具修正，不宣称新生产行为Red→Green。日志为忽略的`.runtime/checks/T13-prereq-mode-before.log`及`T13-prereq-mode-after.log`。

共享包类型与补丁格式检查均exit0。独立评判`/root/t11_independent_judge`正式PASS：独立完整444/0/532expects/31.64s/exit0、shared类型exit0，确认生产授权代码未改动、断言保留、文档一致，可关闭14项前置门槛。该结果不改写T02完整基线4920/1skip/17fail/exit1，也不关闭T16服务退出、MCP命令诊断、Python/包装或T17完整重跑门槛。
