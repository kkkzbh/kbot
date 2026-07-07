const CURRENT_SCHEMA_VERSION = 1;

export {
  constantTimeEqualHex,
  createConfirmCode,
  createRandomToken,
  decryptEnvelopeJson,
  decryptSelfContainedJson,
  encryptEnvelopeJson,
  encryptSelfContainedJson,
  loadOrCreateKek,
  resolveKekPath,
  sha256Hex,
  type EnvelopeCipher,
  type CredentialKek as HbuJwKek,
} from '../shared/credential-crypto.js';

export function credentialAad(ownerKey: string, serviceId: string, credentialId: number): string {
  return `hbu-jw:credential:v${CURRENT_SCHEMA_VERSION}:${ownerKey}:${serviceId}:${credentialId}`;
}

export function cookieAad(ownerKey: string): string {
  return `hbu-jw:cookie:v${CURRENT_SCHEMA_VERSION}:${ownerKey}`;
}
