import {
  decryptEnvelopeJson,
  type CredentialKek,
} from '../shared/credential-crypto.js';
import {
  GENSHIN_GAME_BIZ,
  GENSHIN_SERVICE_ID,
  type GenshinCredential,
  type GenshinCredentialPayload,
  type GenshinGameRole,
} from './types.js';

export function credentialAad(ownerKey: string, credentialId: number): string {
  return `genshin:credential:v1:${ownerKey}:${GENSHIN_SERVICE_ID}:${credentialId}`;
}

export function credentialRole(credential: GenshinCredential): GenshinGameRole {
  return {
    uid: credential.uid,
    region: credential.region,
    regionName: credential.regionName,
    nickname: credential.nickname,
    level: credential.level ?? null,
    gameBiz: GENSHIN_GAME_BIZ,
  };
}

export function decryptGenshinCredential(
  credential: GenshinCredential,
  kek: CredentialKek,
): { payload: GenshinCredentialPayload; role: GenshinGameRole } {
  const payload = decryptEnvelopeJson<GenshinCredentialPayload>(
    credential.credentialCipher,
    credential.credentialMeta,
    credentialAad(credential.ownerKey, credential.id),
    kek,
  );
  return {
    payload,
    role: credentialRole(credential),
  };
}
