import { CredentialError } from "./gateway";

export const SECRET_KEY = "vrata.apiKey";
export class CredentialOperationCancelled extends Error {}

interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

interface CatalogClient {
  models(key: string, signal: AbortSignal): Promise<readonly unknown[]>;
}

interface Session {
  key: string;
  controller: AbortController;
  catalog: readonly unknown[];
  cache: Map<string, unknown>;
}

/** A request and its account-scoped cache belong to exactly one credential session. */
export class Credentials {
  private session?: Session;
  private queue: Promise<unknown> = Promise.resolve();
  private attempt = 0;
  private validation?: AbortController;
  private disposed = false;

  constructor(
    private readonly secrets: Secrets,
    private readonly client: CatalogClient,
    private readonly changed: () => void,
  ) {}

  get connected(): boolean {
    return !!this.session;
  }
  get catalog(): readonly unknown[] {
    return this.session?.catalog ?? [];
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  initialize(): Promise<void> {
    return this.reload();
  }

  reload(): Promise<void> {
    return this.serialize(async () => {
      const key = await this.secrets.get(SECRET_KEY);
      if (this.disposed || key === this.session?.key) return;
      this.cancelValidation();
      this.switchSession(key);
    });
  }

  private cancelValidation(): number {
    this.validation?.abort();
    return ++this.attempt;
  }

  private switchSession(key?: string, catalog: readonly unknown[] = []): void {
    this.session?.controller.abort();
    this.session?.cache.clear();
    this.session = key
      ? { key, catalog, controller: new AbortController(), cache: new Map() }
      : undefined;
    this.changed();
  }

  async replace(raw: string): Promise<void> {
    if (this.disposed) throw new CredentialOperationCancelled();
    const key = raw.trim();
    if (!key) throw new CredentialError("Вставьте API-ключ.");
    const attempt = this.cancelValidation();
    const validation = (this.validation = new AbortController());
    let catalog: readonly unknown[];
    try {
      catalog = await this.client.models(key, validation.signal);
    } catch (error) {
      if (this.disposed || attempt !== this.attempt)
        throw new CredentialOperationCancelled();
      throw error;
    }
    await this.serialize(async () => {
      if (this.disposed || attempt !== this.attempt)
        throw new CredentialOperationCancelled();
      await this.secrets.store(SECRET_KEY, key);
      if (!this.disposed) this.switchSession(key, catalog);
    });
    // A removal can supersede a store already in progress. It owns the final UI result.
    if (this.disposed || attempt !== this.attempt)
      throw new CredentialOperationCancelled();
  }

  async remove(): Promise<void> {
    if (this.disposed) throw new CredentialOperationCancelled();
    this.cancelValidation();
    await this.serialize(async () => {
      await this.secrets.delete(SECRET_KEY);
      this.switchSession();
    });
  }

  async run<T>(
    operation: (session: {
      key: string;
      signal: AbortSignal;
      cache: Map<string, unknown>;
      isCurrent: () => boolean;
    }) => Promise<T>,
  ): Promise<T> {
    const session = this.session;
    if (!session || this.disposed)
      throw new CredentialError(
        "Врата AI не подключены. Вставьте API-ключ через управление провайдером.",
      );
    const isCurrent = () =>
      !this.disposed &&
      this.session === session &&
      !session.controller.signal.aborted;
    const result = await operation({
      key: session.key,
      signal: session.controller.signal,
      cache: session.cache,
      isCurrent,
    });
    if (!isCurrent()) throw new CredentialOperationCancelled();
    return result;
  }

  async refresh(): Promise<void> {
    if (!this.connected) return;
    await this.run(async (session) => {
      const catalog = await this.client.models(session.key, session.signal);
      if (session.isCurrent()) this.session!.catalog = catalog;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.cancelValidation();
    this.session?.controller.abort();
    this.session?.cache.clear();
    this.session = undefined;
  }
}
