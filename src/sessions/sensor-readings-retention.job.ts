import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SessionsService } from './sessions.service';

/**
 * The other half of the sensor_readings storage fix (see the comment
 * on the SensorReading model in schema.prisma and rebuildChartSeries
 * in sessions.service.ts): building chartSeries makes graph *reads*
 * cheap, but the raw per-second rows still accumulate — at 10
 * sessions/day x 10 members x ~45min sessions that's on the order of
 * 250-300k rows/day, which is the actual "cloud storage fills fast"
 * problem. This job is what stops that table growing forever, by
 * deleting a session's raw readings once its chartSeries has had time
 * to prove itself durable (RAW_READING_RETENTION_DAYS).
 *
 * Runs once a day, not on every request — this is bulk cleanup, not a
 * user-facing path, so it doesn't need to be more frequent than that.
 */
@Injectable()
export class SensorReadingsRetentionJob {
  private readonly logger = new Logger(SensorReadingsRetentionJob.name);

  constructor(private readonly sessions: SessionsService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handle() {
    const n = await this.sessions.purgeStaleRawReadings();
    if (n > 0) this.logger.log(`Purged ${n} stale sensor_readings row(s) past the retention window.`);
  }
}
