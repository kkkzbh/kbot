#!/usr/bin/env node

function fail(message) {
  console.error(`[admin-config] ${message}`);
  process.exit(2);
}

function requireOrigin(name, placeholder) {
  const rawOrigin = process.env[name];
  if (!rawOrigin) fail(`${name} is required`);
  if (rawOrigin === placeholder) fail(`${name} still contains the example placeholder`);

  let origin;
  try {
    origin = new URL(rawOrigin);
  } catch {
    fail(`${name} must be an absolute HTTP or HTTPS origin`);
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
    fail(`${name} must contain only scheme, host, and optional port`);
  }
  return origin;
}

requireOrigin('QQBOT_ADMIN_ORIGIN', 'https://admin.example.com');
const sshOrigin = requireOrigin('QQBOT_ADMIN_SSH_ORIGIN');
if (sshOrigin.protocol !== 'http:' || sshOrigin.hostname !== '127.0.0.1') {
  fail('QQBOT_ADMIN_SSH_ORIGIN must use http://127.0.0.1 with the forwarded local port');
}

console.log('[admin-config] browser and SSH origins verified');
