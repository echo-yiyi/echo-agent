# 调度工具说清时间与状态

> 状态:implemented · 提出 2026-11-17（产品方报告：调度工具没有明确的时间和状态）· 拍板 2026-11-17（用户：「可以，按你的顺序做」）· 落地 `packages/core/src/schedule/tools.ts`（`schedule_create`、`schedule_list`、`ScheduleView`、`localIso`）、`packages/core/src/schedule/harness.ts`（`scheduleStatus`、`nextFireAt`），判据见验收

**给谁看**：用调度工具的产品，改 `schedule/` 的人。

## 现状（拍板前）

- `schedule_create` 只回「Created schedule <id>」：不带偏移的 `at` 按本地时区解析成了哪一刻、周期与 cron 下一次什么时候响，模型都看不到，说错了也发现不了。
- `schedule_list` 每条只有规则与上次触发时刻（UTC），没有下次触发时刻，也看不出一条是在等、已到点还没投，还是已经错过。
- 两个工具都不给结构化结果，宿主要知道这些得解析正文。

## 决定

1. **时刻一律写成本地时区、带偏移的 ISO**（[`localIso`](../../../packages/core/src/schedule/tools.ts#symbol=localIso)）：cron 按本地时区解释、不带偏移的 `at` 也按本地时区解析，回显 UTC 的话模型对不上它说的「9 点」。
2. **`schedule_create` 回显解析出的规则与下次触发时刻**，例如 `Created schedule sch-1a2b3c4d: once at 2026-08-05T10:30:00-04:00; next fire 2026-08-05T10:30:00-04:00. Cancel with schedule_cancel.`。
3. **`schedule_list` 每条带状态与下次触发时刻**。状态是封闭集 [`ScheduleStatus`](../../../packages/core/src/schedule/harness.ts#symbol=ScheduleStatus)，与 tick 判到期是同一份判断：
   - `waiting`：还没到点；
   - `due`：已到点、还没投进 inbox，下一拍投（投递一直失败就一直是它）；
   - `missed`：cron 欠着的那次已超过宽限，下一拍跳过、不补投。

   下次触发时刻（[`nextFireAt`](../../../packages/core/src/schedule/harness.ts#symbol=nextFireAt)）：一次性是 `at`；周期是上次投递（没投过就是创建时刻）加一个周期；cron 是游标之后第一个匹配。已到点没投的，就是欠着的那一次。
4. **同样的字段进工具结果的 `metadata`**（[`ScheduleView`](../../../packages/core/src/schedule/tools.ts#symbol=ScheduleView)，时刻是毫秒时间戳）：`schedule_create` 是 `{ schedule }`，`schedule_list` 是 `{ schedules }`。metadata 不发给模型。
5. `schedule_create` 记创建时刻改用调度器自己的时钟（`ctx.clock`），下次触发与状态按同一个时钟算。

## Non-Goals

- **没有「一次性已触发」这一态**：一次性任务投出、落盘之后就从表里删掉，列表里本来就没有它。要让模型看到「已经响过」，得另存一段触发历史，是新的行为，没做。
- 不改触发语义（宽限、补跑、迟到照投），只把已有的判断说出来。

## 验收

- [localIso](../../../packages/core/test/schedule.test.ts#test=localiso本地时区带偏移读回来是同一刻)：格式带偏移，读回来是同一刻，墙上时刻是本地时间。
- [回显时间与状态](../../../packages/core/test/schedule.test.ts#test=create-回显解析出的触发规则与下次触发本地时区带偏移list-每条带状态与下次触发没到点-waiting到点没投-duecron-超宽限-missed同样的字段进-metadata)：三种规则的回显带对的下次触发时刻；列表在没到点时全是 `waiting`，拨过去一天、一拍不走之后是 `due` / `missed` / `due`；metadata 与正文一致。
