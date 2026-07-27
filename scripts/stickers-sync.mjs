#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const rootDir = process.cwd()
loadDotenv(resolveBotEnvPath())

const adminOrigin = requireOrigin(process.env.QQBOT_ADMIN_ORIGIN)
const apiBase = `${adminOrigin}/api/admin/v1`

async function main() {
  const maintenanceResponse = await fetch(
    `${apiBase}/models/maintenance/sticker-index`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: adminOrigin,
      },
      body: '{}',
    },
  )
  const result = await readJsonResponse(
    maintenanceResponse,
    'trigger sticker index maintenance',
  )
  process.stdout.write(
    `[stickers:sync] indexed=${result.indexed} reused=${result.reused} total=${result.total} model=${result.model}\n`,
  )
}

function resolveBotEnvPath() {
  const explicit = String(process.env.QQBOT_ENV_FILE || '').trim()
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.resolve(rootDir, explicit)
  }

  const localEnv = path.resolve(rootDir, '.env.local')
  if (existsSync(localEnv)) return localEnv

  const serverEnv = path.resolve(rootDir, '.env.server')
  if (existsSync(serverEnv)) return serverEnv

  return localEnv
}

function loadDotenv(envPath) {
  if (!existsSync(envPath)) return

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index < 0) continue

    const key = trimmed.slice(0, index).trim()
    if (!key || process.env[key] != null) continue
    process.env[key] = stripQuotes(trimmed.slice(index + 1).trim())
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function requireOrigin(value) {
  const normalized = requireValue(value, 'QQBOT_ADMIN_ORIGIN')
  const url = new URL(normalized)
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
  ) {
    throw new Error('QQBOT_ADMIN_ORIGIN must be an HTTP(S) origin without a path')
  }
  return url.origin
}

function requireValue(value, name) {
  const normalized = String(value || '').trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

async function assertSuccess(response, operation) {
  if (response.ok) return
  const details = await readFailure(response)
  throw new Error(`${operation} failed: status=${response.status}${details}`)
}

async function readJsonResponse(response, operation) {
  await assertSuccess(response, operation)
  const contentType = String(response.headers.get('content-type') || '')
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new Error(`${operation} returned a non-JSON response`)
  }
  return response.json()
}

async function readFailure(response) {
  const contentType = String(response.headers.get('content-type') || '')
  if (!contentType.toLowerCase().includes('application/json')) return ''
  try {
    const payload = await response.json()
    const code = String(payload?.error?.code || '').trim()
    const message = String(payload?.error?.message || '').trim()
    return `${code ? ` code=${code}` : ''}${message ? ` message=${message}` : ''}`
  } catch {
    return ''
  }
}

main().catch((error) => {
  process.stderr.write(
    `[stickers:sync] failed: ${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
