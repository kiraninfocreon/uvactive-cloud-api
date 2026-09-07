import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import { TrainersService } from './trainers.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateTrainerDto, UpdateTrainerDto } from './trainers.dto';

class UpdateSelfDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() phone?: string;
}

class SetPushTokenDto {
  @IsOptional() @IsString() token!: string | null;
}

// ── Self-service — a trainer OR a branch manager editing THEIR OWN
// name/phone. Distinct from BranchTrainersController.update() below,
// which is branch_manager-only and manages OTHER trainers (and
// deliberately can't touch a branch_manager row at all — see
// TrainersService.update). A plain 'trainer' has no access to that
// controller whatsoever, so without this, a trainer had no way to
// edit their own profile at all.
@ApiTags('trainer/me')
@Controller('trainer/me')
@Auth('staff', ['trainer', 'branch_manager'])
export class TrainerSelfController {
  constructor(
    private readonly trainers: TrainersService,
    private readonly notifications: NotificationsService,
  ) {}

  @Patch()
  updateSelf(@Body() dto: UpdateSelfDto, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.updateSelf(user.sub, dto);
  }

  // Same purpose as the Member App's — registered right after login so
  // notify() can reach this trainer's phone with a real system push.
  @Post('push-token')
  setPushToken(@Body() dto: SetPushTokenDto, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.setPushToken('trainer', user.sub, dto.token);
  }
}

@ApiTags('branch/trainers')
@Controller('branch/trainers')
@Auth('staff', ['branch_manager'])
export class BranchTrainersController {
  constructor(private readonly trainers: TrainersService) {}

  @Post()
  create(@Body() dto: CreateTrainerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.create(user.gymId!, dto, user.sub);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.trainers.listForGym(user.gymId!);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTrainerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.update(id, user.gymId!, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.remove(id, user.gymId!, 'staff', user.sub);
  }

  // Reset a trainer's login password — new temporary password delivered
  // by email exactly once, all existing sessions revoked. Scoped to the
  // branch manager's own gym.
  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.resetPassword(id, user.gymId!, 'staff', user.sub);
  }

  @Post(':id/suspend')
  suspend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.setStatus(id, 'suspended', 'staff', user.sub, user.gymId);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.setStatus(id, 'active', 'staff', user.sub, user.gymId);
  }
}

@ApiTags('admin/trainers')
@Controller('admin/trainers')
@Auth('admin')
export class AdminTrainersController {
  constructor(private readonly trainers: TrainersService) {}

  @Get()
  listAll() {
    return this.trainers.listAll(true);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.trainers.get(id);
  }

  @Post(':id/suspend')
  suspend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.setStatus(id, 'suspended', 'admin', user.sub);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.setStatus(id, 'active', 'admin', user.sub);
  }

  // Admin-triggered password reset for any trainer, cross-branch — same
  // temporary-password-by-email + revoke-all-sessions handling as the
  // branch-level reset above (see TrainersService.resetPassword).
  @Post(':id/reset-password')
  resetPassword(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.resetPassword(id, undefined, 'admin', user.sub);
  }

  // Admin soft-delete of a trainer — same guards as the branch-level
  // delete (blocked while upcoming sessions exist, soft-delete only),
  // but cross-branch and audit-logged as an admin override.
  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.trainers.remove(id, undefined, 'admin', user.sub);
  }
}
