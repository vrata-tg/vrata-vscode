import { AccountError, AccountSnapshot, CredentialError } from "./gateway";

export const SECRET_KEY = "vrata.apiKey";
const EMPTY_CATALOG: readonly unknown[] = [];
export class CredentialOperationCancelled extends Error {}

interface Secrets {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
  delete(key: string): PromiseLike<void>;
}

interface CatalogClient {
  models(key: string, signal: AbortSignal): Promise<readonly unknown[]>;
  account(key: string, signal: AbortSignal): Promise<AccountSnapshot>;
}

interface Session {
  key: string;
  controller: AbortController;
  catalog?: readonly unknown[];
  catalogLoadedAt?: number;
  catalogRetryAt?: number;
  catalogFailed?: boolean;
  catalogRequest?: Promise<void>;
  account?: AccountSnapshot;
  accountFailed?: boolean;
  accountInvalid?: boolean;
  accountRequest?: Promise<void>;
}

export class Credentials {
  static readonly catalogTtlMs = 5 * 60_000;
  static readonly catalogRetryMs = 60_000;
  private session?: Session;
  private queue: Promise<unknown> = Promise.resolve();
  private attempt = 0;
  private validation?: AbortController;
  private disposed = false;

  constructor(
    private readonly secrets: Secrets,
    private readonly client: CatalogClient,
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  get key(): string | undefined {
    return this.session?.key;
  }

  get connected(): boolean {
    return !!this.session;
  }
  get catalog(): readonly unknown[] {
    return this.session?.catalog ?? EMPTY_CATALOG;
  }
  get catalogLoaded(): boolean {
    return this.session?.catalog !== undefined;
  }
  get catalogStale(): boolean {
    const session = this.session;
    return (
      !!session?.catalog &&
      (session.catalogFailed === true ||
        session.catalogLoadedAt === undefined ||
        this.now() - session.catalogLoadedAt >= Credentials.catalogTtlMs)
    );
  }
  get catalogUnavailable(): boolean {
    return (
      this.session?.catalogFailed === true && this.session.catalog === undefined
    );
  }
  get account(): AccountSnapshot | undefined {
    return this.session?.account;
  }
  get accountUnavailable(): boolean {
    return (
      this.session?.accountFailed === true && this.session.account === undefined
    );
  }
  get accountInvalid(): boolean {
    return this.session?.accountInvalid === true;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
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

  private switchSession(key?: string, catalog?: readonly unknown[]): void {
    this.session?.controller.abort();
    this.session = key
      ? {
          key,
          catalog,
          catalogLoadedAt: catalog === undefined ? undefined : this.now(),
          controller: new AbortController(),
        }
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
        throw new CredentialOperationCancelled("", { cause: error });
      throw error;
    }
    await this.serialize(async () => {
      if (this.disposed || attempt !== this.attempt)
        throw new CredentialOperationCancelled();
      await this.secrets.store(SECRET_KEY, key);
      if (!this.disposed) this.switchSession(key, catalog);
    });
    if (this.disposed || attempt !== this.attempt)
      throw new CredentialOperationCancelled();
  }

  async remove(): Promise<void> {
    if (this.disposed) throw new CredentialOperationCancelled();
    this.cancelValidation();
    await this.serialize(async () => {
      if (this.disposed) throw new CredentialOperationCancelled();
      await this.secrets.delete(SECRET_KEY);
      if (this.disposed) throw new CredentialOperationCancelled();
      this.switchSession();
    });
  }

  async run<T>(
    operation: (session: {
      key: string;
      signal: AbortSignal;
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
      isCurrent,
    }).catch((error) => {
      if (!isCurrent())
        throw new CredentialOperationCancelled("", { cause: error });
      throw error;
    });
    if (!isCurrent()) throw new CredentialOperationCancelled();
    return result;
  }

  async loadCatalog(force = false): Promise<void> {
    const session = this.session;
    if (!session) return;
    const now = this.now();
    if (
      !force &&
      !session.catalogFailed &&
      session.catalogLoadedAt !== undefined &&
      now - session.catalogLoadedAt < Credentials.catalogTtlMs
    )
      return;
    if (
      !force &&
      session.catalogRetryAt !== undefined &&
      now < session.catalogRetryAt
    )
      return;
    session.catalogRequest ??= this.run(async (active) => {
      try {
        const catalog = await this.client.models(active.key, active.signal);
        if (active.isCurrent()) {
          session.catalog = catalog;
          session.catalogLoadedAt = this.now();
          session.catalogRetryAt = undefined;
          session.catalogFailed = false;
          this.changed();
        }
      } catch (error) {
        if (active.isCurrent()) {
          session.catalogRetryAt = this.now() + Credentials.catalogRetryMs;
          session.catalogFailed = true;
          this.changed();
        }
        throw error;
      }
    }).finally(() => {
      session.catalogRequest = undefined;
    });
    await session.catalogRequest;
  }

  async loadAccount(): Promise<void> {
    const session = this.session;
    if (!session) return;
    session.accountRequest ??= this.run(async (active) => {
      try {
        const account = await this.client.account(active.key, active.signal);
        if (active.isCurrent()) {
          session.account = account;
          session.accountFailed = false;
          session.accountInvalid = false;
          this.changed();
        }
      } catch (error) {
        if (active.isCurrent()) {
          session.accountFailed = true;
          session.accountInvalid =
            error instanceof AccountError && error.status === 401;
          this.changed();
        }
        throw error;
      }
    }).finally(() => {
      session.accountRequest = undefined;
    });
    await session.accountRequest;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelValidation();
    this.session?.controller.abort();
    this.session = undefined;
  }
}
