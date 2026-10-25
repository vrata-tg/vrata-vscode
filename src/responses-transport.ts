import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";
import { openAIClient, TransportError, withModelStream } from "./model-client";
import { tokenUsage, Usage } from "./usage";

import { Message, MessageContentPart, Part } from "./transport";

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
        output: Array.isArray(message.content)
          ? message.content.map(responseContent)
          : (message.content ?? ""),
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
        .responses.create(
          {
            ...body,
            stream: true,
          } as ResponseCreateParamsStreaming,
          { signal: requestSignal },
        )
        .withResponse(),
    async (events, requestId, requestSignal) => {
      const calls = new Map<string, FunctionCall>();
      let completed = false;
      let nextIndex = 0;
      const invalid = () =>
        new TransportError("invalid_stream", 200, requestId);
      const functionCall = (
        itemId: string,
        index: number | undefined,
        item?: ResponseFunctionToolCall,
      ): FunctionCall => {
        let call = calls.get(itemId);
        if (!call) {
          call = { index: index ?? nextIndex++, arguments: "" };
          calls.set(itemId, call);
        }
        if (index !== undefined) call.index = index;
        if (typeof item?.call_id === "string") call.callId = item.call_id;
        if (typeof item?.name === "string") call.name = item.name;
        if (typeof item?.arguments === "string")
          call.arguments = item.arguments;
        return call;
      };
      for await (const event of events) {
        requestSignal.throwIfAborted();
        if (
          !event ||
          typeof event !== "object" ||
          typeof event.type !== "string"
        )
          throw invalid();
        if (
          event.type === "error" ||
          event.type === "response.failed" ||
          event.type === "response.incomplete"
        )
          throw new TransportError("stream_error", 200, requestId, {
            cause: event,
          });
        if (
          event.type === "response.output_text.delta" ||
          event.type === "response.refusal.delta"
        ) {
          if (typeof event.delta !== "string") throw invalid();
          report({ text: event.delta });
        } else if (
          event.type === "response.output_item.added" ||
          event.type === "response.output_item.done"
        ) {
          const item = event.item;
          if (item?.type === "function_call") {
            if (
              typeof item.id !== "string" ||
              !Number.isSafeInteger(event.output_index)
            )
              throw invalid();
            functionCall(item.id, event.output_index, item);
          }
        } else if (
          event.type === "response.function_call_arguments.delta" ||
          event.type === "response.function_call_arguments.done"
        ) {
          if (typeof event.item_id !== "string") throw invalid();
          const call = functionCall(event.item_id, undefined);
          if (event.type === "response.function_call_arguments.delta") {
            if (typeof event.delta !== "string") throw invalid();
            call.arguments += event.delta;
          } else {
            if (typeof event.arguments !== "string") throw invalid();
            call.arguments = event.arguments;
          }
        } else if (event.type === "response.completed") {
          const response = event.response;
          usage = tokenUsage(
            response?.usage?.input_tokens,
            response?.usage?.output_tokens,
            response?.usage?.input_tokens_details?.cached_tokens,
          );
          completed = true;
          break;
        }
      }
      requestSignal.throwIfAborted();
      if (!completed) throw invalid();
      const parts: Part[] = [...calls.values()]
        .sort((left, right) => left.index - right.index)
        .map((call) => {
          if (!call.callId || !call.name) throw invalid();
          const input: unknown = JSON.parse(call.arguments || "{}");
          if (!input || typeof input !== "object" || Array.isArray(input))
            throw invalid();
          return { id: call.callId, name: call.name, input };
        });
      for (const part of parts) report(part);
    },
  );
  if (usage) report({ usage });
  return requestId;
}
