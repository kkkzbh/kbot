import 'koishi';
import type {
  HbuJwAuthAudit,
  HbuJwBindChallenge,
  HbuJwCredential,
  HbuJwSession,
} from '../plugins/hbu-jw/types.js';

declare module 'koishi' {
  interface Tables {
    hbu_jw_bind_challenge: HbuJwBindChallenge;
    hbu_jw_session: HbuJwSession;
    hbu_jw_credential: HbuJwCredential;
    hbu_jw_auth_audit: HbuJwAuthAudit;
  }
}
