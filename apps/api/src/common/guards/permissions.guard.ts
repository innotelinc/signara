import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY, IS_PUBLIC_KEY } from '../decorators';

/**
 * Enforces fine-grained RBAC. Requires the route's permission codes (set via
 * `@Permissions(...)`) to be present in the resolved tenant context
 * (`user.org.permissions`), unless the route is public.
 *
 * Platform administrators bypass permission checks.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredCodes = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic || !requiredCodes || requiredCodes.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }
    if (user.platformRole === 'PLATFORM_ADMIN') {
      return true;
    }

    const granted = user.org?.permissions ?? [];
    const allowed = requiredCodes.some((code) => granted.includes(code));
    if (!allowed) {
      throw new ForbiddenException(`Missing required permission: ${requiredCodes.join(', ')}`);
    }
    return true;
  }
}