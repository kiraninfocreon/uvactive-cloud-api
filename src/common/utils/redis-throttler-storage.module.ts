import { Module } from '@nestjs/common';
import { RedisThrottlerStorage } from './redis-throttler-storage';

// Split into its own module purely so RedisThrottlerStorage (which needs
// ConfigService, itself global via ConfigModule.forRoot({isGlobal:true}))
// can be injected into ThrottlerModule.forRootAsync's useFactory — a
// module's own `providers` aren't visible to factories inside its own
// `imports` array, so this needs to be a separate, importable module.
@Module({
  providers: [RedisThrottlerStorage],
  exports: [RedisThrottlerStorage],
})
export class RedisThrottlerStorageModule {}
