import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  const raw = await readTextIfExists(filePath);
  if (!raw) return null;
  return parseJson<T>(raw, filePath);
}

export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await mkdir(dirname(filePath), { recursive: true });
  try {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
