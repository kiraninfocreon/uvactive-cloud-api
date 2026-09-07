import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, CurrentUser, AuthenticatedUser } from '../common/decorators/auth.decorator';
import { TransferRequestsService } from './transfer-requests.service';
import { CreateTransferRequestDto, AdminCreateTransferRequestDto } from './transfer-requests.dto';

@ApiTags('branch/transfer-requests')
@Controller('branch/transfer-requests')
@Auth('staff', ['branch_manager'])
export class BranchTransferRequestsController {
  constructor(private readonly transferRequests: TransferRequestsService) {}

  @Post()
  create(@Body() dto: CreateTransferRequestDto, @CurrentUser() user: AuthenticatedUser) {
    return this.transferRequests.createFromBranch(user.gymId!, dto.memberId, user.sub);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.transferRequests.listForGym(user.gymId!);
  }

  // Only for requestedByType='admin' rows — branch-initiated requests
  // (this branch's own outgoing invite) wait on the member instead.
  @Post(':id/accept')
  accept(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.transferRequests.acceptByBranch(id, user.gymId!, user.sub);
  }

  @Post(':id/decline')
  decline(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.transferRequests.declineByBranch(id, user.gymId!, user.sub);
  }
}

// The admin realm's only member-placement path exposed in the Admin
// Panel UI — sends a request the receiving branch has to accept or
// decline (see BranchTransferRequestsController.accept/decline above).
// MembersService.adminAssign still exists as a true bypass but is
// intentionally not wired to any admin-facing route here.
@ApiTags('admin/transfer-requests')
@Controller('admin/transfer-requests')
@Auth('admin')
export class AdminTransferRequestsController {
  constructor(private readonly transferRequests: TransferRequestsService) {}

  @Post()
  create(@Body() dto: AdminCreateTransferRequestDto, @CurrentUser() user: AuthenticatedUser) {
    return this.transferRequests.createFromAdmin(dto.toGymId, dto.memberId, user.sub);
  }
}

@ApiTags('member/transfer-requests')
@Controller('member/transfer-requests')
@Auth('member')
export class MemberTransferRequestsController {
  constructor(private readonly transferRequests: TransferRequestsService) {}

  @Get()
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.transferRequests.listPendingForMember(user.sub);
  }

  @Post(':id/accept')
  accept(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.transferRequests.accept(id, user.sub);
  }

  @Post(':id/decline')
  decline(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.transferRequests.decline(id, user.sub);
  }
}
