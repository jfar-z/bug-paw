/**
 * 按业务实体串行化异步修改；不同键仍可并行执行。
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** 在指定键的前序修改完成后执行操作，并在结束时释放空闲键。 */
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** 当前仍有修改排队或执行的实体数量。 */
  get size(): number {
    return this.tails.size;
  }
}
