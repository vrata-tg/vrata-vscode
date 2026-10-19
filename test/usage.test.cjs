const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { streamChat } = require("../dist/transport");
const { streamMessages } = require("../dist/messages-transport");
const { streamResponses } = require("../dist/responses-transport");
const { tokenUsage, messagesUsage } = require("../dist/usage");

const expected = {
  prompt_tokens: 60,
  completion_tokens: 12,
  total_tokens: 72,
  prompt_tokens_details: { cached_tokens: 30 },
};
const sse = (event) => `data: ${JSON.stringify(event)}\n\n`;
const fixtures = [
  {
    name: "Chat Completions",
    stream: streamChat,
    events: [
      {
        choices: [{ delta: { content: "ready" }, finish_reason: "stop" }],
        usage: null,
      },
      { choices: [], usage: expected },
    ],
    end: "data: [DONE]\n\n",
  },
  {
    name: "Messages",
    stream: streamMessages,
    events: [
      {
        type: "message_start",
        message: {
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 20,
            cache_read_input_tokens: 30,
            output_tokens: 1,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ready" },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", usage: { output_tokens: 7 } },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 12 },
      },
    ],
    end: sse({ type: "message_stop" }),
  },
  {
    name: "Responses",
    stream: streamResponses,
    events: [{ type: "response.output_text.delta", delta: "ready" }],
    end: sse({
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 60,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 30 },
        },
      },
    }),
  },
];

for (const fixture of fixtures) {
  test(`${fixture.name} reports final usage once and withholds it on interruption`, async (t) => {
    let ending = fixture.end;
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (fixture.stream === streamChat)
        assert.deepEqual(body.stream_options, { include_usage: true });
      else assert.equal(body.stream_options, undefined);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const byte of Buffer.from(fixture.events.map(sse).join("") + ending))
        res.write(Buffer.from([byte]));
      res.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const url = `http://127.0.0.1:${server.address().port}/fixture`;
    const parts = [];
    await fixture.stream(
      url,
      "synthetic",
      {},
      new AbortController().signal,
      (part) => parts.push(part),
    );
    assert.deepEqual(parts, [{ text: "ready" }, { usage: expected }]);
    for (const end of [
      "",
      sse({ type: "error", error: { message: "fixture" } }),
    ]) {
      ending = end;
      parts.length = 0;
      await assert.rejects(
        fixture.stream(
          url,
          "synthetic",
          {},
          new AbortController().signal,
          (part) => parts.push(part),
        ),
      );
      assert.deepEqual(parts, [{ text: "ready" }]);
    }
    ending = fixture.end;
    const controller = new AbortController();
    parts.length = 0;
    await assert.rejects(
      fixture.stream(url, "synthetic", {}, controller.signal, (part) => {
        parts.push(part);
        controller.abort();
      }),
    );
    assert.deepEqual(parts, [{ text: "ready" }]);
  });
}

test("usage never substitutes unknown or invalid counts with estimated numbers", () => {
  for (const invalid of [
    undefined,
    null,
    "12",
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(tokenUsage(invalid, 12), undefined);
    assert.equal(tokenUsage(60, invalid), undefined);
  }
  assert.deepEqual(tokenUsage(0, 0), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
  });
  assert.equal(tokenUsage(60, 12, 61), undefined);
  assert.equal(tokenUsage(Number.MAX_SAFE_INTEGER, 1), undefined);
  assert.equal(
    messagesUsage({ input_tokens: 10, cache_read_input_tokens: "30" }, 12),
    undefined,
  );
  assert.deepEqual(messagesUsage({ input_tokens: 60 }, 12), tokenUsage(60, 12));
});
