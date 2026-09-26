/**
 * Period / calendar arithmetic. See spec/core.pseudo.md [EC:G1] [EC:G2] [EC:G3].
 * Mirrors packages/core/py/src/boilpayment_core/period.py exactly.
 * All Date instants in/out are UTC (EC:G3); `tz` is used only for civil month/day arithmetic.
 */
import { MonthEndAnchor, Period, ProrationDenominator } from './types.js';

const DAY_MS = 86_400_000;

interface CivilParts {
  year: number;
  month: number; // 1..12
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
}

function civilPartsInTz(date: Date, tz: string): CivilParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour) % 24,
    minute: Number(map.minute),
    second: Number(map.second),
    ms: date.getUTCMilliseconds(),
  };
}

/** Civil-time -> UTC instant, resolved by iterative offset correction (handles DST, EC:G3). */
function civilToUtc(parts: CivilParts, tz: string): Date {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.ms);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const got = civilPartsInTz(new Date(guess), tz);
    const gotUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute, got.second, got.ms);
    const diff = gotUtc - target;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

/** Number of days in `month` (1..12) of `year`, accounting for leap years (EC:G5). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** EC:G2 — actual elapsed days across [start, end). May be fractional. */
export function daysInPeriod(period: Period): number {
  return (period.end.getTime() - period.start.getTime()) / DAY_MS;
}

/**
 * EC:G1 — advance `period` by one `interval`, anchored on `anchorDay` (1..31) in `tz`.
 * - clamp_keep_original_day: retries the original `anchorDay` every cycle (a short month clamps
 *   down; a later, longer month goes back up to `anchorDay`).
 * - clamp_permanently: once a cycle clamps, the clamped day becomes the permanent anchor —
 *   derived statelessly from `period.end`'s day-of-month in `tz` (no extra state needed).
 */
export function nextPeriod(
  period: Period,
  interval: 'month' | 'year',
  anchorDay: number,
  tz: string,
  monthEndAnchor: MonthEndAnchor,
): Period {
  const end = civilPartsInTz(period.end, tz);
  const effectiveDay = monthEndAnchor === 'clamp_permanently' ? end.day : anchorDay;
  const monthsToAdd = interval === 'year' ? 12 : 1;
  const targetIndex = end.month - 1 + monthsToAdd; // 0-based, may overflow past 11
  const targetYear = end.year + Math.floor(targetIndex / 12);
  const targetMonth = (targetIndex % 12) + 1; // 1..12
  const day = Math.min(effectiveDay, daysInMonth(targetYear, targetMonth));
  const newEnd = civilToUtc(
    { year: targetYear, month: targetMonth, day, hour: end.hour, minute: end.minute, second: end.second, ms: end.ms },
    tz,
  );
  return { start: period.end, end: newEnd };
}

/**
 * EC:G1/G3 — the period containing `now`, walked forward from `anchorStart` (the subscription's
 * original period-start instant) one interval at a time.
 */
export function periodContaining(
  anchorStart: Date,
  interval: 'month' | 'year',
  now: Date,
  anchorDay: number,
  tz: string,
  monthEndAnchor: MonthEndAnchor,
): Period {
  let period: Period = nextPeriod({ start: anchorStart, end: anchorStart }, interval, anchorDay, tz, monthEndAnchor);
  const MAX_STEPS = 100_000;
  let steps = 0;
  while (period.end.getTime() <= now.getTime()) {
    period = nextPeriod(period, interval, anchorDay, tz, monthEndAnchor);
    steps += 1;
    if (steps > MAX_STEPS) throw new Error('periodContaining: exceeded max steps; check anchorStart/now');
  }
  return period;
}

/** EC:G2 — fraction of `period` remaining at `now`, clamped to [0, 1]. */
export function prorationRatio(period: Period, now: Date, denominator: ProrationDenominator): number {
  const totalDays = denominator === 'fixed_30' ? 30 : daysInPeriod(period);
  if (totalDays <= 0) return 0;
  const remainingDays = (period.end.getTime() - now.getTime()) / DAY_MS;
  return Math.min(1, Math.max(0, remainingDays / totalDays));
}

/**
 * EC:J7 — the same remaining fraction as prorationRatio, as exact integers (milliseconds), for
 * money math via scaleMinor: `num / den` with 0 <= num <= den.
 */
export function prorationFraction(period: Period, now: Date, denominator: ProrationDenominator): { num: number; den: number } {
  const totalDays = denominator === 'fixed_30' ? 30 : daysInPeriod(period);
  if (totalDays <= 0) return { num: 0, den: 1 };
  const den = Math.round(totalDays * DAY_MS);
  const num = Math.min(den, Math.max(0, period.end.getTime() - now.getTime()));
  return { num, den };
}

/** EC:G2 — fraction of `period` elapsed at `now`, clamped to [0, 1]. */
export function elapsedRatio(period: Period, now: Date, denominator: ProrationDenominator): number {
  return 1 - prorationRatio(period, now, denominator);
}
