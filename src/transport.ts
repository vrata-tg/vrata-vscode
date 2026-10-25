import type { ChatCompletionCreateParamsStreaming } from "openai/resources/chat/completions";
import { openAIClient, TransportError, withModelStream } from "./model-client";
import { tokenUsage, Usage } from "./usage";
export { TransportError } from "./model-client";

export type Part =
  | { text: string }
  | { id: string; name: string; input: object }
  | { usage: Usage };
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

export function toChatMessages(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  let images: MessageContentPart[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "tool" && Array.isArray(message.content)) {
      result.push({
        ...message,
        content: message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      });
      const toolImages = message.content.filter(
        (part) => part.type === "image_url",
      );
      if (toolImages.length)
        images.push(
          { type: "text", text: `Images from tool ${message.tool_call_id}:` },
          ...toolImages,
        );
    } else result.push(message);
    // Chat Completions accepts images only in user messages. Keep all parallel
    // tool replies together before inserting their associated images.
    if (images.length && messages[index + 1]?.role !== "tool") {
      result.push({ role: "user", content: images });
      images = [];
    }
  }
  return result;
}

export async function streamChat(
  origin: string,
  key: string,
  body: object,
  signal: AbortSignal,
  report: (part: Part) => void,
  timeoutMs = 10 * 60_000,
): Promise<string | undefined> {
  let usage: Usage | undefined;
  const requestId = await withModelStream(
    signal,
    timeoutMs,
    (requestSignal) =>
      openAIClient(origin, key)
        .chat.completions.create(
          {
            ...body,
            stream: true,
            stream_options: { include_usage: true },
          } as ChatCompletionCreateParamsStreaming,
          { signal: requestSignal },
        )
        .withResponse(),
    async (events, requestId, requestSignal) => {
      const invalid = () =>
        new TransportError("invalid_stream", 200, requestId);
      const calls = new Map<
        number,
        { id: string; name: string; arguments: string }
      >();
      let finish: string | undefined;
      for await (const event of events) {
        requestSignal.throwIfAborted();
        if (!event || !Array.isArray(event.choices)) throw invalid();
        if (event.usage)
          usage = tokenUsage(
            event.usage.prompt_tokens,
            event.usage.completion_tokens,
            event.usage.prompt_tokens_details?.cached_tokens,
          );
        for (const choice of event.choices) {
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
      requestSignal.throwIfAborted();
      if (finish !== "stop" && finish !== "tool_calls") throw invalid();
      const parts: Part[] = [...calls.values()].map((call) => {
        if (finish !== "tool_calls" || !call.id || !call.name) throw invalid();
        const input: unknown = JSON.parse(call.arguments);
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw invalid();
        return { id: call.id, name: call.name, input };
      });
      for (const part of parts) report(part);
    },
  );
  if (usage) report({ usage });
  return requestId;
}
