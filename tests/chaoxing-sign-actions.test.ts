import QRCode from 'qrcode';
import { describe, expect, it, vi } from 'vitest';
import { ChaoxingOwnerCoordinator } from '../src/plugins/chaoxing/owner-coordinator.js';
import {
  ChaoxingSignActionService,
  parseSignQrPayload,
} from '../src/plugins/chaoxing/sign-action-service.js';
import type { ChaoxingSignType, DetectedSign } from '../src/plugins/chaoxing/sign-service.js';
import { ChaoxingProtocolError, ChaoxingUserError, type ChaoxingSignAction, type OwnerIdentity } from '../src/plugins/chaoxing/types.js';
import { renderChaoxingSignActionPage } from '../src/plugins/chaoxing/web/sign-action-page.js';

const NOW = Date.parse('2026-07-15T10:00:00+08:00');
const identity: OwnerIdentity = {
  ownerKey: 'onebot:10001', platform: 'onebot', qqUserId: '10001', channelId: 'group:1',
};

describe('chaoxing activity-scoped sign actions', () => {
  it('creates a separate forwardable bearer link and consumes it once', async () => {
    const store = createMemoryActionStore();
    let finishExecution!: () => void;
    const executionGate = new Promise<void>((resolve) => { finishExecution = resolve; });
    const signService = {
      resolveDetectedSignForAction: vi.fn().mockResolvedValue(makeDetectedSign('normal')),
      execute: vi.fn().mockImplementation(async () => {
        await executionGate;
        return { status: 'succeeded', officialStatus: 1, message: '测试课程 / 普通签到：签到成功（官方状态：已签到）。' };
      }),
    };
    const service = makeActionService(store, signService);
    const [link] = await service.createActions(identity, [makeDetectedSign('normal')]);
    expect(link?.link).toMatch(/^https:\/\/jw\.example\.com\/chaoxing\/sign-action\?token=/u);
    const token = new URL(link!.link).searchParams.get('token')!;

    const first = service.submit(token, {});
    await vi.waitFor(() => expect(signService.execute).toHaveBeenCalledTimes(1));
    await expect(service.submit(token, {})).rejects.toThrow('正在处理');
    finishExecution();

    await expect(first).resolves.toMatchObject({ action: { status: 'completed' } });
    await expect(service.submit(token, {})).resolves.toMatchObject({ action: { status: 'completed' } });
    expect(signService.execute).toHaveBeenCalledTimes(1);
  });

  it('releases safe validation failures and locks uncertain post-submit outcomes', async () => {
    const store = createMemoryActionStore();
    const signService = {
      resolveDetectedSignForAction: vi.fn().mockResolvedValue(makeDetectedSign('code')),
      execute: vi.fn()
        .mockRejectedValueOnce(new ChaoxingUserError('签到码或手势顺序不正确。'))
        .mockRejectedValueOnce(new ChaoxingProtocolError('sign_verification_failed', '官方状态尚未确认。')),
    };
    const service = makeActionService(store, signService);
    const [link] = await service.createActions(identity, [makeDetectedSign('code')]);
    const token = new URL(link!.link).searchParams.get('token')!;

    await expect(service.submit(token, { body: { signCode: '1111' } })).rejects.toThrow('不正确');
    await expect(service.resolvePage(token)).resolves.toMatchObject({
      action: { status: 'created', errorMessage: '签到码或手势顺序不正确。' },
    });

    await expect(service.submit(token, { body: { signCode: '2222' } })).rejects.toThrow('尚未确认');
    await expect(service.resolvePage(token)).resolves.toMatchObject({
      action: { status: 'uncertain', resultMessage: '官方状态尚未确认。' },
    });
    await expect(service.submit(token, { body: { signCode: '2222' } })).resolves.toMatchObject({ action: { status: 'uncertain' } });
    expect(signService.execute).toHaveBeenCalledTimes(2);
  });

  it('decodes a photographed dynamic QR and validates its activity binding', async () => {
    const store = createMemoryActionStore();
    const detected = makeDetectedSign('qrcode', { ifRefreshQr: true });
    const signService = {
      resolveDetectedSignForAction: vi.fn().mockResolvedValue(detected),
      execute: vi.fn().mockResolvedValue({ status: 'succeeded', officialStatus: 1, message: '二维码签到成功。' }),
    };
    const service = makeActionService(store, signService);
    const [link] = await service.createActions(identity, [detected]);
    const token = new URL(link!.link).searchParams.get('token')!;
    const bytes = await QRCode.toBuffer('SIGNIN:aid=activity-1&source=15&Code=live-code&enc=live-enc', { type: 'png', width: 420 });

    await service.submit(token, { image: { bytes, contentType: 'image/png', filename: 'qr.png' } });

    expect(signService.execute).toHaveBeenCalledWith(identity, detected, {
      kind: 'qrcode', enc: 'live-enc', code: 'live-code', location: undefined,
    });
    expect(parseSignQrPayload('https://example.com/sign?activeId=activity-1&enc=e&Code=c', 'activity-1')).toEqual({ enc: 'e', code: 'c' });
    expect(() => parseSignQrPayload('SIGNIN:aid=other&enc=e', 'activity-1')).toThrow('另一个签到活动');
  });

  it('renders type-specific mobile controls without exposing bound identity data', () => {
    const action = makeActionRow('qrcode');
    const html = renderChaoxingSignActionPage({
      token: 't'.repeat(43),
      submitPath: '/chaoxing/sign-action',
      nonce: 'nonce-value',
      state: {
        action,
        metadata: {
          dynamicQr: true,
          targetLocation: { text: '河北大学坤舆园', latitude: 38.8894, longitude: 115.5789, rangeMeters: 100 },
          activityEndAt: null,
        },
      },
    });

    expect(html).toContain('<video id="qr-video" autoplay playsinline muted>');
    expect(html).toContain('打开后置摄像头');
    expect(html).toContain('扫描当前画面并签到');
    expect(html).toContain('动态二维码');
    expect(html).toContain('河北大学坤舆园');
    expect(html).toContain('转发此签到链接');
    expect(html).toContain("navigator.mediaDevices?.getUserMedia");
    expect(html).not.toContain('id="qr-image"');
    expect(html).not.toContain(action.ownerKey);
    expect(html).not.toContain(action.qqUserId);
    expect(html).not.toContain(action.tokenHash);
    expect(() => new Function(inlineClientScript(html))).not.toThrow();
  });

  it('renders a drawable nine-point gesture board that submits the point sequence', () => {
    const html = renderChaoxingSignActionPage({
      token: 't'.repeat(43),
      submitPath: '/chaoxing/sign-action',
      nonce: 'nonce-value',
      state: {
        action: makeActionRow('gesture'),
        metadata: { dynamicQr: false, targetLocation: null, activityEndAt: null },
      },
    });

    expect(html).toContain('aria-label="九宫格手势板"');
    expect(html).toContain('data-point="1"');
    expect(html).toContain('data-point="9"');
    expect(html).toContain('跨过中间圆点时会自动补入');
    expect(html).toContain("signCode:gesturePattern.join('')");
    expect(html).toContain('清除重画');
    expect(html).toContain('校验手势并签到');
    expect(html).not.toContain('id="sign-code"');
  });
});

function makeActionService(store: ReturnType<typeof createMemoryActionStore>, signService: Record<string, unknown>) {
  return new ChaoxingSignActionService(
    store as never,
    signService as never,
    new ChaoxingOwnerCoordinator(),
    { publicBaseUrl: 'https://jw.example.com', actionPagePath: '/chaoxing/sign-action', actionTokenTtlMs: 600_000 },
    () => NOW,
  );
}

function inlineClientScript(html: string): string {
  const match = html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/u);
  expect(match).not.toBeNull();
  return match![1]!;
}

function makeDetectedSign(signType: ChaoxingSignType, overrides: { ifRefreshQr?: boolean } = {}): DetectedSign {
  const otherId = { normal: '0', photo: '1', qrcode: '2', gesture: '3', location: '4', code: '5', unknown: '' }[signType];
  return {
    course: {
      courseId: 'course-1', classId: 'class-1', cpi: 'cpi-1', name: '测试课程', className: '', teacherName: '', schoolName: '', imageUrl: '', state: 1, isRetired: 0,
    },
    activity: {
      activityId: 'activity-1', courseId: 'course-1', classId: 'class-1', title: `${signType} 签到`, activityType: 2,
      signTypeCode: otherId, status: 1, userStatus: 0, startAt: NOW - 60_000, endAt: NOW + 3_600_000, ext: '{}', raw: {},
    },
    signType,
    info: {
      otherId, ifPhoto: signType === 'photo', ifNeedVCode: false, openCheckFaceFlag: false,
      ifRefreshQr: overrides.ifRefreshQr ?? false,
      locationText: signType === 'location' ? '河北大学坤舆园' : '',
      locationLatitude: signType === 'location' ? 38.8894 : null,
      locationLongitude: signType === 'location' ? 115.5789 : null,
      locationRangeMeters: signType === 'location' ? 100 : null,
      startAt: NOW - 60_000, endAt: NOW + 3_600_000, raw: {},
    },
    attendance: { status: 0 },
  };
}

function makeActionRow(signType: ChaoxingSignType): ChaoxingSignAction {
  return {
    id: 1, tokenHash: 'secret-hash', ownerKey: identity.ownerKey, platform: identity.platform,
    qqUserId: identity.qqUserId, channelId: identity.channelId, activityId: 'activity-1', courseId: 'course-1', classId: 'class-1',
    courseName: '测试课程', activityTitle: '动态二维码签到', signType, status: 'created', attemptId: null,
    metadataJson: '{}', resultMessage: null, errorMessage: null, expiresAt: NOW + 600_000, createdAt: NOW, updatedAt: NOW,
  };
}

function createMemoryActionStore() {
  const rows: ChaoxingSignAction[] = [];
  return {
    rows,
    async cleanupExpiredSignActions(now: number) {
      for (const row of rows) if (row.status === 'created' && row.expiresAt <= now) row.status = 'expired';
    },
    async findSubmittingSignAction(ownerKey: string, activityId: string) {
      return rows.find((row) => row.ownerKey === ownerKey && row.activityId === activityId && row.status === 'submitting') ?? null;
    },
    async cancelOpenSignActions(ownerKey: string, activityId: string, now: number) {
      for (const row of rows) {
        if (row.ownerKey === ownerKey && row.activityId === activityId && row.status === 'created') {
          row.status = 'cancelled'; row.updatedAt = now;
        }
      }
    },
    async createSignAction(owner: OwnerIdentity, input: Omit<ChaoxingSignAction, 'id' | 'ownerKey' | 'platform' | 'qqUserId' | 'channelId' | 'status' | 'attemptId' | 'resultMessage' | 'errorMessage' | 'createdAt' | 'updatedAt'>, now: number) {
      const row: ChaoxingSignAction = {
        id: rows.length + 1, ...owner, ...input, status: 'created', attemptId: null,
        resultMessage: null, errorMessage: null, createdAt: now, updatedAt: now,
      };
      rows.push(row);
      return row;
    },
    async findSignActionByTokenHash(tokenHash: string) {
      return rows.find((row) => row.tokenHash === tokenHash) ?? null;
    },
    async claimSignAction(id: number, attemptId: string, now: number) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.status !== 'created' || row.expiresAt <= now) return null;
      row.status = 'submitting'; row.attemptId = attemptId; row.updatedAt = now;
      return row;
    },
    async releaseSignAction(id: number, attemptId: string, errorMessage: string, now: number) {
      const row = rows.find((candidate) => candidate.id === id && candidate.status === 'submitting' && candidate.attemptId === attemptId);
      if (row) { row.status = 'created'; row.attemptId = null; row.errorMessage = errorMessage; row.updatedAt = now; }
    },
    async completeSignAction(id: number, attemptId: string, resultMessage: string, now: number) {
      const row = rows.find((candidate) => candidate.id === id && candidate.status === 'submitting' && candidate.attemptId === attemptId);
      if (!row) return false;
      row.status = 'completed'; row.attemptId = null; row.resultMessage = resultMessage; row.errorMessage = null; row.updatedAt = now;
      return true;
    },
    async finishSignActionUncertain(id: number, attemptId: string, resultMessage: string, now: number) {
      const row = rows.find((candidate) => candidate.id === id && candidate.status === 'submitting' && candidate.attemptId === attemptId);
      if (row) { row.status = 'uncertain'; row.attemptId = null; row.resultMessage = resultMessage; row.errorMessage = null; row.updatedAt = now; }
    },
  };
}
