/**
 * Heart-rate zone helpers shared by the session tick endpoints and the
 * member profile — mirrors the Trainer App's formula engine
 * (uvactive-trainer-app/src/lib/formula-engine/zones.ts) so the zone
 * colors on web graphs match what the trainer saw live.
 */

/** Default 5-zone table, PDF Module 01 (upper %MHR bound per zone). */
export const ZONE_CEILINGS: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 60, 2: 70, 3: 80, 4: 90, 5: 100 };

/**
 * MHR estimate used when the member has no stored/adaptive MHR — same
 * rule as the Trainer App's createAccumulator().
 */
export function estimateMhr(ageYears: number | null | undefined, sex: string | null | undefined): number {
  if (ageYears != null && ageYears > 0) {
    return ageYears > 40 || sex === 'female' ? 208 - 0.7 * ageYears : 220 - ageYears;
  }
  // No age on file — fall back to a neutral adult estimate.
  return 185;
}

/** %MHR for one reading. */
export function computePctMhr(bpm: number, mhr: number): number {
  if (mhr <= 0) return 0;
  return (bpm / mhr) * 100;
}

/**
 * Zone for one reading: <50% = 0 (standby / not warmed up), then
 * <=60/70/80/90 → zones 1-4, above → zone 5.
 */
export function computeZone(pctMhr: number): number {
  if (pctMhr < 50) return 0;
  if (pctMhr <= ZONE_CEILINGS[1]) return 1;
  if (pctMhr <= ZONE_CEILINGS[2]) return 2;
  if (pctMhr <= ZONE_CEILINGS[3]) return 3;
  if (pctMhr <= ZONE_CEILINGS[4]) return 4;
  return 5;
}

/** One-call helper: zone + %MHR for a bpm reading given a member's bio. */
export function zoneForBpm(bpm: number, ageYears: number | null | undefined, sex: string | null | undefined): { zone: number; pctMhr: number } {
  const mhr = estimateMhr(ageYears, sex);
  const pctMhr = computePctMhr(bpm, mhr);
  return { zone: computeZone(pctMhr), pctMhr };
}

/**
 * Server-side mirror of the Trainer App's formula engine
 * (uvactive-trainer-app/src/lib/formula-engine/*.ts) — used ONLY to
 * recompute a session-member's rich post-workout fields from the raw
 * SensorReading log already stored in Postgres, for sessions that were
 * synced with those fields null/zero (old client build, a crash before
 * finalizeSummary ran, etc.) or that need a fresh recompute after a
 * formula fix. Every helper here must stay numerically identical to
 * its Trainer App counterpart or recalculated figures will silently
 * drift from freshly-ended sessions.
 */

/** Standard Sweat Points, intensity-weighted per second — PDF page 3-4. Mirrors formula-engine/points.ts:computeSweatPointsTick. */
export function sweatPointsTick(pctMhr: number, zone: number): number {
  if (zone <= 0) return 0;
  const zoneCeiling = ZONE_CEILINGS[zone as 1 | 2 | 3 | 4 | 5];
  const intensityFactor = pctMhr / zoneCeiling;
  return (zone * intensityFactor) / 60;
}

/** EPOC (afterburn) estimate — mirrors formula-engine/epoc.ts:computeEpoc. */
export function computeEpocKcal(zone4Minutes: number, zone5Minutes: number, weightKg: number): { epocCalories: number; epocHours: number } {
  const minutesAbove80 = zone4Minutes + zone5Minutes;
  const epocCalories = minutesAbove80 * 0.15 * (weightKg / 70);
  const epocHours = minutesAbove80 / 10;
  return { epocCalories, epocHours };
}

/** Keytel gross calorie burn — mirrors formula-engine/calories.ts:computeGrossCalories. */
export function grossCaloriesKeytel(avgHr: number, weightKg: number, age: number, sex: string | null | undefined, durationHours: number): number {
  if (sex === 'male') {
    return ((-55.0969 + 0.6309 * avgHr + 0.1988 * weightKg + 0.2017 * age) / 4.184) * 60 * durationHours;
  }
  return ((-20.4022 + 0.4472 * avgHr + 0.1263 * weightKg + 0.074 * age) / 4.184) * 60 * durationHours;
}

/** Harris-Benedict BMR — mirrors formula-engine/calories.ts:computeBmr. */
export function harrisBenedictBmr(weightKg: number, heightCm: number, age: number, sex: string | null | undefined): number {
  if (sex === 'male') {
    return 88.362 + 13.397 * weightKg + 4.799 * heightCm - 5.677 * age;
  }
  return 447.593 + 9.247 * weightKg + 3.098 * heightCm - 4.33 * age;
}

/** Recovery Points grading — mirrors formula-engine/recovery.ts:gradeRecoveryPoints. */
export function gradeRecoveryPoints(bpmDropIn60s: number): string {
  if (bpmDropIn60s >= 55) return 'Elite';
  if (bpmDropIn60s >= 40) return 'Excellent';
  if (bpmDropIn60s >= 30) return 'Good';
  if (bpmDropIn60s >= 20) return 'Average';
  if (bpmDropIn60s >= 12) return 'Building';
  return 'Needs work';
}
