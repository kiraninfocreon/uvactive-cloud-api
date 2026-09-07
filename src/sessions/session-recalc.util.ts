import {
  estimateMhr, computePctMhr, computeZone, sweatPointsTick, computeEpocKcal,
  grossCaloriesKeytel, harrisBenedictBmr, gradeRecoveryPoints,
} from '../common/hr.util';

export interface RecalcReadingInput {
  ts: Date;
  hr: number;
}

export interface RecalcMemberBio {
  ageYears: number | null;
  sex: string | null;
  heightCm: number | null;
  weightKg: number | null;
}

export interface RecalcResult {
  avgHr: number | null;
  maxHr: number | null;
  calories: number | null;
  zoneMinutes: Record<string, number> | null;
  sweatPoints: number | null;
  recoveryPoints: number | null;
  recoveryGrade: string | null;
  epocCalories: number | null;
  epocHours: number | null;
  avgPctMhr: number | null;
  maxPctMhr: number | null;
  score: number | null;
  readingCount: number;
}

// A gap this large means the sensor was off/disconnected between ticks
// (trainer paused, member stepped away, sync jitter) — never credit
// zone-seconds across a gap that size.
//
// IMPORTANT: this used to be 5s, mirroring the Trainer App's live
// per-tick cadence back when every real BLE reading (~1/sec) got a
// `ticks`/`sensor_readings` row. As of the adaptive tick-storage filter
// (Trainer App's tickStorageFilter.ts), the Trainer App now only
// PERSISTS a reading when >=15s has passed since the last stored point
// OR bpm moved >=4bpm — so a completely ordinary, fully-connected,
// steady-state stretch can legitimately show up here as a ~15s gap
// between two stored readings. A 5s cap would silently undercount that
// member's zone-seconds/sweatPoints/calories by up to ~66% during any
// steady block, on every recompute. 16s (the filter's 15s cap + a
// second of slack for clock/network jitter) is the new ceiling: any
// GENUINE dropout is still bridged by sensorWatchdog.ts's ~1/sec
// interpolated fill ticks, which are exempt from the storage filter and
// always land at full density — so a stored gap actually exceeding this
// window still means "was truly disconnected", exactly as before.
const MAX_TICK_GAP_SECONDS = 16;

// Recovery-Points reconstruction: the Trainer App's dedicated recovery
// challenge (peak HR -> HR 60s later, standing still) requires a UI
// flow this dataset may never have gone through. Instead, reconstruct
// the same PDF-page-4 formula from whatever the session's natural peak
// and post-peak cool-down actually looked like: find the session's
// highest BPM tick, then the reading closest to 60s after it. Only
// fires when a real reading exists in that window — never invents one.
const RECOVERY_WINDOW_MIN_MS = 45_000;
const RECOVERY_WINDOW_MAX_MS = 90_000;
const RECOVERY_WINDOW_TARGET_MS = 60_000;

/**
 * Recomputes every rich post-workout field for one session-member from
 * their raw SensorReading log — used by the Recalculate feature
 * (Branch Portal / Admin Panel / Trainer App buttons) to backfill
 * sessions that synced with sweatPoints/recoveryPoints/epoc/maxPctMhr
 * null or zero, and to re-run the same math after a formula fix.
 * Pure function — the caller persists the result.
 */
export function recalcSessionMember(readings: RecalcReadingInput[], bio: RecalcMemberBio): RecalcResult {
  if (readings.length === 0) {
    return {
      avgHr: null, maxHr: null, calories: null, zoneMinutes: null, sweatPoints: null,
      recoveryPoints: null, recoveryGrade: null, epocCalories: null, epocHours: null,
      avgPctMhr: null, maxPctMhr: null, score: null, readingCount: 0,
    };
  }

  const sorted = [...readings].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  const mhr = estimateMhr(bio.ageYears, bio.sex);

  const zoneSeconds: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
  let sweatPoints = 0;
  let hrSum = 0;
  let maxHr = 0;
  let maxPctMhr = 0;
  let lastTs: number | null = null;

  for (const r of sorted) {
    const pctMhr = computePctMhr(r.hr, mhr);
    const zone = computeZone(pctMhr);

    const elapsed = lastTs === null ? 1 : Math.max(0, Math.min(MAX_TICK_GAP_SECONDS, Math.round((r.ts.getTime() - lastTs) / 1000)));
    lastTs = r.ts.getTime();

    if (zone > 0) zoneSeconds[zone] += elapsed;
    sweatPoints += sweatPointsTick(pctMhr, zone) * elapsed;

    hrSum += r.hr;
    if (r.hr > maxHr) maxHr = r.hr;
    if (pctMhr > maxPctMhr) maxPctMhr = pctMhr;
  }

  const avgHr = hrSum / sorted.length;
  const avgPctMhr = computePctMhr(avgHr, mhr);
  const zoneMinutes = { '1': zoneSeconds[1] / 60, '2': zoneSeconds[2] / 60, '3': zoneSeconds[3] / 60, '4': zoneSeconds[4] / 60, '5': zoneSeconds[5] / 60 };

  const weightKg = bio.weightKg ?? 70;
  const { epocCalories, epocHours } = computeEpocKcal(zoneMinutes['4'], zoneMinutes['5'], weightKg);

  // Calories need height + weight + age + sex on file — skip (null,
  // left untouched by the caller) rather than silently burning a
  // guessed BMI into a member's historical record.
  let calories: number | null = null;
  if (bio.heightCm != null && bio.weightKg != null && bio.ageYears != null) {
    const durationHours = (sorted[sorted.length - 1].ts.getTime() - sorted[0].ts.getTime()) / 3_600_000;
    const gross = grossCaloriesKeytel(avgHr, bio.weightKg, bio.ageYears, bio.sex, durationHours);
    const bmr = harrisBenedictBmr(bio.weightKg, bio.heightCm, bio.ageYears, bio.sex);
    const resting = (bmr / 24) * durationHours;
    calories = Math.max(0, Math.round(gross - resting));
  }

  // Peak-to-cooldown recovery reconstruction (see comment above).
  let recoveryPoints: number | null = null;
  let recoveryGrade: string | null = null;
  const peakIdx = sorted.reduce((best, r, i) => (r.hr > sorted[best].hr ? i : best), 0);
  const peakTs = sorted[peakIdx].ts.getTime();
  const peakHrValue = sorted[peakIdx].hr;
  let closest: { r: RecalcReadingInput; delta: number } | null = null;
  for (const r of sorted) {
    const dt = r.ts.getTime() - peakTs;
    if (dt < RECOVERY_WINDOW_MIN_MS || dt > RECOVERY_WINDOW_MAX_MS) continue;
    const delta = Math.abs(dt - RECOVERY_WINDOW_TARGET_MS);
    if (!closest || delta < closest.delta) closest = { r, delta };
  }
  if (closest) {
    const drop = peakHrValue - closest.r.hr;
    recoveryPoints = drop;
    recoveryGrade = gradeRecoveryPoints(drop);
  }

  const sweatPointsRounded = Math.round(sweatPoints * 10) / 10;
  const score = Math.round(sweatPointsRounded + (recoveryPoints ?? 0));

  return {
    avgHr: Math.round(avgHr),
    maxHr,
    calories,
    zoneMinutes,
    sweatPoints: sweatPointsRounded,
    recoveryPoints,
    recoveryGrade,
    epocCalories: Math.round(epocCalories),
    epocHours: Math.round(epocHours * 10) / 10,
    avgPctMhr: Math.round(avgPctMhr * 10) / 10,
    maxPctMhr: Math.round(maxPctMhr * 10) / 10,
    score,
    readingCount: sorted.length,
  };
}
