import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AccountTypesModule } from './account-types/account-types.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BalanceModule } from './balance/balance.module';
import { CryptoModule } from './common/crypto.module';
import { FirestoreThrottlerStorage } from './common/firestore-throttler.storage';
import { ExpensesModule } from './expenses/expenses.module';
import { FamilyModule } from './family/family.module';
import { FirebaseModule } from './firebase/firebase.module';
import { FirebaseService } from './firebase/firebase.service';
import { IncomeModule } from './income/income.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    CryptoModule,
    FirebaseModule,
    ThrottlerModule.forRootAsync({
      imports: [FirebaseModule],
      inject: [FirebaseService],
      useFactory: (firebase: FirebaseService) => ({
        throttlers: [
          {
            name: 'default',
            ttl: 60000,
            limit: 60,
          },
        ],
        storage: new FirestoreThrottlerStorage(firebase),
      }),
    }),
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
export class AppModule { }
