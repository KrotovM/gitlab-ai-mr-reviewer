/** @format */

import OpenAI from "openai";
import type { ChatModel } from "openai/resources/index.mjs";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import { readFile } from "node:fs/promises";
import {
  AI_MAX_OUTPUT_TOKENS,
  buildAnswer,
  buildPrompt,
  extractCompletionText,
  type PromptLimits,
} from "../prompt/index.js";
import { generateAICompletion } from "../gitlab/services.js";
import {
  buildGitExcludePathspecs,
  parseIgnoreExtensions,
} from "./args.js";
import {
  logToolUsageMinimal,
  MAX_TOOL_ROUNDS,
  TOOL_NAME_GET_FILE,
  TOOL_NAME_GREP,
} from "./tooling.js";

type LoggerFns = {
  logStep: (message: string) => void;
  logDebug: (message: string) => void;
};

async function runGit(args: string[]): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(
        new Error(
          stderr.trim() || `git ${args.join(" ")} failed with exit code ${code}`,
        ),
      );
    });
  });
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { spawn } = await import("node:child_process");
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(
        new Error(
          stderr.trim() ||
            `${command} ${args.join(" ")} failed with exit code ${code}`,
        ),
      );
    });
  });
}

export async function localDiffWorktree(argv: string[]): Promise<string> {
  const ignoreExtensions = parseIgnoreExtensions(argv);
  const pathspecs = buildGitExcludePathspecs(ignoreExtensions);
  const unstagedArgs =
    pathspecs.length > 0 ? ["diff", "--", ...pathspecs] : ["diff"];
  const stagedArgs =
    pathspecs.length > 0
      ? ["diff", "--staged", "--", ...pathspecs]
      : ["diff", "--staged"];
  const unstaged = await runGit(unstagedArgs);
  const staged = await runGit(stagedArgs);
  return [staged.trim(), unstaged.trim()].filter(Boolean).join("\n\n");
}

export async function localDiffLastCommit(argv: string[]): Promise<string> {
  const ignoreExtensions = parseIgnoreExtensions(argv);
  const pathspecs = buildGitExcludePathspecs(ignoreExtensions);
  const args =
    pathspecs.length > 0
      ? ["show", "--format=", "HEAD", "--", ...pathspecs]
      : ["show", "--format=", "HEAD"];
  return await runGit(args);
}

export async function diffFromFile(filePath: string): Promise<string> {
  return await readFile(filePath, "utf8");
}

function parseChangedPathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    if (!line.startsWith("diff --git ")) continue;
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match == null) continue;
    const bPath = match[2]?.trim();
    if (bPath && bPath !== "/dev/null") paths.push(bPath);
  }
  return Array.from(new Set(paths));
}

async function readLocalFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function readFileAtHead(path: string): Promise<string | null> {
  try {
    return await runGit(["show", `HEAD:${path}`]);
  } catch {
    return null;
  }
}

async function buildLocalReviewContext(diff: string): Promise<string> {
  const paths = parseChangedPathsFromDiff(diff).slice(0, 8);
  if (paths.length === 0) return "";
  const blocks: string[] = [];
  for (const path of paths) {
    const worktreeText = await readLocalFileIfExists(path);
    const headText = await readFileAtHead(path);
    const current = worktreeText?.slice(0, 1200);
    const previous = headText?.slice(0, 1200);
    if (current == null && previous == null) continue;
    blocks.push(
      [
        `File: ${path}`,
        current != null
          ? `Current snippet:\n\`\`\`\n${current}\n\`\`\``
          : "Current snippet: (unavailable)",
        previous != null
          ? `HEAD snippet:\n\`\`\`\n${previous}\n\`\`\``
          : "HEAD snippet: (unavailable)",
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

interface DeterministicFinding {
  title: string;
  detail: string;
}

function editDistanceAtMostTwo(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 2) return 3;
  const dp: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= la; i += 1) {
    let rowMin = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= lb; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
      rowMin = Math.min(rowMin, dp[i]![j]!);
    }
    if (rowMin > 2) return 3;
  }
  return dp[la]![lb]!;
}

function collectCallIdentifiersFromDiffLines(
  lines: string[],
  prefixes: string[],
): Set<string> {
  const out = new Set<string>();
  const callPattern = /\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (const line of lines) {
    if (!prefixes.some((p) => line.startsWith(p))) continue;
    const code = line.slice(1);
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(code)) != null) {
      const ident = match[1]!;
      if (
        ident === "if" ||
        ident === "for" ||
        ident === "while" ||
        ident === "switch" ||
        ident === "catch"
      ) {
        continue;
      }
      out.add(ident);
    }
  }
  return out;
}

function findDeterministicDiffFindings(diff: string): DeterministicFinding[] {
  const lines = diff.split(/\r?\n/);
  const addedCalls = collectCallIdentifiersFromDiffLines(lines, ["+"]);
  const nearbyCalls = collectCallIdentifiersFromDiffLines(lines, [" ", "-", "+"]);
  const findings: DeterministicFinding[] = [];
  for (const added of addedCalls) {
    if (added.length < 7) continue;
    let closest: string | undefined;
    let closestDistance = 3;
    for (const candidate of nearbyCalls) {
      if (candidate === added) continue;
      const distance = editDistanceAtMostTwo(added, candidate);
      if (distance < closestDistance) {
        closestDistance = distance;
        closest = candidate;
      }
    }
    if (closest != null && closestDistance <= 2) {
      findings.push({
        title: "Possible symbol typo",
        detail: `Call \`${added}(...)\` is very close to \`${closest}(...)\` and may be a misspelling causing runtime/reference errors.`,
      });
    }
  }
  return Array.from(
    new Map(findings.map((f) => [`${f.title}:${f.detail}`, f])).values(),
  ).slice(0, 3);
}

function injectDeterministicFindings(
  answer: string,
  findings: DeterministicFinding[],
): string {
  if (findings.length === 0) return answer;
  if (!answer.includes("No confirmed bugs or high-value optimizations found.")) {
    return answer;
  }
  const bullets = findings.map((f) => `- [high] ${f.title}: ${f.detail}`).join("\n");
  const disclaimerIndex = answer.indexOf(
    "\n---\n_This comment was generated by an artificial intelligence duck._",
  );
  const disclaimer =
    disclaimerIndex >= 0
      ? answer.slice(disclaimerIndex)
      : "\n---\n_This comment was generated by an artificial intelligence duck._";
  return `${bullets}${disclaimer}`;
}

async function handleLocalGetFileTool(argsRaw: string): Promise<string> {
  try {
    const parsed = JSON.parse(argsRaw) as { path?: string; ref?: string };
    const path = parsed.path?.trim();
    const ref = (parsed.ref?.trim() || "WORKTREE").toUpperCase();
    if (!path) return JSON.stringify({ ok: false, error: "path is required." });
    if (ref === "WORKTREE") {
      const text = await readLocalFileIfExists(path);
      if (text == null) {
        return JSON.stringify({
          ok: false,
          path,
          ref,
          error: "File not found in worktree.",
        });
      }
      return JSON.stringify({
        ok: true,
        path,
        ref,
        content: text.slice(0, 30000),
        truncated: text.length > 30000,
      });
    }
    const text = await runGit(["show", `${ref}:${path}`]);
    return JSON.stringify({
      ok: true,
      path,
      ref,
      content: text.slice(0, 30000),
      truncated: text.length > 30000,
    });
  } catch (error: any) {
    return JSON.stringify({
      ok: false,
      error: `Failed local get_file_at_ref: ${String(error?.message ?? error)}`,
      raw: argsRaw,
    });
  }
}

async function handleLocalGrepTool(
  argsRaw: string,
  logDebug: (message: string) => void,
): Promise<string> {
  function parseSearchOutput(raw: string): Array<{
    path: string;
    startline: number;
    data: string;
  }> {
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const m = /^(.+?):(\d+):(.*)$/.exec(line);
        if (m == null) return null;
        return {
          path: m[1]!,
          startline: Number(m[2]),
          data: (m[3] ?? "").slice(0, 2000),
        };
      })
      .filter(
        (
          v,
        ): v is {
          path: string;
          startline: number;
          data: string;
        } => v != null,
      )
      .slice(0, 10);
  }

  try {
    const parsed = JSON.parse(argsRaw) as { query?: string; ref?: string };
    const query = parsed.query?.trim();
    if (!query) return JSON.stringify({ ok: false, error: "query is required." });
    let raw = "";
    let searchBackend: "rg" | "grep" = "rg";
    try {
      raw = await runCommand("rg", ["-n", "--no-heading", "--max-count", "30", query, "."]);
    } catch (error: any) {
      if (String(error?.message ?? error).includes("spawn rg ENOENT")) {
        searchBackend = "grep";
        raw = await runCommand("grep", ["-R", "-n", "-m", "30", "--", query, "."]);
      } else {
        throw error;
      }
    }
    const matches = parseSearchOutput(raw);
    logDebug(
      `local grep backend=${searchBackend} query="${query}" matches=${matches.length}`,
    );
    return JSON.stringify({
      ok: true,
      query,
      ref: (parsed.ref?.trim() || "WORKTREE").toUpperCase(),
      matches,
    });
  } catch (error: any) {
    return JSON.stringify({
      ok: false,
      error: `Failed local grep_repository: ${String(error?.message ?? error)}`,
      raw: argsRaw,
    });
  }
}

export async function reviewDiffToConsole(params: {
  diff: string;
  openaiApiKey: string;
  aiModel: ChatModel;
  promptLimits: PromptLimits;
  forceTools: boolean;
  loggers: LoggerFns;
}): Promise<void> {
  const { diff, openaiApiKey, aiModel, promptLimits, forceTools, loggers } = params;
  const { logStep } = loggers;
  if (diff.trim() === "") {
    process.stdout.write("No diff found. Skipping review.\n");
    return;
  }
  const localContext = await buildLocalReviewContext(diff);
  const messageParams = buildPrompt({
    changes: [{ diff }],
    limits: promptLimits,
    additionalContext: localContext,
  });
  const openaiInstance = new OpenAI({ apiKey: openaiApiKey });
  const completion = await generateAICompletion(messageParams, openaiInstance, aiModel);
  if (extractCompletionText(completion) == null) {
    logStep("Primary completion was empty. Retrying once with local tool-enabled flow.");
    await reviewDiffToConsoleWithToolsLocal({
      diff,
      openaiApiKey,
      aiModel,
      promptLimits,
      forceTools,
      loggers,
    });
    return;
  }
  const answer = buildAnswer(completion);
  const finalAnswer = injectDeterministicFindings(
    answer,
    findDeterministicDiffFindings(diff),
  );
  process.stdout.write(`${finalAnswer}\n`);
}

export async function reviewDiffToConsoleWithToolsLocal(params: {
  diff: string;
  openaiApiKey: string;
  aiModel: ChatModel;
  promptLimits: PromptLimits;
  forceTools: boolean;
  loggers: LoggerFns;
}): Promise<void> {
  const { diff, openaiApiKey, aiModel, promptLimits, forceTools, loggers } = params;
  const { logDebug, logStep } = loggers;
  if (diff.trim() === "") {
    process.stdout.write("No diff found. Skipping review.\n");
    return;
  }
  const localContext = await buildLocalReviewContext(diff);
  const messages: ChatCompletionMessageParam[] = buildPrompt({
    changes: [{ diff }],
    limits: promptLimits,
    allowTools: true,
    additionalContext: localContext,
  });
  messages.push({
    role: "user",
    content:
      "Local review context: use ref=WORKTREE for current files, ref=HEAD for last commit snapshot.",
  });
  const openaiInstance = new OpenAI({ apiKey: openaiApiKey });
  const toolResultCache = new Map<string, string>();
  const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: TOOL_NAME_GET_FILE,
        description:
          "Fetch local file content. Use ref=WORKTREE for current file, ref=HEAD for committed snapshot.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "Repository file path." },
            ref: {
              type: "string",
              description: 'Ref value: "WORKTREE" or "HEAD". Defaults to WORKTREE.',
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: TOOL_NAME_GREP,
        description:
          "Search current local repository with ripgrep. Returns up to 10 matches.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              description: "Search string (keyword, function, symbol).",
            },
            ref: {
              type: "string",
              description:
                "Optional logical ref (WORKTREE/HEAD); search runs on current tree.",
            },
          },
          required: ["query"],
        },
      },
    },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const completion = await openaiInstance.chat.completions.create({
      model: aiModel,
      temperature: 0.2,
      stream: false,
      messages,
      tools,
      tool_choice: forceTools && round === 0 ? "required" : "auto",
    });
    const message = completion.choices[0]?.message;
    if (message == null) {
      process.stdout.write(`${buildAnswer(completion)}\n`);
      return;
    }

    const toolCalls = message.tool_calls ?? [];
    logDebug(
      `local-review round=${round + 1} tool_calls=${toolCalls.length} finish_reason=${completion.choices[0]?.finish_reason ?? "unknown"}`,
    );
    if (toolCalls.length === 0) {
      process.stdout.write(`${buildAnswer(completion)}\n`);
      return;
    }

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const argsRaw = toolCall.function.arguments ?? "{}";
      logToolUsageMinimal(logStep, toolCall.function.name, argsRaw);
      logDebug(
        `tool request local id=${toolCall.id} name=${toolCall.function.name} args=${argsRaw.slice(0, 300)}`,
      );
      const cacheKey = `${toolCall.function.name}:${argsRaw}`;
      const cached = toolResultCache.get(cacheKey);
      let toolContent: string;
      if (cached != null) {
        toolContent = cached;
      } else if (toolCall.function.name === TOOL_NAME_GET_FILE) {
        toolContent = await handleLocalGetFileTool(argsRaw);
        toolResultCache.set(cacheKey, toolContent);
      } else if (toolCall.function.name === TOOL_NAME_GREP) {
        toolContent = await handleLocalGrepTool(argsRaw, logDebug);
        toolResultCache.set(cacheKey, toolContent);
      } else {
        toolContent = JSON.stringify({
          ok: false,
          error: `Unknown tool "${toolCall.function.name}"`,
        });
      }
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolContent,
      });
      logDebug(
        `tool response local id=${toolCall.id} name=${toolCall.function.name} payload=${toolContent.slice(0, 300)}`,
      );
    }
  }

  messages.push({
    role: "user",
    content:
      "Tool-call limit reached. Do not call tools anymore. Provide final review now in required format.",
  });
  const finalCompletion = await openaiInstance.chat.completions.create({
    model: aiModel,
    temperature: 0.2,
    max_tokens: AI_MAX_OUTPUT_TOKENS,
    stream: false,
    messages,
  });
  process.stdout.write(`${buildAnswer(finalCompletion)}\n`);
}

