#!/usr/bin/env node

function fail(message) {
  console.error(`[admin-config] ${message}`);
  process.exit(2);
}

function requireSecret(name, minimumLength, placeholder) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  if (value === placeholder) fail(`${name} still contains the example placeholder`);
  if (value.length < minimumLength) fail(`${name} must contain at least ${minimumLength} characters`);
}

requireSecret('QQBOT_ADMIN_ACCESS_TOKEN', 16, 'replace-with-at-least-16-characters');
requireSecret('QQBOT_ADMIN_SESSION_SECRET', 32, 'replace-with-at-least-32-random-characters');

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

console.log('[admin-config] credentials and origin verified');
