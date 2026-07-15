import { CampusAuthUserError, type CampusLocation } from '../campus-auth-core/index.js';

export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface GeoRange extends GeoPoint {
  radius: number;
  label: string;
}

const EARTH_RADIUS_METERS = 6_371_000;
const PI = Math.PI;
const X_PI = PI * 3000 / 180;
const GCJ_A = 6_378_245;
const GCJ_EE = 0.006693421622965943;

export function requireUsableLocation(location: CampusLocation, maxAccuracy = 200): void {
  if (location.accuracy > maxAccuracy) {
    throw new CampusAuthUserError(`当前定位精度约 ${Math.round(location.accuracy)} 米，请开启手机精确定位后重试。`);
  }
}

export function wgs84ToBd09(point: GeoPoint): GeoPoint {
  const gcj = wgs84ToGcj02(point);
  const z = Math.sqrt(gcj.longitude ** 2 + gcj.latitude ** 2) + 0.00002 * Math.sin(gcj.latitude * X_PI);
  const theta = Math.atan2(gcj.latitude, gcj.longitude) + 0.000003 * Math.cos(gcj.longitude * X_PI);
  return {
    longitude: z * Math.cos(theta) + 0.0065,
    latitude: z * Math.sin(theta) + 0.006,
  };
}

export function distanceMeters(left: GeoPoint, right: GeoPoint): number {
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const a = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function nearestRange(point: GeoPoint, ranges: readonly GeoRange[]): { range: GeoRange; distance: number } {
  if (!ranges.length) throw new CampusAuthUserError('活动未配置有效的签到范围，请联系活动负责人。');
  return ranges
    .map((range) => ({ range, distance: distanceMeters(point, range) }))
    .sort((left, right) => left.distance - right.distance)[0]!;
}

function wgs84ToGcj02(point: GeoPoint): GeoPoint {
  let latitudeDelta = transformLatitude(point.longitude - 105, point.latitude - 35);
  let longitudeDelta = transformLongitude(point.longitude - 105, point.latitude - 35);
  const radianLatitude = point.latitude / 180 * PI;
  let magic = Math.sin(radianLatitude);
  magic = 1 - GCJ_EE * magic * magic;
  const squareRootMagic = Math.sqrt(magic);
  latitudeDelta = latitudeDelta * 180 / ((GCJ_A * (1 - GCJ_EE)) / (magic * squareRootMagic) * PI);
  longitudeDelta = longitudeDelta * 180 / (GCJ_A / squareRootMagic * Math.cos(radianLatitude) * PI);
  return {
    latitude: point.latitude + latitudeDelta,
    longitude: point.longitude + longitudeDelta,
  };
}

function transformLatitude(longitude: number, latitude: number): number {
  let value = -100 + 2 * longitude + 3 * latitude + 0.2 * latitude ** 2 + 0.1 * longitude * latitude + 0.2 * Math.sqrt(Math.abs(longitude));
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3;
  value += (20 * Math.sin(latitude * PI) + 40 * Math.sin(latitude / 3 * PI)) * 2 / 3;
  value += (160 * Math.sin(latitude / 12 * PI) + 320 * Math.sin(latitude * PI / 30)) * 2 / 3;
  return value;
}

function transformLongitude(longitude: number, latitude: number): number {
  let value = 300 + longitude + 2 * latitude + 0.1 * longitude ** 2 + 0.1 * longitude * latitude + 0.1 * Math.sqrt(Math.abs(longitude));
  value += (20 * Math.sin(6 * longitude * PI) + 20 * Math.sin(2 * longitude * PI)) * 2 / 3;
  value += (20 * Math.sin(longitude * PI) + 40 * Math.sin(longitude / 3 * PI)) * 2 / 3;
  value += (150 * Math.sin(longitude / 12 * PI) + 300 * Math.sin(longitude / 30 * PI)) * 2 / 3;
  return value;
}

function radians(value: number): number {
  return value * PI / 180;
}
