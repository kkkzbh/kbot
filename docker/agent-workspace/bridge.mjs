import { spawn } from 'node:child_process'
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'

const input = JSON.parse(await new Promise((resolve, reject) => {
  const chunks = []
  process.stdin.on('data', (chunk) => chunks.push(chunk))
  process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  process.stdin.on('error', reject)
}))

const target = path.posix.resolve('/workspace', input.path ?? '.')
if (target !== '/workspace' && !target.startsWith('/workspace/')) {
  throw new Error(`Path "${input.path}" is outside /workspace.`)
}

async function checkExisting(file) {
  const resolved = await realpath(file)
  if (resolved !== '/workspace' && !resolved.startsWith('/workspace/')) {
    throw new Error(`Path "${file}" resolves outside /workspace.`)
  }
  return resolved
}

async function checkParent(file) {
  await mkdir(path.posix.dirname(file), { recursive: true })
  await checkExisting(path.posix.dirname(file))
}

function run(file, args, cwd) {
  return new Promise((resolve, reject) => {
    const stdout = []
    const stderr = []
    const child = spawn(file, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve({
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

let output

if (input.operation === 'health') {
  output = { ok: true }
} else if (input.operation === 'mkdir') {
  await mkdir(target, { recursive: true })
  await checkExisting(target)
  output = { ok: true }
} else if (input.operation === 'read') {
  await checkExisting(target)
  const info = await stat(target)
  if (info.isDirectory()) {
    output = {
      text: (await readdir(target, { withFileTypes: true }))
        .map((entry) => `${path.posix.join(target, entry.name)}${entry.isDirectory() ? '/' : ''}`)
        .join('\n'),
    }
  } else {
    const lines = (await readFile(target, 'utf8')).split('\n')
    const start = input.offset == null ? 0 : Math.max(0, input.offset - 1)
    const end = input.limit == null ? lines.length : Math.min(lines.length, start + input.limit)
    output = {
      text: lines
        .slice(start, end)
        .map((line, index) => `${start + index + 1}: ${line.length > 2000 ? line.slice(0, 2000) : line}`)
        .join('\n'),
    }
  }
} else if (input.operation === 'write') {
  await checkParent(target)
  await writeFile(target, Buffer.from(input.content, input.encoding))
  await checkExisting(target)
  output = { ok: true }
} else if (input.operation === 'edit') {
  await checkExisting(target)
  const content = await readFile(target, 'utf8')
  const matches = content.split(input.oldString).length - 1
  if (matches === 0) {
    output = { success: false, context: '', replacements: 0 }
  } else {
    if (input.replaceCount === 1 && matches !== 1) {
      throw new Error('Found multiple matches for oldString.')
    }
    let count = 0
    const edited = content.replaceAll(input.oldString, (value) => {
      if (input.replaceCount != null && count >= input.replaceCount) return value
      count += 1
      return input.newString
    })
    await writeFile(target, edited)
    output = { success: true, context: edited.slice(0, 4000), replacements: count }
  }
} else if (input.operation === 'grep') {
  await checkExisting(target)
  const args = ['-n', '--hidden', '--no-ignore', '--color', 'never']
  if (input.include) args.push('-g', input.include)
  args.push('-e', input.pattern, '.')
  const result = await run('rg', args, target)
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr)
  output = {
    files: result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => path.posix.join(target, line)),
  }
} else if (input.operation === 'glob') {
  await checkExisting(target)
  const result = await run('rg', ['--files', '--hidden', '--no-ignore', '-g', input.pattern, '.'], target)
  if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr)
  output = {
    files: result.stdout
      .split('\n')
      .filter(Boolean)
      .map((file) => path.posix.resolve(target, file)),
  }
} else if (input.operation === 'asset') {
  await checkExisting(target)
  const data = await readFile(target)
  output = { data: data.toString('base64'), size: data.length }
} else {
  throw new Error(`Unsupported Workspace operation: ${input.operation}`)
}

process.stdout.write(JSON.stringify(output))
