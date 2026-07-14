import {
  decryptEnvelopeJson,
  decryptSelfContainedJson,
  encryptEnvelopeJson,
  encryptSelfContainedJson,
  loadOrCreateKek,
  resolveKekPath,
  type CredentialKek,
} from '../shared/credential-crypto.js';

const SCHEMA_VERSION = 1;

export { decryptEnvelopeJson, decryptSelfContainedJson, encryptEnvelopeJson, encryptSelfContainedJson, loadOrCreateKek, resolveKekPath };
export type ChaoxingKek = CredentialKek;

export function sessionCookieAad(ownerKey: string): string {
  return `chaoxing:session-cookie:v${SCHEMA_VERSION}:${ownerKey}`;
}

export function credentialAad(ownerKey: string, credentialId: number): string {
  return `chaoxing:credential:v${SCHEMA_VERSION}:${ownerKey}:${credentialId}`;
}

export function pendingCookieAad(ownerKey: string, challengeId: number): string {
  return `chaoxing:pending-cookie:v${SCHEMA_VERSION}:${ownerKey}:${challengeId}`;
}

export function pendingCredentialAad(ownerKey: string, challengeId: number): string {
  return `chaoxing:pending-credential:v${SCHEMA_VERSION}:${ownerKey}:${challengeId}`;
}

export function pendingConfirmCodeAad(ownerKey: string, challengeId: number): string {
  return `chaoxing:pending-confirm-code:v${SCHEMA_VERSION}:${ownerKey}:${challengeId}`;
}
