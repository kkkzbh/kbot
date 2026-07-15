import 'koishi';
import type {
  ChaoxingAnswerCache,
  ChaoxingAnswerRecord,
  ChaoxingAuthAudit,
  ChaoxingBindChallenge,
  ChaoxingCourseRow,
  ChaoxingCredential,
  ChaoxingJob,
  ChaoxingJobEvent,
  ChaoxingSession,
  ChaoxingSignAction,
  ChaoxingSignRecord,
  ChaoxingTaskRow,
} from '../plugins/chaoxing/types.js';

declare module 'koishi' {
  interface Tables {
    chaoxing_bind_challenge: ChaoxingBindChallenge;
    chaoxing_session: ChaoxingSession;
    chaoxing_credential: ChaoxingCredential;
    chaoxing_auth_audit: ChaoxingAuthAudit;
    chaoxing_course: ChaoxingCourseRow;
    chaoxing_task_item: ChaoxingTaskRow;
    chaoxing_job: ChaoxingJob;
    chaoxing_job_event: ChaoxingJobEvent;
    chaoxing_sign_record: ChaoxingSignRecord;
    chaoxing_sign_action: ChaoxingSignAction;
    chaoxing_answer_cache: ChaoxingAnswerCache;
    chaoxing_answer_record: ChaoxingAnswerRecord;
  }
}
