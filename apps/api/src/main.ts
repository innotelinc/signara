/**
 * Signara API bootstrap.
 * Global prefix: /api/v1  — Swagger at /api/v1/docs
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // --- Security middleware -------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"], // Swagger UI inline scripts
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          reportUri: [config.get<string>('CSP_REPORT_URI') ?? '/api/v1/audit/csp-report'],
          upgradeInsecureRequests: [],
        },
      },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      frameguard: { action: 'deny' },
    }),
  );

  app.use(cookieParser());
  app.enableCors({
    origin: config.get<string>('WEB_URL')?.split(',') ?? true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Idempotency-Key', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  // --- Global plumbing -----------------------------------------------------
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready', 'metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter(), new HttpExceptionFilter());

  // --- Swagger / OpenAPI ---------------------------------------------------
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Signara API')
    .setDescription('Secure Every Signature. — REST API for the Signara platform.')
    .setVersion('1.0.0')
    .setContact('Signara', 'https://signara.innotel.us', 'security@signara.innotel.us')
    .setLicense('AGPL-3.0-or-later', 'https://www.gnu.org/licenses/agpl-3.0.txt')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-API-Key' }, 'api-key')
    .setExternalDoc('OpenAPI YAML', '/api/v1/openapi.yaml')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/v1/docs', app, document, {
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  // --- Shutdown hooks ------------------------------------------------------
  app.enableShutdownHooks();

  const port = Number(config.get('API_PORT') ?? 8000);
  await app.listen(port, '0.0.0.0');
  logger.log(`Signara API listening on http://0.0.0.0:${port}/api/v1`);
  logger.log(`Swagger available at http://0.0.0.0:${port}/api/v1/docs`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap', err);
  process.exit(1);
});