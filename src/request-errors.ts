import { TransportError } from "./transport";
import { CredentialError } from "./gateway";

export function requestError(error: unknown): {
  code: string;
  message: string;
  action?: { label: string; command: string };
  requestId?: string;
} {
  if (error instanceof CredentialError)
    return {
      code: "missing_key",
      message: "Врата AI не подключены. Вставьте API-ключ.",
      action: { label: "Вставить ключ", command: "vrata.setApiKey" },
    };
  if (!(error instanceof TransportError))
    return {
      code: "request_failed",
      message:
        "Не удалось получить ответ Врат AI. Проверьте соединение и повторите запрос вручную.",
      action: { label: "Открыть журнал", command: "vrata.showLogs" },
    };
  const actions = {
    invalid_key: { label: "Заменить ключ", command: "vrata.setApiKey" },
    insufficient_balance: { label: "Пополнить", command: "vrata.getApiKey" },
    model_unavailable: {
      label: "Обновить модели",
      command: "vrata.refreshModels",
    },
    key_limit: { label: "Открыть бот", command: "vrata.getApiKey" },
    request_rejected: {
      label: "Обновить модели",
      command: "vrata.refreshModels",
    },
    service_error: { label: "Открыть журнал", command: "vrata.showLogs" },
    invalid_stream: { label: "Открыть журнал", command: "vrata.showLogs" },
    stream_error: { label: "Открыть журнал", command: "vrata.showLogs" },
  } as const;
  const messages = {
    invalid_key: "Ключ Врат AI недействителен или отозван.",
    insufficient_balance: "Недостаточно средств на счёте Врат AI.",
    model_unavailable: "Модель недоступна этому ключу или выключена.",
    key_limit: "Лимит ключа исчерпан.",
    rate_limit: "Слишком много запросов. Подождите и повторите вручную.",
    request_too_large:
      "Запрос слишком большой. Сократите контекст и повторите вручную.",
    request_rejected:
      "Сервис отклонил запрос. Проверьте модель и повторите вручную.",
    service_error:
      "Сервис Врат AI временно недоступен. Повторите вручную позже.",
    network: "Нет связи с Вратами AI. Проверьте сеть и повторите вручную.",
    timeout: "Время ожидания Врат AI истекло. Повторите вручную.",
    invalid_stream: "Ответ Врат AI оборвался или имеет неверный формат.",
    stream_error: "Врата AI завершили поток с ошибкой.",
  } as const;
  return {
    code: error.code,
    message: messages[error.code],
    action: actions[error.code as keyof typeof actions],
    requestId: error.requestId,
  };
}
