import { Controller, Get, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Deliberately NOT wrapped in the standard success envelope (see
  // ResponseEnvelopeInterceptor) and returns 503 on failure, not 200 —
  // this is what the load balancer's health check and uptime monitor
  // are wired to (spec §14). Postgres is the only external dependency
  // left to check now that rate limiting rides on the same database
  // instead of a separate Redis instance.
  @Get()
  async check(@Res() res: Response) {
    const db = await this.checkDb();
    const ok = db === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'fail', db, time: new Date().toISOString() });
  }

  private async checkDb(): Promise<'ok' | 'fail'> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'ok';
    } catch {
      return 'fail';
    }
  }
}
