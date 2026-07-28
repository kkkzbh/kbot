import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ZodError } from 'zod';
import { NaturalTriggerConfigError } from './errors.js';
import {
  naturalTriggerConfigDocumentSchema,
  type NaturalTriggerConfigDocument,
} from './types.js';

export async function readNaturalTriggerConfigDocument(
  path: string,
): Promise<NaturalTriggerConfigDocument> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new NaturalTriggerConfigError(
        'config_not_found',
        `natural trigger config does not exist: ${path}`,
        { path, stage: 'read', cause: error },
      );
    }
    throw new NaturalTriggerConfigError(
      'storage_failed',
      `failed to read natural trigger config: ${path}`,
      { path, stage: 'read', cause: error },
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new NaturalTriggerConfigError(
      'schema_invalid',
      `natural trigger config is not valid JSON: ${path}`,
      { path, stage: 'parse', cause: error },
    );
  }

  try {
    return naturalTriggerConfigDocumentSchema.parse(value);
  } catch (error) {
    const location = error instanceof ZodError && error.issues[0]?.path.length
      ? error.issues[0].path.join('.')
      : '<document>';
    throw new NaturalTriggerConfigError(
      'schema_invalid',
      `natural trigger config validation failed at ${location}: ${path}`,
      { path, stage: 'validate', cause: error },
    );
  }
}

export async function writeNaturalTriggerConfigDocumentAtomic(
  path: string,
  document: NaturalTriggerConfigDocument,
): Promise<void> {
  const parsed = naturalTriggerConfigDocumentSchema.parse(document);
  const directory = dirname(path);
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;

  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      await file.writeFile(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    throw new NaturalTriggerConfigError(
      'storage_failed',
      `failed to atomically persist natural trigger config: ${path}`,
      { path, stage: 'persist', cause: error },
    );
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
