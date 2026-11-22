import { Injectable, Logger } from '@nestjs/common';
import { randomUUID as uuidv4 } from 'crypto';
import { AuditLogDoc, COLLECTIONS } from '../firebase/firebase.types';
import { FirebaseService } from '../firebase/firebase.service';
import { computeBlindIndex, redactSensitiveText } from './data-crypto.utils';

export interface AuditEventInput {
  actorUserId: string;
  action: string;
  resource: string;
  resourceId?: string | null;
  outcome: 'ALLOW' | 'DENY' | 'ERROR';
  httpMethod?: string | null;
  path?: string | null;
  statusCode?: number | null;
  clientIp?: string | null;
  details?: string | null;
}

const AUDIT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // 180 dias

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly firebase: FirebaseService) {}

  async log(input: AuditEventInput): Promise<void> {
    const nowMs = Date.now();
    const safeIpHash = input.clientIp
      ? computeBlindIndex('audit:ip', input.clientIp).slice(0, 32)
      : null;

    const record: AuditLogDoc = {
      id: uuidv4(),
      actorUserId: input.actorUserId || 'anonymous',
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId ?? null,
      outcome: input.outcome,
      httpMethod: input.httpMethod ?? null,
      path: input.path ? redactSensitiveText(input.path.split('?')[0]) : null,
      statusCode: input.statusCode ?? null,
      ipHash: safeIpHash,
      details: input.details ? redactSensitiveText(input.details).slice(0, 240) : null,
      createdAt: new Date(nowMs).toISOString(),
      expiresAtMs: nowMs + AUDIT_RETENTION_MS,
    };

    try {
      await this.firebase.setDoc(COLLECTIONS.AUDIT_LOGS, record);
    } catch (error) {
      this.logger.warn(
        `[AUDIT] Falha não bloqueante ao gravar trilha de auditoria (${input.action}): ${
          error instanceof Error ? redactSensitiveText(error.message) : 'erro desconhecido'
        }`,
      );
    }
  }
}
