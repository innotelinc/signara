import { Body, Controller, Get, Post, Query, Redirect, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { AuthService } from './auth.service';
import { CurrentUser, Public } from '../../common/decorators';
import { AuthenticatedUser } from '../../common/types';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Step 1 of the OIDC flow — redirect to Authentik. */
  @Public()
  @Get('login')
  @Redirect()
  @ApiOperation({ summary: 'Redirect to the identity provider (Authentik) login' })
  login(@Query('next') next?: string) {
    const state = Buffer.from(JSON.stringify({ next: next ?? '/', nonce: randomUUID() })).toString('base64url');
    return { url: this.auth.buildLoginUrl(state), statusCode: 302 };
  }

  /** Step 2 — Authentik redirects back with an authorization code. */
  @Public()
  @Get('callback')
  @ApiOperation({ summary: 'OIDC callback — exchange code and establish the session' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (error) throw new UnauthorizedException(`Identity provider error: ${error}`);
    if (!code || !state) throw new UnauthorizedException('Missing code or state');

    let nextPath = '/';
    try {
      nextPath = JSON.parse(Buffer.from(state, 'base64url').toString()).next ?? '/';
    } catch {
      /* ignore malformed state */
    }

    const tokens = await this.auth.exchangeCode(code);
    const userinfo = await this.auth.fetchUserinfo(tokens.access_token);
    const pair = await this.auth.loginWithIdp(
      {
        sub: String(userinfo.sub),
        email: String(userinfo.email),
        name: typeof userinfo.name === 'string' ? userinfo.name : undefined,
        groups: Array.isArray(userinfo.groups) ? userinfo.groups.map(String) : undefined,
      },
      this.fingerprint(req),
      String(req.ip ?? 'unknown'),
    );

    this.setAuthCookies(res, pair.accessToken, pair.refreshToken);
    return res.redirect(nextPath);
  }

  /** Refreshes the access token using the refresh cookie. */
  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Rotate the session and issue a fresh access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.signara_refresh;
    if (!refreshToken) throw new UnauthorizedException('Missing refresh token');
    const pair = await this.auth.refresh(refreshToken, this.fingerprint(req), String(req.ip ?? 'unknown'));
    this.setAuthCookies(res, pair.accessToken, pair.refreshToken);
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
  }

  /** Logs out — revokes the session and clears cookies. */
  @Post('logout')
  @ApiOperation({ summary: 'Revoke the current session' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.signara_refresh;
    if (refreshToken) {
      await this.auth.revokeSession(refreshToken, this.fingerprint(req));
    }
    res.clearCookie('signara_access', this.cookieOptions(15 * 60));
    res.clearCookie('signara_refresh', { ...this.cookieOptions(30 * 24 * 60 * 60), path: '/api/v1/auth' });
    return { success: true };
  }

  /** Current user profile (JWT-authenticated). */
  @Get('me')
  @ApiOperation({ summary: 'Get the current user and active tenant' })
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  private setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
    res.cookie('signara_access', accessToken, this.cookieOptions(15 * 60));
    res.cookie('signara_refresh', refreshToken, {
      ...this.cookieOptions(30 * 24 * 60 * 60),
      sameSite: 'strict',
      path: '/api/v1/auth',
    });
  }

  private cookieOptions(maxAgeSeconds: number) {
    return {
      httpOnly: true,
      secure: process.env.SESSION_COOKIE_SECURE === 'true',
      sameSite: 'lax' as const,
      maxAge: maxAgeSeconds * 1000,
      path: '/',
    };
  }

  private fingerprint(req: Request): string {
    return String(req.headers['user-agent'] ?? 'unknown').slice(0, 256);
  }
}