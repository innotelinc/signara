import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

const ACCESS_SECRET = 'access-secret-for-tests';
const REFRESH_SECRET = 'refresh-secret-for-tests';

function configValue(key: string): string | string[] | undefined {
  const values: Record<string, string | string[]> = {
    'auth.jwtAccessSecret': ACCESS_SECRET,
    'auth.jwtRefreshSecret': REFRESH_SECRET,
    'oidc.clientId': 'signara-test',
    'oidc.redirectUri': 'https://api.example.test/api/v1/auth/callback',
    'oidc.authorizationUrl': 'https://auth.example.test/application/o/authorize/',
    'oidc.tokenUrl': 'https://auth.example.test/application/o/token/',
    'oidc.userinfoUrl': 'https://auth.example.test/application/o/userinfo/',
    'oidc.scopes': ['openid', 'profile', 'email'],
  };
  return values[key];
}

describe('AuthService security invariants', () => {
  let service: AuthService;
  const prismaMock = {
    session: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: ConfigService, useValue: { get: configValue } },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  it('signs and verifies OIDC state while rejecting external redirects', () => {
    const state = service.createLoginState('https://attacker.example/steal');

    expect(service.parseLoginState(state)).toBe('/');
    expect(service.parseLoginState(service.createLoginState('/dashboard'))).toBe('/dashboard');
    expect(() => service.parseLoginState(`${state}.tampered`)).toThrow(
      'Invalid or expired login state',
    );
  });

  it('rejects refresh tokens signed for another token purpose before database lookup', async () => {
    const accessToken = jwt.sign(
      { sub: 'user-1', email: 'user@example.test', type: 'access' },
      ACCESS_SECRET,
      { algorithm: 'HS256', expiresIn: '15m' },
    );

    await expect(service.refresh(accessToken, 'browser', '127.0.0.1')).rejects.toThrow(
      'Invalid or expired refresh token',
    );
    expect(prismaMock.session.findFirst).not.toHaveBeenCalled();
  });
});
