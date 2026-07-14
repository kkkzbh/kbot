export class ChaoxingOwnerCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(ownerKey: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(ownerKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = predecessor.then(() => current);
    this.tails.set(ownerKey, tail);
    await predecessor;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(ownerKey) === tail) this.tails.delete(ownerKey);
    }
  }
}
