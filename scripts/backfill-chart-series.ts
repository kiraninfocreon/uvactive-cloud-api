/**
 * Backfills / rebuilds SessionMember.chartSeries for every member that
 * has a raw sensor_readings log, using the SAME buildChartSeries()
 * (adaptive downsample + LTTB safety cap) that sessions.service.ts uses
 * at session end and during recalculate.
 *
 * Why: sessions stored before the chartSeries feature shipped have a
 * NULL chart_series column (graphs fall back to live-downsampling the
 * raw log per view), and rows built by an earlier, pre-adaptive build
 * may carry every raw point. Running this once converts the whole
 * stored dataset to the compact adaptive series — same data, one small
 * JSONB per member instead of thousands of raw rows per graph view.
 *
 * Safety:
 *  - Idempotent — deterministic given the same readings; safe to re-run.
 *  - Only writes the chart_series column. sensor_readings (which feed
 *    recalcSessionMember's zone/sweat/EPOC/recovery math at full
 *    resolution) are untouched; nothing else is modified.
 *  - Dry-run by default; pass --apply to actually write.
 *
 * Usage:
 *   npx ts-node scripts/backfill-chart-series.ts            # dry run
 *   npx ts-node scripts/backfill-chart-series.ts --apply    # write
 */
import { buildChartSeries } from '../src/sessions/chart-downsample.util';

const APPLY = process.argv.includes('--apply');

async function main() {
  const { Client } = require('pg');
  require('dotenv').config();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (load .env)');

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const members = await client.query(
    `SELECT sm.id, sm.chart_series IS NOT NULL AS had_series,
            (SELECT count(*) FROM sensor_readings sr WHERE sr.session_member_id = sm.id) AS raw_count
       FROM session_members sm
      WHERE EXISTS (SELECT 1 FROM sensor_readings sr WHERE sr.session_member_id = sm.id)
      ORDER BY sm.id`,
  );

  let rebuilt = 0;
  let hadSeries = 0;
  let totalRaw = 0;
  let totalPts = 0;
  let failed = 0;

  for (const m of members.rows) {
    const readings = await client.query(
      `SELECT ts, hr FROM sensor_readings WHERE session_member_id = $1 ORDER BY ts ASC`,
      [m.id],
    );
    const series = buildChartSeries(readings.rows);
    if (!series) continue;

    const pts = series.t.length;
    const before = m.had_series ? 'series' : 'NULL  ';
    const beforePts = m.had_series
      ? await client
          .query(`SELECT jsonb_array_length(chart_series->'t') AS n FROM session_members WHERE id = $1`, [m.id])
          .then((r: { rows: { n: number }[] }) => r.rows[0].n)
      : '-';

    if (APPLY) {
      await client.query(`UPDATE session_members SET chart_series = $1::jsonb WHERE id = $2`, [
        JSON.stringify(series),
        m.id,
      ]);
    }
    rebuilt++;
    if (m.had_series) hadSeries++;
    totalRaw += Number(m.raw_count);
    totalPts += pts;
    console.log(
      `${APPLY ? '[WRITE]' : '[DRY ]'} ${m.id.slice(0, 8)}  raw=${String(m.raw_count).padStart(4)}  chart_series ${before} -> ${String(pts).padStart(3)} pts (was ${beforePts})`,
    );
  }

  await client.end();

  console.log('--------------------------------------------------');
  console.log(`mode        : ${APPLY ? 'APPLY (wrote chart_series)' : 'DRY RUN (no writes)'}`);
  console.log(`members     : ${rebuilt} rebuilt (${hadSeries} already had a series)`);
  console.log(`raw rows    : ${totalRaw} -> ${totalPts} stored points (${totalRaw > 0 ? Math.round((1 - totalPts / totalRaw) * 100) : 0}% reduction)`);
  if (failed) console.log(`failed      : ${failed}`);
  if (!APPLY) console.log('Re-run with --apply to write the series.');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('backfill failed:', err.message);
  process.exit(1);
});