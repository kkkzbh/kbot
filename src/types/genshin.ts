import 'koishi';
import type {
  GenshinAuthAudit,
  GenshinBindChallenge,
  GenshinCredential,
  GenshinRedeemRecord,
  GenshinSignInRecord,
} from '../plugins/genshin/types.js';

declare module 'koishi' {
  interface Tables {
    genshin_bind_challenge: GenshinBindChallenge;
    genshin_credential: GenshinCredential;
    genshin_signin_record: GenshinSignInRecord;
    genshin_redeem_record: GenshinRedeemRecord;
    genshin_auth_audit: GenshinAuthAudit;
  }
}
