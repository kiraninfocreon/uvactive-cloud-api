import { Module } from '@nestjs/common';
import { TrainersService } from './trainers.service';
import { BranchTrainersController, AdminTrainersController, TrainerSelfController } from './trainers.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SessionsModule } from '../sessions/sessions.module';

@Module({
  imports: [AuditLogModule, NotificationsModule, SessionsModule],
  providers: [TrainersService],
  controllers: [BranchTrainersController, AdminTrainersController, TrainerSelfController],
  exports: [TrainersService],
})
export class TrainersModule {}
