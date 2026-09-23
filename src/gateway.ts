import { inspect } from "node:util";

export const API_ORIGIN = "https://api.vrata.tg";
export const BOT_URL = "https://vrata.tg/bot";

export class CredentialError extends Error {}

/** Only the confirmed read-only contract is used here (#337 extends metadata). */
export class GatewayClient {
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async models(key: string, signal: AbortSignal): Promise<readonly unknown[]> {
    signal.throwIfAborted();
    const endpoint = `${API_ORIGIN}/v1/models`;
    this.log(`GET ${endpoint} — проверка ключа (таймаут 15 секунд)`);
    try {
      const response = await this.request(endpoint, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      this.log(`GET ${endpoint} — HTTP ${response.status}`);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new CredentialError(`HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("data" in body) ||
        !Array.isArray(body.data)
      ) {
        throw new CredentialError("INVALID_CATALOG: в ответе сервера отсутствует массив data с каталогом моделей.");
      }
      this.log("Каталог получен, ключ прошёл проверку.");
      return body.data;
    } catch (error) {
      if (signal.aborted) {
        this.log("Проверка ключа отменена.");
        signal.throwIfAborted();
      }
      let details = inspect(error, { depth: null, colors: false, customInspect: false });
      if (key) {
        details = details
          .replaceAll(inspect(key).slice(1, -1), "[REDACTED]")
          .replaceAll(key, "[REDACTED]");
      }
      this.log(details);
      throw error instanceof CredentialError
        ? error
        : new CredentialError("Не удалось проверить ключ. Подробности в журнале «Врата AI».");
    }
  }
}
