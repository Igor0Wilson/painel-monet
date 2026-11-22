import { randomBytes } from 'crypto';

// Gera segredos efêmeros exclusivos da suíte de testes em tempo de execução,
// mantendo a regra de zero chaves fixas no código-fonte.
if (!process.env.DATA_ENCRYPTION_KEY) {
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString('hex');
}

if (!process.env.DATA_ENCRYPTION_KEY_VERSION) {
  process.env.DATA_ENCRYPTION_KEY_VERSION = 'k1';
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = randomBytes(48).toString('hex');
}
