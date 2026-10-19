import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { USER_AGENT } from "./user-agent";

const options = {
  maxRetries: 0,
  logLevel: "off" as const,
  fetchOptions: { redirect: "error" as const },
  defaultHeaders: { "User-Agent": USER_AGENT },
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
};

export function openAIClient(origin: string, key: string): OpenAI {
  return new OpenAI({
    ...options,
    baseURL: `${origin}/v1`,
    apiKey: key,
    organization: null,
    project: null,
  });
}

export function anthropicClient(origin: string, key: string): Anthropic {
  return new Anthropic({
    ...options,
    baseURL: origin,
    apiKey: null,
    authToken: key,
  });
}

type TransportCode =
  | "invalid_key"
  | "insufficient_balance"
  | "model_unavailable"
  | "key_limit"
  | "rate_limit"
  | "request_too_large"
  | "request_rejected"
  | "service_error"
  | "network"
  | "timeout"
  | "invalid_stream"
  | "stream_error";

export class TransportError extends Error {
  constructor(
    readonly code: TransportCode,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(code);
  }
}

function httpCode(status: number, retryAfter: string | null): TransportCode {
  if (status === 401) return "invalid_key";
  if (status === 402) return "insufficient_balance";
  if (status === 403 || status === 404) return "model_unavailable";
  if (status === 429) return retryAfter ? "rate_limit" : "key_limit";
  if (status === 413) return "request_too_large";
  return status >= 500 ? "service_error" : "request_rejected";
}

// The deadline covers both response headers and the entire streamed body.
export async function withModelStream<T>(
  signal: AbortSignal,
  timeoutMs: number,
  request: (
    signal: AbortSignal,
  ) => Promise<{ data: AsyncIterable<T>; response: Response }>,
  consume: (
    events: AsyncIterable<T>,
    requestId: string | undefined,
    signal: AbortSignal,
  ) => Promise<void>,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([signal, deadline]);
  let requestId: string | undefined;
  let status: number | undefined;
  try {
    const { data, response } = await request(requestSignal);
    status = response.status;
    requestId = response.headers.get("x-request-id") ?? undefined;
    if (!response.body)
      throw new TransportError("invalid_stream", status, requestId);
    await consume(data, requestId, requestSignal);
    requestSignal.throwIfAborted();
    return requestId;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (
      deadline.aborted ||
      error instanceof OpenAI.APIConnectionTimeoutError ||
      error instanceof Anthropic.APIConnectionTimeoutError
    )
      throw new TransportError("timeout", status, requestId);
    if (error instanceof TransportError) throw error;
    if (
      error instanceof OpenAI.APIError ||
      error instanceof Anthropic.APIError
    ) {
      const headers = error.headers;
      requestId ??= headers?.get("x-request-id") ?? undefined;
      if (error.status !== undefined)
        throw new TransportError(
          httpCode(error.status, headers?.get("retry-after") ?? null),
          error.status,
          requestId,
        );
      if (
        !(error instanceof OpenAI.APIConnectionError) &&
        !(error instanceof Anthropic.APIConnectionError)
      )
        throw new TransportError("stream_error", status, requestId);
    }
    throw new TransportError(
      error instanceof SyntaxError ? "invalid_stream" : "network",
      status,
      requestId,
    );
  }
}
