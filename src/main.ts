import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  try {
    const app = await NestFactory.create(AppModule);
    configureApp(app);

    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '127.0.0.1';

    await app.listen(port, host);
    logger.log(`Servidor rodando em http://${host}:${port}`);
  } catch (error) {
    logger.error(
      'Falha crítica ao inicializar o servidor',
      error instanceof Error ? error.stack : String(error),
    );
    process.exit(1);
  }
}

bootstrap();
