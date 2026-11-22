import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  computeBlindIndex,
  decryptDocumentFromStorage,
  decryptFieldValue,
  encryptDocumentForStorage,
  encryptFieldValue,
  EncryptionAadContext,
  redactSensitiveText,
  validateEncryptionKeyConfig,
} from './data-crypto.utils';

@Injectable()
export class CryptoService implements OnModuleInit {
  private readonly logger = new Logger(CryptoService.name);

  onModuleInit(): void {
    const info = validateEncryptionKeyConfig();
    const jwtSecret = process.env.JWT_SECRET?.trim() || '';
    if (!jwtSecret || jwtSecret.length < 32 || jwtSecret.includes('SUBSTITUA')) {
      throw new Error(
        '[SECURITY] JWT_SECRET ausente, fraca ou padrão. Configure um segredo forte (mínimo 32 caracteres) nas variáveis de ambiente.',
      );
    }

    this.logger.log(
      `[SECURITY] Criptografia AES-256-GCM validada na inicialização (versão ativa=${info.activeVersion}, versões anteriores=${info.previousVersions.length}, blindIndexDedicado=${info.dedicatedBlindIndexKey}).`,
    );
  }

  encryptField(
    collectionName: string,
    fieldName: string,
    rawValue: string | number,
    context: { recordId: string; ownerId: string },
  ): string {
    return encryptFieldValue(collectionName, fieldName, rawValue, context);
  }

  decryptField(
    storedValue: unknown,
    context: EncryptionAadContext,
  ): string | null {
    return decryptFieldValue(storedValue, context);
  }

  encryptDocument<T extends object>(
    collectionName: string,
    doc: T,
    explicitContext?: { recordId?: string; ownerId?: string },
  ): T {
    return encryptDocumentForStorage(collectionName, doc, explicitContext);
  }

  decryptDocument<T extends object>(
    collectionName: string,
    doc: T | null | undefined,
  ): T | null {
    return decryptDocumentFromStorage(collectionName, doc);
  }

  blindIndex(namespace: string, value: string): string {
    return computeBlindIndex(namespace, value);
  }

  redact(text: string): string {
    return redactSensitiveText(text);
  }
}
