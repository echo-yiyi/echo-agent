// 五段 cron 子集(分 时 日 月 星期),纯函数。
//
// 支持:`*`、`N`、`N-M`、`*/S`、`N-M/S`、逗号列表;日与星期**同时**约束时 OR(标准语义);
// 星期 0 和 7 都是周日;本地时区。不支持 `L`/`W`/`?`。
// 手写子集的理由与 frontmatter 同一条:cron 是 50 年的通用语、模型都认识,
// 而这里是我们自己消费的格式,不需要兼容外部解析器的边角。

const FIELD_RANGES: readonly [number, number][] = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 星期(0/7 = 周日)
];

/** 合法返回 null,非法返回给模型看的错误说明(创建时拒,不排注定炸的任务)。 */
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return `cron must have five fields (minute hour day month weekday), got ${fields.length}`;
  const names = ["minute", "hour", "day", "month", "weekday"];
  for (let i = 0; i < 5; i++) {
    const err = validateField(fields[i]!, FIELD_RANGES[i]![0], FIELD_RANGES[i]![1]);
    if (err !== null) return `field ${i + 1} (${names[i]}) is invalid: ${err}`;
  }
  return null;
}

export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];

  const m = fieldMatches(minute, d.getMinutes(), 0);
  const h = fieldMatches(hour, d.getHours(), 1);
  const monthOk = fieldMatches(month, d.getMonth() + 1, 3);
  if (!(m && h && monthOk)) return false;
  return dayMatches(dom, dow, d);
}

/**
 * 严格晚于 `after` 的第一个匹配分钟起点（本地时区）；往后 `maxYears` 年仍没有返回 null（`0 0 30 2 *` 这类永不命中的表达式）。
 *
 * 按字段跳而不是逐分钟扫：月不对跳到下月 1 日、日不对跳到次日 0 点、时不对跳到下个整点。
 * 「每年 2 月 29 日」这种最坏情况也只走几千步，调度器每拍都要问「下一次在哪」，逐分钟扫扛不住。
 */
export function nextMatchAfter(expr: string, after: number, maxYears = 5): number | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  let d = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  const limit = new Date(d.getTime());
  limit.setFullYear(limit.getFullYear() + maxYears);
  while (d.getTime() <= limit.getTime()) {
    let next: Date;
    if (!fieldMatches(month, d.getMonth() + 1, 3)) next = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0);
    else if (!dayMatches(dom, dow, d)) next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0);
    else if (!fieldMatches(hour, d.getHours(), 1)) next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1, 0);
    else if (!fieldMatches(minute, d.getMinutes(), 0)) next = new Date(d.getTime() + 60_000);
    else return d.getTime();
    // 夏令时回拨那一小时里，按本地字段构造出的时刻可能不晚于当前：退化成逐分钟前进，保证不原地打转
    d = next.getTime() > d.getTime() ? next : new Date(d.getTime() + 60_000);
  }
  return null;
}

/** 日与星期:都不约束 → 过;只约束一边 → 看那边;都约束 → OR(标准语义,两家一致) */
function dayMatches(dom: string, dow: string, d: Date): boolean {
  const domOk = fieldMatches(dom, d.getDate(), 2);
  const dowVal = d.getDay(); // 0 = 周日
  const dowOk = fieldMatches(dow, dowVal, 4) || (dowVal === 0 && fieldMatches(dow, 7, 4));
  if (dom === "*" && dow === "*") return true;
  if (dom === "*") return dowOk;
  if (dow === "*") return domOk;
  return domOk || dowOk;
}

/** 从 now 往回找最近一个匹配的分钟起点(含 now 所在分钟),最多回看 scanMinutes 分钟;没有返回 null。 */
export function latestMatchBefore(expr: string, now: number, scanMinutes = 120): number | null {
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  for (let i = 0; i < scanMinutes; i++) {
    const t = minuteStart - i * 60_000;
    if (cronMatches(expr, new Date(t))) return t;
  }
  return null;
}

/* ───────────── 单字段 ───────────── */

/** `index` 是 FIELD_RANGES 的下标:`*` 与裸 `N/S` 的边界取自字段自己的范围(标准 cron:`*\/N` ≡ `<min>-<max>/N`)。 */
function fieldMatches(field: string, value: number, index: number): boolean {
  const [fieldLo, fieldHi] = FIELD_RANGES[index]!;
  return field.split(",").some((part) => partMatches(part, value, fieldLo, fieldHi));
}

function partMatches(part: string, value: number, fieldLo: number, fieldHi: number): boolean {
  let range = part;
  let step = 1;
  const slash = part.indexOf("/");
  if (slash !== -1) {
    range = part.slice(0, slash);
    step = Number(part.slice(slash + 1));
  }
  let lo: number;
  let hi: number;
  if (range === "*") {
    // 起点是字段下界:日、月从 1 起——写成 0 时 `*/2` 在日段会命中 2、4、6…而不是标准的 1、3、5…(review 2026-09-07)
    lo = fieldLo;
    hi = fieldHi;
  } else if (range.includes("-")) {
    const [a, b] = range.split("-");
    lo = Number(a);
    hi = Number(b);
  } else {
    if (slash === -1) return Number(range) === value;
    lo = Number(range);
    hi = fieldHi;
  }
  return value >= lo && value <= hi && (value - lo) % step === 0;
}

function validateField(field: string, lo: number, hi: number): string | null {
  if (field === "") return "empty field";
  for (const part of field.split(",")) {
    let range = part;
    if (part.includes("/")) {
      const [r, s] = part.split("/");
      range = r ?? "";
      const step = Number(s);
      if (!Number.isInteger(step) || step < 1) return `step '${s}' is invalid`;
    }
    if (range === "*") continue;
    const nums = range.includes("-") ? range.split("-") : [range];
    if (nums.length > 2) return `'${part}' is invalid`;
    for (const n of nums) {
      const v = Number(n);
      if (!Number.isInteger(v) || v < lo || v > hi) return `'${n}' is out of range [${lo},${hi}]`;
    }
    if (nums.length === 2 && Number(nums[0]) > Number(nums[1])) return `range '${range}' starts after it ends`;
  }
  return null;
}
