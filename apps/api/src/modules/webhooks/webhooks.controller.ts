import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, IsUrl } from 'class-validator';
import { WebhooksService } from './webhooks.service';
import { CurrentUser, Permissions, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class CreateWebhookDto {
  @IsUrl({ require_protocol: true })
  url!: string;

  /** Event names from `GET /webhooks/events`; omit for every event. */
  @IsOptional() @IsArray() @IsString({ each: true }) events?: string[];

  @IsOptional() @IsString() description?: string;
}

@ApiTags('webhooks')
@Controller('webhooks')
@TenantRequired()
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Post()
  @Permissions('webhooks.manage')
  @ApiOperation({ summary: 'Register a webhook endpoint (signing secret returned once)' })
  create(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateWebhookDto) {
    return this.webhooks.create(user, dto);
  }

  @Get()
  @Permissions('webhooks.manage')
  @ApiOperation({ summary: 'List webhook endpoints' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.webhooks.list(user);
  }

  @Get('deliveries')
  @Permissions('webhooks.manage')
  @ApiOperation({ summary: 'Recent delivery attempts (optionally for one endpoint)' })
  deliveries(@CurrentUser() user: AuthenticatedUser, @Query('endpointId') endpointId?: string) {
    return this.webhooks.listDeliveries(user, endpointId);
  }

  @Post(':id/ping')
  @Permissions('webhooks.manage')
  @ApiOperation({ summary: 'Send a signed ping to one endpoint' })
  ping(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.webhooks.ping(user, id);
  }

  @Delete(':id')
  @Permissions('webhooks.manage')
  @ApiOperation({ summary: 'Remove a webhook endpoint and its delivery history' })
  remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.webhooks.remove(user, id);
  }
}
