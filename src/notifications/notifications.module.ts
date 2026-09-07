import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsRetryJob } from './notifications.retry.job';
import { MemberNotificationsController, BranchNotificationsController, AdminNotificationsController } from './notifications.controller';

@Module({
  providers: [NotificationsService, NotificationsRetryJob],
  controllers: [MemberNotificationsController, BranchNotificationsController, AdminNotificationsController],
  exports: [NotificationsService],
})
export class NotificationsModule {}
