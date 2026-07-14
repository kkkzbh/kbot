import 'koishi';
import type {
  CampusAuthAudit,
  CampusAuthChallenge,
  CampusAuthCredential,
  CampusAuthProvider,
  CampusAuthSession,
} from '../plugins/campus-auth-core/types.js';
import type { CampusAuthService } from '../plugins/campus-auth-core/service.js';

export interface CampusAuthServiceLike extends CampusAuthService {
  registerProvider(provider: CampusAuthProvider): () => void;
}

declare module 'koishi' {
  interface Context {
    campusAuth?: CampusAuthServiceLike;
  }

  interface Tables {
    campus_auth_challenge: CampusAuthChallenge;
    campus_auth_credential: CampusAuthCredential;
    campus_auth_session: CampusAuthSession;
    campus_auth_audit: CampusAuthAudit;
  }
}
