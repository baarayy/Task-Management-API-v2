/**
 * Minimal in-memory Redis, covering exactly the commands this codebase uses:
 * refresh-token storage, cache entries and tag sets.
 *
 * Running the suite against a real Redis would make `npm test` depend on
 * Docker, which is the wrong trade for CI. The surface is small enough that a
 * stub stays honest - and cache/token behaviour is asserted through the API,
 * not against the stub's internals.
 */
type Value = string | Set<string>;

export class RedisMock {
  private store = new Map<string, Value>();
  private expiries = new Map<string, number>();

  private alive(key: string): boolean {
    const expiry = this.expiries.get(key);
    if (expiry !== undefined && expiry <= Date.now()) {
      this.store.delete(key);
      this.expiries.delete(key);
      return false;
    }
    return this.store.has(key);
  }

  async get(key: string): Promise<string | null> {
    if (!this.alive(key)) return null;
    const value = this.store.get(key);
    return typeof value === 'string' ? value : null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK'> {
    this.store.set(key, value);
    const exIndex = args.findIndex((a) => String(a).toUpperCase() === 'EX');
    if (exIndex !== -1) {
      this.expiries.set(key, Date.now() + Number(args[exIndex + 1]) * 1000);
    }
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys.flat()) {
      if (this.store.delete(key)) removed += 1;
      this.expiries.delete(key);
    }
    return removed;
  }

  async exists(key: string): Promise<number> {
    return this.alive(key) ? 1 : 0;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = (this.alive(key) ? this.store.get(key) : undefined) as Set<string> | undefined;
    const target = set ?? new Set<string>();
    let added = 0;
    for (const member of members.flat()) {
      if (!target.has(member)) {
        target.add(member);
        added += 1;
      }
    }
    this.store.set(key, target);
    return added;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.store.get(key);
    if (!(set instanceof Set)) return 0;
    let removed = 0;
    for (const member of members.flat()) if (set.delete(member)) removed += 1;
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    if (!this.alive(key)) return [];
    const set = this.store.get(key);
    return set instanceof Set ? [...set] : [];
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.store.has(key)) return 0;
    this.expiries.set(key, Date.now() + seconds * 1000);
    return 1;
  }

  async call(...args: unknown[]): Promise<unknown> {
    const [command, ...rest] = args as [string, ...string[]];
    const fn = (this as unknown as Record<string, unknown>)[command.toLowerCase()];
    return typeof fn === 'function' ? (fn as (...a: unknown[]) => unknown).apply(this, rest) : null;
  }

  /** multi() and pipeline() share one deferred-command implementation. */
  private chain() {
    const ops: Array<() => Promise<unknown>> = [];
    const proxy = {
      set: (...a: Parameters<RedisMock['set']>) => (ops.push(() => this.set(...a)), proxy),
      del: (...a: string[]) => (ops.push(() => this.del(...a)), proxy),
      sadd: (...a: [string, ...string[]]) => (ops.push(() => this.sadd(...a)), proxy),
      srem: (...a: [string, ...string[]]) => (ops.push(() => this.srem(...a)), proxy),
      expire: (...a: [string, number]) => (ops.push(() => this.expire(...a)), proxy),
      exec: async () => {
        const results: Array<[null, unknown]> = [];
        for (const op of ops) results.push([null, await op()]);
        return results;
      },
    };
    return proxy;
  }

  multi() {
    return this.chain();
  }

  pipeline() {
    return this.chain();
  }

  /** Async-iterable batches of matching keys, mirroring ioredis' scanStream. */
  scanStream({ match }: { match: string; count?: number }) {
    const pattern = new RegExp(`^${match.replace(/\*/g, '.*')}$`);
    const keys = [...this.store.keys()].filter((k) => pattern.test(k));
    return {
      async *[Symbol.asyncIterator]() {
        if (keys.length > 0) yield keys;
      },
    };
  }

  on(): this {
    return this;
  }
  async quit(): Promise<'OK'> {
    return 'OK';
  }
  disconnect(): void {}

  /** Test-only helpers. */
  flushall(): void {
    this.store.clear();
    this.expiries.clear();
  }
  keys(): string[] {
    return [...this.store.keys()];
  }
}

export const redisMock = new RedisMock();
