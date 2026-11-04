# 流空闲超时：SSE 连着却不再吐字节，5 分钟没收到任何字节就中止这次 attempt、按可重试的 timeout 处理

> 状态:implemented · 提出 2026-11-03（provider 适配与主循环一线的 bug 清单）· 拍板 2026-11-03（用户：「按推荐修」）· 落地 `packages/core/src/provider/openai.ts`，判据见文末

**给谁看**：改 OpenAI 兼容方言读流、或排查「run 卡住不动」的人。假设已知 [Run Loop 的四层](../../design/run-loop-layers.md) §6（重试归 loop：方言一次请求一条流，失败标 `retryable`，再不再来由 loop 决定）。

## 现状（拍板前）

方言读 SSE 是裸的 `reader.read()`。连接还开着、上游却不再吐字节（网关挂起、上游推理卡死而连接没断）时，这次 read 永远不返回，没有任何计时：attempt 不结束，turn 不结束，run 不结束。终端里人还能按 Esc（abort）；`--serve` 宿主与 inbox 叫醒的临时容器没人按，这个 run 一直占着 admission 的执行许可，后面的工作全排着。`timeoutMs` 是可选的 run 墙钟、缺省不配，管不到这件事。

参照（只看做法）：codex 对流式响应有一个空闲上限，缺省 300 000 ms（codex-rs `model-provider-info` 的 `DEFAULT_STREAM_IDLE_TIMEOUT_MS`；字段说明是「等流式响应上的动静，超时就当连接已断」），超时按断线重试。

## 选项

- **A. 方言里加空闲计时**：多久没收到任何字节就中止这次请求，归成可重试的 timeout，loop 照 `retryPolicy` 再来一个 attempt。
- **B. 只靠 run 的 `timeoutMs`**：墙钟管整条 run，长任务得设得很大，设大了就管不住卡住的那一次请求；而且缺省不配。
- **C. 做成选项**（`OpenAiDialectOptions` 加一个空闲上限）：今天没有调用方需要调，先不开这个口子。

## 决定

**A**（2026-11-03 用户拍板「按推荐修」）。

1. **只在等字节的那一段计时**（`IdleWatch.wait`）：等响应头、每一次 `read()` 各自起表，拿到就停。消费方处理事件（emit、渲染）花的时间不算——慢的订阅者不会让一条好好的流被当成空闲掐掉。
2. **上限** [`STREAM_IDLE_TIMEOUT_MS`](../../../packages/core/src/provider/openai.ts#symbol=STREAM_IDLE_TIMEOUT_MS) = 300 000（5 分钟），取 codex 的缺省。模块常量，不进包的公共导出、不做选项。
3. **到点**：中止这次 fetch（计时器的 signal 与外层 signal 合并后交给 fetch），挂着的那次 read 在赛跑里输掉，读流 `cancel` 放掉连接；归成 `provider` / `timeout` / 可重试。已流出的正文按惯例留在失败消息里、不送回模型。
4. **尊重外层 signal**：调用方取消、run 超时与空闲计时走同一个合并 signal，外层先到就归 `aborted`，不等空闲计时。归类先看 signal、再看异常长什么样（`classifyThrown`）——各运行时被中止时拒绝的值不一样。

## Non-Goals

- 不加整条流的总时长上限：一直在吐字节就一直读，墙钟仍是 `timeoutMs`。
- 不在 loop 层另加 attempt 超时：loop 不知道 provider 有没有在吐字节。
- 压缩摘要器不另做：它走同一个方言，自动受同一计时。
- 不做成产品或宿主可调的选项（选项 C）。

## 验收

- [空闲到点](../../../packages/core/test/openai.test.ts#test=流空闲-300s-没收到任何字节中止这次请求以可重试的-timeout-收场已流出的正文留在失败消息里)：假时钟拨到差 1 ms 时还没收场；到点后以 `timeout`、可重试收场，已流出的正文留在失败消息里。
- [外层中止](../../../packages/core/test/openai.test.ts#test=流空闲期间外层-signal-中止以-aborted-收场不等空闲计时)：空闲等待中外层 signal 中止 → `aborted`，不等计时。
- 变异：计时器不起表 / 不把外层 signal 合进赛跑，各让对应判据变红。
