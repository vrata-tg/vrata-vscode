import { setTimeout } from "node:timers/promises";
import { MODEL_REQUEST_TIMEOUT_MS, TransportError } from "./model-client";

function temporary(error: unknown): error is TransportError {
  if (!(error instanceof TransportError)) return false;
  switch (error.code) {
    case "network":
    case "timeout":
    case "rate_limit":
    case "service_error":
    case "incomplete_stream":
      return true;
    case "stream_error": {
      // SDK APIErrors, Anthropic error envelopes and Responses failed events.
      let detail: unknown = error.cause;
      for (let depth = 0; depth < 3; depth++) {
        if (!detail || typeof detail !== "object") return false;
        const body = detail as {
          error?: unknown;
          response?: { error?: unknown };
          code?: unknown;
          type?: unknown;
        };
        if (body.error) detail = body.error;
        else if (body.response?.error) detail = body.response.error;
        else
          return [
            "stream_interrupted",
            "server_error",
            "api_error",
            "overloaded_error",
          ].includes(String(body.code ?? body.type));
      }
      return false;
    }
    default:
      return false;
  }
}

// Published parts cannot be replaced through the language model provider API.
// Keep SDK retries disabled; only this boundary can observe publication.
export async function withModelRetries<T>(
  signal: AbortSignal,
  request: (signal: AbortSignal, publish: () => void) => Promise<T>,
  timeoutMs = MODEL_REQUEST_TIMEOUT_MS,
): Promise<T> {
  signal.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([signal, deadline]);
  let published = false;
  let lastFailure: TransportError | undefined;
  try {
    for (let retry = 0; ; retry++) {
      requestSignal.throwIfAborted();
      try {
        const result = await request(requestSignal, () => {
          published = true;
        });
        requestSignal.throwIfAborted();
        return result;
      } catch (error) {
        if (error instanceof TransportError) lastFailure = error;
        requestSignal.throwIfAborted();
        if (published || retry >= 20 || !temporary(error)) throw error;
        const backoff = Math.max(
          1000,
          Math.min(1000 * 2 ** retry, 15_000) * (0.5 + Math.random() / 2),
        );
        await setTimeout(
          // Never pass an oversized Retry-After to Node's timer: overflow would
          // shorten it to 1 ms. The shared deadline aborts this bounded sleep.
          Math.min(timeoutMs, Math.max(backoff, error.retryAfterMs ?? 0)),
          undefined,
          {
            signal: requestSignal,
          },
        );
      }
    }
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (deadline.aborted)
      throw new TransportError(
        "timeout",
        lastFailure?.status,
        lastFailure?.requestId,
        { cause: error },
      );
    throw error;
  }
}
