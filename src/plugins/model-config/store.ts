import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { ModelConfigError, asModelConfigError } from './errors.js';
import type { ModelConfigOperation } from './errors.js';
import {
  modelConfigDocumentSchema,
  type ModelConfigDocument,
} from './types.js';

export async function readModelConfigDocument(
  path: string,
  operation: Extract<ModelConfigOperation, 'load' | 'save' | 'apply'> = 'load',
): Promise<ModelConfigDocument> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) {
      throw new ModelConfigError({
        code: 'config_not_found',
        operation,
        stage: 'read',
        path,
        message: `model config does not exist: ${path}`,
        cause: error,
      });
    }
    throw asModelConfigError(error, {
      code: 'storage_failed',
      operation,
      stage: 'read',
      path,
      message: `failed to read model config: ${path}`,
    });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ModelConfigError({
      code: 'schema_invalid',
      operation,
      stage: 'parse',
      path,
      message: `model config is not valid JSON: ${path}`,
      cause: error,
    });
  }

  try {
    return modelConfigDocumentSchema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ModelConfigError({
        code: 'schema_invalid',
        operation,
        stage: 'validate',
        path,
        message: `model config validation failed at ${formatFirstIssue(error)}: ${path}`,
        cause: error,
      });
    }
    throw error;
  }
}

export async function assertModelConfigDoesNotExist(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw asModelConfigError(error, {
      code: 'storage_failed',
      operation: 'initialize',
      stage: 'read',
      path,
      message: `failed to inspect model config path: ${path}`,
    });
  }
  throw new ModelConfigError({
    code: 'config_already_exists',
    operation: 'initialize',
    stage: 'compare',
    path,
    message: `model config already exists: ${path}`,
  });
}

export async function writeModelConfigDocumentAtomic(
  path: string,
  document: ModelConfigDocument,
  operation: Extract<ModelConfigOperation, 'initialize' | 'save' | 'apply'> = 'save',
): Promise<void> {
  const parsed = modelConfigDocumentSchema.parse(document);
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
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isNodeError(cleanupError, 'ENOENT')) {
          // The original persistence failure is authoritative.
        }
      }
    }
    throw asModelConfigError(error, {
      code: 'storage_failed',
      operation,
      stage: 'persist',
      path,
      message: `failed to atomically persist model config: ${path}`,
    });
  }
}

function formatFirstIssue(error: ZodError): string {
  const [issue] = error.issues;
  if (!issue) return '<document>';
  return issue.path.length > 0 ? issue.path.join('.') : '<document>';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
