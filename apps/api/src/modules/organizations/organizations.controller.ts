import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { WorkspaceVisibility } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { OrganizationsService } from './organizations.service';
import { CurrentUser, Permissions, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class UpdateOrganizationDto {
  @IsOptional() @IsString() name?: string;
  @IsOptional() @IsString() legalName?: string;
  @IsOptional() @IsString() taxId?: string;
  @IsOptional() branding?: Record<string, unknown>;
}

class CreateWorkspaceDto {
  @IsString() name!: string;
  @IsOptional() @IsString() slug?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsEnum(WorkspaceVisibility) visibility?: WorkspaceVisibility;
}

class CreateTeamDto {
  @IsString() name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() workspaceId?: string;
  @IsOptional() memberIds?: string[];
}

@ApiTags('organizations')
@Controller('organizations')
@TenantRequired()
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get('current')
  @Permissions('organizations.read')
  @ApiOperation({ summary: 'Get the active organization profile' })
  current(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.getCurrent(user);
  }

  @Patch('current')
  @Permissions('organizations.update')
  @ApiOperation({ summary: 'Update the organization profile and branding' })
  updateCurrent(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.updateCurrent(user, dto);
  }

  @Get('current/workspaces')
  @Permissions('organizations.read')
  @ApiOperation({ summary: 'List workspaces' })
  workspaces(@CurrentUser() user: AuthenticatedUser) {
    return this.organizations.listWorkspaces(user);
  }

  @Post('current/workspaces')
  @Permissions('workspaces.manage')
  @ApiOperation({ summary: 'Create a workspace' })
  createWorkspace(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWorkspaceDto) {
    return this.organizations.createWorkspace(user, dto);
  }

  @Get('current/teams')
  @Permissions('organizations.read')
  @ApiOperation({ summary: 'List teams (optionally filtered by workspace)' })
  teams(@CurrentUser() user: AuthenticatedUser, @Query('workspaceId') workspaceId?: string) {
    return this.organizations.listTeams(user, workspaceId);
  }

  @Post('current/teams')
  @Permissions('teams.manage')
  @ApiOperation({ summary: 'Create a team' })
  createTeam(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateTeamDto) {
    return this.organizations.createTeam(user, dto);
  }
}