import { Global, Module } from '@nestjs/common';
import { TokenService } from './utils/token.service';
import { RateLimitService } from './utils/rate-limit.service';
import { RateLimitSweepJob } from './utils/rate-limit-sweep.job';

// Global so AuthGuard / GymActiveGuard (used via @Auth() in every
// feature module) can resolve TokenService without every module having
// to import CommonModule explicitly.
@Global()
@Module({
  providers: [TokenService, RateLimitService, RateLimitSweepJob],
  exports: [TokenService, RateLimitService],
})
export class CommonModule {}
