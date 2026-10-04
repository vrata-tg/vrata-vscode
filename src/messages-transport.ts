import { httpCode, Message, Part, TransportError } from "./transport";

export function toAnthropicMessages(messages: readonly Message[]): object[] {
  const result: { role: "user" | "assistant"; content: object[] }[] = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const content: object[] = [];
    if (message.role === "tool") {
      content.push({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: message.content ?? "",
      });
    } else {
      if (message.content)
        content.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? [])
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: JSON.parse(call.function.arguments),
        });
    }
    if (!content.length) continue;
    const previous = result.at(-1);
    if (previous?.role === role) previous.content.push(...content);
    else result.push({ role, content });
  }
  return result;
}

interface Block {
  type: "text" | "tool_use";
  id?: string;
  name?: string;
  json: string;
  closed: boolean;
}

export async function streamMessages(
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
        "Anthropic-Version": "2023-06-01",
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
  const blocks = new Map<number, Block>();
  let buffer = "";
  let frame: string[] = [];
  let stopped = false;
  let started = false;
  let finish: string | undefined;
  let failure: unknown;
  const invalid = () => new TransportError("invalid_stream", 200, requestId);
  const processFrame = () => {
    const data = frame
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    frame = [];
    if (!data) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data);
    } catch {
      throw invalid();
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string")
      throw invalid();
    if (event.type === "error")
      throw new TransportError("stream_error", 200, requestId);
    if (event.type === "message_start") {
      if (started) throw invalid();
      started = true;
      return;
    }
    if (!started) throw invalid();
    if (event.type === "message_stop") {
      stopped = true;
      return;
    }
    if (event.type === "message_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (typeof delta?.stop_reason === "string") finish = delta.stop_reason;
      return;
    }
    if (event.type === "content_block_start") {
      const block = event.content_block as Record<string, unknown> | undefined;
      if (
        !Number.isSafeInteger(event.index) ||
        blocks.has(event.index as number) ||
        !block ||
        (block.type !== "text" && block.type !== "tool_use")
      )
        throw invalid();
      blocks.set(event.index as number, {
        type: block.type,
        id: block.id as string | undefined,
        name: block.name as string | undefined,
        json: "",
        closed: false,
      });
      return;
    }
    if (event.type === "content_block_stop") {
      const block = blocks.get(event.index as number);
      if (!block || block.closed) throw invalid();
      block.closed = true;
      return;
    }
    if (event.type === "content_block_delta") {
      const block = blocks.get(event.index as number);
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!block || block.closed || !delta) throw invalid();
      if (
        block.type === "text" &&
        delta.type === "text_delta" &&
        typeof delta.text === "string"
      )
        report({ text: delta.text });
      else if (
        block.type === "tool_use" &&
        delta.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      )
        block.json += delta.partial_json;
      else throw invalid();
    }
  };
  try {
    while (!stopped) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += chunk.value;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(newline + 1);
        if (line) frame.push(line);
        else processFrame();
        if (stopped) break;
      }
    }
    signal.throwIfAborted();
    if (deadline.aborted) throw new TransportError("timeout", 200, requestId);
    if (
      !started ||
      !stopped ||
      (finish !== "end_turn" && finish !== "tool_use")
    )
      throw invalid();
    const tools: Part[] = [];
    for (const block of blocks.values()) {
      if (!block.closed) throw invalid();
      if (block.type !== "tool_use") continue;
      if (finish !== "tool_use" || !block.id || !block.name) throw invalid();
      let input: unknown;
      try {
        input = JSON.parse(block.json || "{}");
      } catch {
        throw invalid();
      }
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw invalid();
      tools.push({ id: block.id, name: block.name, input });
    }
    for (const tool of tools) report(tool);
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
    }
    reader.releaseLock();
  }
  if (failure) throw failure;
  return requestId;
}
