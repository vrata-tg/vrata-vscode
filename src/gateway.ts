import { USER_AGENT } from "./user-agent";

export const API_ORIGIN = "https://api.vrata.tg";
export const STAGING_API_ORIGIN =
  "https://llm-billing-staging.ai.vladimirlebe.dev";
export const BOT_URL = "https://vrata.tg/bot";

export class CredentialError extends Error {}
export class AccountError extends Error {
  constructor(readonly status?: number) {
    super(status ? `HTTP ${status}` : "INVALID_ACCOUNT");
  }
}

export interface AccountSnapshot {
  checked_at: string;
  balance: {
    paid_available: string;
    promo_available: string;
    reserved: string;
    spendable: string;
  };
  quota: {
    limit: string | null;
    remaining: string | null;
  };
}

function atoms(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value);
}

function accountSnapshot(value: unknown): AccountSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const account = value as Record<string, unknown>;
  const balance = account.balance as Record<string, unknown> | undefined;
  const quota = account.quota as Record<string, unknown> | undefined;
  if (
    typeof account.checked_at !== "string" ||
    !balance ||
    balance.currency !== "RUB" ||
    balance.unit !== "coin_atoms" ||
    !quota ||
    quota.currency !== "RUB" ||
    quota.unit !== "coin_atoms" ||
    !atoms(balance.paid_available) ||
    !atoms(balance.promo_available) ||
    !atoms(balance.reserved) ||
    !atoms(balance.spendable) ||
    (quota.limit !== null && !atoms(quota.limit)) ||
    (quota.remaining !== null && !atoms(quota.remaining))
  )
    return undefined;
  return value as AccountSnapshot;
}

/** Only the confirmed read-only contract is used here (#337 extends metadata). */
export class GatewayClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly log: (message: string) => void = () => {},
    private readonly origin: string = API_ORIGIN,
  ) {}

  async models(key: string, signal: AbortSignal): Promise<readonly unknown[]> {
    signal.throwIfAborted();
    const endpoint = `${this.origin}/v1/models`;
    const entries: unknown[] = [];
    for (const protocol of ["openai", "anthropic"] as const) {
      this.log(`GET ${endpoint} (${protocol}) — проверка ключа`);
      const response = await this.request(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "User-Agent": USER_AGENT,
          ...(protocol === "anthropic"
            ? { "Anthropic-Version": "2023-06-01" }
            : {}),
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      this.log(`GET ${endpoint} (${protocol}) — HTTP ${response.status}`);
      if (!response.ok) {
        await response.body?.cancel();
        throw new CredentialError(`HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("data" in body) ||
        !Array.isArray(body.data)
      )
        throw new CredentialError(
          "INVALID_CATALOG: сервер не вернул массив моделей.",
        );
      entries.push(...body.data);
    }
    this.log("Каталог получен, ключ прошёл проверку.");
    return entries;
  }

  async account(key: string, signal: AbortSignal): Promise<AccountSnapshot> {
    signal.throwIfAborted();
    const endpoint = `${this.origin}/v1/account`;
    this.log(`GET ${endpoint} — чтение счёта`);
    const response = await this.request(endpoint, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": USER_AGENT,
      },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    this.log(`GET ${endpoint} — HTTP ${response.status}`);
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccountError(response.status);
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      throw new AccountError();
    }
    const account = accountSnapshot(value);
    if (!account) throw new AccountError();
    return account;
  }
}
