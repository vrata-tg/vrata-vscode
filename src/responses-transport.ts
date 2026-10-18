import { USER_AGENT } from "./user-agent";

import {
  httpCode,
  Message,
  MessageContentPart,
  Part,
  TransportError,
} from "./transport";

function responseContent(part: MessageContentPart): object {
  return part.type === "text"
    ? { type: "input_text", text: part.text }
    : { type: "input_image", image_url: part.image_url.url };
}

export function toResponsesInput(messages: readonly Message[]): object[] {
  const input: object[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content ?? "",
      });
      continue;
    }
    const role = message.role;
    const content = Array.isArray(message.content)
      ? message.content.map(responseContent)
      : message.content
        ? [
            {
              type: role === "assistant" ? "output_text" : "input_text",
              text: message.content,
            },
          ]
        : [];
    if (content.length) input.push({ role, content });
    for (const call of message.tool_calls ?? [])
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
  }
  return input;
}

interface FunctionCall {
  index: number;
  callId?: string;
  name?: string;
  arguments: string;
}

export async function streamResponses(
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
    throw new TransportError(deadline.aborted ? "timeout" : "network");
  }
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Preserve the actionable HTTP status if the response body won't cancel.
    }
    throw new TransportError(
      httpCode(response.status, response.headers.get("retry-after")),
      response.status,
      requestId,
    );
  }
  if (!response.body)
    throw new TransportError("invalid_stream", 200, requestId);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const calls = new Map<string, FunctionCall>();
  let buffer = "";
  let frame: string[] = [];
  let completed = false;
  let nextIndex = 0;
  let failure: unknown;
  const invalid = () => new TransportError("invalid_stream", 200, requestId);
  const functionCall = (
    itemId: string,
    index: number | undefined,
    item?: Record<string, unknown>,
  ): FunctionCall => {
    let call = calls.get(itemId);
    if (!call) {
      call = { index: index ?? nextIndex++, arguments: "" };
      calls.set(itemId, call);
    }
    if (index !== undefined) call.index = index;
    if (typeof item?.call_id === "string") call.callId = item.call_id;
    if (typeof item?.name === "string") call.name = item.name;
    if (typeof item?.arguments === "string") call.arguments = item.arguments;
    return call;
  };
  const processFrame = () => {
    const data = frame
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    frame = [];
    if (!data || data === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      throw invalid();
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string")
      throw invalid();
    if (
      event.type === "error" ||
      event.type === "response.failed" ||
      event.type === "response.incomplete"
    )
      throw new TransportError("stream_error", 200, requestId);
    if (
      event.type === "response.output_text.delta" ||
      event.type === "response.refusal.delta"
    ) {
      if (typeof event.delta !== "string") throw invalid();
      report({ text: event.delta });
    } else if (event.type === "response.output_item.added") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        if (
          typeof item.id !== "string" ||
          !Number.isSafeInteger(event.output_index)
        )
          throw invalid();
        functionCall(item.id, event.output_index as number, item);
      }
    } else if (
      event.type === "response.function_call_arguments.delta" ||
      event.type === "response.function_call_arguments.done"
    ) {
      if (typeof event.item_id !== "string") throw invalid();
      const call = functionCall(event.item_id, undefined);
      if (event.type.endsWith(".delta")) {
        if (typeof event.delta !== "string") throw invalid();
        call.arguments += event.delta;
      } else {
        if (typeof event.arguments !== "string") throw invalid();
        call.arguments = event.arguments;
      }
    } else if (event.type === "response.output_item.done") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "function_call") {
        if (
          typeof item.id !== "string" ||
          !Number.isSafeInteger(event.output_index)
        )
          throw invalid();
        functionCall(item.id, event.output_index as number, item);
      }
    } else if (event.type === "response.completed") {
      completed = true;
    }
  };
  try {
    while (!completed) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line) frame.push(line);
        else processFrame();
        if (completed) break;
      }
    }
    signal.throwIfAborted();
    if (deadline.aborted) throw new TransportError("timeout", 200, requestId);
    if (!completed) throw invalid();
    const parts: Part[] = [...calls.values()]
      .sort((left, right) => left.index - right.index)
      .map((call) => {
        if (!call.callId || !call.name) throw invalid();
        let input: unknown;
        try {
          input = JSON.parse(call.arguments || "{}");
        } catch {
          throw invalid();
        }
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw invalid();
        return { id: call.callId, name: call.name, input };
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
      if (!failure) failure = invalid();
    } finally {
      reader.releaseLock();
    }
  }
  if (failure) throw failure;
  return requestId;
}
