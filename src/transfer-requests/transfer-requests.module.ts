import { Module } from '@nestjs/common';
import { TransferRequestsService } from './transfer-requests.service';
import { TransferRequestsExpiryJob } from './transfer-requests.expiry.job';
import { BranchTransferRequestsController, AdminTransferRequestsController, MemberTransferRequestsController } from './transfer-requests.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { MembersModule } from '../members/members.module';

@Module({
  imports: [AuditLogModule, NotificationsModule, MembersModule],
  providers: [TransferRequestsService, TransferRequestsExpiryJob],
  controllers: [BranchTransferRequestsController, AdminTransferRequestsController, MemberTransferRequestsController],
  exports: [TransferRequestsService],
})
export class TransferRequestsModule {}
