import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import express, { NextFunction, Request, Response } from 'express';
import { AuditService } from './common/audit.service';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

const setupLogger = new Logger('SecuritySetup');

export function getAllowedOrigins(): string[] {
  const configuredOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);

  const isProduction =
    process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

  const defaultProductionOrigins = isProduction
    ? [
        'https://painel-monet-front.vercel.app',
        'https://www.wssprime.com.br',
        'https://wssprime.com.br',
      ]
    : [];

  const devOrigins = isProduction
    ? []
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
      ];

  const mobileWebViewOrigins = [
    'capacitor://localhost',
    'ionic://localhost',
    'http://localhost',
    'https://localhost',
  ];

  return Array.from(
    new Set([
      ...configuredOrigins,
      ...defaultProductionOrigins,
      ...devOrigins,
      ...mobileWebViewOrigins,
    ]),
  );
}

export function configureApp(app: INestApplication): void {
  const expressInstance = app.getHttpAdapter().getInstance();
  if (typeof expressInstance?.disable === 'function') {
    expressInstance.disable('x-powered-by');
  }
  if (typeof expressInstance?.set === 'function') {
    expressInstance.set('trust proxy', 1);
  }

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'",
    );
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  const allowedOrigins = getAllowedOrigins();

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = origin.replace(/\/+$/, '');
      if (allowedOrigins.includes(normalizedOrigin)) {
        return callback(null, true);
      }

      setupLogger.warn(
        `[SECURITY] Requisição CORS bloqueada para origem não autorizada: ${normalizedOrigin}`,
      );
      return callback(new Error('Origem não permitida pelo CORS'), false);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  });

  let auditService: AuditService | undefined;
  try {
    auditService = app.get(AuditService, { strict: false });
  } catch {
    auditService = undefined;
  }

  app.useGlobalFilters(new AllExceptionsFilter(auditService));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
