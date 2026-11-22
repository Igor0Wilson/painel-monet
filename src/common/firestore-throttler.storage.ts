import { Injectable, Optional } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { COLLECTIONS } from '../firebase/firebase.types';
import { FirebaseService } from '../firebase/firebase.service';

interface MemoryBucket {
  totalHits: number;
  expiresAtMs: number;
  blockedUntilMs: number;
}

@Injectable()
export class FirestoreThrottlerStorage implements ThrottlerStorage {
  private readonly memoryBuckets = new Map<string, MemoryBucket>();

  constructor(@Optional() private readonly firebase?: FirebaseService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    const now = Date.now();
    const docId = createHash('sha256')
      .update(`${throttlerName}:${key}`)
      .digest('hex');

    // Usa transação no Firestore em produção para consistência multi-instância serverless (Vercel);
    // recorre ao bucket em memória quando o FirebaseService não está inicializado (ex.: testes unitários isolados).
    if (this.firebase && typeof this.firebase.incrementRateLimit === 'function') {
      try {
        return await this.firebase.incrementRateLimit(
          docId,
          ttl,
          limit,
          blockDuration,
          now,
        );
      } catch {
        // Fallback gracioso para memória local se o Firestore não estiver inicializado no contexto de teste
      }
    }

    return this.incrementInMemory(docId, ttl, limit, blockDuration, now);
  }

  private incrementInMemory(
    docId: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    now: number,
  ): {
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  } {
    const existing = this.memoryBuckets.get(docId);

    if (existing && existing.blockedUntilMs > now) {
      return {
        totalHits: existing.totalHits,
        timeToExpire: Math.max(0, existing.expiresAtMs - now),
        isBlocked: true,
        timeToBlockExpire: Math.max(0, existing.blockedUntilMs - now),
      };
    }

    let bucket: MemoryBucket;
    if (!existing || existing.expiresAtMs <= now) {
      bucket = {
        totalHits: 1,
        expiresAtMs: now + ttl,
        blockedUntilMs: 0,
      };
    } else {
      bucket = {
        totalHits: existing.totalHits + 1,
        expiresAtMs: existing.expiresAtMs,
        blockedUntilMs: existing.blockedUntilMs,
      };
    }

    let isBlocked = false;
    if (bucket.totalHits > limit) {
      isBlocked = true;
      bucket.blockedUntilMs = now + (blockDuration > 0 ? blockDuration : ttl);
    }

    this.memoryBuckets.set(docId, bucket);

    if (this.memoryBuckets.size > 5000) {
      for (const [k, v] of this.memoryBuckets.entries()) {
        if (v.expiresAtMs <= now && v.blockedUntilMs <= now) {
          this.memoryBuckets.delete(k);
        }
      }
    }

    return {
      totalHits: bucket.totalHits,
      timeToExpire: Math.max(0, bucket.expiresAtMs - now),
      isBlocked,
      timeToBlockExpire: isBlocked
        ? Math.max(0, bucket.blockedUntilMs - now)
        : 0,
    };
  }
}
