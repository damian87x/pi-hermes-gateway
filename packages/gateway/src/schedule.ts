export type LocalParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let fmt = dtfCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, fmt);
  }
  return fmt;
}

export function partsOf(ms: number, timeZone: string): LocalParts {
  const map: Record<string, string> = {};
  for (const p of dtf(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const hourRaw = Number(map.hour);
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function asUtcMs(p: LocalParts): number {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function ymdKey(y: number, m: number, d: number): number {
  return y * 10000 + m * 100 + d;
}

function addDays(y: number, m: number, d: number, days: number): { year: number; month: number; day: number } {
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/** First fold occurrence; null when the local time does not exist (DST gap). */
export function zonedLocalInstant(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number | null {
  const wanted = Date.UTC(year, month - 1, day, hour, minute, 0);
  const matches: number[] = [];
  for (const delta of [0, -3_600_000, 3_600_000, -7_200_000, 7_200_000, -10_800_000, 10_800_000]) {
    const guess = wanted + delta;
    const offset = asUtcMs(partsOf(guess, timeZone)) - guess;
    const candidate = wanted - offset;
    const p = partsOf(candidate, timeZone);
    if (
      p.year === year &&
      p.month === month &&
      p.day === day &&
      p.hour === hour &&
      p.minute === minute &&
      p.second === 0 &&
      !matches.includes(candidate)
    ) {
      matches.push(candidate);
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a - b);
  return matches[0] ?? null;
}

export function dailyInstantsInRange(opts: {
  timeZone: string;
  localTime: string;
  afterMs: number;
  toMs: number;
}): number[] {
  const hm = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(opts.localTime);
  if (!hm) throw new Error("invalid localTime");
  const hour = Number(hm[1]);
  const minute = Number(hm[2]);
  const start = partsOf(opts.afterMs, opts.timeZone);
  const end = partsOf(opts.toMs, opts.timeZone);
  let cursor = addDays(start.year, start.month, start.day, -1);
  const last = addDays(end.year, end.month, end.day, 1);
  const out: number[] = [];
  while (ymdKey(cursor.year, cursor.month, cursor.day) <= ymdKey(last.year, last.month, last.day)) {
    const instant = zonedLocalInstant(opts.timeZone, cursor.year, cursor.month, cursor.day, hour, minute);
    if (instant !== null && instant > opts.afterMs && instant <= opts.toMs) out.push(instant);
    cursor = addDays(cursor.year, cursor.month, cursor.day, 1);
  }
  return out;
}

export function onceInstant(atUtc: string): number {
  const ms = Date.parse(atUtc);
  if (!Number.isFinite(ms)) throw new Error("invalid atUtc");
  return ms;
}
