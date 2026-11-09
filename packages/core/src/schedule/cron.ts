// 五段 cron 子集(分 时 日 月 星期),纯函数。
//
// 支持:`*`、`N`、`N-M`、`*/S`、`N-M/S`、逗号列表;日与星期**同时**约束时 OR(标准语义);
// 星期 0 和 7 都是周日;本地时区。不支持 `L`/`W`/`?`。
// 手写子集的理由与 frontmatter 同一条:cron 是 50 年的通用语、模型都认识,
// 而这里是我们自己消费的格式,不需要兼容外部解析器的边角。
//
// 夏令时照 Vixie cron / cronie:**分或时以 `*` 起头的是通配任务**(`*/15 * * * *`、`30 * * * *`),
// 其余是**固定时刻任务**(`30 1 * * *`)。
//   - 通配任务照真实时间走:墙上时间每出现一次匹配就触发一次——回拨时重复的那一小时里触发两遍,
//     拨快时不存在的那段里一次都没有,也不补。
//   - 固定时刻任务每个墙上时刻只认一次:回拨时重复的那一小时不再触发;拨快时被跳过的时刻在间隙之后的
//     第一刻补一次(间隙里有几个匹配都并成这一次)。
// cronie 把超过 3 小时的时钟跳变当成「改了系统时间」而不是夏令时,这里同样只在 3 小时窗口里找回拨。

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

/** `d` 的本地字段是否匹配。只看字段，不管夏令时（触发时刻见 `nextMatchAfter`）。 */
export function cronMatches(expr: string, d: Date): boolean {
  const f = parseFields(expr);
  if (f === null) return false;
  return fieldsMatch(f, d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay());
}

/**
 * 严格晚于 `after` 的第一个触发时刻（分钟起点，夏令时语义见文件头）；往后 `maxYears` 年仍没有返回 null
 * （`0 0 30 2 *` 这类永不命中的表达式）。
 */
export function nextMatchAfter(expr: string, after: number, maxYears = 5): number | null {
  const f = parseFields(expr);
  if (f === null) return null;
  const start = Math.floor(after / MINUTE) * MINUTE;
  const limit = new Date(start);
  limit.setFullYear(limit.getFullYear() + maxYears);
  return nextFiring(f, start, limit.getTime());
}

/**
 * 不晚于 `now` 的最近一个触发时刻（含 now 所在分钟），最多回看 `scanMinutes` 分钟；没有返回 null。
 * 与 `nextMatchAfter` 同一套触发时刻——拨快日补在间隙之后的那一刻，回看也认它。
 */
export function latestMatchBefore(expr: string, now: number, scanMinutes = 120): number | null {
  const f = parseFields(expr);
  if (f === null) return null;
  const end = Math.floor(now / MINUTE) * MINUTE;
  let last: number | null = null;
  for (let t = nextFiring(f, end - scanMinutes * MINUTE, end); t !== null; t = nextFiring(f, t, end)) last = t;
  return last;
}

/* ───────────── 触发时刻(夏令时) ───────────── */

const MINUTE = 60_000;
const DAY = 86_400_000;
/** 回拨只在这个窗口里找:cronie 把更大的时钟跳变当成改了系统时间,不当夏令时。 */
const DST_WINDOW = 3 * 3_600_000;

type Fields = readonly [minute: string, hour: string, dom: string, month: string, dow: string];

function parseFields(expr: string): Fields | null {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 ? (fields as unknown as Fields) : null;
}

/** 通配任务:分或时以 `*` 起头(cronie 的 MIN_STAR / HR_STAR)。 */
function isWildcard(f: Fields): boolean {
  return f[0].startsWith("*") || f[1].startsWith("*");
}

/** `start`(分钟起点)之后、不晚于 `limit` 的第一个触发时刻。 */
function nextFiring(f: Fields, start: number, limit: number): number | null {
  return isWildcard(f) ? nextWildcardFiring(f, start, limit) : nextFixedFiring(f, start, limit);
}

/** 本地时区在 `t` 这一刻比 UTC 快多少毫秒(东正西负)。 */
function offsetAt(t: number): number {
  return -new Date(t).getTimezoneOffset() * MINUTE;
}

/** 墙上时间:`t` 时刻的本地字段当成 UTC 读出来的毫秒数。在它上面按字段跳没有夏令时。 */
function wallOf(t: number): number {
  return t + offsetAt(t);
}

/**
 * 固定时刻任务:每个墙上时刻只认一次。到真实时刻 `t` 为止「墙上时间走到过的最远一分钟」之后的第一个匹配,
 * 在墙上时间第一次够到它的那一刻触发——回拨时重复的那一小时够不着新的时刻,拨快时被跳过的时刻在间隙之后那一刻够到。
 */
function nextFixedFiring(f: Fields, start: number, limit: number): number | null {
  const m = nextWallMatch(f, frontier(start) + MINUTE, frontier(limit));
  return m === null ? null : firstReaching(m);
}

/** 通配任务:真实时间往前走,每一分钟看它的墙上时间。偏移不变的一段里按字段跳,碰到偏移变化就从变化那一分钟接着找。 */
function nextWildcardFiring(f: Fields, start: number, limit: number): number | null {
  let t = start;
  while (t < limit) {
    const from = t + MINUTE;
    const off = offsetAt(from);
    const m = nextWallMatch(f, from + off, limit + off);
    const candidate = m === null ? null : m - off;
    const change = nextOffsetChange(from, candidate ?? limit, off);
    if (change === null) return candidate;
    t = change - MINUTE;
  }
  return null;
}

/** 真实时刻 `t`(含)往回 `DST_WINDOW` 里墙上时间到过的最远一分钟:没有回拨就是 `t` 自己的墙上时间。 */
function frontier(t: number): number {
  const early = t - DST_WINDOW;
  if (offsetAt(early) <= offsetAt(t)) return wallOf(t);
  return Math.max(wallOf(t), wallOf(firstChange(early, t) - MINUTE));
}

/** 墙上时间第一次 ≥ `m` 的真实时刻。`m` 在回拨里出现两次取前一次;在拨快的间隙里不存在,取间隙之后那一刻。 */
function firstReaching(m: number): number {
  const before = offsetAt(m - DAY);
  const after = offsetAt(m + DAY);
  const candidates = before === after ? [m - before] : [m - before, m - after].sort((a, b) => a - b);
  for (const t of candidates) if (wallOf(t) === m) return t;
  return firstChange(m - after, m - before);
}

/** `(from, to]` 里第一个偏移不是 `off` 的分钟;没有返回 null。按天探——一个时区一天之内不会变两次偏移。 */
function nextOffsetChange(from: number, to: number, off: number): number | null {
  for (let lo = from; lo < to; lo += DAY) {
    const hi = Math.min(lo + DAY, to);
    if (offsetAt(hi) !== off) return firstChange(lo, hi);
  }
  return null;
}

/** `lo` 与 `hi` 偏移不同(之间只变一次):二分出偏移变化的那一分钟。 */
function firstChange(lo: number, hi: number): number {
  const o = offsetAt(lo);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
    if (offsetAt(mid) === o) lo = mid;
    else hi = mid;
  }
  return hi;
}

/**
 * 墙上时间里 `from`(含)起第一个匹配的分钟,超过 `wallLimit` 返回 null。
 *
 * 按字段跳而不是逐分钟扫：月不对跳到下月 1 日、日不对跳到次日 0 点、时不对跳到下个整点。
 * 「每年 2 月 29 日」这种最坏情况也只走几千步，调度器每拍都要问「下一次在哪」，逐分钟扫扛不住。
 * 墙上时间用 UTC 字段读写，没有夏令时，每一跳都严格前进。
 */
function nextWallMatch(f: Fields, from: number, wallLimit: number): number | null {
  const [minute, hour, dom, month, dow] = f;
  let d = new Date(from);
  while (d.getTime() <= wallLimit) {
    const y = d.getUTCFullYear();
    const mo = d.getUTCMonth();
    const day = d.getUTCDate();
    if (!fieldMatches(month, mo + 1, 3)) d = new Date(Date.UTC(y, mo + 1, 1));
    else if (!dayMatches(dom, dow, day, d.getUTCDay())) d = new Date(Date.UTC(y, mo, day + 1));
    else if (!fieldMatches(hour, d.getUTCHours(), 1)) d = new Date(Date.UTC(y, mo, day, d.getUTCHours() + 1));
    else if (!fieldMatches(minute, d.getUTCMinutes(), 0)) d = new Date(d.getTime() + MINUTE);
    else return d.getTime();
  }
  return null;
}

function fieldsMatch(f: Fields, minute: number, hour: number, date: number, month: number, weekday: number): boolean {
  const [m, h, dom, mo, dow] = f;
  return fieldMatches(m, minute, 0) && fieldMatches(h, hour, 1) && fieldMatches(mo, month, 3) && dayMatches(dom, dow, date, weekday);
}

/** 日与星期:都不约束 → 过;只约束一边 → 看那边;都约束 → OR(标准语义,两家一致)。`weekday` 0 = 周日。 */
function dayMatches(dom: string, dow: string, date: number, weekday: number): boolean {
  const domOk = fieldMatches(dom, date, 2);
  const dowOk = fieldMatches(dow, weekday, 4) || (weekday === 0 && fieldMatches(dow, 7, 4));
  if (dom === "*" && dow === "*") return true;
  if (dom === "*") return dowOk;
  if (dow === "*") return domOk;
  return domOk || dowOk;
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
