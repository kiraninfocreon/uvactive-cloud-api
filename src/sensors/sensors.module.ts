import { Module } from '@nestjs/common';
import { SensorsService } from './sensors.service';
import { BranchSensorsController, AdminSensorsController, TrainerSensorsController } from './sensors.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [AuditLogModule],
  providers: [SensorsService],
  controllers: [BranchSensorsController, AdminSensorsController, TrainerSensorsController],
  exports: [SensorsService],
})
export class SensorsModule {}
