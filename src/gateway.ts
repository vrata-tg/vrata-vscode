export const API_ORIGIN = "https://api.vrata.tg";
export const BOT_URL = "https://vrata.tg/bot";

export class CredentialError extends Error {}

/** Only the confirmed read-only contract is used here (#337 extends metadata). */
export class GatewayClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  async models(key: string, signal: AbortSignal): Promise<readonly unknown[]> {
    signal.throwIfAborted();
    try {
      const response = await this.request(`${API_ORIGIN}/v1/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          throw new CredentialError(
            "Ключ недействителен, отозван или доступ запрещён. Проверьте ключ в боте.",
          );
        }
        throw new CredentialError(
          "Сервис временно недоступен. Попробуйте позже.",
        );
      }
      const body: unknown = await response.json();
      if (
        !body ||
        typeof body !== "object" ||
        !("data" in body) ||
        !Array.isArray(body.data)
      ) {
        throw new CredentialError(
          "Сервис вернул неподдерживаемый каталог. Попробуйте позже.",
        );
      }
      return body.data;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CredentialError) throw error;
      // Never expose fetch errors, server bodies or their potentially sensitive contents.
      throw new CredentialError(
        "Не удалось проверить ключ. Проверьте соединение и попробуйте позже.",
      );
    }
  }
}
