import { Module } from '@nestjs/common';
import { PgThrottlerStorage } from './pg-throttler-storage';

// Split into its own module purely so PgThrottlerStorage can be
// injected into ThrottlerModule.forRootAsync's useFactory — a module's
// own `providers` aren't visible to factories inside its own `imports`
// array, so this needs to be a separate, importable module. PrismaModule
// is @Global() so it doesn't need to be imported here explicitly.
@Module({
  providers: [PgThrottlerStorage],
  exports: [PgThrottlerStorage],
})
export class PgThrottlerStorageModule {}
