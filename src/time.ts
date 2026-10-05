/** Timezone helpers: days in the views are calendar days in the configured timezone. */

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD" for an instant, in `tz`. */
export function localDate(iso: string | Date, tz: string): string {
  let f = dateFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dateFormatters.set(tz, f);
  }
  return f.format(typeof iso === "string" ? new Date(iso) : iso);
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds (positive east of UTC). */
function offsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant of local midnight starting `date` ("YYYY-MM-DD") in `tz`. */
export function startOfLocalDay(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const naive = Date.UTC(y, m - 1, d);
  let guess = naive - offsetMs(naive, tz);
  guess = naive - offsetMs(guess, tz); // second pass settles DST transitions
  return new Date(guess);
}

/** Half-open UTC range [start, end) covering local `date` in `tz`, as ISO strings. */
export function localDayRange(date: string, tz: string): [string, string] {
  return [toIso(startOfLocalDay(date, tz)), toIso(startOfLocalDay(addDays(date, 1), tz))];
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO without milliseconds, matching GitHub's format so string comparison works. */
export function toIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function isDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
