import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth } from '../common/decorators/auth.decorator';
import { AuditLogService } from './audit-log.service';

@ApiTags('admin/audit-log')
@Controller('admin/audit-log')
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  // Full audit detail (who, what, IP, when) is sensitive enough that it's
  // deliberately restricted to super_admin, not every admin — a support
  // admin has no business browsing IP addresses and override history.
  @Auth('admin', ['super_admin'])
  @Get()
  list(
    @Query('targetType') targetType?: string,
    @Query('actorId') actorId?: string,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    return this.auditLog.list({
      targetType,
      actorId,
      take: take ? parseInt(take, 10) : undefined,
      skip: skip ? parseInt(skip, 10) : undefined,
    });
  }
}
