const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const http = require("node:http");
const { streamChat, toChatMessages } = require("../dist/transport");
const {
  streamMessages,
  toAnthropicMessages,
} = require("../dist/messages-transport");
const {
  streamResponses,
  toResponsesInput,
} = require("../dist/responses-transport");

const vscode = {
  LanguageModelChatMessageRole: { Assistant: 2 },
  LanguageModelTextPart: class {
    constructor(value) {
      this.value = value;
    }
  },
  LanguageModelToolCallPart: class {
    constructor(callId, name, input) {
      Object.assign(this, { callId, name, input });
    }
  },
  LanguageModelToolResultPart: class {
    constructor(callId, content) {
      Object.assign(this, { callId, content });
    }
  },
};
const originalLoad = Module._load;
let extension;
try {
  Module._load = function (id, ...args) {
    return id === "vscode" ? vscode : originalLoad.call(this, id, ...args);
  };
  extension = require("../dist/extension");
} finally {
  Module._load = originalLoad;
}

test("browser screenshot results preserve bytes, call IDs and parallel tool ordering", async (t) => {
  const image = {
    data: Uint8Array.from([0, 1, 2, 255]),
    mimeType: "image/png",
  };
  const toolRequestMessages = [
    {
      role: 2,
      content: [
        new vscode.LanguageModelToolCallPart("screen-1", "screenshot", {}),
        new vscode.LanguageModelToolCallPart("screen-2", "screenshot", {}),
        new vscode.LanguageModelToolCallPart("read-1", "read", {}),
      ],
    },
    {
      role: 1,
      content: [
        new vscode.LanguageModelToolResultPart("screen-1", [
          new vscode.LanguageModelTextPart("Before"),
          image,
          new vscode.LanguageModelTextPart("After"),
        ]),
        new vscode.LanguageModelToolResultPart("screen-2", [
          { data: Uint8Array.from([3]), mimeType: "image/jpeg" },
        ]),
        new vscode.LanguageModelToolResultPart("read-1", [
          new vscode.LanguageModelTextPart("line 1"),
          new vscode.LanguageModelTextPart("line 2"),
        ]),
      ],
    },
    { role: 1, content: [new vscode.LanguageModelTextPart("Continue")] },
  ];
  const toolHistory = extension.toMessages(toolRequestMessages);
  const pngUrl = "data:image/png;base64,AAEC/w==";
  const jpegUrl = "data:image/jpeg;base64,Aw==";
  assert.deepEqual(toolHistory[1], {
    role: "tool",
    tool_call_id: "screen-1",
    content: [
      { type: "text", text: "Before" },
      { type: "image_url", image_url: { url: pngUrl } },
      { type: "text", text: "After" },
    ],
  });
  assert.equal(toolHistory[3].content, "line 1\nline 2");
  const responsesHistory = toResponsesInput(toolHistory);
  assert.deepEqual(responsesHistory.slice(3, 6), [
    {
      type: "function_call_output",
      call_id: "screen-1",
      output: [
        { type: "input_text", text: "Before" },
        { type: "input_image", image_url: pngUrl },
        { type: "input_text", text: "After" },
      ],
    },
    {
      type: "function_call_output",
      call_id: "screen-2",
      output: [{ type: "input_image", image_url: jpegUrl }],
    },
    {
      type: "function_call_output",
      call_id: "read-1",
      output: "line 1\nline 2",
    },
  ]);
  const anthropicHistory = toAnthropicMessages(toolHistory);
  assert.deepEqual(anthropicHistory[1].content[0], {
    type: "tool_result",
    tool_use_id: "screen-1",
    content: [
      { type: "text", text: "Before" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "AAEC/w==" },
      },
      { type: "text", text: "After" },
    ],
  });
  assert.equal(anthropicHistory[1].content[1].tool_use_id, "screen-2");
  assert.deepEqual(anthropicHistory[1].content[1].content, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "Aw==" },
    },
  ]);
  const chatHistory = toChatMessages(toolHistory);
  assert.deepEqual(chatHistory.slice(1, 4), [
    { role: "tool", tool_call_id: "screen-1", content: "Before\nAfter" },
    { role: "tool", tool_call_id: "screen-2", content: "" },
    { role: "tool", tool_call_id: "read-1", content: "line 1\nline 2" },
  ]);
  assert.deepEqual(chatHistory[4], {
    role: "user",
    content: [
      { type: "text", text: "Images from tool screen-1:" },
      { type: "image_url", image_url: { url: pngUrl } },
      { type: "text", text: "Images from tool screen-2:" },
      { type: "image_url", image_url: { url: jpegUrl } },
    ],
  });
  assert.equal(chatHistory[5].content, "Continue");
  assert.deepEqual(
    toChatMessages(toolHistory.slice(0, -1)),
    chatHistory.slice(0, -1),
  );
  const nextScreenshot = { type: "image_url", image_url: { url: jpegUrl } };
  assert.deepEqual(
    toChatMessages([
      ...toolHistory.slice(0, -1),
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "screen-next",
            type: "function",
            function: { name: "screenshot", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "screen-next", content: [nextScreenshot] },
    ]).filter((message) => message.role === "user"),
    [
      chatHistory[4],
      {
        role: "user",
        content: [
          { type: "text", text: "Images from tool screen-next:" },
          nextScreenshot,
        ],
      },
    ],
  );
  for (const [content, expected] of [
    [[], ""],
    [[new vscode.LanguageModelTextPart("plain")], "plain"],
  ])
    assert.equal(
      extension.toMessages([
        {
          role: 1,
          content: [new vscode.LanguageModelToolResultPart("one", content)],
        },
      ])[0].content,
      expected,
    );
  for (const content of [
    [{}],
    [{ data: new Uint8Array([1]), mimeType: "image/bmp" }],
  ])
    assert.throws(
      () =>
        extension.toMessages([
          {
            role: 1,
            content: [new vscode.LanguageModelToolResultPart("one", content)],
          },
        ]),
      /supports/,
    );
  const received = [];
  const service = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (req.url === "/v1/responses")
      res.end(
        'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
      );
    else if (req.url === "/v1/messages")
      res.end(
        'event: message_start\ndata: {"type":"message_start","message":{}}\n\n' +
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      );
    else
      res.end(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
  });
  t.after(() => {
    service.closeAllConnections();
    service.close();
  });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${service.address().port}`;
  for (const [stream, body] of [
    [streamChat, { messages: chatHistory }],
    [streamMessages, { messages: anthropicHistory }],
    [streamResponses, { input: responsesHistory }],
  ])
    await stream(
      origin,
      "synthetic",
      { model: "fixture", ...body },
      new AbortController().signal,
      () => {},
    );
  assert.deepEqual(
    received.map(({ path }) => path),
    ["/v1/chat/completions", "/v1/messages", "/v1/responses"],
  );
  assert.deepEqual(received[0].body.messages, chatHistory);
  assert.deepEqual(received[1].body.messages, anthropicHistory);
  assert.deepEqual(received[2].body.input, responsesHistory);
});
