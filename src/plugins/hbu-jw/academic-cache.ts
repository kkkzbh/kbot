import { createHash } from 'node:crypto';
import { HbuJwLoginError, type HbuJwHttpClient } from './jw-client.js';
import type { HbuJwStore, HbuJwAcademicItemInput } from './store.js';
import type {
  HbuJwAcademicDataKind,
  HbuJwCourseSelectionResult,
  HbuJwExamPlanEvent,
  HbuJwScheduleCourse,
  HbuJwScoreRow,
  HbuJwSubitemScoreLookParams,
  HbuJwSubitemScoreLookResult,
  HbuJwSubitemScoreTerm,
  HbuJwThisSemesterSchedule,
  HbuJwThisTermScoreRow,
  OwnerIdentity,
  SerializedCookieJar,
} from './types.js';

const DAY_MS = 86_400_000;
export const HBU_JW_DATABASE_FALLBACK_MAX_AGE_MS = 183 * DAY_MS;

export type HbuJwAcademicQuerySource = 'remote' | 'database';

export interface HbuJwAcademicAuthenticatedSession {
  cookieJar: SerializedCookieJar;
  credentialVersion?: number;
}

export interface HbuJwAcademicQueryPolicy {
  fallbackMaxAgeMs: number | null;
}

export interface HbuJwAcademicQueryResult<T> {
  data: T;
  source: HbuJwAcademicQuerySource;
  fetchedAt: number;
  failureReason?: string;
}

export class HbuJwAcademicCache {
  constructor(
    private readonly store: HbuJwStore,
    private readonly jwClient: Pick<
      HbuJwHttpClient,
      | 'getAllPassingScores'
      | 'getThisTermScores'
      | 'getSubitemScoreTerms'
      | 'getSubitemScoreDetails'
      | 'getCourseSelectionResult'
      | 'getThisSemesterSchedule'
      | 'getExamSchedule'
    >,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getAllPassingScores(
    identity: OwnerIdentity,
    auth: HbuJwAcademicAuthenticatedSession,
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<HbuJwAcademicQueryResult<HbuJwScoreRow[]>> {
    return this.getList(
      identity,
      auth,
      'passing_score',
      'all',
      () => this.jwClient.getAllPassingScores(auth.cookieJar),
      passingScoreKeyParts,
      policy,
    );
  }

  async getThisTermScores(
    identity: OwnerIdentity,
    auth: HbuJwAcademicAuthenticatedSession,
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<HbuJwAcademicQueryResult<HbuJwThisTermScoreRow[]>> {
    return this.getList(
      identity,
      auth,
      'term_score',
      'current',
      () => this.jwClient.getThisTermScores(auth.cookieJar),
      thisTermScoreKeyParts,
      policy,
    );
  }

  async getSubitemScoreTerms(
    identity: OwnerIdentity,
    auth: HbuJwAcademicAuthenticatedSession,
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<HbuJwAcademicQueryResult<HbuJwSubitemScoreTerm[]>> {
    return this.getList(
      identity,
      auth,
      'subitem_term',
      'all',
      () => this.jwClient.getSubitemScoreTerms(auth.cookieJar),
      (row) => [row.code],
      policy,
    );
  }

  async getSubitemScoreDetails(
    identity: OwnerIdentity,
    auth: HbuJwAcademicAuthenticatedSession,
    params: HbuJwSubitemScoreLookParams,
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<HbuJwAcademicQueryResult<HbuJwSubitemScoreLookResult>> {
    const scopeKey = subitemDetailScopeKey(params);
    const credentialVersion = requireCredentialVersion(auth);
    const now = this.now();
    await this.store.beginAcademicSync(identity.ownerKey, credentialVersion, 'subitem_detail', scopeKey, now);
    try {
      const result = await this.jwClient.getSubitemScoreDetails(auth.cookieJar, params);
      await this.syncList(identity, credentialVersion, 'subitem_detail', scopeKey, result.rows, (row) => [
        params.zxjxjhh,
        params.kch,
        params.kxh,
        params.kssj,
        params.kcsxdm,
        readNestedText(row, 'id', 'executiveEducationPlanNumber'),
        readNestedText(row, 'id', 'courseNumber'),
        row.coureSequenceNumber,
        readNestedText(row, 'id', 'examtime'),
        readNestedText(row, 'id', 'studentNumber'),
        canonicalScoreTypeCode(readNestedText(row, 'id', 'scoreTypeCode')),
      ], now);
      return { data: result, source: 'remote', fetchedAt: now };
    } catch (error) {
      const reason = describeError(error);
      await this.store.failAcademicSync(identity.ownerKey, credentialVersion, 'subitem_detail', scopeKey, reason, now);
      const rows = await this.readList<HbuJwSubitemScoreLookResult['rows'][number]>(
        identity.ownerKey,
        credentialVersion,
        'subitem_detail',
        scopeKey,
        policy,
      );
      if (!rows) throw error;
      return {
        data: { params, rows: rows.data, message: '' },
        source: 'database',
        fetchedAt: rows.fetchedAt,
        failureReason: reason,
      };
    }
  }

  async getThisSemesterSchedule(
    identity: OwnerIdentity,
    auth: HbuJwAcademicAuthenticatedSession,
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<HbuJwAcademicQueryResult<HbuJwThisSemesterSchedule>> {
    const credentialVersion = requireCredentialVersion(auth);
    const now = this.now();
    await Promise.all([
      this.store.beginAcademicSync(identity.ownerKey, credentialVersion, 'schedule_header', 'current', now),
      this.store.beginAcademicSync(identity.ownerKey, credentialVersion, 'schedule_course', 'current', now),
    ]);
    try {
      const schedule = await this.jwClient.getThisSemesterSchedule(auth.cookieJar);
      const header = {
        executiveEducationPlanNumber: schedule.executiveEducationPlanNumber,
        programPlanName: schedule.programPlanName,
        totalUnits: schedule.totalUnits,
      };
      await this.syncList(identity, credentialVersion, 'schedule_header', 'current', [header], () => ['current'], now);
      await this.syncList(identity, credentialVersion, 'schedule_course', 'current', schedule.courses, scheduleCourseKeyParts, now);
      return { data: schedule, source: 'remote', fetchedAt: now };
    } catch (error) {
      const reason = describeError(error);
      await Promise.all([
        this.store.failAcademicSync(identity.ownerKey, credentialVersion, 'schedule_header', 'current', reason, now),
        this.store.failAcademicSync(identity.ownerKey, credentialVersion, 'schedule_course', 'current', reason, now),
      ]);
      const [headerRows, courseRows] = await Promise.all([
        this.readList<Pick<HbuJwThisSemesterSchedule, 'executiveEducationPlanNumber' | 'programPlanName' | 'totalUnits'>>(
          identity.ownerKey,
          credentialVersion,
          'schedule_header',
          'current',
          policy,
        ),
        this.readList<HbuJwScheduleCourse>(
          identity.ownerKey,
          credentialVersion,
          'schedule_course',
          'current',
          policy,
        ),
      ]);
      const header = headerRows?.data[0];
      if (!header || !courseRows) throw error;
      return {
        data: { ...header, courses: courseRows.data },
        source: 'database',
        fetchedAt: Math.min(headerRows.fetchedAt, courseRows.fetchedAt),
        failureReason: reason,
      };
    }
  }

  async getCourseSelectionResult(
    identity: OwnerIdentity,
    auth: HbuJwAcademicAuthenticatedSession,
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<HbuJwAcademicQueryResult<HbuJwCourseSelectionResult>> {
    const result = await this.getList(
      identity,
      auth,
      'course_selection_result',
      'current',
      async () => [await this.jwClient.getCourseSelectionResult(auth.cookieJar)],
      () => ['current'],
      policy,
    );
    const selection = result.data[0];
    if (!selection) {
      throw new Error('course selection result snapshot is empty.');
    }
    return { ...result, data: selection };
  }

  async getExamSchedule(
    identity: OwnerIdentity,
    auth: HbuJwAcademicAuthenticatedSession,
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<HbuJwAcademicQueryResult<HbuJwExamPlanEvent[]>> {
    return this.getList(
      identity,
      auth,
      'exam_event',
      'current',
      () => this.jwClient.getExamSchedule(auth.cookieJar),
      examEventKeyParts,
      policy,
    );
  }

  private async getList<T>(
    identity: OwnerIdentity,
    auth: HbuJwAcademicAuthenticatedSession,
    dataKind: HbuJwAcademicDataKind,
    scopeKey: string,
    fetchRemote: () => Promise<T[]>,
    keyParts: (row: T, index: number) => unknown[],
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<HbuJwAcademicQueryResult<T[]>> {
    const credentialVersion = requireCredentialVersion(auth);
    const now = this.now();
    await this.store.beginAcademicSync(identity.ownerKey, credentialVersion, dataKind, scopeKey, now);
    try {
      const rows = await fetchRemote();
      await this.syncList(identity, credentialVersion, dataKind, scopeKey, rows, keyParts, now);
      return { data: rows, source: 'remote', fetchedAt: now };
    } catch (error) {
      const reason = describeError(error);
      await this.store.failAcademicSync(identity.ownerKey, credentialVersion, dataKind, scopeKey, reason, now);
      const cached = await this.readList<T>(identity.ownerKey, credentialVersion, dataKind, scopeKey, policy);
      if (!cached) throw error;
      return {
        data: cached.data,
        source: 'database',
        fetchedAt: cached.fetchedAt,
        failureReason: reason,
      };
    }
  }

  private async syncList<T>(
    identity: OwnerIdentity,
    credentialVersion: number,
    dataKind: HbuJwAcademicDataKind,
    scopeKey: string,
    rows: T[],
    keyParts: (row: T, index: number) => unknown[],
    now: number,
  ): Promise<void> {
    const duplicateCounts = new Map<string, number>();
    const items = rows.map<HbuJwAcademicItemInput>((row, index) => {
      const parts = keyParts(row, index);
      const baseKey = hashValue(parts);
      const duplicateIndex = duplicateCounts.get(baseKey) ?? 0;
      duplicateCounts.set(baseKey, duplicateIndex + 1);
      const sourceHash = hashValue(row);
      return {
        recordKey: recordKey(identity.ownerKey, credentialVersion, dataKind, scopeKey, [...parts, duplicateIndex]),
        rawJson: serializeJson(row),
        sourceHash,
        position: index,
      };
    });
    await this.store.replaceAcademicItems(identity.ownerKey, credentialVersion, dataKind, scopeKey, items, now);
    await this.store.completeAcademicSync(
      identity.ownerKey,
      credentialVersion,
      dataKind,
      scopeKey,
      rows.length,
      hashValue(items.map((item) => item.sourceHash)),
      now,
    );
  }

  private async readList<T>(
    ownerKey: string,
    credentialVersion: number,
    dataKind: HbuJwAcademicDataKind,
    scopeKey: string,
    policy: HbuJwAcademicQueryPolicy,
  ): Promise<{ data: T[]; fetchedAt: number } | null> {
    if (policy.fallbackMaxAgeMs == null) return null;
    const minFetchedAt = this.now() - policy.fallbackMaxAgeMs;
    const rows = await this.store.listAcademicItems(
      ownerKey,
      credentialVersion,
      dataKind,
      scopeKey,
      minFetchedAt,
    );
    if (rows.length === 0) {
      const state = await this.store.getAcademicSyncState(ownerKey, credentialVersion, dataKind, scopeKey);
      if (state?.lastSucceededAt != null && state.lastSucceededAt >= minFetchedAt && state.rowCount === 0) {
        return { data: [], fetchedAt: state.lastSucceededAt };
      }
      return null;
    }
    return {
      data: rows.map((row) => JSON.parse(row.rawJson) as T),
      fetchedAt: Math.min(...rows.map((row) => row.fetchedAt)),
    };
  }
}

export function hbuJwDatabaseFallbackPolicy(): HbuJwAcademicQueryPolicy {
  return { fallbackMaxAgeMs: HBU_JW_DATABASE_FALLBACK_MAX_AGE_MS };
}

export function formatAcademicFallbackNotice(results: Array<HbuJwAcademicQueryResult<unknown> | null | undefined>): string | null {
  const databaseResults = results.filter((result): result is HbuJwAcademicQueryResult<unknown> => result?.source === 'database');
  if (databaseResults.length === 0) return null;
  const fetchedAt = Math.min(...databaseResults.map((result) => result.fetchedAt));
  return `实时查询失败，以下为数据库记录（更新于 ${formatShanghaiTime(fetchedAt)}）。`;
}

function requireCredentialVersion(auth: HbuJwAcademicAuthenticatedSession): number {
  const version = auth.credentialVersion;
  if (!Number.isInteger(version) || version == null || version < 1) {
    throw new Error('authenticated hbu-jw session is missing credential version.');
  }
  return version;
}

function passingScoreKeyParts(row: HbuJwScoreRow): unknown[] {
  const id = isRecord(row.id) ? row.id : {};
  return [
    id.executiveEducationPlanNumber,
    id.courseNumber,
    id.coureSequenceNumber,
    id.examtime ?? id.examTime ?? id.startTime ?? row.examTime,
    row.academicYearCode,
    row.termName,
    row.xkcsxdm ?? row.courseAttributeCode,
    row.courseName,
  ];
}

function thisTermScoreKeyParts(row: HbuJwThisTermScoreRow): unknown[] {
  return [
    row.id?.executiveEducationPlanNumber,
    row.id?.courseNumber,
    row.coureSequenceNumber,
    row.id?.examtime,
    row.id?.studentNumber,
    row.coursePropertyCode,
    row.termName,
    row.courseName,
  ];
}

function scheduleCourseKeyParts(row: HbuJwScheduleCourse): unknown[] {
  return [
    row.executiveEducationPlanNumber,
    row.courseNumber,
    row.sequenceNumber,
    row.courseName,
  ];
}

function examEventKeyParts(row: HbuJwExamPlanEvent): unknown[] {
  return [row.start, row.title, row.color];
}

function subitemDetailScopeKey(params: HbuJwSubitemScoreLookParams): string {
  return hashValue([params.zxjxjhh, params.kch, params.kxh, params.kssj, params.kcsxdm]);
}

function recordKey(
  ownerKey: string,
  credentialVersion: number,
  dataKind: HbuJwAcademicDataKind,
  scopeKey: string,
  parts: unknown[],
): string {
  return `${dataKind}:${hashValue([ownerKey, credentialVersion, scopeKey, parts])}`;
}

function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value) ?? 'null';
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNestedText(value: unknown, parent: string, key: string): string {
  if (!isRecord(value) || !isRecord(value[parent])) return '';
  return String(value[parent][key] ?? '').trim();
}

function canonicalScoreTypeCode(value: string): string {
  return value === '1' ? '001' : value;
}

function describeError(error: unknown): string {
  if (error instanceof HbuJwLoginError) {
    return `${error.name}[${error.code}]: ${error.message}; ${error.diagnostic}`.slice(0, 500);
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 500);
  return String(error).slice(0, 500);
}

function formatShanghaiTime(value: number): string {
  const date = new Date(value + 8 * 60 * 60 * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
