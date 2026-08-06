import { AsyncLocalStorage } from 'node:async_hooks';

export class HbuJwSharedSessionCoordinator {
  private readonly storage = new AsyncLocalStorage<boolean>();
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
      return await this.storage.run(true, operation);
    } finally {
      release();
    }
  }
}
