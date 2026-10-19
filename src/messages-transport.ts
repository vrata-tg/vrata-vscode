import type { MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages";
import {
  anthropicClient,
  TransportError,
  withModelStream,
} from "./model-client";
import { messagesUsage } from "./usage";

import { Message, MessageContentPart, Part } from "./transport";

function anthropicContentPart(part: MessageContentPart): object {
  if (part.type === "text") return { type: "text", text: part.text };
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/i.exec(
    part.image_url.url,
  );
  if (!match) throw new Error("Invalid image data URL");
  return {
    type: "image",
    source: { type: "base64", media_type: match[1], data: match[2] },
  };
}

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
      if (Array.isArray(message.content))
        content.push(...message.content.map(anthropicContentPart));
      else if (message.content)
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
  origin: string,
  key: string,
  body: object,
  signal: AbortSignal,
  report: (part: Part) => void,
  timeoutMs = 10 * 60_000,
): Promise<string | undefined> {
  let inputUsage: Record<string, unknown> = {};
  let outputTokens: unknown;
  const requestId = await withModelStream(
    signal,
    timeoutMs,
    (requestSignal) =>
      anthropicClient(origin, key)
        .messages.create(
          {
            ...body,
            stream: true,
          } as MessageCreateParamsStreaming,
          { signal: requestSignal },
        )
        .withResponse(),
    async (events, requestId, requestSignal) => {
      const blocks = new Map<number, Block>();
      let stopped = false;
      let started = false;
      let finish: string | undefined;
      const invalid = () =>
        new TransportError("invalid_stream", 200, requestId);
      for await (const event of events) {
        requestSignal.throwIfAborted();
        if (
          !event ||
          typeof event !== "object" ||
          typeof event.type !== "string"
        )
          throw invalid();
        if (event.type === "message_start") {
          if (started) throw invalid();
          started = true;
          const message = event.message;
          inputUsage = { ...message?.usage };
          continue;
        }
        if (!started) throw invalid();
        if (event.type === "message_stop") {
          stopped = true;
          break;
        }
        if (event.type === "message_delta") {
          const delta = event.delta;
          if (typeof delta?.stop_reason === "string")
            finish = delta.stop_reason;
          const usage = event.usage;
          inputUsage = { ...inputUsage, ...usage };
          if (usage?.output_tokens !== undefined)
            outputTokens = usage.output_tokens;
          continue;
        }
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (
            !Number.isSafeInteger(event.index) ||
            blocks.has(event.index) ||
            !block ||
            (block.type !== "text" && block.type !== "tool_use")
          )
            throw invalid();
          blocks.set(event.index, {
            type: block.type,
            id: block.type === "tool_use" ? block.id : undefined,
            name: block.type === "tool_use" ? block.name : undefined,
            json: "",
            closed: false,
          });
          continue;
        }
        if (event.type === "content_block_stop") {
          const block = blocks.get(event.index);
          if (!block || block.closed) throw invalid();
          block.closed = true;
          continue;
        }
        if (event.type === "content_block_delta") {
          const block = blocks.get(event.index);
          const delta = event.delta;
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
      }
      requestSignal.throwIfAborted();
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
        const input: unknown = JSON.parse(block.json || "{}");
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw invalid();
        tools.push({ id: block.id, name: block.name, input });
      }
      for (const tool of tools) report(tool);
    },
  );
  // Anthropic input_tokens excludes both cache reads and cache writes.
  const usage = messagesUsage(inputUsage, outputTokens);
  if (usage) report({ usage });
  return requestId;
}
