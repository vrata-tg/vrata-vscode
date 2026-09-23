import * as vscode from "vscode";
import { Message, streamChat } from "./transport";

function text(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) return part.value;
      throw new Error("Spike supports text tool results only");
    })
    .join("\n");
}

export function toMessages(
  messages: readonly vscode.LanguageModelChatRequestMessage[],
): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    const role =
      message.role === vscode.LanguageModelChatMessageRole.Assistant
        ? "assistant"
        : "user";
    let content = "";
    const calls: NonNullable<Message["tool_calls"]> = [];
    const flush = () => {
      if (content || calls.length)
        result.push({
          role,
          content: content || null,
          ...(calls.length ? { tool_calls: [...calls] } : {}),
        });
      content = "";
      calls.length = 0;
    };
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) content += part.value;
      else if (part instanceof vscode.LanguageModelToolCallPart) {
        calls.push({
          id: part.callId,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input) },
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        flush();
        result.push({
          role: "tool",
          tool_call_id: part.callId,
          content: text(part.content),
        });
      } else throw new Error("Spike supports text and tool parts only");
    }
    flush();
  }
  return result;
}

export function activate(context: vscode.ExtensionContext): void {
  // Explicit development host only: no production onboarding or workspace URLs.
  if (context.extensionMode === vscode.ExtensionMode.Production) return;
  const endpoint = process.env.VRATA_SPIKE_ENDPOINT;
  const key = process.env.VRATA_SPIKE_KEY;
  if (!endpoint || !key)
    throw new Error(
      "Set the spike endpoint and dedicated test key before launching",
    );
  const models = ["gpt-5.6-terra", "claude-sonnet-5"].map((id) => ({
    id,
    name: `${id} (spike)`,
    family: id,
    version: "spike",
    maxInputTokens: 60000,
    maxOutputTokens: 4096,
    capabilities: { toolCalling: true, imageInput: false },
  }));
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("vrata", {
      provideLanguageModelChatInformation: () => models,
      async provideTokenCount(_model, input) {
        // Prototype estimate, never a billing input.
        return Math.ceil(
          Buffer.byteLength(
            typeof input === "string" ? input : JSON.stringify(input),
            "utf8",
          ) / 3,
        );
      },
      async provideLanguageModelChatResponse(
        model,
        messages,
        options,
        progress,
        token,
      ) {
        const controller = new AbortController();
        const subscription = token.onCancellationRequested(() =>
          controller.abort(),
        );
        if (token.isCancellationRequested) controller.abort();
        try {
          await streamChat(
            endpoint,
            key,
            {
              model: model.id,
              messages: toMessages(messages),
              max_tokens: model.maxOutputTokens,
              ...(options.tools?.length
                ? {
                    tools: options.tools.map((tool) => ({
                      type: "function",
                      function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema ?? {
                          type: "object",
                          properties: {},
                        },
                      },
                    })),
                    tool_choice:
                      options.toolMode ===
                      vscode.LanguageModelChatToolMode.Required
                        ? "required"
                        : "auto",
                  }
                : {}),
            },
            controller.signal,
            (part) => {
              progress.report(
                "text" in part
                  ? new vscode.LanguageModelTextPart(part.text)
                  : new vscode.LanguageModelToolCallPart(
                      part.id,
                      part.name,
                      part.input,
                    ),
              );
            },
          );
        } catch (error) {
          if (token.isCancellationRequested)
            throw new vscode.CancellationError();
          throw error;
        } finally {
          subscription.dispose();
        }
      },
    }),
  );
}
