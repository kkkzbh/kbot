#!/usr/bin/env node

function fail(message) {
  console.error(`[admin-config] ${message}`);
  process.exit(2);
}

const rawOrigin = process.env.QQBOT_ADMIN_ORIGIN;
if (!rawOrigin) fail('QQBOT_ADMIN_ORIGIN is required');
if (rawOrigin === 'https://admin.example.com') {
  fail('QQBOT_ADMIN_ORIGIN still contains the example placeholder');
}

let origin;
try {
  origin = new URL(rawOrigin);
} catch {
  fail('QQBOT_ADMIN_ORIGIN must be an absolute HTTP or HTTPS origin');
}

if (
  !['http:', 'https:'].includes(origin.protocol)
  || origin.username
  || origin.password
  || origin.pathname !== '/'
  || origin.search
  || origin.hash
  || origin.origin !== rawOrigin.replace(/\/$/, '')
) {
  fail('QQBOT_ADMIN_ORIGIN must contain only scheme, host, and optional port');
}

console.log('[admin-config] origin verified');
