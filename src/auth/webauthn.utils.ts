import { createHash, createPublicKey, createVerify, timingSafeEqual } from 'crypto';

function decodeCborValue(
  buf: Buffer,
  offset: { pos: number },
): unknown {
  if (offset.pos >= buf.length) {
    throw new Error('CBOR inesperado: fim do buffer');
  }
  const initial = buf[offset.pos++];
  const major = initial >> 5;
  const addInfo = initial & 0x1f;

  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      if (offset.pos + 1 > buf.length) throw new Error('CBOR uint8 OOB');
      return buf[offset.pos++];
    }
    if (info === 25) {
      if (offset.pos + 2 > buf.length) throw new Error('CBOR uint16 OOB');
      const val = buf.readUInt16BE(offset.pos);
      offset.pos += 2;
      return val;
    }
    if (info === 26) {
      if (offset.pos + 4 > buf.length) throw new Error('CBOR uint32 OOB');
      const val = buf.readUInt32BE(offset.pos);
      offset.pos += 4;
      return val;
    }
    throw new Error('CBOR comprimento não suportado');
  };

  if (major === 0) {
    return readLength(addInfo);
  }
  if (major === 1) {
    return -1 - readLength(addInfo);
  }
  if (major === 2) {
    const len = readLength(addInfo);
    if (offset.pos + len > buf.length) throw new Error('CBOR bytes OOB');
    const out = buf.subarray(offset.pos, offset.pos + len);
    offset.pos += len;
    return out;
  }
  if (major === 3) {
    const len = readLength(addInfo);
    if (offset.pos + len > buf.length) throw new Error('CBOR text OOB');
    const out = buf.subarray(offset.pos, offset.pos + len).toString('utf8');
    offset.pos += len;
    return out;
  }
  if (major === 4) {
    const len = readLength(addInfo);
    const arr: unknown[] = [];
    for (let i = 0; i < len; i++) {
      arr.push(decodeCborValue(buf, offset));
    }
    return arr;
  }
  if (major === 5) {
    const len = readLength(addInfo);
    const map = new Map<unknown, unknown>();
    for (let i = 0; i < len; i++) {
      const k = decodeCborValue(buf, offset);
      const v = decodeCborValue(buf, offset);
      map.set(k, v);
    }
    return map;
  }
  if (major === 7) {
    if (addInfo === 20) return false;
    if (addInfo === 21) return true;
    if (addInfo === 22) return null;
    if (addInfo === 23) return undefined;
    return addInfo;
  }
  throw new Error(`CBOR major type inválido: ${major}`);
}

export function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (normalized.length % 4)) % 4;
  return Buffer.from(normalized + '='.repeat(padLen), 'base64');
}

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest();
}

export function safeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const VERCEL_PROJECT_ORIGIN_RE =
  /^https:\/\/painel-monet-front(?:-[a-z0-9-]+)?\.vercel\.app$/i;

export function isOriginAllowedForWebAuthn(
  origin: string,
  allowedOrigins: string[],
): boolean {
  try {
    const parsedOrigin = new URL(origin).origin.toLowerCase();
    if (VERCEL_PROJECT_ORIGIN_RE.test(parsedOrigin)) {
      return true;
    }
    return allowedOrigins.some((allowed) => {
      try {
        return new URL(allowed).origin.toLowerCase() === parsedOrigin;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function coseKeyMapToSpkiPem(coseMap: Map<unknown, unknown>): string {
  const kty = coseMap.get(1);
  const alg = coseMap.get(3);

  // EC2 P-256 (ES256)
  if (kty === 2 && alg === -7) {
    const crv = coseMap.get(-1);
    const xRaw = coseMap.get(-2);
    const yRaw = coseMap.get(-3);
    if (
      crv !== 1 ||
      !Buffer.isBuffer(xRaw) ||
      !Buffer.isBuffer(yRaw) ||
      xRaw.length !== 32 ||
      yRaw.length !== 32
    ) {
      throw new Error('Chave WebAuthn EC2 P-256 inválida');
    }
    const pubKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: xRaw.toString('base64url'),
        y: yRaw.toString('base64url'),
      },
      format: 'jwk',
    });
    return pubKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  // RSA RS256 (Windows Hello / Android TPM fallback)
  if (kty === 3 && alg === -257) {
    const nRaw = coseMap.get(-1);
    const eRaw = coseMap.get(-2);
    if (
      !Buffer.isBuffer(nRaw) ||
      !Buffer.isBuffer(eRaw) ||
      nRaw.length < 128
    ) {
      throw new Error('Chave WebAuthn RSA inválida');
    }
    const pubKey = createPublicKey({
      key: {
        kty: 'RSA',
        n: nRaw.toString('base64url'),
        e: eRaw.toString('base64url'),
      },
      format: 'jwk',
    });
    return pubKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  // RSA (RS256)
  if (kty === 3 && alg === -257) {
    const nRaw = coseMap.get(-1);
    const eRaw = coseMap.get(-2);
    if (!Buffer.isBuffer(nRaw) || !Buffer.isBuffer(eRaw)) {
      throw new Error('Chave WebAuthn RSA inválida');
    }
    const pubKey = createPublicKey({
      key: {
        kty: 'RSA',
        n: nRaw.toString('base64url'),
        e: eRaw.toString('base64url'),
      },
      format: 'jwk',
    });
    return pubKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  throw new Error(
    `Algoritmo WebAuthn não suportado (kty=${String(kty)}, alg=${String(alg)})`,
  );
}

export function verifyWebAuthnRegistrationPayload(params: {
  clientDataJSONB64: string;
  attestationObjectB64: string;
  expectedChallenge: string;
  allowedOrigins: string[];
}): {
  credentialIdB64: string;
  publicKeySpkiPem: string;
  signCount: number;
  origin: string;
} {
  const clientDataRaw = decodeBase64Url(params.clientDataJSONB64);
  const clientData = JSON.parse(clientDataRaw.toString('utf8')) as {
    type?: string;
    challenge?: string;
    origin?: string;
  };

  if (clientData.type !== 'webauthn.create') {
    throw new Error('Tipo de cliente WebAuthn inválido para registro');
  }
  if (
    !clientData.challenge ||
    !safeEqualStrings(clientData.challenge, params.expectedChallenge)
  ) {
    throw new Error('Desafio WebAuthn não corresponde');
  }
  if (
    !clientData.origin ||
    !isOriginAllowedForWebAuthn(clientData.origin, params.allowedOrigins)
  ) {
    throw new Error('Origem WebAuthn não autorizada');
  }

  const originHost = new URL(clientData.origin).hostname;
  const attBuffer = decodeBase64Url(params.attestationObjectB64);
  const attDecoded = decodeCborValue(attBuffer, { pos: 0 });
  if (!(attDecoded instanceof Map)) {
    throw new Error('AttestationObject inválido');
  }

  const authData = attDecoded.get('authData');
  if (!Buffer.isBuffer(authData) || authData.length < 55) {
    throw new Error('AuthenticatorData inválido ou ausente');
  }

  const rpIdHash = authData.subarray(0, 32);
  const expectedRpIdHash = sha256(originHost);
  if (!timingSafeEqual(rpIdHash, expectedRpIdHash)) {
    throw new Error('RP ID Hash WebAuthn inválido');
  }

  const flags = authData[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  const hasAttestedCredential = (flags & 0x40) !== 0;

  if (!userPresent || !userVerified || !hasAttestedCredential) {
    throw new Error(
      'A verificação biométrica do usuário (UV) é obrigatória para registrar esta credencial.',
    );
  }

  const signCount = authData.readUInt32BE(33);
  const credIdLen = authData.readUInt16BE(53);
  const credIdStart = 55;
  const credIdEnd = credIdStart + credIdLen;
  if (credIdLen === 0 || credIdEnd > authData.length) {
    throw new Error('Comprimento de credentialId inválido');
  }

  const credentialIdBuf = authData.subarray(credIdStart, credIdEnd);
  const coseKeyBuffer = authData.subarray(credIdEnd);
  const coseKeyMap = decodeCborValue(coseKeyBuffer, { pos: 0 });
  if (!(coseKeyMap instanceof Map)) {
    throw new Error('Chave pública COSE inválida');
  }

  const publicKeySpkiPem = coseKeyMapToSpkiPem(coseKeyMap);

  return {
    credentialIdB64: credentialIdBuf.toString('base64url'),
    publicKeySpkiPem,
    signCount,
    origin: clientData.origin,
  };
}

export function verifyWebAuthnAssertionPayload(params: {
  clientDataJSONB64: string;
  authenticatorDataB64: string;
  signatureB64: string;
  expectedChallenge: string;
  allowedOrigins: string[];
  publicKeySpkiPem: string;
  storedSignCount: number;
}): { newSignCount: number } {
  const clientDataRaw = decodeBase64Url(params.clientDataJSONB64);
  const clientData = JSON.parse(clientDataRaw.toString('utf8')) as {
    type?: string;
    challenge?: string;
    origin?: string;
  };

  if (clientData.type !== 'webauthn.get') {
    throw new Error('Tipo de cliente WebAuthn inválido para login');
  }
  if (
    !clientData.challenge ||
    !safeEqualStrings(clientData.challenge, params.expectedChallenge)
  ) {
    throw new Error('Desafio biométrico expirado ou inválido');
  }
  if (
    !clientData.origin ||
    !isOriginAllowedForWebAuthn(clientData.origin, params.allowedOrigins)
  ) {
    throw new Error('Origem WebAuthn não autorizada');
  }

  const originHost = new URL(clientData.origin).hostname;
  const authData = decodeBase64Url(params.authenticatorDataB64);
  if (authData.length < 37) {
    throw new Error('AuthenticatorData inválido');
  }

  const rpIdHash = authData.subarray(0, 32);
  if (!timingSafeEqual(rpIdHash, sha256(originHost))) {
    throw new Error('RP ID Hash WebAuthn inválido');
  }

  const flags = authData[32];
  const userPresent = (flags & 0x01) !== 0;
  const userVerified = (flags & 0x04) !== 0;
  if (!userPresent || !userVerified) {
    throw new Error('Verificação biométrica não confirmada pelo dispositivo');
  }

  const newSignCount = authData.readUInt32BE(33);
  if (
    params.storedSignCount > 0 &&
    newSignCount > 0 &&
    newSignCount < params.storedSignCount
  ) {
    throw new Error('Contador WebAuthn inválido (possível replay detectado)');
  }

  const signature = decodeBase64Url(params.signatureB64);
  const clientDataHash = sha256(clientDataRaw);
  const signedBytes = Buffer.concat([authData, clientDataHash]);

  const verifier = createVerify('SHA256');
  verifier.update(signedBytes);
  verifier.end();

  if (!verifier.verify(params.publicKeySpkiPem, signature)) {
    throw new Error('Assinatura biométrica inválida');
  }

  return { newSignCount };
}
