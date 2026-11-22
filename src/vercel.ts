import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { Express, Request, Response } from 'express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { redactSensitiveText } from './common/data-crypto.utils';

const logger = new Logger('VercelHandler');
let cachedServerPromise: Promise<Express> | null = null;

async function bootstrapServer(): Promise<Express> {
  const expressApp = express();
  const nestApp = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
    { bodyParser: false },
  );

  configureApp(nestApp);
  await nestApp.init();

  return expressApp;
}

function getServer(): Promise<Express> {
  if (!cachedServerPromise) {
    cachedServerPromise = bootstrapServer().catch((error) => {
      cachedServerPromise = null;
      logger.error(
        'Erro ao inicializar instância serverless NestJS',
        error instanceof Error
          ? redactSensitiveText(error.message)
          : redactSensitiveText(String(error)),
      );
      throw error;
    });
  }
  return cachedServerPromise;
}

export default async function handler(req: Request, res: Response) {
  const server = await getServer();
  return server(req, res);
}
