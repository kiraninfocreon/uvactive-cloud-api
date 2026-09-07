import { Module } from '@nestjs/common';
import { MembersService } from './members.service';
import { BranchMembersController, AdminMembersController, MemberSelfController } from './members.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { AdminsModule } from '../admins/admins.module';

@Module({
  imports: [AuditLogModule, NotificationsModule, AdminsModule],
  providers: [MembersService],
  controllers: [BranchMembersController, AdminMembersController, MemberSelfController],
  exports: [MembersService],
})
export class MembersModule {}
