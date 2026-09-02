import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { AuthenticatedUser } from './types';

export const IS_PUBLIC_KEY = 'isPublic';
export const PERMISSIONS_KEY = 'permissions';
export const TENANT_REQUIRED_KEY = 'tenantRequired';

/** Marks a route as publicly accessible (no JWT required). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires the tenant (organization) context to be resolved. */
export const TenantRequired = () => SetMetadata(TENANT_REQUIRED_KEY, true);

/** Requires the caller to hold at least one of the given permission codes. */
export const Permissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

/** Injects the authenticated user. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user as AuthenticatedUser;
  },
);

/** Injects the resolved tenant (organization) context. */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    return request.user?.org;
  },
);

/** Injects the `X-Idempotency-Key` header value, if present. */
export const IdempotencyKey = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.headers['x-idempotency-key'] as string | undefined;
});