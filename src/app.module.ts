import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import configuration from './config/configuration';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { PgThrottlerStorageModule } from './common/utils/pg-throttler-storage.module';
import { PgThrottlerStorage } from './common/utils/pg-throttler-storage';
import { AuditLogModule } from './audit-log/audit-log.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuthModule } from './auth/auth.module';
import { GymsModule } from './gyms/gyms.module';
import { MembersModule } from './members/members.module';
import { TrainersModule } from './trainers/trainers.module';
import { SessionsModule } from './sessions/sessions.module';
import { SensorsModule } from './sensors/sensors.module';
import { TransferRequestsModule } from './transfer-requests/transfer-requests.module';
import { AdminsModule } from './admins/admins.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(), // powers the notification-retry, transfer-expiry and rate-limit-sweep cron jobs
    // Baseline DDoS-shaped throttling on top of (not instead of) the
    // stricter per-realm login limiter in RateLimitService — this one
    // is a blunt global default, that one is the business-critical one.
    // Storage is PgThrottlerStorage (Postgres-backed, see that file) so
    // the limit holds correctly across every replica without Redis.
    PgThrottlerStorageModule,
    ThrottlerModule.forRootAsync({
      imports: [PgThrottlerStorageModule],
      inject: [PgThrottlerStorage],
      useFactory: (storage: PgThrottlerStorage) => ({
        throttlers: [{ ttl: 60_000, limit: 120 }],
        storage,
      }),
    }),

    PrismaModule,
    CommonModule,
    AuditLogModule,
    NotificationsModule,

    AuthModule,
    GymsModule,
    MembersModule,
    TrainersModule,
    SessionsModule,
    SensorsModule,
    TransferRequestsModule,
    AdminsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
