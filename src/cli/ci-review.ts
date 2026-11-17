/** @format */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/index.mjs";
import { createAnthropicCompletion } from "./anthropic.js";
import {
  buildAnswer,
  buildConsolidatePrompt,
  buildFileReviewPrompt,
  buildPrompt,
  buildTriagePrompt,
  buildVerificationPrompt,
  DEFAULT_PROMPT_PROFILE,
  DISCLAIMER,
  extractCompletionText,
  insertBeforeDisclaimer,
  isEmptyReviewBody,
  MAX_REVIEW_INSTRUCTIONS_CHARS,
  NO_FINDINGS_SENTENCE,
  NOT_REVIEWED_NOTE,
  parseTriageResponseDetailed,
  type PromptLimits,
  type PromptProfile,
  type TriageFileInput,
  type TriageFileVerdict,
  type TriageResult,
  withReviewInstructions,
} from "../prompt/index.js";
import {
  fetchFileAtRef,
  searchRepository,
  type MergeRequestChange,
} from "../gitlab/services.js";
import { parseReviewFindings, truncateWithMarker } from "../prompt/utils.js";
import {
  logToolFailure,
  logToolUsageMinimal,
  MAX_FILE_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS,
  MAX_VERIFICATION_TOOL_ROUNDS,
  TOOL_NAME_GET_FILE,
  TOOL_NAME_GREP,
} from "./tooling.js";

/** Hard deadline per model call, retries included. Must exceed the gateway's own
 *  proxy timeout so the SDK's 5xx retries stay the first line of defense. */
const COMPLETION_TIMEOUT_MS = 180_000;

/** Optional OpenAI request params that some endpoints reject with a 400: strict
 *  gateways refuse stream_options, and reasoning models (o-series, gpt-5 with
 *  reasoning on) accept only the default temperature. Each one is dropped for
 *  the rest of the run the first time a 400 names it. */
const OPTIONAL_PARAMS = ["stream_options", "temperature"] as const;
const droppedParams = new Set<string>();

/** Tool-result caps. Every tool response is re-sent as prompt on each following
 *  round, so oversized results multiply prefill time on self-hosted models. */
const MAX_TOOL_FILE_CHARS = 12_000;
const MAX_TOOL_GREP_CHARS = 800;
const MAX_TOOL_GREP_RESULTS = 10;

type LoggerFns = {
  logStep: (message: string) => void;
  logDebug: (message: string) => void;
};
type DebugRecordWriter = (record: Record<string, unknown>) => Promise<void> | void;
type Refs = { base: string; head: string };

/** What every model call and tool call of one review run needs. */
type RunContext = {
  llm: OpenAI | Anthropic;
  aiModel: string;
  refs: Refs;
  gitLabProjectApiUrl: URL;
  headers: Record<string, string>;
  forceTools: boolean;
  /** Repository REVIEW.md (see loadReviewInstructions), appended to every pass. */
  reviewInstructions?: string;
  loggers: LoggerFns;
  debugRecordWriter?: DebugRecordWriter;
};

type CompletionRequest = {
  model: string;
  temperature: number;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  tool_choice?: "auto" | "required";
  response_format?: { type: "json_object" };
};

type TriageReviewAction = "review" | "skipped" | "reviewed_via_override";

type TriageFileDecision = TriageFileVerdict & {
  review_action: TriageReviewAction;
};

function buildTriageDecisions(params: {
  changes: MergeRequestChange[];
  triageResult: TriageResult;
}): { decisions: TriageFileDecision[]; skipAllOverride: boolean; reviewFiles: MergeRequestChange[] } {
  const { changes, triageResult } = params;
  const triageMap = new Map(triageResult.files.map((f) => [f.path, f]));
  let reviewFiles = changes.filter(
    (c) => triageMap.get(c.new_path)?.verdict !== "SKIP",
  );
  const skipAllOverride = reviewFiles.length === 0;
  if (skipAllOverride) reviewFiles = changes;

  const decisions: TriageFileDecision[] = changes.map((change) => {
    const path = change.new_path;
    const triageFile = triageMap.get(path);
    const verdict = triageFile?.verdict ?? "NEEDS_REVIEW";
    const reason =
      triageFile?.reason ??
      (triageFile == null ? "not listed in triage response" : undefined);
    let review_action: TriageReviewAction;
    if (verdict === "NEEDS_REVIEW" || triageFile == null) {
      review_action = "review";
    } else if (skipAllOverride) {
      review_action = "reviewed_via_override";
    } else {
      review_action = "skipped";
    }
    return {
      path,
      verdict,
      ...(reason != null ? { reason } : {}),
      review_action,
    };
  });

  return { decisions, skipAllOverride, reviewFiles };
}

function formatTriageDecisionLine(decision: TriageFileDecision): string {
  const reasonSuffix =
    decision.reason != null && decision.reason !== ""
      ? ` — ${decision.reason}`
      : "";
  switch (decision.review_action) {
    case "skipped":
      return `  Skipped: ${decision.path} (${decision.verdict})${reasonSuffix}`;
    case "reviewed_via_override":
      return `  Reviewed via override: ${decision.path} (triage=${decision.verdict})${reasonSuffix}`;
    default:
      return `  Review: ${decision.path} (${decision.verdict})${reasonSuffix}`;
  }
}

async function record(
  ctx: RunContext,
  entry: Record<string, unknown>,
): Promise<void> {
  await ctx.debugRecordWriter?.({ ts: new Date().toISOString(), ...entry });
}

async function complete(
  ctx: RunContext,
  label: string,
  request: CompletionRequest,
): Promise<ChatCompletion> {
  const { llm } = ctx;
  await record(ctx, { kind: "openai_request", label, request });
  // Stream and reassemble: reverse proxies (nginx proxy_read_timeout) return 504 on
  // long silent non-streamed completions; streamed chunks keep the connection alive.
  // The SDK's own timeout only covers time-to-headers; a stalled SSE body would hang
  // forever without the explicit AbortSignal deadline.
  const attempt = (): Promise<ChatCompletion> => {
    if (llm instanceof Anthropic) {
      return createAnthropicCompletion(
        llm,
        request,
        AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      );
    }
    const body: Record<string, unknown> = {
      ...request,
      stream_options: { include_usage: true },
    };
    for (const param of droppedParams) delete body[param];
    return llm.chat.completions
      .stream(body as CompletionRequest, {
        signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS),
      })
      .finalChatCompletion();
  };
  try {
    let completion: ChatCompletion;
    // Each retry drops one more param, so this ends after OPTIONAL_PARAMS.length retries.
    for (;;) {
      try {
        completion = await attempt();
        break;
      } catch (error: any) {
        const message = String(error?.message ?? "");
        const rejected =
          !(llm instanceof Anthropic) &&
          error?.status === 400 &&
          OPTIONAL_PARAMS.find((p) => !droppedParams.has(p) && message.includes(p));
        if (!rejected) throw error;
        droppedParams.add(rejected);
      }
    }
    await record(ctx, {
      kind: "openai_response",
      label,
      response: {
        id: completion.id,
        model: completion.model,
        usage: completion.usage,
        choices: completion.choices.map((c) => ({
          index: c.index,
          finish_reason: c.finish_reason,
          message: c.message,
        })),
      },
    });
    return completion;
  } catch (error: any) {
    await record(ctx, {
      kind: "openai_error",
      label,
      error: {
        name: error?.name,
        message: error?.message,
        code: error?.code,
        status: error?.status,
        type: error?.type,
      },
    });
    throw error;
  }
}

function buildReviewMetadata(changes: MergeRequestChange[], refs: Refs): string {
  const files = changes.map((change, index) => ({
    index: index + 1,
    old_path: change.old_path,
    new_path: change.new_path,
    new_file: change.new_file ?? false,
    deleted_file: change.deleted_file ?? false,
    renamed_file: change.renamed_file ?? false,
  }));
  return JSON.stringify(
    {
      refs,
      changed_files: files,
      tool_usage_guidance: [
        "If diff context is insufficient, call get_file_at_ref to read a specific file.",
        "Use grep_repository to find usages or definitions by literal text (no regex) across the codebase.",
        "Use refs.base to inspect pre-change content and refs.head for current content.",
        "Prefer targeted searches and file fetches; avoid broad context requests.",
      ],
    },
    null,
    2,
  );
}

function buildTools(refs: Refs): ChatCompletionTool[] {
  return [
    {
      type: "function",
      function: {
        name: TOOL_NAME_GET_FILE,
        description: `Read a repository file at a git ref. Each returned line starts with its line number and a tab; the result also gives start_line, end_line and total_lines. One call returns at most about ${MAX_TOOL_FILE_CHARS.toLocaleString("en-US")} characters: when truncated is true, call again with start_line set to next_start_line, or pass start_line/end_line to read just the region you need in a large file. Use the head ref for the code as the merge request leaves it and the base ref for the code before it. A file that doesn't exist at the ref (e.g. a new file at base) returns ok: false with the HTTP status.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Repository file path." },
            ref: {
              type: "string",
              description: `Git ref or sha. Prefer "${refs.base}" (base) or "${refs.head}" (head).`,
            },
            start_line: {
              type: "integer",
              minimum: 1,
              description: "First line to return (1-based). Default: 1.",
            },
            end_line: {
              type: "integer",
              minimum: 1,
              description: "Last line to return, inclusive. Default: end of file.",
            },
          },
          required: ["path", "ref"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: TOOL_NAME_GREP,
        description:
          "Search the repository for literal text (case-insensitive substring match). Regular expressions are not supported: `a|b` or `foo.*bar` are searched as literal text, so query one identifier at a time. Returns up to 10 matching code fragments with file paths and line numbers.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description:
                "Literal text to find, e.g. a function or variable name (no regex).",
            },
            ref: {
              type: "string",
              description: `Git ref to search in. Prefer "${refs.head}" (head).`,
            },
          },
          required: ["query"],
        },
      },
    },
  ];
}

export async function handleGetFileTool(
  ctx: Pick<RunContext, "gitLabProjectApiUrl" | "headers" | "loggers">,
  argsRaw: string,
): Promise<string> {
  const { logStep } = ctx.loggers;
  try {
    const parsed = JSON.parse(argsRaw) as {
      path?: string;
      ref?: string;
      start_line?: number;
      end_line?: number;
    };
    const path = parsed.path?.trim();
    const ref = parsed.ref?.trim();
    if (!path || !ref) {
      return JSON.stringify({
        ok: false,
        error: "Both path and ref are required.",
      });
    }
    const fileText = await fetchFileAtRef({
      gitLabProjectApiUrl: ctx.gitLabProjectApiUrl,
      headers: ctx.headers,
      filePath: path,
      ref,
    });
    if (fileText instanceof Error) {
      logToolFailure(logStep, TOOL_NAME_GET_FILE, fileText);
      return JSON.stringify({
        ok: false,
        path,
        ref,
        status: fileText.statusCode,
        error: fileText.message,
      });
    }
    const lines = fileText.split("\n");
    if (fileText.endsWith("\n")) lines.pop();
    const start = Math.max(1, Math.floor(Number(parsed.start_line) || 1));
    const end = Math.min(
      lines.length,
      Math.floor(Number(parsed.end_line) || lines.length),
    );
    if (start > lines.length) {
      return JSON.stringify({
        ok: false,
        path,
        ref,
        error: `start_line ${start} is past the end of the file (${lines.length} lines).`,
      });
    }
    // Numbered like `cat -n`, so findings cite exact lines instead of counted
    // ones. Cut at a line boundary so next_start_line resumes exactly; a single
    // line longer than the cap (minified code) is sliced.
    const rows: string[] = [];
    let size = 0;
    let last = start - 1;
    for (let n = start; n <= end; n += 1) {
      const row = `${n}\t${lines[n - 1]}`.slice(0, MAX_TOOL_FILE_CHARS);
      if (rows.length > 0 && size + row.length > MAX_TOOL_FILE_CHARS) break;
      rows.push(row);
      size += row.length + 1; // + the newline joining it to the next row
      last = n;
    }
    const truncated = last < end;
    return JSON.stringify({
      ok: true,
      path,
      ref,
      start_line: start,
      end_line: last,
      total_lines: lines.length,
      content: rows.join("\n"),
      truncated,
      ...(truncated ? { next_start_line: last + 1 } : {}),
    });
  } catch (error: any) {
    logToolFailure(logStep, TOOL_NAME_GET_FILE, error);
    return JSON.stringify({
      ok: false,
      error: `Tool call failed: ${String(error?.message ?? error)}`,
      raw: argsRaw,
    });
  }
}

async function handleGrepTool(ctx: RunContext, argsRaw: string): Promise<string> {
  const { refs } = ctx;
  const { logStep } = ctx.loggers;
  try {
    const parsed = JSON.parse(argsRaw) as { query?: string; ref?: string };
    const query = parsed.query?.trim();
    if (!query)
      return JSON.stringify({ ok: false, error: "query is required." });
    // GitLab search answers 200 [] for unknown refs, so only the MR's own refs are searched.
    const ref = parsed.ref?.trim() === refs.base ? refs.base : refs.head;
    const results = await searchRepository({
      gitLabProjectApiUrl: ctx.gitLabProjectApiUrl,
      headers: ctx.headers,
      query,
      ref,
    });
    if (results instanceof Error) {
      logToolFailure(logStep, TOOL_NAME_GREP, results);
      return JSON.stringify({
        ok: false,
        query,
        ref,
        status: results.statusCode,
        error: results.message,
      });
    }
    // GitLab lists file-name matches (file head, startline 1) before content matches;
    // rank hits that contain the query first so they aren't crowded out.
    const needle = query.toLowerCase();
    const hasNeedle = (r: { data: string | null }) =>
      (r.data ?? "").toLowerCase().includes(needle);
    const trimmed = results
      .sort((a, b) => Number(hasNeedle(b)) - Number(hasNeedle(a)))
      .slice(0, MAX_TOOL_GREP_RESULTS)
      .map((r) => ({
        path: r.path,
        startline: r.startline,
        data: (r.data ?? "").slice(0, MAX_TOOL_GREP_CHARS),
      }));
    return JSON.stringify({ ok: true, query, ref, matches: trimmed });
  } catch (error: any) {
    logToolFailure(logStep, TOOL_NAME_GREP, error);
    return JSON.stringify({
      ok: false,
      error: `Tool call failed: ${String(error?.message ?? error)}`,
      raw: argsRaw,
    });
  }
}

async function runTool(ctx: RunContext, name: string, argsRaw: string): Promise<string> {
  if (name === TOOL_NAME_GET_FILE) return handleGetFileTool(ctx, argsRaw);
  if (name === TOOL_NAME_GREP) return handleGrepTool(ctx, argsRaw);
  return JSON.stringify({ ok: false, error: `Unknown tool "${name}"` });
}

/** Calls the model with the repo tools until it answers without tool calls or
 *  `maxRounds` runs out, then asks once more with tools off. */
async function runToolLoop(
  ctx: RunContext,
  params: {
    /** Request label prefix; debug-artifacts-html.ts groups passes by it. */
    label: string;
    phase: string;
    /** Shown in `[tools]` log lines and tool-call debug records. */
    context?: string;
    messages: ChatCompletionMessageParam[];
    maxRounds: number;
    temperature: number;
    forceFirstRound: boolean;
    limitMessage: string;
    /** When set, every round is logged under this name. */
    progress?: string;
  },
): Promise<ChatCompletion> {
  const { label, phase, context, maxRounds, temperature, progress } = params;
  const { logStep, logDebug } = ctx.loggers;
  const messages = [...params.messages];
  const tools = buildTools(ctx.refs);

  for (let round = 1; round <= maxRounds; round += 1) {
    if (progress)
      logStep(`${progress} round ${round}/${maxRounds}: requesting model response...`);
    const completion = await complete(ctx, `${label}_round_${round}`, {
      model: ctx.aiModel,
      temperature,
      messages,
      tools,
      tool_choice: params.forceFirstRound && round === 1 ? "required" : "auto",
    });
    const message = completion.choices[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    logDebug(
      `${label} round=${round} tool_calls=${toolCalls.length} finish_reason=${completion.choices[0]?.finish_reason ?? "unknown"}`,
    );
    if (progress)
      logStep(`${progress} round ${round}: model returned ${toolCalls.length} tool call(s).`);
    if (message == null || toolCalls.length === 0) return completion;

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: toolCalls,
    });
    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") continue;
      const name = toolCall.function.name;
      const argsRaw = toolCall.function.arguments || "{}";
      logToolUsageMinimal(logStep, name, argsRaw, context);
      const result = await runTool(ctx, name, argsRaw);
      messages.push({ role: "tool", tool_call_id: toolCall.id, content: result });
      await record(ctx, {
        kind: "tool_call",
        phase,
        context,
        round,
        id: toolCall.id,
        name,
        arguments: argsRaw,
        result,
      });
      logDebug(
        `tool response ${label} id=${toolCall.id} name=${name} payload=${result.slice(0, 300)}`,
      );
    }
  }

  messages.push({ role: "user", content: params.limitMessage });
  if (progress) logStep(`${progress} tool-call limit reached. Requesting final answer.`);
  return complete(ctx, `${label}_final_after_tool_limit`, {
    model: ctx.aiModel,
    temperature,
    messages,
  });
}

/** Text length of a prompt, the unit --max-total-prompt-chars is measured in. */
function promptChars(messages: ChatCompletionMessageParam[]): number {
  return messages.reduce(
    (sum, m) => sum + (typeof m.content === "string" ? m.content.length : 0),
    0,
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const idx = nextIndex;
      nextIndex += 1;
      results[idx] = await fn(items[idx]!);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

/** Reads REVIEW.md from the MR's target branch, never from the MR itself, so an
 *  MR can't relax the rules it is reviewed under. Missing file → undefined. */
export async function loadReviewInstructions(params: {
  gitLabProjectApiUrl: URL;
  headers: Record<string, string>;
  mr: { target_branch?: string; diff_refs?: { start_sha?: string } };
  logStep: (message: string) => void;
}): Promise<string | undefined> {
  const { gitLabProjectApiUrl, headers, mr, logStep } = params;
  // start_sha is the target branch tip the diff was built against; base_sha is
  // only the merge-base and may still hold rules the target branch dropped.
  const ref = mr.target_branch ?? mr.diff_refs?.start_sha;
  if (ref == null) return undefined;
  const text = await fetchFileAtRef({
    gitLabProjectApiUrl,
    headers,
    filePath: "REVIEW.md",
    ref,
  });
  if (text instanceof Error) {
    if (text.statusCode !== 404)
      logStep(
        `Could not read REVIEW.md at ${ref} (HTTP ${text.statusCode}); reviewing without it.`,
      );
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const truncated = trimmed.length > MAX_REVIEW_INSTRUCTIONS_CHARS;
  logStep(
    `Using REVIEW.md from ${ref} (${trimmed.length} chars${truncated ? `; only the first ${MAX_REVIEW_INSTRUCTIONS_CHARS} are used` : ""}).`,
  );
  return truncateWithMarker(trimmed, MAX_REVIEW_INSTRUCTIONS_CHARS, "REVIEW.md");
}

async function reviewSinglePass(
  ctx: RunContext,
  params: {
    promptLimits: PromptLimits;
    changes: MergeRequestChange[];
    promptProfile: PromptProfile;
  },
): Promise<string> {
  const { promptLimits, changes, promptProfile } = params;
  ctx.loggers.logStep(
    `Single-pass review started for ${changes.length} file(s) (fallback mode).`,
  );
  const messages = withReviewInstructions(
    buildPrompt({
      changes: changes.map((change) => ({ path: change.new_path, diff: change.diff })),
      limits: promptLimits,
      allowTools: true,
      profile: promptProfile,
    }),
    ctx.reviewInstructions,
  );
  messages.push({
    role: "user",
    content: `Merge request metadata:\n${buildReviewMetadata(changes, ctx.refs)}`,
  });
  const completion = await runToolLoop(ctx, {
    label: "main_review",
    phase: "main_review",
    messages,
    maxRounds: MAX_TOOL_ROUNDS,
    temperature: 0.2,
    forceFirstRound: ctx.forceTools,
    limitMessage: `Tool-call limit reached (${MAX_TOOL_ROUNDS}). Do not call any tools. Provide your best-effort final review now, strictly following the required output format. If confidence is low, return the exact no-issues sentence.`,
    progress: "Single-pass",
  });
  return buildAnswer(completion);
}

export async function reviewMergeRequestMultiPass(
  params: RunContext & {
    promptLimits: PromptLimits;
    triageDiffChars: number;
    changes: MergeRequestChange[];
    maxFindings: number;
    reviewConcurrency: number;
    promptProfile?: PromptProfile;
    /** When AI_PROMPT_PROFILE is not set explicitly, a triage JSON parse failure
     *  demotes the whole run to the "weak" profile (behavioral capability probe). */
    allowProfileAutoDemote?: boolean;
  },
): Promise<string> {
  const ctx: RunContext = params;
  const {
    aiModel,
    promptLimits,
    triageDiffChars,
    changes,
    maxFindings,
    reviewConcurrency,
    promptProfile = DEFAULT_PROMPT_PROFILE,
    allowProfileAutoDemote = false,
    reviewInstructions,
  } = params;
  const { logStep } = params.loggers;
  let effectiveProfile: PromptProfile = promptProfile;

  const triageInputs: TriageFileInput[] = changes.map((c) => ({
    path: c.new_path,
    new_file: c.new_file,
    deleted_file: c.deleted_file,
    renamed_file: c.renamed_file,
    diff: c.diff,
  }));
  const triagePrompt = (profile: PromptProfile, diffChars: number) =>
    withReviewInstructions(
      buildTriagePrompt(triageInputs, profile, diffChars),
      reviewInstructions,
    );
  // Triage sees every file in one call, so a large MR must still fit in
  // --max-total-prompt-chars instead of failing into the single-pass fallback.
  // The prompt with every diff cut to nothing is the fixed cost (system prompt,
  // REVIEW.md, per-file headers and truncation markers); what is left is split
  // evenly across the diffs.
  const triageCharsFor = (profile: PromptProfile): number => {
    const overhead = promptChars(triagePrompt(profile, 0));
    const perFile = Math.floor(
      (promptLimits.maxTotalPromptChars - overhead) / changes.length,
    );
    return Math.max(0, Math.min(triageDiffChars, perFile));
  };
  const triageChars = triageCharsFor(promptProfile);
  logStep(
    `Pass 1/4: triaging ${changes.length} file(s) ` +
      `(prompt profile=${promptProfile}, triage_diff_chars=${triageChars}` +
      `${triageChars < triageDiffChars ? ", capped by --max-total-prompt-chars" : ""})`,
  );
  if (triageChars === 0) {
    logStep(
      "Warning: the file list alone fills --max-total-prompt-chars; triage sees file names and sizes only. Raise the flag for a better triage.",
    );
  }
  const triage = async (profile: PromptProfile, label: string) => {
    const completion = await complete(ctx, label, {
      model: aiModel,
      temperature: 0.1,
      messages: triagePrompt(profile, triageCharsFor(profile)),
      response_format: { type: "json_object" },
    });
    const text = extractCompletionText(completion);
    return { text, parse: text == null ? null : parseTriageResponseDetailed(text) };
  };

  let triageResult: TriageResult | null = null;
  let triageText: string | null = null;
  let triageParse: ReturnType<typeof parseTriageResponseDetailed> | null = null;
  try {
    ({ text: triageText, parse: triageParse } = await triage(promptProfile, "triage_pass"));
    triageResult = triageParse?.result ?? null;
  } catch (error: any) {
    logStep(
      `Triage pass failed: ${error?.message ?? error}. Falling back to single-pass.`,
    );
  }

  // The triage pass doubles as a capability probe: models that cannot return the
  // strict triage JSON with the default prompts follow the terser weak-profile
  // prompts better. Retry triage once with "weak"; on success the remaining
  // passes run with it. (Self-reported model names are unreliable behind
  // gateway aliases, so we probe behavior instead of asking.)
  if (
    triageResult == null &&
    triageText != null &&
    effectiveProfile === "default" &&
    allowProfileAutoDemote
  ) {
    logStep(
      "Triage response unparseable with prompt profile=default. Retrying triage with profile=weak.",
    );
    try {
      const weak = await triage("weak", "triage_pass_weak_retry");
      if (weak.parse?.result != null) {
        triageResult = weak.parse.result;
        effectiveProfile = "weak";
        logStep(
          "Weak-profile triage parsed successfully. Continuing all passes with prompt profile=weak.",
        );
      } else {
        // The failure report below describes the last attempt, this one.
        triageText = weak.text;
        triageParse = weak.parse;
      }
    } catch (error: any) {
      logStep(`Weak-profile triage retry failed: ${error?.message ?? error}.`);
    }
  }

  if (triageResult == null) {
    if (triageText != null) {
      const triagePreview = triageText.replace(/\s+/g, " ").trim().slice(0, 200);
      const parseErrorText =
        triageParse?.parseError != null ? ` parse_error=${triageParse.parseError}` : "";
      logStep(
        `Triage parse failed: reason=${triageParse?.reason}.${parseErrorText} Preview: ${triagePreview || "<empty>"}`,
      );
    } else {
      logStep("Triage parse failed: model returned empty response body.");
    }
    logStep("Falling back to single-pass pipeline.");
    return reviewSinglePass(ctx, {
      promptLimits,
      changes,
      promptProfile: effectiveProfile,
    });
  }

  const { decisions, skipAllOverride, reviewFiles } = buildTriageDecisions({
    changes,
    triageResult,
  });
  const skippedCount = decisions.filter((d) => d.review_action === "skipped").length;

  await record(ctx, {
    kind: "triage_decision",
    summary: triageResult.summary,
    skip_all_override: skipAllOverride,
    triage_diff_chars: triageCharsFor(effectiveProfile),
    files: decisions,
  });

  if (skipAllOverride) {
    logStep(
      `Triage wanted to skip all ${changes.length} file(s) — overriding to review all. Summary: ${triageResult.summary.slice(0, 120)}...`,
    );
  } else {
    logStep(
      `Triage: ${reviewFiles.length} file(s) to review, ${skippedCount} skipped. Summary: ${triageResult.summary.slice(0, 120)}...`,
    );
  }
  for (const decision of decisions) {
    if (decision.review_action === "review") continue;
    logStep(formatTriageDecisionLine(decision));
  }

  logStep(
    `Pass 2/4: reviewing ${reviewFiles.length} file(s) (concurrency=${reviewConcurrency})`,
  );
  const summary = triageResult.summary;
  const allChangedPaths = changes.map((c) => c.new_path);
  const failedPaths: string[] = [];
  const perFileFindings = await mapWithConcurrency(
    reviewFiles,
    reviewConcurrency,
    async (change) => {
      const path = change.new_path;
      let findings: string;
      try {
        const completion = await runToolLoop(ctx, {
          label: `file_review_${path}`,
          phase: "file_review",
          context: path,
          messages: withReviewInstructions(
            buildFileReviewPrompt({
              filePath: path,
              fileDiff: truncateWithMarker(change.diff, promptLimits.maxDiffChars, path),
              summary,
              otherChangedFiles: allChangedPaths.filter((p) => p !== path),
              allowTools: true,
              profile: effectiveProfile,
            }),
            reviewInstructions,
          ),
          maxRounds: MAX_FILE_TOOL_ROUNDS,
          temperature: 0.2,
          forceFirstRound: ctx.forceTools,
          limitMessage:
            "Tool-call limit reached. Provide your final review now without any tool calls.",
        });
        findings = extractCompletionText(completion) ?? NO_FINDINGS_SENTENCE;
      } catch (error: any) {
        const preview = String(error?.message ?? error)
          .replace(/\s+/g, " ")
          .slice(0, 200);
        logStep(
          `Pass 2: review failed for ${path}: ${preview}. Continuing with remaining files.`,
        );
        failedPaths.push(path);
        findings = NO_FINDINGS_SENTENCE;
      }
      return { path, findings };
    },
  );
  if (failedPaths.length === reviewFiles.length) {
    throw new Error(
      `All ${reviewFiles.length} per-file reviews failed (e.g. ${failedPaths[0]}). See log above.`,
    );
  }

  // Cap transparency: if consolidation likely trimmed the list (final count hit
  // the cap while per-file review produced more candidates), say so in the note
  // instead of silently dropping findings.
  // ponytail: candidates deduped by file+title only; differently-worded dupes
  // across files still inflate the count, which is why the note says "candidate".
  const candidateCount = new Set(
    perFileFindings.flatMap((f) =>
      parseReviewFindings(f.findings).map(
        (x) => `${x.file}|${x.title.toLowerCase()}`,
      ),
    ),
  ).size;
  // Deterministic note header (title + triage summary) and footnotes, added in
  // code so every final-answer path gets them regardless of model formatting.
  const summaryText = summary.trim().replace(/\s*\n\s*/g, " ");
  const finish = (body: string): string => {
    let out = body;
    const finalCount = parseReviewFindings(out).length;
    if (finalCount >= maxFindings && candidateCount > finalCount) {
      out = insertBeforeDisclaimer(
        out,
        `ℹ️ Showing top ${finalCount} of ${candidateCount} candidate findings (\`--max-findings=${maxFindings}\`). Run with \`--include-artifacts\` for the full list.`,
      );
    }
    if (failedPaths.length > 0) {
      out = insertBeforeDisclaimer(
        out,
        `${NOT_REVIEWED_NOTE} ${failedPaths.map((p) => `\`${p}\``).join(", ")}.`,
      );
    }
    return `### 🤖 AI Code Review\n\n${summaryText === "" ? "" : `> ${summaryText}\n\n`}${out}`;
  };

  logStep("Pass 3/4: consolidating findings");
  const consolidateMessages = buildConsolidatePrompt({
    perFileFindings,
    summary,
    maxFindings,
    profile: effectiveProfile,
  });
  if (consolidateMessages == null) {
    return finish(`${NO_FINDINGS_SENTENCE}\n\n---\n_${DISCLAIMER}_`);
  }
  let consolidateCompletion: ChatCompletion;
  try {
    consolidateCompletion = await complete(ctx, "consolidate_pass", {
      model: aiModel,
      temperature: 0.1,
      messages: withReviewInstructions(consolidateMessages, reviewInstructions),
    });
  } catch (error: any) {
    logStep(
      `Consolidation failed: ${error?.message ?? error}. Returning raw per-file findings.`,
    );
    const raw = perFileFindings
      .filter((f) => !isEmptyReviewBody(f.findings))
      .map((f) => f.findings)
      .join("\n");
    return finish(`${raw || NO_FINDINGS_SENTENCE}\n\n---\n_${DISCLAIMER}_`);
  }
  const consolidatedText = extractCompletionText(consolidateCompletion);
  if (consolidatedText == null) return finish(buildAnswer(consolidateCompletion));

  logStep("Pass 4/4: verifying consolidated findings (repo tools)");
  try {
    const verificationCompletion = await runToolLoop(ctx, {
      label: "verification_pass",
      phase: "verification",
      context: "(verify)",
      messages: withReviewInstructions(
        buildVerificationPrompt({
          perFileFindings,
          summary,
          consolidatedFindings: consolidatedText,
          maxFindings,
          refs: ctx.refs,
          profile: effectiveProfile,
        }),
        reviewInstructions,
      ),
      maxRounds: MAX_VERIFICATION_TOOL_ROUNDS,
      temperature: 0,
      // Forcing a tool call only makes sense when there is a finding to check.
      forceFirstRound:
        ctx.forceTools && /-\s*\[(?:high|medium)\]/i.test(consolidatedText),
      limitMessage: `Tool-call limit reached (${MAX_VERIFICATION_TOOL_ROUNDS}). Do not call tools. Output only the verified findings in the required format.`,
    });
    return finish(buildAnswer(verificationCompletion));
  } catch (error: any) {
    logStep(
      `Verification failed: ${error?.message ?? error}. Returning consolidated findings.`,
    );
    return finish(buildAnswer(consolidateCompletion));
  }
}
