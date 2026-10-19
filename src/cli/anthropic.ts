/** @format */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/index.mjs";

type BetaBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaTool = Anthropic.Beta.BetaTool;

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

/** Raw assistant turns by their first tool_use id. The review loops rebuild
 *  assistant messages from content + tool_calls, but Claude needs its thinking
 *  blocks back verbatim, and the closing no-tools round must resend the same
 *  tools: both are part of the prefix the API validates thinking blocks against. */
const turns = new Map<string, { content: BetaBlockParam[]; tools: BetaTool[] }>();

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? "").join("")
      : "";

/** Runs an OpenAI-shaped chat request (as built in ci-review.ts) on the Anthropic
 *  Messages API and returns the answer as a ChatCompletion. `temperature` and
 *  `response_format` are dropped: Claude 4.7+ reject non-default sampling, and the
 *  triage parser already tolerates replies without JSON mode. */
export async function createAnthropicCompletion(
  client: Anthropic,
  request: {
    model: string;
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
  },
  signal?: AbortSignal,
): Promise<ChatCompletion> {
  let tools = request.tools?.flatMap((tool): BetaTool[] =>
    tool.type === "function"
      ? [
          {
            name: tool.function.name,
            description: tool.function.description,
            input_schema: tool.function.parameters as BetaTool["input_schema"],
          },
        ]
      : [],
  );
  const system: string[] = [];
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  // Tool results of one round, and any user text after them, share one user turn.
  const pushUser = (block: BetaBlockParam) => {
    const last = messages.at(-1);
    if (last?.role === "user" && Array.isArray(last.content)) {
      last.content.push(block);
    } else {
      messages.push({ role: "user", content: [block] });
    }
  };
  for (const message of request.messages) {
    if (message.role === "system" || message.role === "developer") {
      system.push(textOf(message.content));
    } else if (message.role === "user") {
      pushUser({ type: "text", text: textOf(message.content) });
    } else if (message.role === "tool") {
      pushUser({
        type: "tool_result",
        tool_use_id: message.tool_call_id,
        content: textOf(message.content),
      });
    } else if (message.role === "assistant") {
      const turn = turns.get(message.tool_calls?.[0]?.id ?? "");
      tools ??= turn?.tools;
      messages.push({
        role: "assistant",
        content: turn?.content ?? textOf(message.content),
      });
    }
  }

  const response = await client.beta.messages
    .stream(
      {
        model: request.model,
        max_tokens: 64_000,
        ...(system.length > 0 && { system: system.join("\n\n") }),
        messages,
        // Tool rounds resend the growing history, so cache it. --force-tools maps
        // to auto: Claude Opus/Sonnet 5.5 reject forced tool use. The closing round
        // after the tool limit turns the tools off instead of dropping them.
        ...(tools && {
          tools,
          tool_choice: request.tools ? { type: "auto" } : { type: "none" },
          cache_control: { type: "ephemeral" },
        }),
        // A safety-classifier refusal is re-run on Anthropic's recommended fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    )
    .finalMessage();
  if (response.stop_reason === "refusal") {
    throw new Error(
      `Model refused the request (category: ${response.stop_details?.category ?? "none"}).`,
    );
  }

  // After a mid-output fallback only the declined model's text carries over; its
  // thinking and tool calls are not part of the conversation the fallback continued.
  const cut = response.content.map((block) => block.type).lastIndexOf("fallback");
  const content = response.content.filter(
    (block, i) => i >= cut || block.type === "text",
  );
  const toolUses = content.filter((block) => block.type === "tool_use");
  if (toolUses[0] != null) {
    turns.set(toolUses[0].id, { content, tools: tools ?? [] });
  }

  const usage = response.usage;
  const promptTokens =
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  return {
    id: response.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: response.model,
    // Raw fields stay too, so debug artifacts show cache reads.
    usage: {
      ...usage,
      prompt_tokens: promptTokens,
      completion_tokens: usage.output_tokens,
      total_tokens: promptTokens + usage.output_tokens,
    },
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason:
          toolUses.length > 0
            ? "tool_calls"
            : response.stop_reason === "max_tokens"
              ? "length"
              : "stop",
        message: {
          role: "assistant",
          content: content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join(""),
          refusal: null,
          ...(toolUses.length > 0 && {
            tool_calls: toolUses.map((block) => ({
              id: block.id,
              type: "function" as const,
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            })),
          }),
        },
      },
    ],
  };
}
