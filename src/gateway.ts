export const API_ORIGIN = "https://llm-billing-staging.ai.vladimirlebe.dev;
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
    const response = await this.request(endpoint, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    this.log(`GET ${endpoint} — HTTP ${response.status}`);
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
    ) {
      throw new CredentialError(
        "INVALID_CATALOG: в ответе сервера отсутствует массив data с каталогом моделей.",
      );
    }
    this.log("Каталог получен, ключ прошёл проверку.");
    return body.data;
  }
}
