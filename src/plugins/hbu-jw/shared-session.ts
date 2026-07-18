import { AsyncLocalStorage } from 'node:async_hooks';
import type { SerializedCookieJar } from './types.js';

interface SharedSessionState {
  authenticated?: {
    ownerKey: string;
    cookieJar: SerializedCookieJar;
    credentialVersion: number;
  };
}

export class HbuJwSharedSessionCoordinator {
  private readonly storage = new AsyncLocalStorage<SharedSessionState>();
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.storage.getStore()) return operation();

    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.storage.run({}, operation);
    } finally {
      release();
    }
  }

  requireState(): SharedSessionState {
    const state = this.storage.getStore();
    if (!state) {
      throw new Error('shared HBU JW session access requires an exclusive transaction.');
    }
    return state;
  }
}
