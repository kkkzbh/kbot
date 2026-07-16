import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROFILE_VERSION = 1;

export interface GenshinDeviceProfile {
  version: typeof PROFILE_VERSION;
  deviceId: string;
  fingerprintDeviceId: string;
  deviceName: string;
  productName: string;
  deviceFp: string;
}

export interface GenshinDeviceProfileStoreLike {
  readonly profile: GenshinDeviceProfile;
  saveDeviceFp(deviceFp: string): void;
}

export class GenshinDeviceProfileStore implements GenshinDeviceProfileStoreLike {
  readonly profile: GenshinDeviceProfile;

  constructor(private readonly path: string) {
    this.profile = existsSync(path) ? readProfile(path) : createProfile();
    if (!existsSync(path)) this.save();
  }

  saveDeviceFp(deviceFp: string): void {
    const normalized = deviceFp.trim();
    if (!normalized) throw new Error('genshin device_fp must not be empty.');
    this.profile.deviceFp = normalized;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.profile)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.path);
  }
}

export function createMemoryGenshinDeviceProfileStore(deviceId: string = randomUUID()): GenshinDeviceProfileStoreLike {
  const profile = createProfile(deviceId);
  return {
    profile,
    saveDeviceFp(deviceFp: string): void {
      const normalized = deviceFp.trim();
      if (!normalized) throw new Error('genshin device_fp must not be empty.');
      profile.deviceFp = normalized;
    },
  };
}

export function genshinDeviceProfilePath(credentialKekPath: string): string {
  return join(dirname(credentialKekPath), 'genshin-device-profile.json');
}

function createProfile(deviceId: string = randomUUID()): GenshinDeviceProfile {
  return {
    version: PROFILE_VERSION,
    deviceId,
    fingerprintDeviceId: randomBytes(8).toString('hex'),
    deviceName: randomText(12),
    productName: randomText(6),
    deviceFp: '',
  };
}

function readProfile(path: string): GenshinDeviceProfile {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<GenshinDeviceProfile>;
  if (
    value.version !== PROFILE_VERSION
    || !isNonEmptyString(value.deviceId)
    || !isNonEmptyString(value.fingerprintDeviceId)
    || !isNonEmptyString(value.deviceName)
    || !isNonEmptyString(value.productName)
    || typeof value.deviceFp !== 'string'
  ) {
    throw new Error(`invalid genshin device profile: ${path}`);
  }
  return value as GenshinDeviceProfile;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function randomText(length: number): string {
  return randomBytes(length).toString('base64url').toUpperCase().slice(0, length);
}
