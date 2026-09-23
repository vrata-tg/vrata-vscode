export const API_ORIGIN = "https://api.vrata.tg";
export const BOT_URL = "https://vrata.tg/bot";

export class CredentialError extends Error {}

// Only known codes and our own text may reach notifications or the log. Raw
// fetch errors can contain credentials, proxy URLs and response fragments.
const NETWORK_ERRORS: Readonly<Record<string, string>> = {
  ENOTFOUND: "DNS не смог найти адрес сервера",
  EAI_AGAIN: "DNS временно недоступен",
  ECONNREFUSED: "сервер или прокси отклонил соединение",
  ECONNRESET: "соединение сброшено сервером или прокси",
  ETIMEDOUT: "истекло время ожидания соединения",
  ENETUNREACH: "сеть недоступна",
  EHOSTUNREACH: "сервер недоступен по сети",
  EACCES: "доступ к сети запрещён",
  EPERM: "сетевое соединение запрещено системой",
  EPIPE: "соединение закрыто во время отправки",
  UND_ERR_CONNECT_TIMEOUT: "истекло время установления соединения",
  UND_ERR_HEADERS_TIMEOUT: "истекло время ожидания заголовков ответа",
  UND_ERR_BODY_TIMEOUT: "истекло время ожидания тела ответа",
  UND_ERR_SOCKET: "сетевое соединение неожиданно закрыто",
  CERT_HAS_EXPIRED: "истёк срок действия TLS-сертификата",
  CERT_NOT_YET_VALID: "TLS-сертификат ещё не действует; проверьте часы системы",
  DEPTH_ZERO_SELF_SIGNED_CERT: "сервер или прокси использует самоподписанный TLS-сертификат",
  SELF_SIGNED_CERT_IN_CHAIN: "в цепочке TLS есть недоверенный самоподписанный сертификат",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "не удалось проверить цепочку TLS-сертификата",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "не найден доверенный издатель TLS-сертификата",
  ERR_TLS_CERT_ALTNAME_INVALID: "имя сервера не совпадает с TLS-сертификатом",
  ERR_SSL_WRONG_VERSION_NUMBER: "сервер или прокси не установил TLS-соединение",
  ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION: "сервер или прокси отклонил версию TLS",
};

function networkFailure(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const reasons = new Set<string>();
  // Node may wrap socket failures in both Error.cause and AggregateError.
  for (let i = 0; i < pending.length && i < 16; i++) {
    const item = pending[i];
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const code = "code" in item ? item.code : undefined;
    if (typeof code === "string" && Object.hasOwn(NETWORK_ERRORS, code)) {
      reasons.add(`${code}: ${NETWORK_ERRORS[code]}`);
    }
    if (item instanceof Error) {
      if (item.name === "TimeoutError") reasons.add("TIMEOUT: проверка ключа не завершилась за 15 секунд");
      if (item.message === "unexpected redirect") reasons.add("REDIRECT: сервер вернул запрещённое перенаправление");
    }
    if ("cause" in item) pending.push(item.cause);
    if (item instanceof AggregateError) pending.push(...item.errors.slice(0, 16));
  }
  return reasons.size
    ? [...reasons].join("; ")
    : "NETWORK_ERROR: транспорт не сообщил известный код ошибки";
}

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
        const reason = response.status === 401 || response.status === 403
          ? "Ключ недействителен, отозван или доступ запрещён. Проверьте ключ в боте."
          : response.status === 429
            ? "Превышен лимит запросов. Повторите позже."
            : "Сервис вернул ошибку.";
        throw new CredentialError(`HTTP ${response.status}: ${reason}`);
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new CredentialError("INVALID_JSON: сервер вернул некорректный JSON вместо каталога моделей.");
        }
        throw error;
      }
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
      const failure = error instanceof CredentialError
        ? error
        : new CredentialError(`Не удалось проверить ключ: ${networkFailure(error)}.`);
      this.log(failure.message);
      throw failure;
    }
  }
}
