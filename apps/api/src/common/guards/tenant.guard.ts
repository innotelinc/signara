import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TENANT_REQUIRED_KEY, IS_PUBLIC_KEY } from '../decorators';

/**
 * Multi-tenant gate. Routes decorated with @TenantRequired() reject requests
 * that lack a resolved organization context, guaranteeing tenant isolation at
 * the controller boundary.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<boolean>(TENANT_REQUIRED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic || !required) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    if (!request.user?.org) {
      throw new ForbiddenException(
        'No active tenant. Join or create an organization to use this endpoint.',
      );
    }
    return true;
  }
}