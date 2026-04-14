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
  extractCompletionText,
  parseTriageResponse,
  type PromptLimits,
  type TriageFileInput,
} from "../prompt/index.js";
import {
  fetchFileAtRef,
  searchRepository,
  type MergeRequestChange,
} from "../gitlab/services.js";
import {
  logToolUsageMinimal,
  MAX_FILE_TOOL_ROUNDS,
  MAX_TOOL_ROUNDS,
  MAX_VERIFICATION_TOOL_ROUNDS,
  TOOL_NAME_GET_FILE,
  TOOL_NAME_GREP,
} from "./tooling.js";

type LoggerFns = {
  logStep: (message: string) => void;
  logDebug: (message: string) => void;
};
type DebugRecordWriter = (record: Record<string, unknown>) => Promise<void> | void;

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
  try {
    const completion = await openaiInstance.chat.completions.create(request);
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
      content: fileText.slice(0, 30000),
      truncated: fileText.length > 30000,
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
      data: r.data.slice(0, 2000),
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
    loggers,
    debugDumpFile,
    debugRecordWriter,
  } = params;
  const { logDebug, logStep } = loggers;

  const messages: ChatCompletionMessageParam[] = buildPrompt({
    changes: changes.map((change) => ({ diff: change.diff })),
    limits: promptLimits,
    allowTools: true,
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
      return extractCompletionText(completion) ?? "No issues found.";

    const toolCalls = msg.tool_calls ?? [];
    logDebug(
      `file-review path=${filePath} round=${round + 1} tool_calls=${toolCalls.length} finish_reason=${completion.choices[0]?.finish_reason ?? "unknown"}`,
    );
    if (toolCalls.length === 0)
      return extractCompletionText(completion) ?? "No issues found.";

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
  return extractCompletionText(final) ?? "No issues found.";
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
  changes: MergeRequestChange[];
  refs: { base: string; head: string };
  gitLabProjectApiUrl: URL;
  projectId: string;
  headers: Record<string, string>;
  maxFindings: number;
  reviewConcurrency: number;
  forceTools: boolean;
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
    maxFindings,
    reviewConcurrency,
    forceTools,
    loggers,
    debugDumpFile,
    debugRecordWriter,
  } = params;
  const { logStep } = loggers;

  logStep(`Pass 1/4: triaging ${changes.length} file(s)`);
  const triageInputs: TriageFileInput[] = changes.map((c) => ({
    path: c.new_path,
    new_file: c.new_file,
    deleted_file: c.deleted_file,
    renamed_file: c.renamed_file,
    diff: c.diff,
  }));
  const triageMessages = buildTriagePrompt(triageInputs);
  let triageResult: ReturnType<typeof parseTriageResponse> = null;
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
    const triageText = extractCompletionText(triageCompletion);
    if (triageText != null) triageResult = parseTriageResponse(triageText);
  } catch (error: any) {
    logStep(
      `Triage pass failed: ${error?.message ?? error}. Falling back to single-pass.`,
    );
  }

  if (triageResult == null) {
    logStep("Triage parse failed. Falling back to single-pass pipeline.");
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
      loggers,
      debugDumpFile,
      debugRecordWriter,
    });
  }

  const triageMap = new Map(triageResult.files.map((f) => [f.path, f.verdict]));
  let reviewFiles = changes.filter(
    (c) => triageMap.get(c.new_path) !== "SKIP",
  );
  const skippedCount = changes.length - reviewFiles.length;
  if (reviewFiles.length === 0) {
    logStep(
      `Triage wanted to skip all ${changes.length} file(s) — overriding to review all. Summary: ${triageResult.summary.slice(0, 120)}...`,
    );
    reviewFiles = changes;
  } else {
    logStep(
      `Triage: ${reviewFiles.length} file(s) to review, ${skippedCount} skipped. Summary: ${triageResult.summary.slice(0, 120)}...`,
    );
  }

  logStep(
    `Pass 2/4: reviewing ${reviewFiles.length} file(s) (concurrency=${reviewConcurrency})`,
  );
  const allChangedPaths = changes.map((c) => c.new_path);
  const perFileFindings = await mapWithConcurrency(
    reviewFiles,
    reviewConcurrency,
    async (change) => {
      const otherFiles = allChangedPaths.filter((p) => p !== change.new_path);
      const findings = await runFileReviewWithTools({
        openaiInstance,
        aiModel,
        filePath: change.new_path,
        fileDiff: change.diff,
        summary: triageResult!.summary,
        otherChangedFiles: otherFiles,
        refs,
        gitLabProjectApiUrl,
        projectId,
        headers,
        forceTools,
        loggers,
        debugDumpFile,
        debugRecordWriter,
      });
      return { path: change.new_path, findings };
    },
  );

  logStep("Pass 3/4: consolidating findings");
  const consolidateMessages = buildConsolidatePrompt({
    perFileFindings,
    summary: triageResult.summary,
    maxFindings,
  });
  if (consolidateMessages == null) {
    const DISCLAIMER = "This comment was generated by AI review bot.";
    return `No confirmed bugs or high-value optimizations found.\n\n---\n_${DISCLAIMER}_`;
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
      return buildAnswer(consolidateCompletion);
    }

    logStep("Pass 4/4: verifying consolidated findings (repo tools)");
    const verificationMessages = buildVerificationPrompt({
      perFileFindings,
      summary: triageResult.summary,
      consolidatedFindings: consolidatedText,
      maxFindings,
      refs,
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
      return buildAnswer(verificationCompletion);
    } catch (error: any) {
      logStep(
        `Verification failed: ${error?.message ?? error}. Returning consolidated findings.`,
      );
      return buildAnswer(consolidateCompletion);
    }
  } catch (error: any) {
    logStep(
      `Consolidation failed: ${error?.message ?? error}. Returning raw per-file findings.`,
    );
    const DISCLAIMER = "This comment was generated by AI review bot.";
    const raw = perFileFindings
      .filter(
        (f) =>
          !f.findings.includes("No issues found.") &&
          !f.findings.includes("No confirmed bugs"),
      )
      .map((f) => f.findings)
      .join("\n");
    return `${raw || "No confirmed bugs or high-value optimizations found."}\n\n---\n_${DISCLAIMER}_`;
  }
}
