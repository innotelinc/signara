import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MembershipRole } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, IsArray } from 'class-validator';
import { UsersService } from './users.service';
import { CurrentUser, Permissions, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class UpdateProfileDto {
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() locale?: string;
}

class InviteMemberDto {
  @IsEmail() email!: string;
  @IsEnum(MembershipRole) role!: MembershipRole;
  @IsOptional() @IsArray() @IsString({ each: true }) workspaceIds?: string[];
}

class MemberQueryDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(MembershipRole) role?: MembershipRole;
  @IsOptional() limit?: number;
  @IsOptional() offset?: number;
}

@ApiTags('users')
@Controller('users')
@TenantRequired()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the current user profile' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return { id: user.id, email: user.email, displayName: user.displayName, platformRole: user.platformRole, org: user.org };
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the current user profile' })
  updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.users.updateProfile(user, dto);
  }

  @Get()
  @Permissions('members.invite', 'organizations.read')
  @ApiOperation({ summary: 'List organization members' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: MemberQueryDto) {
    return this.users.listMembers(user, query);
  }

  @Post('invite')
  @Permissions('members.invite')
  @ApiOperation({ summary: 'Invite a member to the organization' })
  invite(@CurrentUser() user: AuthenticatedUser, @Body() dto: InviteMemberDto) {
    return this.users.inviteMember(user, dto);
  }

  @Patch(':id/role')
  @Permissions('members.manage')
  @ApiOperation({ summary: "Update a member's role" })
  updateRole(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body('role') role: MembershipRole) {
    return this.users.updateMemberRole(user, id, role);
  }

  @Delete(':id')
  @Permissions('members.manage')
  @ApiOperation({ summary: 'Remove a member from the organization' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.users.removeMember(user, id);
  }
}