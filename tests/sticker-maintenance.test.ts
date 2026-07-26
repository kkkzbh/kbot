import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelRuntimeClient } from '../src/plugins/model-config/index.js';
import {
  StickerMaintenanceService,
} from '../src/plugins/sticker/maintenance.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    )),
  );
});

describe('sticker maintenance service', () => {
  it('indexes new images through the sticker.index binding and atomically publishes a catalog', async () => {
    const stickerDir = await createStickerDirectory();
    await writeFile(join(stickerDir, 'images/global/wave.png'), Buffer.from('png'));
    const executeChat = vi.fn<ModelRuntimeClient['executeChat']>(async (_input) => ({
      text: JSON.stringify(validMetadata()),
    }));
    const onCatalogWritten = vi.fn();
    const service = new StickerMaintenanceService({
      stickerDir,
      modelRuntime: createRuntime(executeChat),
      now: () => new Date('2026-07-26T12:00:00.000Z'),
      onCatalogWritten,
    });

    const result = await service.runIndex();
    const catalog = JSON.parse(
      await readFile(join(stickerDir, 'catalog.generated.json'), 'utf8'),
    );

    expect(result).toEqual({
      generatedAt: '2026-07-26T12:00:00.000Z',
      model: 'qqbot-primary/vision',
      indexed: 1,
      reused: 0,
      total: 1,
    });
    expect(catalog).toEqual({
      version: 1,
      generatedAt: '2026-07-26T12:00:00.000Z',
      model: 'qqbot-primary/vision',
      entries: [
        expect.objectContaining({
          file: 'images/global/wave.png',
          mime: 'image/png',
          scopes: ['global'],
          caption: '挥手打招呼',
        }),
      ],
    });
    expect(catalog.entries[0].id).toMatch(/^wave-[a-f0-9]{12}$/);
    expect(executeChat).toHaveBeenCalledOnce();
    expect(executeChat.mock.calls[0]?.[0]).toMatchObject({
      workload: 'sticker.index',
      request: {
        structuredOutput: {
          name: 'sticker_metadata',
          strict: true,
        },
        messages: [
          { role: 'system' },
          {
            role: 'user',
            content: [
              { type: 'text' },
              {
                type: 'imageUrl',
                url: 'data:image/png;base64,cG5n',
                detail: 'low',
              },
            ],
          },
        ],
      },
    });
    expect(onCatalogWritten).toHaveBeenCalledOnce();
  });

  it('reuses hash-identical entries without calling the model', async () => {
    const stickerDir = await createStickerDirectory();
    await writeFile(join(stickerDir, 'images/personas/sakiko/cold.webp'), Buffer.from('webp'));
    const firstRuntime = createRuntime(vi.fn(async () => ({
      text: JSON.stringify(validMetadata()),
    })));
    await new StickerMaintenanceService({
      stickerDir,
      modelRuntime: firstRuntime,
    }).runIndex();

    const executeChat = vi.fn(async () => {
      throw new Error('model must not be called for unchanged images');
    });
    const result = await new StickerMaintenanceService({
      stickerDir,
      modelRuntime: createRuntime(executeChat),
    }).runIndex();
    const catalog = JSON.parse(
      await readFile(join(stickerDir, 'catalog.generated.json'), 'utf8'),
    );

    expect(result).toMatchObject({ indexed: 0, reused: 1, total: 1 });
    expect(executeChat).not.toHaveBeenCalled();
    expect(catalog.entries[0]).toMatchObject({
      file: 'images/personas/sakiko/cold.webp',
      mime: 'image/webp',
      scopes: ['persona:sakiko'],
    });
  });

  it('keeps the previous catalog intact when model indexing fails', async () => {
    const stickerDir = await createStickerDirectory();
    const imagePath = join(stickerDir, 'images/global/fail.png');
    await writeFile(imagePath, Buffer.from('old'));
    await new StickerMaintenanceService({
      stickerDir,
      modelRuntime: createRuntime(vi.fn(async () => ({
        text: JSON.stringify(validMetadata()),
      }))),
    }).runIndex();
    const before = await readFile(join(stickerDir, 'catalog.generated.json'), 'utf8');
    await writeFile(imagePath, Buffer.from('changed'));

    const service = new StickerMaintenanceService({
      stickerDir,
      modelRuntime: createRuntime(vi.fn(async () => {
        throw new Error('upstream unavailable');
      })),
    });

    await expect(service.runIndex()).rejects.toThrow('upstream unavailable');
    expect(
      await readFile(join(stickerDir, 'catalog.generated.json'), 'utf8'),
    ).toBe(before);
  });

  it('rejects malformed model output and publishes no catalog', async () => {
    const stickerDir = await createStickerDirectory();
    await writeFile(join(stickerDir, 'images/global/bad.jpg'), Buffer.from('jpeg'));
    const service = new StickerMaintenanceService({
      stickerDir,
      modelRuntime: createRuntime(vi.fn(async () => ({
        text: '{"caption":"missing fields"}',
      }))),
    });

    await expect(service.runIndex()).rejects.toThrow(
      'sticker metadata validation failed',
    );
    await expect(
      readFile(join(stickerDir, 'catalog.generated.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails preflight for unsupported scope paths before model execution', async () => {
    const stickerDir = await createStickerDirectory();
    await mkdir(join(stickerDir, 'images/misc'), { recursive: true });
    await writeFile(join(stickerDir, 'images/misc/unknown.gif'), Buffer.from('gif'));
    const executeChat = vi.fn();
    const service = new StickerMaintenanceService({
      stickerDir,
      modelRuntime: createRuntime(executeChat),
    });

    await expect(service.runIndex()).rejects.toThrow(
      'unsupported sticker scope path',
    );
    expect(executeChat).not.toHaveBeenCalled();
  });

  it('allows only one index job at a time', async () => {
    const stickerDir = await createStickerDirectory();
    await writeFile(join(stickerDir, 'images/global/wait.png'), Buffer.from('wait'));
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new StickerMaintenanceService({
      stickerDir,
      modelRuntime: createRuntime(vi.fn(async () => {
        await waiting;
        return { text: JSON.stringify(validMetadata()) };
      })),
    });

    const active = service.runIndex();
    expect(() => service.runIndex()).toThrow(
      'sticker index maintenance is already running',
    );
    release?.();
    await active;
  });
});

async function createStickerDirectory(): Promise<string> {
  const directory = await mkdtemp(join(process.cwd(), '.tmp-sticker-maintenance-'));
  temporaryDirectories.push(directory);
  await mkdir(join(directory, 'images/global'), { recursive: true });
  await mkdir(join(directory, 'images/personas/sakiko'), { recursive: true });
  return directory;
}

function createRuntime(
  executeChat: ReturnType<typeof vi.fn>,
): ModelRuntimeClient {
  return {
    resolve: vi.fn(() => ({
      workload: 'sticker.index',
      sourceWorkload: 'sticker.index',
      mode: 'dedicated',
      model: 'qqbot-primary/vision',
      revision: 1,
      target: {
        canonicalModel: 'qqbot-primary/vision',
        connection: {
          id: 'primary',
        },
        model: {
          id: 'vision',
          capabilities: {
            chat: true,
            embedding: false,
            vision: true,
            tools: false,
            structuredOutput: true,
          },
        },
      },
    })),
    executeChat,
  } as unknown as ModelRuntimeClient;
}

function validMetadata() {
  return {
    caption: '挥手打招呼',
    keywords: ['挥手', '你好'],
    moods: ['友好'],
    scenes: ['打招呼'],
    historyLabel: '挥手',
    confidence: 0.94,
  };
}
