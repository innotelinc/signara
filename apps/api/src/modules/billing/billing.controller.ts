import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PlanCode } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { BillingService } from './billing.service';
import { CurrentUser, Permissions, TenantRequired } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

class CreateSubscriptionDto {
  @IsEnum(PlanCode) plan!: PlanCode;
  @IsOptional() @IsInt() @Min(1) seats?: number;
  @IsOptional() @IsString() couponCode?: string;
  @IsOptional() @IsEnum(['monthly', 'yearly']) period?: 'monthly' | 'yearly';
}

@ApiTags('billing')
@Controller('billing')
@TenantRequired()
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @Permissions('billing.read')
  @ApiOperation({ summary: 'Get the billing account with subscriptions' })
  account(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.getAccount(user);
  }

  @Get('plans')
  @Permissions('billing.read')
  @ApiOperation({ summary: 'List the plan catalog' })
  plans() {
    return this.billing.listPlans();
  }

  @Post('subscriptions')
  @Permissions('billing.manage')
  @ApiOperation({ summary: 'Create a subscription for the organization' })
  subscribe(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateSubscriptionDto) {
    return this.billing.createSubscription(user, {
      plan: dto.plan,
      seats: dto.seats ?? 1,
      couponCode: dto.couponCode,
      period: dto.period,
    });
  }

  @Get('invoices')
  @Permissions('billing.read')
  @ApiOperation({ summary: 'List invoices' })
  invoices(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.listInvoices(user);
  }

  @Get('usage')
  @Permissions('billing.read')
  @ApiOperation({ summary: 'Current billing-period usage and limits' })
  usage(@CurrentUser() user: AuthenticatedUser) {
    return this.billing.usage(user);
  }
}