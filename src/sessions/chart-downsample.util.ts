// Turns a raw per-second sensor_readings log (potentially thousands of
// rows for a long session) into a small, storable, graph-ready series.
//
// Pure function, no I/O — SessionsService is the only caller, at
// session-end and during a manual recalculate.

export interface RawPoint {
  ts: Date;
  hr: number;
}

// Columnar, not [{t,hr}, ...]: same data, smaller JSON (keys aren't
// repeated per point) and compresses better over the wire.
export interface ChartSeries {
  t: number[]; // epoch ms, ascending
  hr: number[];
}

// A point is kept once EITHER of these is crossed since the last kept
// point — whichever happens first:
//  - MAX_GAP_MS: guarantees a minimum time resolution through flat,
//    resting stretches where BPM barely moves (nothing else would
//    otherwise trigger a keep for a long time).
//  - MIN_DELTA_BPM: guarantees a real spike or dip is never smoothed
//    away just because it happened to land between fixed sample
//    points — the failure mode of naive "every Nth row" decimation.
// Together they track the *shape* of the curve, spending points where
// the curve is actually changing and skipping where it isn't, rather
// than spending a fixed budget uniformly over time regardless of
// what's happening in the data.
// Defaults — overridable per-call via DownsampleOptions, which is how
// SessionsService threads through GRAPH_MAX_GAP_MS / GRAPH_MIN_DELTA_BPM /
// GRAPH_MAX_CHART_POINTS (see config/configuration.ts's graphEngine block)
// without this file itself doing any I/O or config lookups — it stays a
// pure function, callers own reading config.
const MAX_GAP_MS = 15_000;
const MIN_DELTA_BPM = 4;

// Hard ceiling on stored points, regardless of how jittery a session's
// data is. A pathological reading log (e.g. a flaky sensor bouncing
// several bpm every second for an hour) could otherwise make the
// adaptive rule above keep nearly every point. Ordinary sessions never
// get close to this — it exists purely as a backstop so one bad
// session can't blow up the stored JSON size.
const MAX_CHART_POINTS = 400;

/**
 * Primary downsampling method. Walks the sorted log once and keeps a
 * point whenever MAX_GAP_MS has elapsed or BPM has moved MIN_DELTA_BPM
 * since the last kept point. Always keeps the first and last point so
 * the series spans the full session.
 */
export interface DownsampleOptions {
  maxGapMs?: number;
  minDeltaBpm?: number;
  maxChartPoints?: number;
}

export function downsampleAdaptive(points: RawPoint[], opts: DownsampleOptions = {}): RawPoint[] {
  const n = points.length;
  if (n <= 2) return points;

  const maxGapMs = opts.maxGapMs ?? MAX_GAP_MS;
  const minDeltaBpm = opts.minDeltaBpm ?? MIN_DELTA_BPM;

  const kept: RawPoint[] = [points[0]];
  let last = points[0];
  for (let i = 1; i < n - 1; i++) {
    const p = points[i];
    const gapMs = p.ts.getTime() - last.ts.getTime();
    const deltaBpm = Math.abs(p.hr - last.hr);
    if (gapMs >= maxGapMs || deltaBpm >= minDeltaBpm) {
      kept.push(p);
      last = p;
    }
  }
  kept.push(points[n - 1]);
  return kept;
}

/**
 * Largest-Triangle-Three-Buckets (Sveinn Steinarsson, 2013,
 * "Downsampling Time Series for Visual Representation"). Used here
 * only as the safety-cap fallback below — picks, from each time
 * bucket, the point that forms the largest triangle with the already-
 * chosen previous point and the next bucket's average, preserving the
 * visual shape of the curve at a fixed point budget.
 */
export function downsampleLTTB(points: RawPoint[], threshold: number): RawPoint[] {
  const n = points.length;
  if (threshold >= n || threshold <= 2) return points;

  const sampled: RawPoint[] = [points[0]];
  // Bucket size for the middle points (first and last are kept as-is).
  const bucketSize = (n - 2) / (threshold - 2);

  let a = 0; // index of the previously-selected point
  for (let i = 0; i < threshold - 2; i++) {
    const rangeStart = Math.floor((i + 1) * bucketSize) + 1;
    const rangeEnd = Math.min(Math.floor((i + 2) * bucketSize) + 1, n);

    // Average point of the NEXT bucket, used as one triangle vertex.
    let avgX = 0;
    let avgY = 0;
    const nextStart = rangeEnd;
    const nextEnd = Math.min(Math.floor((i + 3) * bucketSize) + 1, n);
    const nextRangeLen = Math.max(1, nextEnd - nextStart);
    for (let j = nextStart; j < nextEnd; j++) {
      avgX += points[j].ts.getTime();
      avgY += points[j].hr;
    }
    avgX /= nextRangeLen;
    avgY /= nextRangeLen;
    // If the next bucket is empty (tail of the series), fall back to
    // the last point so the triangle-area math below still holds.
    if (nextEnd <= nextStart) {
      const last = points[n - 1];
      avgX = last.ts.getTime();
      avgY = last.hr;
    }

    const pointA = points[a];
    let maxArea = -1;
    let maxAreaIdx = rangeStart;
    for (let j = rangeStart; j < rangeEnd; j++) {
      const p = points[j];
      const area = Math.abs(
        (pointA.ts.getTime() - avgX) * (p.hr - pointA.hr) -
          (pointA.ts.getTime() - p.ts.getTime()) * (avgY - pointA.hr),
      );
      if (area > maxArea) {
        maxArea = area;
        maxAreaIdx = j;
      }
    }
    sampled.push(points[maxAreaIdx]);
    a = maxAreaIdx;
  }
  sampled.push(points[n - 1]);
  return sampled;
}

/**
 * Builds the compact, storable chart series from a raw reading log.
 * Returns null for an empty log (member never streamed readings) so
 * callers can distinguish "nothing to graph" from "not built yet".
 *
 * Adaptive sampling runs first (spends points where the curve is
 * actually moving); LTTB only steps in afterwards, and only if that
 * still left more than MAX_CHART_POINTS — a fixed-budget reduction of
 * the adaptive result, not of the raw log, so the worst case is still
 * bounded without giving up the adaptive shape-tracking for the
 * common case.
 */
export function buildChartSeries(readings: RawPoint[], opts: DownsampleOptions = {}): ChartSeries | null {
  if (readings.length === 0) return null;
  const maxChartPoints = opts.maxChartPoints ?? MAX_CHART_POINTS;
  const sorted = [...readings].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  let reduced = downsampleAdaptive(sorted, opts);
  if (reduced.length > maxChartPoints) {
    reduced = downsampleLTTB(reduced, maxChartPoints);
  }
  return {
    t: reduced.map((p) => p.ts.getTime()),
    hr: reduced.map((p) => p.hr),
  };
}
