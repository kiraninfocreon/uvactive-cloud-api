import { Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import { NotificationsService } from './notifications.service';

@ApiTags('member/notifications')
@Controller('member/notifications')
@Auth('member')
export class MemberNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('unread') unread?: string) {
    return this.notifications.listForRecipient('member', user.sub, unread === 'true');
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(id, 'member', user.sub);
  }
}

@ApiTags('branch/notifications')
@Controller('branch/notifications')
@Auth('staff', ['branch_manager', 'trainer'])
export class BranchNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // Branch-level alerts (e.g. reassignment_needed) are addressed to the
  // gym itself, not an individual staff login — every staff member at
  // the branch sees the same dashboard feed.
  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('unread') unread?: string) {
    return this.notifications.listForRecipient('branch', user.gymId!, unread === 'true');
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(id, 'branch', user.gymId!);
  }
}

@ApiTags('admin/notifications')
@Controller('admin/notifications')
@Auth('admin')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query('unread') unread?: string) {
    return this.notifications.listForRecipient('admin', user.sub, unread === 'true');
  }

  @Get('stats')
  stats() {
    return this.notifications.getEmailStats();
  }

  @Post(':id/read')
  markRead(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(id, 'admin', user.sub);
  }
}
