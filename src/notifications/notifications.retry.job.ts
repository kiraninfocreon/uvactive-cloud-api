import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationsService } from './notifications.service';

@Injectable()
export class NotificationsRetryJob {
  private readonly logger = new Logger(NotificationsRetryJob.name);

  constructor(private readonly notifications: NotificationsService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handle() {
    const n = await this.notifications.retryPending();
    if (n > 0) this.logger.log(`Retried ${n} pending/failed notification(s).`);
  }
}
