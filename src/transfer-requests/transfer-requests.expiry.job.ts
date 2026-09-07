import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TransferRequestsService } from './transfer-requests.service';

@Injectable()
export class TransferRequestsExpiryJob {
  private readonly logger = new Logger(TransferRequestsExpiryJob.name);

  constructor(private readonly transferRequests: TransferRequestsService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handle() {
    const n = await this.transferRequests.expireStaleRequests();
    if (n > 0) this.logger.log(`Expired ${n} stale transfer request(s).`);
  }
}
