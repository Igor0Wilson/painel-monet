import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { AuditService } from '../audit.service';
import { redactSensitiveText } from '../data-crypto.utils';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(@Optional() private readonly auditService?: AuditService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const sanitizedPath = redactSensitiveText(
      String(request.url || '/').split('?')[0],
    );

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Erro interno no servidor';
    let code: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = redactSensitiveText(exceptionResponse);
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        if ('message' in exceptionResponse) {
          const rawMsg = (exceptionResponse as { message: string | string[] })
            .message;
          message = Array.isArray(rawMsg)
            ? rawMsg.map((item) => redactSensitiveText(String(item)))
            : redactSensitiveText(String(rawMsg));
        }
        if (
          'code' in exceptionResponse &&
          typeof (exceptionResponse as { code?: unknown }).code === 'string'
        ) {
          code = (exceptionResponse as { code: string }).code;
        }
      }
    } else if (exception instanceof Error) {
      this.logger.error(
        `Unhandled error on ${request.method} ${sanitizedPath}: ${redactSensitiveText(exception.message)}`,
      );
    } else {
      this.logger.error(
        `Unknown exception on ${request.method} ${sanitizedPath}`,
      );
    }

    if (
      (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) &&
      this.auditService
    ) {
      const authReq = request as Partial<AuthenticatedRequest>;
      const actorId = authReq.user?.userId || 'anonymous';
      const clientIp =
        (request.headers?.['x-forwarded-for'] as string | undefined)
          ?.split(',')[0]
          ?.trim() || request.ip;
      void this.auditService.log({
        actorUserId: actorId,
        action: 'security.access_denied',
        resource: sanitizedPath,
        outcome: 'DENY',
        httpMethod: request.method,
        path: sanitizedPath,
        statusCode: status,
        clientIp,
        details: code || (status === 401 ? 'unauthorized' : 'forbidden'),
      });
    }

    response.status(status).json({
      statusCode: status,
      message,
      ...(code ? { code } : {}),
      timestamp: new Date().toISOString(),
      path: sanitizedPath,
    });
  }
}
