import { Module } from '@nestjs/common';
import { GymsService } from './gyms.service';
import { GymsController } from './gyms.controller';
import { BranchGymController } from './branch-gym.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { TrainersModule } from '../trainers/trainers.module';

@Module({
  imports: [AuditLogModule, NotificationsModule, TrainersModule],
  providers: [GymsService],
  controllers: [GymsController, BranchGymController],
  exports: [GymsService],
})
export class GymsModule {}
