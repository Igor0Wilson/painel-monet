import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountTypesModule } from './account-types/account-types.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BalanceModule } from './balance/balance.module';
import { ExpensesModule } from './expenses/expenses.module';
import { FamilyModule } from './family/family.module';
import { FirebaseModule } from './firebase/firebase.module';
import { IncomeModule } from './income/income.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 60,
      },
    ]),
    FirebaseModule,
    AuthModule,
    UsersModule,
    AccountTypesModule,
    ExpensesModule,
    IncomeModule,
    BalanceModule,
    FamilyModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
