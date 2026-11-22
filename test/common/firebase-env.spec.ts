import { randomBytes } from 'crypto';
import {
  decryptFieldValue,
  encryptFieldValue,
  isDevelopmentFirebaseEnv,
} from '../../src/common/data-crypto.utils';
import { COLLECTIONS } from '../../src/firebase/firebase.types';
import {
  FirebaseService,
  resolveActiveFirebaseEnvironment,
} from '../../src/firebase/firebase.service';

describe('Firebase Environment Switching (production vs development)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('defaults to production and switches cleanly to development with FIREBASE_ENV=development', () => {
    delete process.env.FIREBASE_ENV;
    expect(resolveActiveFirebaseEnvironment()).toBe('production');
    expect(isDevelopmentFirebaseEnv()).toBe(false);

    process.env.FIREBASE_ENV = 'development';
    expect(resolveActiveFirebaseEnvironment()).toBe('development');
    expect(isDevelopmentFirebaseEnv()).toBe(true);

    process.env.FIREBASE_ENV = 'dev';
    expect(resolveActiveFirebaseEnvironment()).toBe('development');
  });

  it('uses isolated DATA_ENCRYPTION_KEY_DEV when FIREBASE_ENV=development is active', () => {
    const prodKey = randomBytes(32).toString('hex');
    const devKey = randomBytes(32).toString('hex');

    process.env.FIREBASE_ENV = 'production';
    process.env.DATA_ENCRYPTION_KEY = prodKey;
    const prodCipher = encryptFieldValue(COLLECTIONS.USERS, 'cpf', '52998224725', {
      recordId: 'u-env',
      ownerId: 'u-env',
    });

    process.env.FIREBASE_ENV = 'development';
    process.env.DATA_ENCRYPTION_KEY_DEV = devKey;
    const devCipher = encryptFieldValue(COLLECTIONS.USERS, 'cpf', '52998224725', {
      recordId: 'u-env',
      ownerId: 'u-env',
    });

    // Chave DEV não deve descriptografar dado cifrado em PROD
    expect(() =>
      decryptFieldValue(prodCipher, {
        collectionName: COLLECTIONS.USERS,
        fieldName: 'cpf',
        recordId: 'u-env',
        ownerId: 'u-env',
      }),
    ).toThrow(/autenticação|integridade/i);

    expect(
      decryptFieldValue(devCipher, {
        collectionName: COLLECTIONS.USERS,
        fieldName: 'cpf',
        recordId: 'u-env',
        ownerId: 'u-env',
      }),
    ).toBe('52998224725');
  });

  it('blocks FIREBASE_ENV=development from accidentally connecting with production painel-monet credentials', () => {
    process.env.FIREBASE_ENV = 'development';
    process.env.FIREBASE_DEV_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: 'painel-monet',
      client_email: 'admin@painel-monet.iam.gserviceaccount.com',
      private_key: 'test-key-placeholder',
    });

    const service = new FirebaseService();
    expect(() => service.onModuleInit()).toThrow(/Bloqueio de segurança.*painel-monet-dev/i);
  });

  it('blocks FIREBASE_ENV=production from accidentally connecting with development painel-monet-dev credentials', () => {
    process.env.FIREBASE_ENV = 'production';
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: 'painel-monet-dev',
      client_email: 'admin@painel-monet-dev.iam.gserviceaccount.com',
      private_key: 'test-key-placeholder',
    });
    delete process.env.FIREBASE_PROJECT_ID;

    const service = new FirebaseService();
    expect(() => service.onModuleInit()).toThrow(/Bloqueio de segurança.*painel-monet-dev/i);
  });
});
