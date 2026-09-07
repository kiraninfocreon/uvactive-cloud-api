import { Body, Controller, Get, Patch } from '@nestjs/common';
import { IsString } from 'class-validator';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import { GymsService } from './gyms.service';
import { TrainersService } from '../trainers/trainers.service';
import { UpdateGymProfileDto } from './gyms.dto';

class UpdateManagerNameDto {
  @IsString() name!: string;
}

// ── Branch Portal — a staff member's own gym only, never cross-branch ──
@ApiTags('branch/gym')
@Controller('branch')
@Auth('staff', ['branch_manager', 'trainer'])
export class BranchGymController {
  constructor(
    private readonly gyms: GymsService,
    private readonly trainers: TrainersService,
  ) {}

  @Get('gym')
  getProfile(@CurrentUser() user: AuthenticatedUser) {
    return this.gyms.getOwnProfile(user.gymId!);
  }

  // Deliberately branch_manager-only — a trainer can view branch
  // settings (e.g. to see the address) but not change them.
  @Auth('staff', ['branch_manager'])
  @Patch('gym')
  updateProfile(@Body() dto: UpdateGymProfileDto, @CurrentUser() user: AuthenticatedUser) {
    return this.gyms.updateOwnProfile(user.gymId!, dto);
  }

  // Their own name only — email and phone stay admin-only, see
  // TrainersService.updateManagerName.
  @Auth('staff', ['branch_manager'])
  @Patch('gym/manager-name')
  updateManagerName(@Body() dto: UpdateManagerNameDto, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.updateManagerName(user.gymId!, user.sub, dto.name);
  }

  @Get('dashboard')
  dashboard(@CurrentUser() user: AuthenticatedUser) {
    return this.gyms.getDashboard(user.gymId!);
  }
}
