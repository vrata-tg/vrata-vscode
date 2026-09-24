export type Part =
  { text: string } | { id: string; name: string; input: object };
export interface Message {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
}
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
): Promise<void> {
  signal.throwIfAborted();
  const response = await fetch(endpoint, {
    method: "POST",
    signal,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Gateway HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Missing gateway stream");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const calls = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();
  let buffer = "",
    finish: string | undefined,
    done = false;
  const failures: unknown[] = [];
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
        const event = JSON.parse(data) as {
          error?: unknown;
          choices?: { delta: Delta; finish_reason?: string }[];
        };
        if (event.error)
          throw new Error("Gateway stream error", { cause: event.error });
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
    if (!done || !finish) throw new Error("Incomplete gateway stream");
    if (finish !== "stop" && finish !== "tool_calls")
      throw new Error("Unsupported gateway finish reason");
    // Validate the whole batch before letting the editor execute any tool.
    const parts: Part[] = [...calls.values()].map((call) => {
      if (finish !== "tool_calls" || !call.id || !call.name)
        throw new Error("Invalid gateway tool call");
      const input: unknown = JSON.parse(call.arguments);
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid gateway tool arguments");
      return { id: call.id, name: call.name, input };
    });
    for (const part of parts) report(part);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await reader.cancel();
    } catch (error) {
      if (!failures.includes(error)) failures.push(error);
    } finally {
      reader.releaseLock();
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Gateway stream cleanup failed");
}
