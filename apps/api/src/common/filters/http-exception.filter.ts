import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

/**
 * Normalizes all HTTP errors into a consistent envelope and attaches a request
 * id for log correlation:
 *   { statusCode, error, message[], path, timestamp, requestId }
 */
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: HttpException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest();
    const status = exception.getStatus();
    const body = exception.getResponse();

    const message =
      typeof body === 'string'
        ? [body]
        : Array.isArray((body as Record<string, unknown>).message)
          ? ((body as Record<string, unknown>).message as string[])
          : [(body as Record<string, unknown>).message ?? exception.message];

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} -> ${status} ${message.join('; ')}`,
        exception.stack,
      );
    }

    response.status(status).json({
      statusCode: status,
      error: HttpStatus[status] ?? 'Error',
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId: request.requestId,
    });
  }
}