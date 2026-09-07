import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import { AdminsService } from './admins.service';
import { CreateAdminDto } from './admins.dto';

@ApiTags('admin/admins')
@Controller('admin/admins')
@Auth('admin', ['super_admin'])
export class AdminsController {
  constructor(private readonly admins: AdminsService) {}

  @Post()
  create(@Body() dto: CreateAdminDto, @CurrentUser() user: AuthenticatedUser) {
    return this.admins.create(dto, user.sub);
  }

  @Get()
  list() {
    return this.admins.list();
  }

  @Post(':id/reset-2fa')
  reset2fa(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.admins.reset2fa(id, user.sub);
  }
}
