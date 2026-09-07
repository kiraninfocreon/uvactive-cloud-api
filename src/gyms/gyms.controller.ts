import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import { GymsService } from './gyms.service';
import { CreateGymDto, ResetGymManagerPasswordDto, UpdateGymDto, UpdateGymManagerDto } from './gyms.dto';

@ApiTags('admin/gyms')
@Controller('admin/gyms')
@Auth('admin')
export class GymsController {
  constructor(private readonly gyms: GymsService) {}

  @Post()
  create(@Body() dto: CreateGymDto, @CurrentUser() user: AuthenticatedUser) {
    return this.gyms.create(dto, user.sub);
  }

  @Get()
  list() {
    return this.gyms.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.gyms.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateGymDto, @CurrentUser() user: AuthenticatedUser) {
    return this.gyms.update(id, dto, user.sub);
  }

  @Get(':id/manager')
  getManager(@Param('id') id: string) {
    return this.gyms.getManager(id);
  }

  // Admin-only edit of the manager's own name/email/phone — the
  // Branch Portal Settings screen can't touch these. Distinct from
  // reset-password below (credentials only) and from update() above
  // (the gym row, not the manager's staff account).
  @Patch(':id/manager')
  updateManager(@Param('id') id: string, @Body() dto: UpdateGymManagerDto, @CurrentUser() user: AuthenticatedUser) {
    return this.gyms.updateManager(id, dto, user.sub);
  }

  @Post(':id/manager/reset-password')
  resetManagerPassword(@Param('id') id: string, @Body() dto: ResetGymManagerPasswordDto, @CurrentUser() user: AuthenticatedUser) {
    return this.gyms.resetManagerPassword(id, dto, user.sub);
  }

  @Post(':id/suspend')
  suspend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.gyms.suspend(id, user.sub);
  }

  @Post(':id/activate')
  activate(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.gyms.activate(id, user.sub);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.gyms.remove(id, user.sub);
  }
}
