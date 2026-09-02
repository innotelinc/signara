import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { AdminService } from './admin.service';
import { CurrentUser, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class OrgStatusDto {
  @IsEnum(['ACTIVE', 'SUSPENDED', 'CANCELED']) status!: 'ACTIVE' | 'SUSPENDED' | 'CANCELED';
}

class UserStatusDto {
  @IsEnum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']) status!: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
}

@ApiTags('admin')
@Controller('admin')
@TenantRequired()
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('organizations')
  @ApiOperation({ summary: 'List all organizations across tenants (platform admins)' })
  organizations(
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.admin.listOrganizations(user, {
      search,
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('users')
  @ApiOperation({ summary: 'List all users across tenants (platform admins)' })
  users(
    @CurrentUser() user: AuthenticatedUser,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.admin.listUsers(user, {
      search,
      status,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Patch('organizations/:id/status')
  @ApiOperation({ summary: 'Suspend/activate a tenant organization' })
  setOrgStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: OrgStatusDto) {
    return this.admin.setOrganizationStatus(user, id, dto.status);
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Suspend/activate a user account' })
  setUserStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() dto: UserStatusDto) {
    return this.admin.setUserStatus(user, id, dto.status);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Platform-wide counts (platform admins)' })
  metrics(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.metrics(user);
  }
}