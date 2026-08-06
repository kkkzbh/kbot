import 'koishi';
import type {
  HbuJwAcademicItem,
  HbuJwAcademicSyncState,
  HbuJwAuthAudit,
  HbuJwBindChallenge,
  HbuJwCredential,
  HbuJwSession,
  HbuJwSmsDevice,
  HbuJwTrainingPlanCacheRow,
} from '../plugins/hbu-jw/types.js';

declare module 'koishi' {
  interface Tables {
    hbu_jw_bind_challenge: HbuJwBindChallenge;
    hbu_jw_session: HbuJwSession;
    hbu_jw_sms_device: HbuJwSmsDevice;
    hbu_jw_credential: HbuJwCredential;
    hbu_jw_auth_audit: HbuJwAuthAudit;
    hbu_jw_academic_sync_state: HbuJwAcademicSyncState;
    hbu_jw_academic_item: HbuJwAcademicItem;
    hbu_jw_training_plan: HbuJwTrainingPlanCacheRow;
  }
}
