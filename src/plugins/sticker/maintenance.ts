import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { z } from 'zod';
import {
  ModelConfigError,
  type ModelRuntimeClient,
} from '../model-config/index.js';
import {
  STICKER_CATALOG_FILENAME,
  mimeFromExtension,
  type StickerCatalogDocument,
  type StickerCatalogEntry,
} from './selection.js';

const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_STICKER_IMAGE_BYTES = 10 * 1024 * 1024;

const stickerMetadataSchema = z.object({
  caption: z.string().trim().min(1).max(240),
  keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  moods: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
  scenes: z.array(z.string().trim().min(1).max(120)).min(1).max(8),
  historyLabel: z.string().trim().min(1).max(80),
  confidence: z.number().min(0).max(1),
}).strict();

const stickerCatalogEntrySchema = stickerMetadataSchema.extend({
  id: z.string().trim().min(1).max(120),
  file: z.string().trim().min(1).max(512),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  scopes: z.array(z.string().trim().min(1).max(160)).min(1),
}).strict();

const stickerCatalogDocumentSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  model: z.string().trim().min(1),
  entries: z.array(stickerCatalogEntrySchema),
}).strict();

const STICKER_METADATA_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'caption',
    'keywords',
    'moods',
    'scenes',
    'historyLabel',
    'confidence',
  ],
  properties: {
    caption: { type: 'string', minLength: 1, maxLength: 240 },
    keywords: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 80 },
    },
    moods: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 80 },
    },
    scenes: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    historyLabel: { type: 'string', minLength: 1, maxLength: 80 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

export interface StickerIndexMaintenanceResult {
  generatedAt: string;
  model: string;
  indexed: number;
  reused: number;
  total: number;
}

export interface StickerMaintenanceServiceLike {
  runIndex(): Promise<StickerIndexMaintenanceResult>;
}

type StickerSource = {
  absolutePath: string;
  relativePath: string;
  hash: string;
  mime: StickerCatalogEntry['mime'];
  scopes: string[];
  id: string;
  bytes: Buffer;
};

export interface StickerMaintenanceServiceOptions {
  stickerDir: string;
  modelRuntime: ModelRuntimeClient;
  now?: () => Date;
  onCatalogWritten?: () => void;
}

export class StickerMaintenanceService implements StickerMaintenanceServiceLike {
  private readonly stickerDir: string;
  private readonly modelRuntime: ModelRuntimeClient;
  private readonly now: () => Date;
  private readonly onCatalogWritten: () => void;
  private activeRun: Promise<StickerIndexMaintenanceResult> | null = null;

  constructor(options: StickerMaintenanceServiceOptions) {
    this.stickerDir = resolve(options.stickerDir);
    this.modelRuntime = options.modelRuntime;
    this.now = options.now ?? (() => new Date());
    this.onCatalogWritten = options.onCatalogWritten ?? (() => {});
  }

  runIndex(): Promise<StickerIndexMaintenanceResult> {
    if (this.activeRun) {
      throw new ModelConfigError({
        code: 'runtime_operation_invalid',
        operation: 'execute',
        stage: 'validate',
        workload: 'sticker.index',
        message: 'sticker index maintenance is already running',
      });
    }

    const run = this.executeIndex();
    this.activeRun = run;
    void run.then(
      () => {
        if (this.activeRun === run) this.activeRun = null;
      },
      () => {
        if (this.activeRun === run) this.activeRun = null;
      },
    );
    return run;
  }

  private async executeIndex(): Promise<StickerIndexMaintenanceResult> {
    const resolvedBinding = this.modelRuntime.resolve('sticker.index');
    if (!resolvedBinding.target) {
      throw new ModelConfigError({
        code: 'runtime_operation_invalid',
        operation: 'execute',
        stage: 'validate',
        workload: 'sticker.index',
        message: 'sticker index maintenance is disabled',
      });
    }

    const [sources, existingByFile] = await Promise.all([
      this.readSources(),
      this.readExistingCatalog(),
    ]);
    const entries: StickerCatalogEntry[] = [];
    let indexed = 0;
    let reused = 0;

    for (const source of sources) {
      const existing = existingByFile.get(source.relativePath);
      if (existing?.hash === source.hash) {
        entries.push({
          ...existing,
          id: source.id,
          file: source.relativePath,
          mime: source.mime,
          scopes: source.scopes,
        });
        reused += 1;
        continue;
      }

      const metadata = await this.describeSource(source);
      entries.push({
        id: source.id,
        file: source.relativePath,
        hash: source.hash,
        mime: source.mime,
        scopes: source.scopes,
        ...metadata,
      });
      indexed += 1;
    }

    const generatedAt = this.now().toISOString();
    const document = stickerCatalogDocumentSchema.parse({
      version: 1,
      generatedAt,
      model: resolvedBinding.target.canonicalModel,
      entries,
    }) as StickerCatalogDocument;
    await writeCatalogAtomic(
      join(this.stickerDir, STICKER_CATALOG_FILENAME),
      document,
    );
    this.onCatalogWritten();

    return {
      generatedAt,
      model: resolvedBinding.target.canonicalModel,
      indexed,
      reused,
      total: entries.length,
    };
  }

  private async readSources(): Promise<StickerSource[]> {
    const imageRoot = join(this.stickerDir, 'images');
    const files = await listStickerFiles(imageRoot);
    const sources: StickerSource[] = [];
    const ids = new Set<string>();

    for (const absolutePath of files.sort()) {
      const relativeToImages = toPosixPath(relative(imageRoot, absolutePath));
      const relativePath = `images/${relativeToImages}`;
      const bytes = await readFile(absolutePath);
      if (bytes.byteLength > MAX_STICKER_IMAGE_BYTES) {
        throw maintenanceError(
          `sticker image exceeds ${MAX_STICKER_IMAGE_BYTES} bytes: ${relativePath}`,
        );
      }
      const hash = sha256(bytes);
      const id = createStickerId(relativePath);
      if (ids.has(id)) {
        throw maintenanceError(`duplicate sticker identity: ${id}`);
      }
      ids.add(id);
      sources.push({
        absolutePath,
        relativePath,
        hash,
        id,
        mime: parseStickerMime(absolutePath),
        scopes: resolveStickerScopes(relativeToImages),
        bytes,
      });
    }
    return sources;
  }

  private async readExistingCatalog(): Promise<Map<string, StickerCatalogEntry>> {
    const catalogPath = join(this.stickerDir, STICKER_CATALOG_FILENAME);
    let text: string;
    try {
      text = await readFile(catalogPath, 'utf8');
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return new Map();
      throw maintenanceError(`failed to read sticker catalog: ${catalogPath}`, error);
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw maintenanceError(`sticker catalog is not valid JSON: ${catalogPath}`, error);
    }

    const document = stickerCatalogDocumentSchema.safeParse(value);
    if (!document.success) {
      throw maintenanceError(
        `sticker catalog validation failed at ${formatFirstIssue(document.error)}: ${catalogPath}`,
        document.error,
      );
    }
    return new Map(document.data.entries.map((entry) => [entry.file, entry]));
  }

  private async describeSource(source: StickerSource) {
    const dataUrl = `data:${source.mime};base64,${source.bytes.toString('base64')}`;
    const response = await this.modelRuntime.executeChat({
      workload: 'sticker.index',
      request: {
        temperature: 0,
        maxOutputTokens: 512,
        structuredOutput: {
          name: 'sticker_metadata',
          schema: STICKER_METADATA_JSON_SCHEMA,
          strict: true,
        },
        messages: [
          {
            role: 'system',
            content:
              '你是表情包索引器。准确描述图片的聊天语义，并严格返回指定 JSON schema。',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  '为这张聊天表情包生成检索元数据。caption 是简短概括；keywords、moods、scenes 各给 1 到 8 个短语；historyLabel 是极短中文标签；confidence 是 0 到 1。',
              },
              {
                type: 'imageUrl',
                url: dataUrl,
                detail: 'low',
              },
            ],
          },
        ],
      },
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch (error) {
      throw maintenanceError(
        `sticker model returned invalid JSON for ${source.relativePath}`,
        error,
      );
    }
    const metadata = stickerMetadataSchema.safeParse(parsed);
    if (!metadata.success) {
      throw maintenanceError(
        `sticker metadata validation failed at ${formatFirstIssue(metadata.error)} for ${source.relativePath}`,
        metadata.error,
      );
    }
    return metadata.data;
  }
}

async function listStickerFiles(directory: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw maintenanceError(`failed to read sticker image directory: ${directory}`, error);
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listStickerFiles(absolutePath));
      continue;
    }
    if (
      entry.isFile()
      && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())
    ) {
      files.push(absolutePath);
    }
  }
  return files;
}

function resolveStickerScopes(relativeToImages: string): string[] {
  if (relativeToImages.startsWith('global/')) return ['global'];
  const matched = /^personas\/([^/]+)\//.exec(relativeToImages);
  const presetId = matched?.[1]?.trim();
  if (presetId) return [`persona:${presetId}`];
  throw maintenanceError(
    `unsupported sticker scope path: images/${relativeToImages}`,
  );
}

function createStickerId(relativePath: string): string {
  const stem = relativePath.slice(0, -extname(relativePath).length);
  const label = basename(stem)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  const identityHash = sha256(Buffer.from(relativePath)).slice(0, 12);
  return `${label || 'sticker'}-${identityHash}`;
}

function parseStickerMime(filePath: string): StickerCatalogEntry['mime'] {
  const mime = mimeFromExtension(filePath);
  if (
    mime === 'image/png'
    || mime === 'image/jpeg'
    || mime === 'image/gif'
    || mime === 'image/webp'
  ) {
    return mime;
  }
  throw maintenanceError(`unsupported sticker MIME: ${filePath}`);
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function toPosixPath(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

async function writeCatalogAtomic(
  catalogPath: string,
  document: StickerCatalogDocument,
): Promise<void> {
  const directory = dirname(catalogPath);
  const temporaryPath = join(
    directory,
    `.${basename(catalogPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;

  try {
    await mkdir(directory, { recursive: true });
    const file = await open(
      temporaryPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      await file.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, catalogPath);
    temporaryCreated = false;
    const directoryHandle = await open(directory, fsConstants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    if (temporaryCreated) {
      try {
        await unlink(temporaryPath);
      } catch {
        // The original persistence error remains authoritative.
      }
    }
    throw maintenanceError(
      `failed to atomically persist sticker catalog: ${catalogPath}`,
      error,
    );
  }
}

function maintenanceError(message: string, cause?: unknown): ModelConfigError {
  return new ModelConfigError({
    code: 'runtime_operation_invalid',
    operation: 'execute',
    stage: 'validate',
    workload: 'sticker.index',
    message,
    cause,
  });
}

function formatFirstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return '<document>';
  return issue.path.length > 0 ? issue.path.join('.') : '<document>';
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
