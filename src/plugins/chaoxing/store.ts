import type { Context } from 'koishi';
import {
  CHAOXING_SERVICE_ID,
  type ChaoxingAnswerCache,
  type ChaoxingAnswerRecord,
  type ChaoxingAuthAudit,
  type ChaoxingBindChallenge,
  type ChaoxingBindStatus,
  type ChaoxingCourse,
  type ChaoxingCourseRow,
  type ChaoxingCredential,
  type ChaoxingDeadlineItem,
  type ChaoxingJob,
  type ChaoxingJobEvent,
  type ChaoxingJobStatus,
  type ChaoxingJobType,
  type ChaoxingProfile,
  type ChaoxingSession,
  type ChaoxingSessionStatus,
  type ChaoxingSignRecord,
  type ChaoxingTaskKind,
  type ChaoxingTaskRow,
  type DatabaseLike,
  type OwnerIdentity,
} from './types.js';

const ACTIVE_CHALLENGE_STATUSES: ChaoxingBindStatus[] = [
  'created',
  'qr_pending',
  'qr_scanned',
  'login_pending',
  'login_succeeded',
];

const ACTIVE_JOB_STATUSES: ChaoxingJobStatus[] = ['queued', 'running', 'waiting_input'];

export function ensureChaoxingTables(ctx: Context): void {
  ctx.model.extend('chaoxing_bind_challenge', {
    id: 'unsigned', tokenHash: 'string', ownerKey: 'string', platform: 'string', qqUserId: 'string', channelId: 'string', status: 'string',
    bindingMode: { type: 'string', nullable: true }, qrUuid: { type: 'string', nullable: true }, qrEnc: { type: 'string', nullable: true },
    loginAttemptId: { type: 'string', nullable: true }, confirmCodeHash: { type: 'string', nullable: true },
    pendingConfirmCodeCipher: { type: 'text', nullable: true }, pendingConfirmCodeMeta: { type: 'text', nullable: true },
    pendingCookieJarCipher: { type: 'text', nullable: true }, pendingCredentialCipher: { type: 'text', nullable: true },
    pendingCredentialMeta: { type: 'text', nullable: true }, pendingProfileJson: { type: 'text', nullable: true },
    errorMessage: { type: 'text', nullable: true }, expiresAt: 'double', createdAt: 'double', updatedAt: 'double',
  }, { autoInc: true, unique: ['tokenHash'], indexes: [['ownerKey', 'status'], ['expiresAt']] });

  ctx.model.extend('chaoxing_session', {
    id: 'unsigned', ownerKey: 'string', platform: 'string', qqUserId: 'string', channelId: 'string', cookieJarCipher: 'text',
    profileJson: 'text', status: 'string', credentialVersion: { type: 'unsigned', nullable: true }, validatedAt: 'double',
    lastRefreshAt: { type: 'double', nullable: true }, lastFailureReason: { type: 'text', nullable: true },
    createdAt: 'double', updatedAt: 'double',
  }, { autoInc: true, unique: ['ownerKey'], indexes: [['status'], ['updatedAt']] });

  ctx.model.extend('chaoxing_credential', {
    id: 'unsigned', ownerKey: 'string', platform: 'string', qqUserId: 'string', serviceId: 'string',
    credentialCipher: 'text', credentialMeta: 'text', kekId: 'string', alg: 'string', version: 'unsigned',
    createdAt: 'double', updatedAt: 'double', lastUsedAt: { type: 'double', nullable: true },
    lastFailureReason: { type: 'text', nullable: true }, revokedAt: { type: 'double', nullable: true },
  }, { autoInc: true, unique: ['ownerKey'], indexes: [['ownerKey', 'serviceId'], ['revokedAt']] });

  ctx.model.extend('chaoxing_auth_audit', {
    id: 'unsigned', ownerKey: 'string', eventType: 'string', status: 'string', reason: { type: 'text', nullable: true }, createdAt: 'double',
  }, { autoInc: true, indexes: [['ownerKey'], ['eventType'], ['createdAt']] });

  ctx.model.extend('chaoxing_course', {
    id: 'unsigned', recordKey: 'string', ownerKey: 'string', credentialVersion: 'unsigned', courseId: 'string', classId: 'string', cpi: 'string',
    name: 'string', className: 'string', teacherName: 'string', schoolName: 'string', imageUrl: 'text', state: 'integer', isRetired: 'integer',
    sourceJson: 'text', firstSeenAt: 'double', lastSeenAt: 'double', createdAt: 'double', updatedAt: 'double',
  }, { autoInc: true, unique: ['recordKey'], indexes: [['ownerKey', 'credentialVersion'], ['courseId', 'classId'], ['lastSeenAt']] });

  ctx.model.extend('chaoxing_task_item', {
    id: 'unsigned', recordKey: 'string', ownerKey: 'string', credentialVersion: 'unsigned', kind: 'string', courseId: 'string', classId: 'string',
    remoteId: 'string', courseName: 'string', title: 'text', status: 'string', startAt: { type: 'double', nullable: true },
    endAt: { type: 'double', nullable: true }, score: { type: 'string', nullable: true }, sourceJson: 'text', sourceHash: 'string',
    firstSeenAt: 'double', lastSeenAt: 'double', notifiedAt: { type: 'double', nullable: true }, remindedAt: { type: 'double', nullable: true },
    createdAt: 'double', updatedAt: 'double',
  }, { autoInc: true, unique: ['recordKey'], indexes: [['ownerKey', 'kind'], ['ownerKey', 'endAt'], ['lastSeenAt']] });

  ctx.model.extend('chaoxing_job', {
    id: 'unsigned', ownerKey: 'string', platform: 'string', qqUserId: 'string', channelId: 'string', type: 'string', status: 'string',
    courseId: { type: 'string', nullable: true }, classId: { type: 'string', nullable: true }, courseQuery: { type: 'text', nullable: true },
    payloadJson: 'text', progressJson: 'text', resultJson: { type: 'text', nullable: true }, errorMessage: { type: 'text', nullable: true },
    runAfter: 'double', lockedAt: { type: 'double', nullable: true }, startedAt: { type: 'double', nullable: true }, finishedAt: { type: 'double', nullable: true },
    createdAt: 'double', updatedAt: 'double',
  }, { autoInc: true, indexes: [['ownerKey', 'status'], ['type', 'status', 'runAfter'], ['updatedAt']] });

  ctx.model.extend('chaoxing_job_event', {
    id: 'unsigned', jobId: 'unsigned', ownerKey: 'string', eventType: 'string', detailJson: 'text', createdAt: 'double',
  }, { autoInc: true, indexes: [['jobId'], ['ownerKey'], ['createdAt']] });

  ctx.model.extend('chaoxing_sign_record', {
    id: 'unsigned', ownerKey: 'string', jobId: { type: 'unsigned', nullable: true }, activityId: 'string', courseId: 'string', classId: 'string',
    signType: 'string', status: 'string', requestJson: 'text', responseText: 'text', createdAt: 'double',
  }, { autoInc: true, indexes: [['ownerKey', 'activityId'], ['jobId'], ['createdAt']] });

  ctx.model.extend('chaoxing_answer_cache', {
    id: 'unsigned', answerKey: 'string', questionType: 'string', title: 'text', optionsJson: 'text', answer: 'text', source: 'string',
    confidence: 'double', createdAt: 'double', updatedAt: 'double',
  }, { autoInc: true, unique: ['answerKey'], indexes: [['questionType'], ['updatedAt']] });

  ctx.model.extend('chaoxing_answer_record', {
    id: 'unsigned', ownerKey: 'string', jobId: 'unsigned', workId: 'string', questionId: 'string', questionType: 'string', title: 'text',
    answer: 'text', source: 'string', confidence: 'double', submitMode: 'string', resultStatus: 'string', resultMessage: 'text', createdAt: 'double',
  }, { autoInc: true, indexes: [['ownerKey', 'workId'], ['jobId'], ['createdAt']] });
}

export class ChaoxingTaskStore {
  constructor(private readonly database: DatabaseLike) {}

  async cleanupExpiredChallenges(now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', {
      status: { $in: ACTIVE_CHALLENGE_STATUSES }, expiresAt: { $lte: now },
    }, clearedChallengePatch('expired', now));
  }

  async cancelActiveChallenges(ownerKey: string, now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', {
      ownerKey, status: { $in: ACTIVE_CHALLENGE_STATUSES },
    }, clearedChallengePatch('cancelled', now));
  }

  async createChallenge(identity: OwnerIdentity, tokenHash: string, expiresAt: number, now: number): Promise<ChaoxingBindChallenge> {
    return this.database.create<ChaoxingBindChallenge>('chaoxing_bind_challenge', {
      tokenHash, ownerKey: identity.ownerKey, platform: identity.platform, qqUserId: identity.qqUserId, channelId: identity.channelId,
      status: 'created', bindingMode: null, qrUuid: null, qrEnc: null, loginAttemptId: null, confirmCodeHash: null,
      pendingConfirmCodeCipher: null, pendingConfirmCodeMeta: null, pendingCookieJarCipher: null, pendingCredentialCipher: null,
      pendingCredentialMeta: null, pendingProfileJson: null, errorMessage: null, expiresAt, createdAt: now, updatedAt: now,
    });
  }

  async findChallengeByTokenHash(tokenHash: string): Promise<ChaoxingBindChallenge | null> {
    const [row] = await this.database.get<ChaoxingBindChallenge>('chaoxing_bind_challenge', { tokenHash });
    return row ?? null;
  }

  async findLoginSucceededChallenge(ownerKey: string): Promise<ChaoxingBindChallenge | null> {
    const rows = await this.database.get<ChaoxingBindChallenge>('chaoxing_bind_challenge', { ownerKey, status: 'login_succeeded' });
    return latest(rows);
  }

  async findLatestChallenge(ownerKey: string): Promise<ChaoxingBindChallenge | null> {
    return latest(await this.database.get<ChaoxingBindChallenge>('chaoxing_bind_challenge', { ownerKey }));
  }

  async setChallengeQr(id: number, qrUuid: string, qrEnc: string, pendingCookieJarCipher: string, now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', { id, status: 'created' }, {
      status: 'qr_pending', bindingMode: 'qr', qrUuid, qrEnc, pendingCookieJarCipher, errorMessage: null, updatedAt: now,
    });
  }

  async markChallengeQrScanned(id: number, now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', { id, status: 'qr_pending' }, { status: 'qr_scanned', updatedAt: now });
  }

  async updateChallengeQrCookies(id: number, pendingCookieJarCipher: string, now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', { id, status: { $in: ['qr_pending', 'qr_scanned'] } }, {
      pendingCookieJarCipher, updatedAt: now,
    });
  }

  async resetChallengeQr(id: number, reason: string, now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', { id, status: { $in: ['qr_pending', 'qr_scanned'] } }, {
      status: 'created', bindingMode: null, qrUuid: null, qrEnc: null, pendingCookieJarCipher: null, errorMessage: reason, updatedAt: now,
    });
  }

  async claimChallengeLogin(id: number, expectedStatuses: ChaoxingBindStatus[], attemptId: string, mode: 'qr' | 'password', now: number): Promise<ChaoxingBindChallenge | null> {
    await this.database.set('chaoxing_bind_challenge', { id, status: { $in: expectedStatuses } }, {
      status: 'login_pending', bindingMode: mode, loginAttemptId: attemptId, errorMessage: null, updatedAt: now,
    });
    const [row] = await this.database.get<ChaoxingBindChallenge>('chaoxing_bind_challenge', { id, status: 'login_pending', loginAttemptId: attemptId });
    return row ?? null;
  }

  async completeChallengeLogin(id: number, attemptId: string, patch: Record<string, unknown>): Promise<boolean> {
    await this.database.set('chaoxing_bind_challenge', { id, status: 'login_pending', loginAttemptId: attemptId }, patch);
    const [row] = await this.database.get<ChaoxingBindChallenge>('chaoxing_bind_challenge', { id });
    return row?.status === 'login_succeeded' && row.loginAttemptId == null;
  }

  async releaseChallengeLogin(id: number, attemptId: string, reason: string, now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', { id, status: 'login_pending', loginAttemptId: attemptId }, {
      status: 'created', bindingMode: null, loginAttemptId: null, qrUuid: null, qrEnc: null, pendingCookieJarCipher: null,
      errorMessage: reason, updatedAt: now,
    });
  }

  async clearChallengeSecrets(id: number, status: ChaoxingBindStatus, now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', { id }, clearedChallengePatch(status, now));
  }

  async clearOwnerChallengeSecrets(ownerKey: string, now: number): Promise<void> {
    await this.database.set('chaoxing_bind_challenge', { ownerKey }, clearedChallengePatch('cancelled', now));
  }

  async saveSession(identity: OwnerIdentity, cookieJarCipher: string, profile: ChaoxingProfile, credentialVersion: number | null, now: number): Promise<void> {
    const [existing] = await this.database.get<ChaoxingSession>('chaoxing_session', { ownerKey: identity.ownerKey });
    const data = {
      platform: identity.platform, qqUserId: identity.qqUserId, channelId: identity.channelId, cookieJarCipher,
      profileJson: JSON.stringify(profile), status: 'active', credentialVersion, validatedAt: now,
      lastRefreshAt: null, lastFailureReason: null, updatedAt: now,
    };
    if (existing) await this.database.set('chaoxing_session', { id: existing.id }, data);
    else await this.database.create('chaoxing_session', { ownerKey: identity.ownerKey, ...data, createdAt: now });
  }

  async getSession(ownerKey: string): Promise<ChaoxingSession | null> {
    const [row] = await this.database.get<ChaoxingSession>('chaoxing_session', { ownerKey });
    return row ?? null;
  }

  async listActiveSessions(): Promise<ChaoxingSession[]> {
    return this.database.get<ChaoxingSession>('chaoxing_session', { status: 'active' });
  }

  async updateSessionCookie(ownerKey: string, cookieJarCipher: string, credentialVersion: number | null, now: number): Promise<void> {
    await this.database.set('chaoxing_session', { ownerKey }, {
      cookieJarCipher, credentialVersion, status: 'active', validatedAt: now, lastRefreshAt: now, lastFailureReason: null, updatedAt: now,
    });
  }

  async markSessionValidated(ownerKey: string, now: number): Promise<void> {
    await this.database.set('chaoxing_session', { ownerKey }, { status: 'active', validatedAt: now, lastFailureReason: null, updatedAt: now });
  }

  async setSessionStatus(ownerKey: string, status: ChaoxingSessionStatus, reason: string | null, now: number): Promise<void> {
    await this.database.set('chaoxing_session', { ownerKey }, { status, lastFailureReason: reason, updatedAt: now });
  }

  async removeSession(ownerKey: string): Promise<void> {
    await this.database.remove('chaoxing_session', { ownerKey });
  }

  async createCredentialShell(identity: OwnerIdentity, now: number): Promise<ChaoxingCredential> {
    const [existing] = await this.database.get<ChaoxingCredential>('chaoxing_credential', { ownerKey: identity.ownerKey });
    if (existing) {
      const version = existing.version + 1;
      return {
        ...existing,
        platform: identity.platform,
        qqUserId: identity.qqUserId,
        serviceId: CHAOXING_SERVICE_ID,
        version,
        revokedAt: null,
        updatedAt: now,
      };
    }
    return this.database.create<ChaoxingCredential>('chaoxing_credential', {
      ownerKey: identity.ownerKey, platform: identity.platform, qqUserId: identity.qqUserId, serviceId: CHAOXING_SERVICE_ID,
      credentialCipher: '', credentialMeta: '', kekId: '', alg: 'aes-256-gcm', version: 1,
      createdAt: now, updatedAt: now, lastUsedAt: null, lastFailureReason: null, revokedAt: null,
    });
  }

  async updateCredentialEnvelope(row: ChaoxingCredential, credentialCipher: string, credentialMeta: string, kekId: string, now: number): Promise<void> {
    await this.database.set('chaoxing_credential', { id: row.id }, {
      platform: row.platform, qqUserId: row.qqUserId, serviceId: CHAOXING_SERVICE_ID,
      credentialCipher, credentialMeta, kekId, alg: 'aes-256-gcm', version: row.version,
      revokedAt: null, updatedAt: now, lastFailureReason: null,
    });
  }

  async getActiveCredential(ownerKey: string): Promise<ChaoxingCredential | null> {
    const [row] = await this.database.get<ChaoxingCredential>('chaoxing_credential', { ownerKey, revokedAt: null });
    return row?.credentialCipher ? row : null;
  }

  async markCredentialUsed(id: number, now: number): Promise<void> {
    await this.database.set('chaoxing_credential', { id }, { lastUsedAt: now, lastFailureReason: null, updatedAt: now });
  }

  async markCredentialFailure(id: number, reason: string, now: number): Promise<void> {
    await this.database.set('chaoxing_credential', { id }, { lastFailureReason: reason, updatedAt: now });
  }

  async revokeCredential(ownerKey: string, now: number): Promise<void> {
    await this.database.set('chaoxing_credential', { ownerKey, revokedAt: null }, {
      credentialCipher: '', credentialMeta: '', revokedAt: now, updatedAt: now,
    });
  }

  async addAudit(row: Omit<ChaoxingAuthAudit, 'id'>): Promise<void> {
    await this.database.create('chaoxing_auth_audit', row);
  }

  async upsertCourses(ownerKey: string, credentialVersion: number, courses: ChaoxingCourse[], now: number): Promise<void> {
    for (const course of courses) {
      const recordKey = `${ownerKey}:${credentialVersion}:${course.courseId}:${course.classId}`;
      const [existing] = await this.database.get<ChaoxingCourseRow>('chaoxing_course', { recordKey });
      const data = { ...course, sourceJson: JSON.stringify(course), lastSeenAt: now, updatedAt: now };
      if (existing) await this.database.set('chaoxing_course', { id: existing.id }, data);
      else await this.database.create('chaoxing_course', { recordKey, ownerKey, credentialVersion, ...data, firstSeenAt: now, createdAt: now });
    }
  }

  async listCourses(ownerKey: string): Promise<ChaoxingCourseRow[]> {
    return this.database.get<ChaoxingCourseRow>('chaoxing_course', { ownerKey });
  }

  async replaceTaskSnapshot(ownerKey: string, credentialVersion: number, items: ChaoxingDeadlineItem[], sourceHash: (value: string) => string, now: number): Promise<ChaoxingTaskRow[]> {
    const created: ChaoxingTaskRow[] = [];
    for (const item of items) {
      const recordKey = `${ownerKey}:${credentialVersion}:${item.recordKey}`;
      const sourceJson = JSON.stringify(item.source);
      const hash = sourceHash(sourceJson);
      const { source: _source, recordKey: _remoteRecordKey, ...persistedItem } = item;
      const [existing] = await this.database.get<ChaoxingTaskRow>('chaoxing_task_item', { recordKey });
      const data = { ...persistedItem, recordKey, sourceJson, sourceHash: hash, lastSeenAt: now, updatedAt: now };
      if (existing) {
        await this.database.set('chaoxing_task_item', { id: existing.id }, data);
      } else {
        const row = await this.database.create<ChaoxingTaskRow>('chaoxing_task_item', {
          ownerKey, credentialVersion, ...data, firstSeenAt: now, notifiedAt: null, remindedAt: null, createdAt: now,
        });
        created.push(row);
      }
    }
    return created;
  }

  async listTasks(ownerKey: string, kind?: ChaoxingTaskKind): Promise<ChaoxingTaskRow[]> {
    return this.database.get<ChaoxingTaskRow>('chaoxing_task_item', kind ? { ownerKey, kind } : { ownerKey });
  }

  async pruneTasks(ownerKey: string, kinds: readonly ChaoxingTaskKind[], syncStartedAt: number): Promise<void> {
    if (kinds.length === 0) return;
    await this.database.remove('chaoxing_task_item', { ownerKey, kind: { $in: [...kinds] }, lastSeenAt: { $lt: syncStartedAt } });
  }

  async markTaskNotified(id: number, now: number): Promise<void> {
    await this.database.set('chaoxing_task_item', { id }, { notifiedAt: now, updatedAt: now });
  }

  async markTaskReminded(id: number, now: number): Promise<void> {
    await this.database.set('chaoxing_task_item', { id }, { remindedAt: now, updatedAt: now });
  }

  async createJob(identity: OwnerIdentity, type: ChaoxingJobType, args: {
    courseId?: string | null; classId?: string | null; courseQuery?: string | null; payload?: unknown; runAfter?: number;
  }, now: number): Promise<ChaoxingJob> {
    return this.database.create<ChaoxingJob>('chaoxing_job', {
      ownerKey: identity.ownerKey, platform: identity.platform, qqUserId: identity.qqUserId, channelId: identity.channelId,
      type, status: 'queued', courseId: args.courseId ?? null, classId: args.classId ?? null, courseQuery: args.courseQuery ?? null,
      payloadJson: JSON.stringify(args.payload ?? {}), progressJson: '{}', resultJson: null, errorMessage: null,
      runAfter: args.runAfter ?? now, lockedAt: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now,
    });
  }

  async getJob(id: number): Promise<ChaoxingJob | null> {
    const [row] = await this.database.get<ChaoxingJob>('chaoxing_job', { id });
    return row ?? null;
  }

  async listJobs(ownerKey: string): Promise<ChaoxingJob[]> {
    return this.database.get<ChaoxingJob>('chaoxing_job', { ownerKey });
  }

  async findActiveJob(ownerKey: string, type?: ChaoxingJobType): Promise<ChaoxingJob | null> {
    const rows = await this.database.get<ChaoxingJob>('chaoxing_job', type
      ? { ownerKey, type, status: { $in: ACTIVE_JOB_STATUSES } }
      : { ownerKey, status: { $in: ACTIVE_JOB_STATUSES } });
    return latest(rows);
  }

  async nextQueuedJob(now: number): Promise<ChaoxingJob | null> {
    const rows = await this.database.get<ChaoxingJob>('chaoxing_job', { status: 'queued', runAfter: { $lte: now } });
    return oldest(rows);
  }

  async markJobRunning(id: number, now: number): Promise<void> {
    await this.database.set('chaoxing_job', { id, status: 'queued' }, {
      status: 'running', lockedAt: now, startedAt: now, errorMessage: null, updatedAt: now,
    });
  }

  async updateJobProgress(id: number, progress: unknown, now: number): Promise<void> {
    await this.database.set('chaoxing_job', { id, status: 'running' }, { progressJson: JSON.stringify(progress), updatedAt: now });
  }

  async updateWaitingJobProgress(id: number, progress: unknown, now: number): Promise<void> {
    await this.database.set('chaoxing_job', { id, status: 'waiting_input' }, {
      progressJson: JSON.stringify(progress), updatedAt: now,
    });
  }

  async finishJob(id: number, status: Extract<ChaoxingJobStatus, 'waiting_input' | 'succeeded' | 'failed' | 'cancelled'>, args: {
    progress?: unknown; result?: unknown; errorMessage?: string | null;
  }, now: number): Promise<void> {
    const patch: Record<string, unknown> = {
      status,
      resultJson: args.result === undefined ? null : JSON.stringify(args.result), errorMessage: args.errorMessage ?? null,
      lockedAt: null, finishedAt: status === 'waiting_input' ? null : now, updatedAt: now,
    };
    if (args.progress !== undefined) patch.progressJson = JSON.stringify(args.progress);
    await this.database.set('chaoxing_job', { id, status: { $in: ['queued', 'running', 'waiting_input'] } }, patch);
  }

  async resumeJob(id: number, now: number): Promise<void> {
    await this.database.set('chaoxing_job', { id, status: { $in: ['waiting_input', 'failed', 'cancelled'] } }, {
      status: 'queued', runAfter: now, lockedAt: null, finishedAt: null, errorMessage: null, updatedAt: now,
    });
  }

  async rescheduleJob(id: number, progress: unknown, runAfter: number, now: number): Promise<void> {
    await this.database.set('chaoxing_job', { id, status: 'running' }, {
      status: 'queued', progressJson: JSON.stringify(progress), runAfter, lockedAt: null, updatedAt: now,
    });
  }

  async cancelJobs(ownerKey: string, type: ChaoxingJobType | null, now: number): Promise<void> {
    await this.database.set('chaoxing_job', type
      ? { ownerKey, type, status: { $in: ACTIVE_JOB_STATUSES } }
      : { ownerKey, status: { $in: ACTIVE_JOB_STATUSES } }, {
      status: 'cancelled', lockedAt: null, finishedAt: now, updatedAt: now,
    });
  }

  async recoverInterruptedJobs(now: number): Promise<void> {
    await this.database.set('chaoxing_job', { status: 'running' }, {
      status: 'queued', lockedAt: null, runAfter: now, errorMessage: 'worker_restarted', updatedAt: now,
    });
  }

  async appendJobEvent(jobId: number, ownerKey: string, eventType: string, detail: unknown, now: number): Promise<void> {
    await this.database.create<ChaoxingJobEvent>('chaoxing_job_event', {
      jobId, ownerKey, eventType, detailJson: JSON.stringify(detail), createdAt: now,
    });
  }

  async addSignRecord(row: Omit<ChaoxingSignRecord, 'id'>): Promise<void> {
    await this.database.create('chaoxing_sign_record', row);
  }

  async getAnswerCache(answerKey: string): Promise<ChaoxingAnswerCache | null> {
    const [row] = await this.database.get<ChaoxingAnswerCache>('chaoxing_answer_cache', { answerKey });
    return row ?? null;
  }

  async upsertAnswerCache(row: Omit<ChaoxingAnswerCache, 'id' | 'createdAt' | 'updatedAt'>, now: number): Promise<void> {
    const existing = await this.getAnswerCache(row.answerKey);
    if (existing) await this.database.set('chaoxing_answer_cache', { id: existing.id }, { ...row, updatedAt: now });
    else await this.database.create('chaoxing_answer_cache', { ...row, createdAt: now, updatedAt: now });
  }

  async removeAnswerCache(answerKey: string): Promise<void> {
    await this.database.remove('chaoxing_answer_cache', { answerKey });
  }

  async addAnswerRecord(row: Omit<ChaoxingAnswerRecord, 'id'>): Promise<void> {
    await this.database.create('chaoxing_answer_record', row);
  }

  async listWrongAnswers(ownerKey: string): Promise<ChaoxingAnswerRecord[]> {
    return this.database.get<ChaoxingAnswerRecord>('chaoxing_answer_record', {
      ownerKey, resultStatus: { $in: ['wrong', 'partial'] },
    });
  }

  async removeOwnerData(ownerKey: string): Promise<void> {
    await Promise.all([
      this.database.remove('chaoxing_course', { ownerKey }),
      this.database.remove('chaoxing_task_item', { ownerKey }),
      this.database.remove('chaoxing_job', { ownerKey }),
      this.database.remove('chaoxing_job_event', { ownerKey }),
      this.database.remove('chaoxing_sign_record', { ownerKey }),
      this.database.remove('chaoxing_answer_record', { ownerKey }),
    ]);
  }
}

function clearedChallengePatch(status: ChaoxingBindStatus, now: number): Record<string, unknown> {
  return {
    status, bindingMode: null, qrUuid: null, qrEnc: null, loginAttemptId: null, confirmCodeHash: null,
    pendingConfirmCodeCipher: null, pendingConfirmCodeMeta: null, pendingCookieJarCipher: null,
    pendingCredentialCipher: null, pendingCredentialMeta: null, pendingProfileJson: null, errorMessage: null, updatedAt: now,
  };
}

function latest<T extends { updatedAt: number }>(rows: T[]): T | null {
  return [...rows].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null;
}

function oldest<T extends { createdAt: number }>(rows: T[]): T | null {
  return [...rows].sort((left, right) => left.createdAt - right.createdAt)[0] ?? null;
}
