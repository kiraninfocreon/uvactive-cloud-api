import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SessionsService } from './sessions.service';

/**
 * Fallback path, not the primary one (spec §8, step 4): a session
 * flagged needs_reassignment that nobody reassigned before its own
 * start time gets auto-cancelled and every enrolled member notified.
 * The primary path is a human at the Branch Portal reassigning or
 * cancelling explicitly — this job only catches what falls through.
 */
@Injectable()
export class SessionsReassignmentJob {
  private readonly logger = new Logger(SessionsReassignmentJob.name);

  constructor(private readonly sessions: SessionsService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handle() {
    const n = await this.sessions.autoCancelOverdueFlagged();
    if (n > 0) this.logger.log(`Auto-cancelled ${n} overdue unreassigned session(s).`);
  }
}
