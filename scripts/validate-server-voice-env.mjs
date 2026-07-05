#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function parseEnv(content) {
  const env = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const matched = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!matched) continue;
    env[matched[1]] = matched[2];
  }
  return env;
}

function isEnabled(value) {
  return String(value ?? 'true').trim().toLowerCase() !== 'false';
}

function isLoopbackUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.trim().toLowerCase();
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return /:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(url);
  }
}

function fail(message) {
  console.error(`[voice-env] ${message}`);
  process.exit(1);
}

const envPath = process.argv[2];
if (!envPath) {
  fail('usage: node scripts/validate-server-voice-env.mjs <env-file>');
}

const content = readFileSync(resolve(envPath), 'utf8');
const env = parseEnv(content);
const inputEnabled = isEnabled(env.QQ_VOICE_INPUT_ENABLED);
const outputEnabled = isEnabled(env.QQ_VOICE_OUTPUT_ENABLED);
const ttsBaseUrl = String(env.QQ_VOICE_TTS_BASE_URL ?? '').trim();
const ttsApiKey = String(env.QQ_VOICE_TTS_API_KEY ?? '').trim();

if (inputEnabled) {
  fail('server runtime does not support QQ_VOICE_INPUT_ENABLED=true. Keep voice input disabled on the server.');
}

if (!outputEnabled) {
  process.exit(0);
}

if (!ttsBaseUrl) {
  fail('QQ_VOICE_OUTPUT_ENABLED=true but QQ_VOICE_TTS_BASE_URL is empty.');
}

if (!ttsApiKey) {
  fail('QQ_VOICE_OUTPUT_ENABLED=true but QQ_VOICE_TTS_API_KEY is empty.');
}

if (isLoopbackUrl(ttsBaseUrl)) {
  fail('server QQ_VOICE_TTS_BASE_URL must point to laptop Tailnet TTS, not 127.0.0.1/localhost.');
}
