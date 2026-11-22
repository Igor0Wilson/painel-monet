import {
  Controller,
  Get,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AppService } from './app.service';
import { FirebaseService } from './firebase/firebase.service';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly appService: AppService,
    @Optional() private readonly firebaseService?: FirebaseService,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async getHealth() {
    if (!this.firebaseService) {
      return { status: 'ok', database: 'not_configured' };
    }

    try {
      await this.firebaseService.healthCheck();
      return {
        status: 'ok',
        database: 'connected',
        provider: 'firebase-firestore',
        environment:
          typeof this.firebaseService.getActiveEnvironment === 'function'
            ? this.firebaseService.getActiveEnvironment()
            : 'production',
      };
    } catch {
      this.logger.error('Falha ao verificar conexão com o Cloud Firestore');
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'disconnected',
      });
    }
  }
}
