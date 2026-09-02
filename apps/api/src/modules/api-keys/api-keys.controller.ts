import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiKeysService } from './api-keys.service';
import { CurrentUser, Permissions, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class CreateApiKeyDto {
  @IsString() name!: string;
  @IsOptional() @IsArray() @IsString({ each: true }) scopes?: string[];
  @IsOptional() @IsInt() @Min(1) @Max(365) expiresInDays?: number;
}

@ApiTags('api-keys')
@Controller('api-keys')
@TenantRequired()
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  @Permissions('apikeys.manage')
  @ApiOperation({ summary: 'Create an API key (plaintext returned once)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateApiKeyDto) {
    return this.apiKeys.create(user, dto);
  }

  @Get()
  @Permissions('apikeys.manage')
  @ApiOperation({ summary: 'List active API keys' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.apiKeys.list(user);
  }

  @Delete(':id')
  @Permissions('apikeys.manage')
  @ApiOperation({ summary: 'Revoke an API key' })
  revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.apiKeys.revoke(user, id);
  }
}