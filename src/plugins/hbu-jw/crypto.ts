import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const AES_256_GCM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const CURRENT_SCHEMA_VERSION = 1;

export interface HbuJwKek {
  id: string;
  key: Buffer;
}

export interface EnvelopeCipher {
  cipherText: string;
  meta: string;
}

type EnvelopeMeta = {
  schemaVersion: number;
  alg: typeof AES_256_GCM;
  kekId: string;
  iv: string;
  tag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapTag: string;
  aad: string;
};

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function constantTimeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex');
  const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function createRandomToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url');
}

export function createConfirmCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, '0');
}

export function resolveKekPath(baseDir: string, path: string): string {
  return path.startsWith('/') ? path : resolve(baseDir, path);
}

export function loadOrCreateKek(path: string): HbuJwKek {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${randomBytes(KEY_BYTES).toString('hex')}\n`, { mode: 0o600 });
  }

  const stat = statSync(path);
  if (!stat.isFile()) {
    throw new Error(`hbu-jw credential KEK path is not a file: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`hbu-jw credential KEK file must be readable only by owner: ${path}`);
  }

  const encoded = readFileSync(path, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(encoded)) {
    throw new Error(`hbu-jw credential KEK file must contain a 32-byte hex key: ${path}`);
  }
  const key = Buffer.from(encoded, 'hex');
  return {
    id: sha256Hex(key.toString('hex')).slice(0, 16),
    key,
  };
}

function encryptAesGcm(key: Buffer, plaintext: Buffer, aad: string): { cipherText: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(AES_256_GCM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const cipherText = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { cipherText, iv, tag: cipher.getAuthTag() };
}

function decryptAesGcm(key: Buffer, cipherText: Buffer, iv: Buffer, tag: Buffer, aad: string): Buffer {
  const decipher = createDecipheriv(AES_256_GCM, key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(cipherText), decipher.final()]);
}

export function encryptEnvelopeJson(value: unknown, aad: string, kek: HbuJwKek): EnvelopeCipher {
  const dek = randomBytes(KEY_BYTES);
  try {
    const encryptedPayload = encryptAesGcm(dek, Buffer.from(JSON.stringify(value), 'utf8'), aad);
    const encryptedDek = encryptAesGcm(kek.key, dek, `${aad}:dek`);
    const meta: EnvelopeMeta = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      alg: AES_256_GCM,
      kekId: kek.id,
      iv: encryptedPayload.iv.toString('base64url'),
      tag: encryptedPayload.tag.toString('base64url'),
      wrappedDek: encryptedDek.cipherText.toString('base64url'),
      wrapIv: encryptedDek.iv.toString('base64url'),
      wrapTag: encryptedDek.tag.toString('base64url'),
      aad,
    };
    return {
      cipherText: encryptedPayload.cipherText.toString('base64url'),
      meta: JSON.stringify(meta),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptEnvelopeJson<T>(cipherText: string, metaText: string, aad: string, kek: HbuJwKek): T {
  const meta = JSON.parse(metaText) as EnvelopeMeta;
  if (meta.schemaVersion !== CURRENT_SCHEMA_VERSION || meta.alg !== AES_256_GCM || meta.kekId !== kek.id || meta.aad !== aad) {
    throw new Error('hbu-jw credential envelope metadata does not match the expected binding.');
  }
  const dek = decryptAesGcm(
    kek.key,
    Buffer.from(meta.wrappedDek, 'base64url'),
    Buffer.from(meta.wrapIv, 'base64url'),
    Buffer.from(meta.wrapTag, 'base64url'),
    `${aad}:dek`,
  );
  try {
    const plaintext = decryptAesGcm(
      dek,
      Buffer.from(cipherText, 'base64url'),
      Buffer.from(meta.iv, 'base64url'),
      Buffer.from(meta.tag, 'base64url'),
      aad,
    );
    return JSON.parse(plaintext.toString('utf8')) as T;
  } finally {
    dek.fill(0);
  }
}

export function encryptSelfContainedJson(value: unknown, aad: string, kek: HbuJwKek): string {
  const encrypted = encryptEnvelopeJson(value, aad, kek);
  return JSON.stringify(encrypted);
}

export function decryptSelfContainedJson<T>(value: string, aad: string, kek: HbuJwKek): T {
  const encrypted = JSON.parse(value) as EnvelopeCipher;
  return decryptEnvelopeJson<T>(encrypted.cipherText, encrypted.meta, aad, kek);
}

export function credentialAad(ownerKey: string, serviceId: string, credentialId: number): string {
  return `hbu-jw:credential:v${CURRENT_SCHEMA_VERSION}:${ownerKey}:${serviceId}:${credentialId}`;
}

export function cookieAad(ownerKey: string): string {
  return `hbu-jw:cookie:v${CURRENT_SCHEMA_VERSION}:${ownerKey}`;
}
