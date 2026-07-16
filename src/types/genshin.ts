import 'koishi';
import type {
  GenshinAuthAudit,
  GenshinBindChallenge,
  GenshinCredential,
  GenshinGachaRecord,
  GenshinGachaSyncState,
  GenshinRedeemRecord,
  GenshinSignInRecord,
  GenshinStatusVerification,
} from '../plugins/genshin/types.js';

declare module 'koishi' {
  interface Tables {
    genshin_bind_challenge: GenshinBindChallenge;
    genshin_credential: GenshinCredential;
    genshin_status_verification: GenshinStatusVerification;
    genshin_signin_record: GenshinSignInRecord;
    genshin_redeem_record: GenshinRedeemRecord;
    genshin_gacha_record: GenshinGachaRecord;
    genshin_gacha_sync_state: GenshinGachaSyncState;
    genshin_auth_audit: GenshinAuthAudit;
  }
}
