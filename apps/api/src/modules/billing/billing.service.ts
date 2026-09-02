import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PlanCode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../common/types';

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  async getAccount(user: AuthenticatedUser) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');

    const account = await this.prisma.billingAccount.findUnique({
      where: { organizationId: orgId },
      include: { subscriptions: { orderBy: { createdAt: 'desc' } } },
    });
    if (!account) {
      return this.prisma.billingAccount.create({
        data: { organizationId: orgId, plan: PlanCode.COMMUNITY },
        include: { subscriptions: true },
      });
    }
    return account;
  }

  async listPlans() {
    return this.prisma.plan.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } });
  }

  /**
   * Creates a subscription. When BILLING_ENABLED with Stripe is configured the
   * checkout is delegated to Stripe; otherwise a local subscription is created
   * with status TRIALING (self-hosted trial mode) — see docs/AdministrationGuide.md.
   */
  async createSubscription(
    user: AuthenticatedUser,
    input: { plan: PlanCode; seats: number; couponCode?: string; period?: 'monthly' | 'yearly' },
  ) {
    const orgId = user.org?.id;
    if (!orgId) throw new ForbiddenException('No active tenant');
    if (input.seats < 1) throw new BadRequestException('Seats must be at least 1');

    const plan = await this.prisma.plan.findUnique({ where: { code: input.plan } });
    if (!plan || !plan.isActive) throw new NotFoundException('Plan not found');

    const account = await this.getAccount(user);
    let discount = 0;
    if (input.couponCode) {
      discount = await this.applyCoupon(account.id, input.couponCode);
    }

    const priceCents =
      input.period === 'yearly' ? plan.priceYearly : plan.priceMonthly;
    const amountDue = Math.max(0, Math.round((priceCents * input.seats * (100 - discount)) / 100));

    const subscription = await this.prisma.subscription.create({
      data: {
        billingAccountId: account.id,
        planId: plan.id,
        provider: process.env.BILLING_ENABLED === 'true' ? 'stripe' : 'local',
        providerSubscriptionId: process.env.BILLING_ENABLED === 'true' ? undefined : `sub_${randomUUID()}`,
        status: process.env.BILLING_ENABLED === 'true' ? 'TRIALING' : 'ACTIVE',
        seats: input.seats,
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    if (amountDue > 0) {
      await this.prisma.invoice.create({
        data: {
          billingAccountId: account.id,
          subscriptionId: subscription.id,
          status: 'OPEN',
          amountDue,
          currency: 'usd',
          lineItems: [
            {
              description: `${plan.name} (${input.period ?? 'monthly'}) × ${input.seats} seat(s)`,
              quantity: input.seats,
              unitAmount: input.period === 'yearly' ? plan.priceYearly : plan.priceMonthly,
              discountPercent: discount,
            },
          ],
        },
      });
    }

    await this.prisma.billingAccount.update({
      where: { id: account.id },
      data: { plan: plan.code, status: 'TRIALING', seatsLimit: input.seats },
    });

    return this.getAccount(user);
  }

  async listInvoices(user: AuthenticatedUser) {
    const orgId = user.org?.id!;
    const account = await this.prisma.billingAccount.findUnique({ where: { organizationId: orgId } });
    if (!account) return { total: 0, items: [] };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.invoice.count({ where: { billingAccountId: account.id } }),
      this.prisma.invoice.findMany({
        where: { billingAccountId: account.id },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    return { total, items };
  }

  /** Usage counters for the current billing period. */
  async usage(user: AuthenticatedUser) {
    const orgId = user.org?.id!;
    const account = await this.getAccount(user);
    const periodStart = account.currentPeriodEnd ? new Date(account.currentPeriodEnd.getTime() - 30 * 24 * 60 * 60 * 1000) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [documents, completedRequests, members] = await this.prisma.$transaction([
      this.prisma.document.count({ where: { organizationId: orgId, createdAt: { gte: periodStart } } }),
      this.prisma.signingRequest.count({ where: { organizationId: orgId, status: 'COMPLETED', completedAt: { gte: periodStart } } }),
      this.prisma.membership.count({ where: { organizationId: orgId } }),
    ]);

    return {
      periodStart,
      plan: account.plan,
      usage: { documents, completedRequests, members },
      limits: {
        documents: account.documentsLimit,
        seats: account.seatsLimit,
        storageBytes: account.storageLimitBytes,
      },
    };
  }

  private async applyCoupon(billingAccountId: string, code: string): Promise<number> {
    const coupon = await this.prisma.coupon.findUnique({ where: { code: code.toUpperCase() } });
    if (!coupon || !coupon.isActive) throw new BadRequestException('Invalid coupon code');
    if (coupon.expiresAt && coupon.expiresAt < new Date()) throw new BadRequestException('Coupon has expired');
    if (coupon.maxRedemptions !== null && coupon.redeemedCount >= coupon.maxRedemptions) {
      throw new BadRequestException('Coupon has reached its redemption limit');
    }

    const already = await this.prisma.couponRedemption.findUnique({
      where: { couponId_billingAccountId: { couponId: coupon.id, billingAccountId } },
    });
    if (already) throw new BadRequestException('Coupon already redeemed by this organization');

    await this.prisma.couponRedemption.create({ data: { couponId: coupon.id, billingAccountId } });
    await this.prisma.coupon.update({ where: { id: coupon.id }, data: { redeemedCount: { increment: 1 } } });
    return coupon.type === 'PERCENT' ? coupon.value : 0; // FIXED amounts handled by billing gateway
  }
}