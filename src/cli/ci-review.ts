/** @format */

import OpenAI from "openai";
import type { ChatModel } from "openai/resources/index.mjs";
import type { ChatCompletionMessageParam } from "openai/resources/index.mjs";
import {
  buildAnswer,
  buildConsolidatePrompt,
  buildFileReviewPrompt,
  buildPrompt,
  buildTriagePrompt,
  buildVerificationPrompt,
  DEFAULT_PROMPT_PROFILE,
  extractCompletionText,
  isEmptyReviewBody,
  NO_FINDINGS_SENTENCE,
  parseTriageResponseDetailed,
  parseTriageResponse,
  type PromptLimits,
  type PromptProfile,
  type TriageFileInput,
  type TriageParseFailureReason,
  type TriageFileVerdict,
} from "../prompt/index.js";
import {
  fetchFileAtRef,
  searchRepository,
  type MergeRequestChange,
} from "../gitlab/services.js";
import { parseReviewFindings, truncateWithMarker } from "../prompt/utils.js";
import {
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

/** Whether to request token usage in streamed completions. Flipped off for the
 *  rest of the run the first time a gateway rejects stream_options with a 400. */
let streamUsageSupported = true;

/** Tool-result caps. Every tool response is re-sent as prompt on each following
 *  round, so oversized results multiply prefill time on self-hosted models. */
const MAX_TOOL_FILE_CHARS = 12_000;
const MAX_TOOL_GREP_CHARS = 800;

type LoggerFns = {
  logStep: (message: string) => void;
  logDebug: (message: string) => void;
};
type DebugRecordWriter = (record: Record<string, unknown>) => Promise<void> | void;

type TriageReviewAction = "review" | "skipped" | "reviewed_via_override";

type TriageFileDecision = TriageFileVerdict & {
  review_action: TriageReviewAction;
};

function buildTriageDecisions(params: {
  changes: MergeRequestChange[];
  triageResult: { summary: string; files: TriageFileVerdict[] };
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

async function appendDebugDump(
  _debugDumpFile: string | undefined,
  debugRecordWriter: DebugRecordWriter | undefined,
  record: Record<string, unknown>,
): Promise<void> {
  const withTs = { ts: new Date().toISOString(), ...record };
  if (debugRecordWriter != null) {
    await debugRecordWriter(withTs);
  }
}

async function createCompletionWithDebug(params: {
  openaiInstance: OpenAI;
  requestLabel: string;
  request: any;
  debugDumpFile?: string;
  debugRecordWriter?: DebugRecordWriter;
}): Promise<any> {
  const { openaiInstance, requestLabel, request, debugDumpFile, debugRecordWriter } =
    params;
  await appendDebugDump(debugDumpFile, debugRecordWriter, {
    kind: "openai_request",
    label: requestLabel,
    request,
  });
  // Stream and reassemble: reverse proxies (nginx proxy_read_timeout) return 504 on
  // long silent non-streamed completions; streamed chunks keep the connection alive.
  // The SDK's own timeout only covers time-to-headers; a stalled SSE body would hang
  // forever without the explicit AbortSignal deadline.
  const { stream: _stream, ...createParams } = request;
  const attempt = (withUsage: boolean) =>
    openaiInstance.chat.completions
      .stream(
        withUsage
          ? { ...createParams, stream_options: { include_usage: true } }
          : createParams,
        { signal: AbortSignal.timeout(COMPLETION_TIMEOUT_MS) },
      )
      .finalChatCompletion();
  try {
    let completion: any;
    try {
      completion = await attempt(streamUsageSupported);
    } catch (error: any) {
      // Strict OpenAI-compatible gateways 400 on unknown params. Drop the
      // usage request for the rest of the run and retry this call once.
      const rejectedStreamOptions =
        streamUsageSupported &&
        error?.status === 400 &&
        String(error?.message ?? "").includes("stream_options");
      if (!rejectedStreamOptions) throw error;
      streamUsageSupported = false;
      completion = await attempt(false);
    }
    await appendDebugDump(debugDumpFile, debugRecordWriter, {
      kind: "openai_response",
      label: requestLabel,
      response: {
        id: completion.id,
        model: completion.model,
        usage: (completion as any).usage,
        choices: completion.choices.map((c: any) => ({
          index: c.index,
          finish_reason: c.finish_reason,
          message: c.message,
        })),
      },
    });
    return completion;
  } catch (error: any) {
    await appendDebugDump(debugDumpFile, debugRecordWriter, {
      kind: "openai_error",
      label: requestLabel,
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

function buildReviewMetadata(
  changes: MergeRequestChange[],
  refs: { base: string; head: string },
): string {
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
        "Use grep_repository to search for usages, definitions, or patterns across the codebase.",
        "Use refs.base to inspect pre-change content and refs.head for current content.",
        "Prefer targeted searches and file fetches; avoid broad context requests.",
      ],
    },
    null,
    2,
  );
}

async function handleGetFileTool(
  argsRaw: string,
  gitLabProjectApiUrl: URL,
  headers: Record<string, string>,
): Promise<string> {
  try {
    const parsed = JSON.parse(argsRaw) as { path?: string; ref?: string };
    const path = parsed.path?.trim();
    const ref = parsed.ref?.trim();
    if (!path || !ref) {
      return JSON.stringify({
        ok: false,
        error: "Both path and ref are required.",
      });
    }
    const fileText = await fetchFileAtRef({
      gitLabBaseUrl: gitLabProjectApiUrl,
      headers,
      filePath: path,
      ref,
    });
    if (fileText instanceof Error) {
      return JSON.stringify({
        ok: false,
        path,
        ref,
        error: fileText.message,
      });
    }
    return JSON.stringify({
      ok: true,
      path,
      ref,
      content: fileText.slice(0, MAX_TOOL_FILE_CHARS),
      truncated: fileText.length > MAX_TOOL_FILE_CHARS,
    });
  } catch (error: any) {
    return JSON.stringify({
      ok: false,
      error: `Failed to parse tool arguments: ${String(error?.message ?? error)}`,
      raw: argsRaw,
    });
  }
}

async function handleGrepTool(
  argsRaw: string,
  defaultRef: string,
  gitLabProjectApiUrl: URL,
  headers: Record<string, string>,
  projectId: string,
): Promise<string> {
  try {
    const parsed = JSON.parse(argsRaw) as { query?: string; ref?: string };
    const query = parsed.query?.trim();
    if (!query)
      return JSON.stringify({ ok: false, error: "query is required." });
    const ref = parsed.ref?.trim() || defaultRef;
    const results = await searchRepository({
      gitLabBaseUrl: gitLabProjectApiUrl,
      headers,
      query,
      ref,
      projectId,
    });
    if (results instanceof Error) {
      return JSON.stringify({
        ok: false,
        query,
        ref,
        error: results.message,
      });
    }
    const trimmed = results.map((r) => ({
      path: r.path,
      startline: r.startline,
      data: r.data.slice(0, MAX_TOOL_GREP_CHARS),
    }));
    return JSON.stringify({ ok: true, query, ref, matches: trimmed });
  } catch (error: any) {
    return JSON.stringify({
      ok: false,
      error: `Failed to parse tool arguments: ${String(error?.message ?? error)}`,
      raw: argsRaw,
    });
  }
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

export async function reviewMergeRequestWithTools(params: {
  openaiInstance: OpenAI;
  aiModel: ChatModel;
  promptLimits: PromptLimits;
  changes: MergeRequestChange[];
  refs: { base: string; head: string };
  gitLabProjectApiUrl: URL;
  projectId: string;
  headers: Record<string, string>;
  forceTools: boolean;
  promptProfile?: PromptProfile;
  loggers: LoggerFns;
  debugDumpFile?: string;
  debugRecordWriter?: DebugRecordWriter;
}): Promise<string> {
  const {
    openaiInstance,
    aiModel,
    promptLimits,
    changes,
    refs,
    gitLabProjectApiUrl,
    projectId,
    headers,
    forceTools,
    promptProfile = DEFAULT_PROMPT_PROFILE,
    loggers,
    debugDumpFile,
    debugRecordWriter,
  } = params;
  const { logDebug, logStep } = loggers;
  logStep(
    `Single-pass review started for ${changes.length} file(s) (fallback mode).`,
  );

  const messages: ChatCompletionMessageParam[] = buildPrompt({
    changes: changes.map((change) => ({ diff: change.diff })),
    limits: promptLimits,
    allowTools: true,
    profile: promptProfile,
  });
  messages.push({
    role: "user",
    content: `Merge request metadata:\n${buildReviewMetadata(changes, refs)}`,
  });

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: TOOL_NAME_GET_FILE,
        description:
          "Fetch raw file content at a specific git ref for review context.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Repository file path." },
            ref: {
              type: "string",
              description: `Git ref or sha. Prefer "${refs.base}" (base) or "${refs.head}" (head).`,
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
          "Search the repository for a keyword or pattern. Returns up to 10 matching code fragments with file paths and line numbers.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description:
                "Search string (keyword, function name, variable, etc.).",
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

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    logStep(
      `Single-pass round ${round + 1}/${MAX_TOOL_ROUNDS}: requesting model response...`,
    );
    const completion = await createCompletionWithDebug({
      openaiInstance,
      requestLabel: `main_review_round_${round + 1}`,
      debugDumpFile,
      debugRecordWriter,
      request: {
        model: aiModel,
        temperature: 0.2,
        stream: false,
        messages,
        tools,
        tool_choice: forceTools && round === 0 ? "required" : "auto",
      },
    });
    const message = completion.choices[0]?.message;
    if (message == null) return buildAnswer(completion);

    const toolCalls = message.tool_calls ?? [];
    logDebug(
      `main-review round=${round + 1} tool_calls=${toolCalls.length} finish_reason=${completion.choices[0]?.finish_reason ?? "unknown"}`,
    );
    logStep(
      `Single-pass round ${round + 1}: model returned ${toolCalls.length} tool call(s).`,
    );
    if (toolCalls.length === 0) return buildAnswer(completion);

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") continue;
      const toolName = toolCall.function.name;
      const argsRaw = toolCall.function.arguments ?? "{}";
      await appendDebugDump(debugDumpFile, debugRecordWriter, {
        kind: "tool_call",
        phase: "main_review",
        round: round + 1,
        id: toolCall.id,
        name: toolName,
        arguments: argsRaw,
      });
      logToolUsageMinimal(logStep, toolName, argsRaw);
      let toolContent: string;
      if (toolName === TOOL_NAME_GET_FILE) {
        toolContent = await handleGetFileTool(
          argsRaw,
          gitLabProjectApiUrl,
          headers,
        );
      } else if (toolName === TOOL_NAME_GREP) {
        toolContent = await handleGrepTool(
          argsRaw,
          refs.head,
          gitLabProjectApiUrl,
          headers,
          projectId,
        );
      } else {
        toolContent = JSON.stringify({
          ok: false,
          error: `Unknown tool "${toolName}"`,
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolContent,
      });
      await appendDebugDump(debugDumpFile, debugRecordWriter, {
        kind: "tool_response",
        phase: "main_review",
        round: round + 1,
        id: toolCall.id,
        name: toolName,
        content: toolContent,
      });
      logDebug(
        `tool response id=${toolCall.id} name=${toolName} payload=${toolContent.slice(0, 300)}`,
      );
    }
  }

  messages.push({
    role: "user",
    content: `Tool-call limit reached (${MAX_TOOL_ROUNDS}). Do not call any tools. Provide your best-effort final review now, strictly following the required output format. If confidence is low, return the exact no-issues sentence.`,
  });
  logStep("Single-pass tool-call limit reached. Requesting final answer.");
  const finalCompletion = await createCompletionWithDebug({
    openaiInstance,
    requestLabel: "main_review_final_after_tool_limit",
    debugDumpFile,
    debugRecordWriter,
    request: {
      model: aiModel,
      temperature: 0.2,
      stream: false,
      messages,
    },
  });
  return buildAnswer(finalCompletion);
}

async function runFileReviewWithTools(params: {
  openaiInstance: OpenAI;
  aiModel: ChatModel;
  filePath: string;
  fileDiff: string;
  summary: string;
  otherChangedFiles: string[];
  refs: { base: string; head: string };
  gitLabProjectApiUrl: URL;
  projectId: string;
  headers: Record<string, string>;
  forceTools: boolean;
  promptProfile: PromptProfile;
  loggers: LoggerFns;
  debugDumpFile?: string;
  debugRecordWriter?: DebugRecordWriter;
}): Promise<string> {
  const {
    openaiInstance,
    aiModel,
    filePath,
    fileDiff,
    summary,
    otherChangedFiles,
    refs,
    gitLabProjectApiUrl,
    projectId,
    headers,
    forceTools,
    promptProfile,
    loggers,
    debugDumpFile,
    debugRecordWriter,
  } = params;
  const { logDebug, logStep } = loggers;

  const messages: ChatCompletionMessageParam[] = buildFileReviewPrompt({
    filePath,
    fileDiff,
    summary,
    otherChangedFiles,
    allowTools: true,
    profile: promptProfile,
  });

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: TOOL_NAME_GET_FILE,
        description:
          "Fetch raw file content at a specific git ref for review context.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Repository file path." },
            ref: {
              type: "string",
              description: `Git ref or sha. Prefer "${refs.base}" (base) or "${refs.head}" (head).`,
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
          "Search the repository for a keyword or pattern. Returns up to 10 matching code fragments with file paths and line numbers.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description:
                "Search string (keyword, function name, variable, etc.).",
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

  for (let round = 0; round < MAX_FILE_TOOL_ROUNDS; round += 1) {
    const completion = await createCompletionWithDebug({
      openaiInstance,
      requestLabel: `file_review_${filePath}_round_${round + 1}`,
      debugDumpFile,
      debugRecordWriter,
      request: {
        model: aiModel,
        temperature: 0.2,
        stream: false,
        messages,
        tools,
        tool_choice: forceTools && round === 0 ? "required" : "auto",
      },
    });
    const msg = completion.choices[0]?.message;
    if (msg == null)
      return extractCompletionText(completion) ?? NO_FINDINGS_SENTENCE;

    const toolCalls = msg.tool_calls ?? [];
    logDebug(
      `file-review path=${filePath} round=${round + 1} tool_calls=${toolCalls.length} finish_reason=${completion.choices[0]?.finish_reason ?? "unknown"}`,
    );
    if (toolCalls.length === 0)
      return extractCompletionText(completion) ?? NO_FINDINGS_SENTENCE;

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") continue;
      const toolName = toolCall.function.name;
      const argsRaw = toolCall.function.arguments ?? "{}";
      await appendDebugDump(debugDumpFile, debugRecordWriter, {
        kind: "tool_call",
        phase: "file_review",
        filePath,
        round: round + 1,
        id: toolCall.id,
        name: toolName,
        arguments: argsRaw,
      });
      logToolUsageMinimal(logStep, toolName, argsRaw, filePath);
      let toolContent: string;
      if (toolName === TOOL_NAME_GET_FILE) {
        toolContent = await handleGetFileTool(
          argsRaw,
          gitLabProjectApiUrl,
          headers,
        );
      } else if (toolName === TOOL_NAME_GREP) {
        toolContent = await handleGrepTool(
          argsRaw,
          refs.head,
          gitLabProjectApiUrl,
          headers,
          projectId,
        );
      } else {
        toolContent = JSON.stringify({
          ok: false,
          error: `Unknown tool "${toolName}"`,
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolContent,
      });
      await appendDebugDump(debugDumpFile, debugRecordWriter, {
        kind: "tool_response",
        phase: "file_review",
        filePath,
        round: round + 1,
        id: toolCall.id,
        name: toolName,
        content: toolContent,
      });
      logDebug(
        `tool response file=${filePath} id=${toolCall.id} name=${toolName} payload=${toolContent.slice(0, 300)}`,
      );
    }
  }

  messages.push({
    role: "user",
    content:
      "Tool-call limit reached. Provide your final review now without any tool calls.",
  });
  const final = await createCompletionWithDebug({
    openaiInstance,
    requestLabel: `file_review_${filePath}_final_after_tool_limit`,
    debugDumpFile,
    debugRecordWriter,
    request: {
      model: aiModel,
      temperature: 0.2,
      stream: false,
      messages,
    },
  });
  return extractCompletionText(final) ?? NO_FINDINGS_SENTENCE;
}

function draftHasStructuredFindings(consolidatedText: string): boolean {
  return /-\s*\[(?:high|medium)\]/i.test(consolidatedText);
}

async function runVerificationWithTools(params: {
  openaiInstance: OpenAI;
  aiModel: ChatModel;
  baseMessages: ChatCompletionMessageParam[];
  refs: { base: string; head: string };
  gitLabProjectApiUrl: URL;
  projectId: string;
  headers: Record<string, string>;
  forceTools: boolean;
  consolidatedDraft: string;
  loggers: LoggerFns;
  debugDumpFile?: string;
  debugRecordWriter?: DebugRecordWriter;
}): Promise<any> {
  const {
    openaiInstance,
    aiModel,
    baseMessages,
    refs,
    gitLabProjectApiUrl,
    projectId,
    headers,
    forceTools,
    consolidatedDraft,
    loggers,
    debugDumpFile,
    debugRecordWriter,
  } = params;
  const { logDebug, logStep } = loggers;

  const messages: ChatCompletionMessageParam[] = [...baseMessages];

  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: TOOL_NAME_GET_FILE,
        description:
          "Fetch raw file content at a specific git ref for review context.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Repository file path." },
            ref: {
              type: "string",
              description: `Git ref or sha. Prefer "${refs.base}" (base) or "${refs.head}" (head).`,
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
          "Search the repository for a keyword or pattern. Returns up to 10 matching code fragments with file paths and line numbers.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description:
                "Search string (keyword, function name, variable, etc.).",
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

  const verificationForceRound0 =
    forceTools && draftHasStructuredFindings(consolidatedDraft);

  for (let round = 0; round < MAX_VERIFICATION_TOOL_ROUNDS; round += 1) {
    const completion = await createCompletionWithDebug({
      openaiInstance,
      requestLabel: `verification_pass_round_${round + 1}`,
      debugDumpFile,
      debugRecordWriter,
      request: {
        model: aiModel,
        temperature: 0,
        stream: false,
        messages,
        tools,
        tool_choice: verificationForceRound0 && round === 0 ? "required" : "auto",
      },
    });
    const message = completion.choices[0]?.message;
    if (message == null) return completion;

    const toolCalls = message.tool_calls ?? [];
    logDebug(
      `verification round=${round + 1} tool_calls=${toolCalls.length} finish_reason=${completion.choices[0]?.finish_reason ?? "unknown"}`,
    );
    if (toolCalls.length === 0) return completion;

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      if (toolCall.type !== "function") continue;
      const toolName = toolCall.function.name;
      const argsRaw = toolCall.function.arguments ?? "{}";
      await appendDebugDump(debugDumpFile, debugRecordWriter, {
        kind: "tool_call",
        phase: "verification",
        round: round + 1,
        id: toolCall.id,
        name: toolName,
        arguments: argsRaw,
      });
      logToolUsageMinimal(logStep, toolName, argsRaw, "(verify)");
      let toolContent: string;
      if (toolName === TOOL_NAME_GET_FILE) {
        toolContent = await handleGetFileTool(
          argsRaw,
          gitLabProjectApiUrl,
          headers,
        );
      } else if (toolName === TOOL_NAME_GREP) {
        toolContent = await handleGrepTool(
          argsRaw,
          refs.head,
          gitLabProjectApiUrl,
          headers,
          projectId,
        );
      } else {
        toolContent = JSON.stringify({
          ok: false,
          error: `Unknown tool "${toolName}"`,
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolContent,
      });
      await appendDebugDump(debugDumpFile, debugRecordWriter, {
        kind: "tool_response",
        phase: "verification",
        round: round + 1,
        id: toolCall.id,
        name: toolName,
        content: toolContent,
      });
      logDebug(
        `verification tool id=${toolCall.id} name=${toolName} payload=${toolContent.slice(0, 300)}`,
      );
    }
  }

  messages.push({
    role: "user",
    content: `Tool-call limit reached (${MAX_VERIFICATION_TOOL_ROUNDS}). Do not call tools. Output only the verified findings in the required format.`,
  });
  return createCompletionWithDebug({
    openaiInstance,
    requestLabel: "verification_pass_final_after_tool_limit",
    debugDumpFile,
    debugRecordWriter,
    request: {
      model: aiModel,
      temperature: 0,
      stream: false,
      messages,
    },
  });
}

export async function reviewMergeRequestMultiPass(params: {
  openaiInstance: OpenAI;
  aiModel: ChatModel;
  promptLimits: PromptLimits;
  triageDiffChars: number;
  changes: MergeRequestChange[];
  refs: { base: string; head: string };
  gitLabProjectApiUrl: URL;
  projectId: string;
  headers: Record<string, string>;
  maxFindings: number;
  reviewConcurrency: number;
  forceTools: boolean;
  promptProfile?: PromptProfile;
  /** When AI_PROMPT_PROFILE is not set explicitly, a triage JSON parse failure
   *  demotes the whole run to the "weak" profile (behavioral capability probe). */
  allowProfileAutoDemote?: boolean;
  loggers: LoggerFns;
  debugDumpFile?: string;
  debugRecordWriter?: DebugRecordWriter;
}): Promise<string> {
  const {
    openaiInstance,
    aiModel,
    promptLimits,
    triageDiffChars,
    changes,
    refs,
    gitLabProjectApiUrl,
    projectId,
    headers,
    maxFindings,
    reviewConcurrency,
    forceTools,
    promptProfile = DEFAULT_PROMPT_PROFILE,
    allowProfileAutoDemote = false,
    loggers,
    debugDumpFile,
    debugRecordWriter,
  } = params;
  const { logStep } = loggers;
  let effectiveProfile: PromptProfile = promptProfile;

  logStep(
    `Pass 1/4: triaging ${changes.length} file(s) ` +
      `(prompt profile=${promptProfile}, triage_diff_chars=${triageDiffChars})`,
  );
  const triageInputs: TriageFileInput[] = changes.map((c) => ({
    path: c.new_path,
    new_file: c.new_file,
    deleted_file: c.deleted_file,
    renamed_file: c.renamed_file,
    diff: c.diff,
  }));
  const triageMessages = buildTriagePrompt(
    triageInputs,
    promptProfile,
    triageDiffChars,
  );
  let triageResult: ReturnType<typeof parseTriageResponse> = null;
  let triageText: string | null = null;
  let triageParseReason: TriageParseFailureReason | null = null;
  let triageParseError: string | null = null;
  try {
    const triageCompletion = await createCompletionWithDebug({
      openaiInstance,
      requestLabel: "triage_pass",
      debugDumpFile,
      debugRecordWriter,
      request: {
        model: aiModel,
        temperature: 0.1,
        stream: false,
        messages: triageMessages,
        response_format: { type: "json_object" },
      },
    });
    triageText = extractCompletionText(triageCompletion);
    if (triageText != null) {
      const triageParse = parseTriageResponseDetailed(triageText);
      triageResult = triageParse.result;
      triageParseReason = triageParse.reason;
      triageParseError = triageParse.parseError;
    }
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
      const weakTriageCompletion = await createCompletionWithDebug({
        openaiInstance,
        requestLabel: "triage_pass_weak_retry",
        debugDumpFile,
        debugRecordWriter,
        request: {
          model: aiModel,
          temperature: 0.1,
          stream: false,
          messages: buildTriagePrompt(triageInputs, "weak", triageDiffChars),
          response_format: { type: "json_object" },
        },
      });
      const weakTriageText = extractCompletionText(weakTriageCompletion);
      const weakParse =
        weakTriageText != null
          ? parseTriageResponseDetailed(weakTriageText)
          : null;
      if (weakParse?.result != null) {
        triageResult = weakParse.result;
        effectiveProfile = "weak";
        logStep(
          "Weak-profile triage parsed successfully. Continuing all passes with prompt profile=weak.",
        );
      }
    } catch (error: any) {
      logStep(`Weak-profile triage retry failed: ${error?.message ?? error}.`);
    }
  }

  if (triageResult == null) {
    if (triageText != null) {
      const triagePreview = triageText.replace(/\s+/g, " ").trim().slice(0, 200);
      const looksLikeHtml = /<html|<!doctype html/i.test(triageText);
      const parseReasonText =
        triageParseReason != null
          ? `reason=${triageParseReason}`
          : `reason=${looksLikeHtml ? "html_response" : "unknown_non_json"}`;
      const parseErrorText =
        triageParseError != null ? ` parse_error=${triageParseError}` : "";
      logStep(
        `Triage parse failed: ${parseReasonText}.${parseErrorText} Preview: ${triagePreview || "<empty>"}`,
      );
    } else {
      logStep("Triage parse failed: model returned empty response body.");
    }
    logStep("Falling back to single-pass pipeline.");
    return await reviewMergeRequestWithTools({
      openaiInstance,
      aiModel,
      promptLimits,
      changes,
      refs,
      gitLabProjectApiUrl,
      projectId,
      headers,
      forceTools,
      promptProfile: effectiveProfile,
      loggers,
      debugDumpFile,
      debugRecordWriter,
    });
  }

  const { decisions, skipAllOverride, reviewFiles } = buildTriageDecisions({
    changes,
    triageResult,
  });
  const skippedCount = decisions.filter((d) => d.review_action === "skipped").length;

  await appendDebugDump(debugDumpFile, debugRecordWriter, {
    kind: "triage_decision",
    summary: triageResult.summary,
    skip_all_override: skipAllOverride,
    triage_diff_chars: triageDiffChars,
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
  const allChangedPaths = changes.map((c) => c.new_path);
  const failedPaths: string[] = [];
  const perFileFindings = await mapWithConcurrency(
    reviewFiles,
    reviewConcurrency,
    async (change) => {
      const otherFiles = allChangedPaths.filter((p) => p !== change.new_path);
      let findings: string;
      try {
        findings = await runFileReviewWithTools({
          openaiInstance,
          aiModel,
          filePath: change.new_path,
          fileDiff: truncateWithMarker(
            change.diff,
            promptLimits.maxDiffChars,
            change.new_path,
          ),
          summary: triageResult!.summary,
          otherChangedFiles: otherFiles,
          refs,
          gitLabProjectApiUrl,
          projectId,
          headers,
          forceTools,
          promptProfile: effectiveProfile,
          loggers,
          debugDumpFile,
          debugRecordWriter,
        });
      } catch (error: any) {
        const preview = String(error?.message ?? error)
          .replace(/\s+/g, " ")
          .slice(0, 200);
        logStep(
          `Pass 2: review failed for ${change.new_path}: ${preview}. Continuing with remaining files.`,
        );
        failedPaths.push(change.new_path);
        // ponytail: failed file surfaces as "no findings" in the MR comment;
        // thread failedPaths into the consolidate prompt if that ever matters.
        findings = NO_FINDINGS_SENTENCE;
      }
      return { path: change.new_path, findings };
    },
  );
  if (failedPaths.length === reviewFiles.length) {
    throw new Error(
      `All ${reviewFiles.length} per-file reviews failed (e.g. ${failedPaths[0]}). See log above.`,
    );
  }

  // Deterministic note header: title + triage summary. Prepended in code so
  // every final-answer path gets it regardless of model formatting discipline.
  const summaryText = triageResult.summary.trim().replace(/\s*\n\s*/g, " ");
  const withHeader = (body: string): string =>
    `### 🤖 AI Code Review\n\n${summaryText === "" ? "" : `> ${summaryText}\n\n`}${body}`;

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
  const withCapNote = (body: string): string => {
    const finalCount = parseReviewFindings(body).length;
    if (finalCount < maxFindings || candidateCount <= finalCount) return body;
    const note = `\n\nℹ️ Showing top ${finalCount} of ${candidateCount} candidate findings (\`--max-findings=${maxFindings}\`). Run with \`--include-artifacts\` for the full list.`;
    const disclaimerAt = body.lastIndexOf("\n\n---\n_");
    return disclaimerAt === -1
      ? body + note
      : body.slice(0, disclaimerAt) + note + body.slice(disclaimerAt);
  };

  logStep("Pass 3/4: consolidating findings");
  const consolidateMessages = buildConsolidatePrompt({
    perFileFindings,
    summary: triageResult.summary,
    maxFindings,
    profile: effectiveProfile,
  });
  if (consolidateMessages == null) {
    const DISCLAIMER = "This comment was generated by AI review bot.";
    return withHeader(`${NO_FINDINGS_SENTENCE}\n\n---\n_${DISCLAIMER}_`);
  }
  try {
    const consolidateCompletion = await createCompletionWithDebug({
      openaiInstance,
      requestLabel: "consolidate_pass",
      debugDumpFile,
      debugRecordWriter,
      request: {
        model: aiModel,
        temperature: 0.1,
        stream: false,
        messages: consolidateMessages,
      },
    });
    const consolidatedText = extractCompletionText(consolidateCompletion);
    if (consolidatedText == null || consolidatedText.trim() === "") {
      return withHeader(withCapNote(buildAnswer(consolidateCompletion)));
    }

    logStep("Pass 4/4: verifying consolidated findings (repo tools)");
    const verificationMessages = buildVerificationPrompt({
      perFileFindings,
      summary: triageResult.summary,
      consolidatedFindings: consolidatedText,
      maxFindings,
      refs,
      profile: effectiveProfile,
    });
    try {
      const verificationCompletion = await runVerificationWithTools({
        openaiInstance,
        aiModel,
        baseMessages: verificationMessages,
        refs,
        gitLabProjectApiUrl,
        projectId,
        headers,
        forceTools,
        consolidatedDraft: consolidatedText,
        loggers,
        debugDumpFile,
        debugRecordWriter,
      });
      return withHeader(withCapNote(buildAnswer(verificationCompletion)));
    } catch (error: any) {
      logStep(
        `Verification failed: ${error?.message ?? error}. Returning consolidated findings.`,
      );
      return withHeader(withCapNote(buildAnswer(consolidateCompletion)));
    }
  } catch (error: any) {
    logStep(
      `Consolidation failed: ${error?.message ?? error}. Returning raw per-file findings.`,
    );
    const DISCLAIMER = "This comment was generated by AI review bot.";
    const raw = perFileFindings
      .filter((f) => !isEmptyReviewBody(f.findings))
      .map((f) => f.findings)
      .join("\n");
    return withHeader(`${raw || NO_FINDINGS_SENTENCE}\n\n---\n_${DISCLAIMER}_`);
  }
}
