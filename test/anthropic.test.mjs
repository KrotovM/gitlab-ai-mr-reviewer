// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createAnthropicCompletion } from "../dist/cli/anthropic.js";

/** Records every request and answers with the scripted messages in order. */
function fakeClient(responses) {
  const requests = [];
  const stream = (params) => {
    requests.push(structuredClone(params));
    return { finalMessage: async () => responses.shift() };
  };
  return { requests, beta: { messages: { stream } } };
}

const reply = (content, stop_reason = "end_turn", extra = {}) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_details: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 100,
  },
  ...extra,
});

const grepTool = {
  type: "function",
  function: {
    name: "grep_repository",
    description: "Search the repository.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

test("anthropic: tool round replays Claude's turn verbatim and keeps tools for the final answer", async () => {
  const turn = [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "tool_use", id: "toolu_1", name: "grep_repository", input: { query: "foo" } },
  ];
  const client = fakeClient([
    reply(turn, "tool_use"),
    reply([{ type: "text", text: "LGTM" }]),
  ]);
  const messages = [
    { role: "system", content: "You review code." },
    { role: "user", content: "Diff" },
  ];

  const first = await createAnthropicCompletion(client, {
    model: "claude-opus-5-5",
    temperature: 0.2,
    messages,
    tools: [grepTool],
    tool_choice: "required",
  });
  const toolCalls = first.choices[0].message.tool_calls;
  assert.deepEqual(toolCalls, [
    {
      id: "toolu_1",
      type: "function",
      function: { name: "grep_repository", arguments: '{"query":"foo"}' },
    },
  ]);

  // Same history shape the review loops in ci-review.ts build between rounds.
  messages.push(
    { role: "assistant", content: "", tool_calls: toolCalls },
    { role: "tool", tool_call_id: "toolu_1", content: '{"ok":true}' },
    { role: "user", content: "Tool-call limit reached." },
  );
  const final = await createAnthropicCompletion(client, {
    model: "claude-opus-5-5",
    temperature: 0.2,
    messages,
  });

  const [round1, round2] = client.requests;
  assert.equal(round1.system, "You review code.");
  assert.equal(round1.temperature, undefined);
  assert.equal(round1.fallbacks, "default");
  assert.deepEqual(round1.cache_control, { type: "ephemeral" });
  assert.deepEqual(round1.tool_choice, { type: "auto" });
  assert.deepEqual(round1.tools, [
    {
      name: "grep_repository",
      description: "Search the repository.",
      input_schema: grepTool.function.parameters,
    },
  ]);
  assert.deepEqual(round2.messages, [
    { role: "user", content: [{ type: "text", text: "Diff" }] },
    { role: "assistant", content: turn },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":true}' },
        { type: "text", text: "Tool-call limit reached." },
      ],
    },
  ]);
  assert.deepEqual(round2.tools, round1.tools);
  assert.deepEqual(round2.tool_choice, { type: "none" });
  assert.equal(final.choices[0].message.content, "LGTM");
  assert.equal(final.usage.prompt_tokens, 110);
});

test("anthropic: a refusal throws so the pass falls back instead of posting an empty review", async () => {
  const client = fakeClient([
    reply([], "refusal", {
      stop_details: { type: "refusal", category: "cyber", explanation: null },
    }),
  ]);
  await assert.rejects(
    createAnthropicCompletion(client, {
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "Diff" }],
    }),
    /refused.*cyber/,
  );
});

test("anthropic: after a mid-output fallback only the fallback model's tool calls run and replay", async () => {
  const content = [
    { type: "thinking", thinking: "", signature: "declined" },
    { type: "tool_use", id: "toolu_declined", name: "grep_repository", input: { query: "a" } },
    {
      type: "fallback",
      from: { model: "claude-opus-5-5" },
      to: { model: "claude-opus-4-8" },
      trigger: { type: "refusal" },
    },
    { type: "tool_use", id: "toolu_fallback", name: "grep_repository", input: { query: "b" } },
  ];
  const client = fakeClient([
    reply(content, "tool_use"),
    reply([{ type: "text", text: "done" }]),
  ]);
  const messages = [{ role: "user", content: "Diff" }];

  const first = await createAnthropicCompletion(client, {
    model: "claude-opus-5-5",
    messages,
    tools: [grepTool],
  });
  const toolCalls = first.choices[0].message.tool_calls;
  assert.deepEqual(
    toolCalls.map((c) => c.id),
    ["toolu_fallback"],
  );

  messages.push(
    { role: "assistant", content: "", tool_calls: toolCalls },
    { role: "tool", tool_call_id: "toolu_fallback", content: "{}" },
  );
  await createAnthropicCompletion(client, {
    model: "claude-opus-5-5",
    messages,
    tools: [grepTool],
  });
  assert.deepEqual(client.requests[1].messages[1], {
    role: "assistant",
    content: content.slice(2),
  });
});
