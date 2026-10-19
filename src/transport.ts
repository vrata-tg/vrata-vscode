import { USER_AGENT } from "./user-agent";

export type Part =
  { text: string } | { id: string; name: string; input: object };
export type TransportCode =
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

export function httpCode(
  status: number,
  retryAfter: string | null,
): TransportCode {
  if (status === 401) return "invalid_key";
  if (status === 402) return "insufficient_balance";
  if (status === 403 || status === 404) return "model_unavailable";
  if (status === 429) return retryAfter ? "rate_limit" : "key_limit";
  if (status === 413) return "request_too_large";
  return status >= 500 ? "service_error" : "request_rejected";
}
export interface Message {
  role: "user" | "assistant" | "tool";
  content: string | MessageContentPart[] | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}
export type MessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };
interface Delta {
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}
export async function streamChat(
  endpoint: string,
  key: string,
  body: object,
  signal: AbortSignal,
  report: (part: Part) => void,
  timeoutMs = 10 * 60_000,
): Promise<string | undefined> {
  signal.throwIfAborted();
  const deadline = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([signal, deadline]);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      signal: requestSignal,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${key}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
  } catch {
    if (signal.aborted) signal.throwIfAborted();
    if (deadline.aborted) throw new TransportError("timeout");
    throw new TransportError("network");
  }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new TransportError(
      httpCode(response.status, response.headers.get("retry-after")),
      response.status,
      requestId,
    );
  }
  if (!response.body)
    throw new TransportError("invalid_stream", 200, requestId);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let buffer = "",
    finish: string | undefined,
    done = false;
  let failure: unknown;
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trimStart();
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let event: {
          error?: unknown;
          choices?: { delta: Delta; finish_reason?: string }[];
        };
        try {
          event = JSON.parse(data);
        } catch {
          throw new TransportError("invalid_stream", 200, requestId);
        }
        if (
          !event ||
          typeof event !== "object" ||
          (!Array.isArray(event.choices) && !event.error)
        )
          throw new TransportError("invalid_stream", 200, requestId);
        if (event.error)
          throw new TransportError("stream_error", 200, requestId);
        for (const choice of event.choices ?? []) {
          if (choice.finish_reason) finish = choice.finish_reason;
          if (choice.delta?.content) report({ text: choice.delta.content });
          for (const fragment of choice.delta?.tool_calls ?? []) {
            const call = calls.get(fragment.index) ?? {
              id: "",
              name: "",
              arguments: "",
            };
            call.id += fragment.id ?? "";
            call.name += fragment.function?.name ?? "";
            call.arguments += fragment.function?.arguments ?? "";
            calls.set(fragment.index, call);
          }
        }
      }
    }
    signal.throwIfAborted();
    if (deadline.aborted) throw new TransportError("timeout", 200, requestId);
    if (!done || !finish)
      throw new TransportError("invalid_stream", 200, requestId);
    if (finish !== "stop" && finish !== "tool_calls")
      throw new TransportError("invalid_stream", 200, requestId);
    const parts: Part[] = [...calls.values()].map((call) => {
      if (finish !== "tool_calls" || !call.id || !call.name)
        throw new TransportError("invalid_stream", 200, requestId);
      let input: unknown;
      try {
        input = JSON.parse(call.arguments);
      } catch {
        throw new TransportError("invalid_stream", 200, requestId);
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new TransportError("invalid_stream", 200, requestId);
      return { id: call.id, name: call.name, input };
    });
    for (const part of parts) report(part);
  } catch (error) {
    failure = signal.aborted
      ? signal.reason
      : deadline.aborted
        ? new TransportError("timeout", 200, requestId)
        : error instanceof TransportError
          ? error
          : new TransportError("network", 200, requestId);
  } finally {
    try {
      await reader.cancel();
    } catch {
      if (!failure)
        failure = new TransportError("invalid_stream", 200, requestId);
    } finally {
      reader.releaseLock();
    }
  }
  if (failure) throw failure;
  return requestId;
}
