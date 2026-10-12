import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { AdminService } from './admin.service';
import { CurrentUser } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class OrgStatusDto {
  @IsEnum(['ACTIVE', 'SUSPENDED', 'CANCELED']) status!: 'ACTIVE' | 'SUSPENDED' | 'CANCELED';
}

class UserStatusDto {
  @IsEnum(['ACTIVE', 'SUSPENDED', 'DEACTIVATED']) status!: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
}

class ReindexSearchDto {
  /** Restrict the rebuild to one tenant; omitted means every tenant. */
  @IsOptional() @IsString() organizationId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) batchSize?: number;
}

@ApiTags('admin')
@Controller('admin')
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
  setOrgStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: OrgStatusDto,
  ) {
    return this.admin.setOrganizationStatus(user, id, dto.status);
  }

  @Patch('users/:id/status')
  @ApiOperation({ summary: 'Suspend/activate a user account' })
  setUserStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UserStatusDto,
  ) {
    return this.admin.setUserStatus(user, id, dto.status);
  }

  @Get('metrics')
  @ApiOperation({ summary: 'Platform-wide counts (platform admins)' })
  metrics(@CurrentUser() user: AuthenticatedUser) {
    return this.admin.metrics(user);
  }

  @Post('search/reindex')
  @ApiOperation({ summary: 'Rebuild the document search index from the database (platform admins)' })
  reindexSearch(@CurrentUser() user: AuthenticatedUser, @Body() dto: ReindexSearchDto) {
    return this.admin.reindexSearch(user, {
      organizationId: dto.organizationId,
      batchSize: dto.batchSize,
    });
  }
}
