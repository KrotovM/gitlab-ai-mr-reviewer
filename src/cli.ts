#!/usr/bin/env node
/** @format */

import OpenAI from "openai";
import type { ChatModel } from "openai/resources/index.mjs";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import { readFile } from "node:fs/promises";
import {
  buildAnswer,
  buildConsolidatePrompt,
  buildFileReviewPrompt,
  buildPrompt,
  buildTriagePrompt,
  DEFAULT_MAX_FINDINGS,
  DEFAULT_PROMPT_LIMITS,
  DEFAULT_REVIEW_CONCURRENCY,
  extractCompletionText,
  parseTriageResponse,
  type PromptLimits,
  type TriageFileInput,
} from "./prompt/index.js";
import {
  fetchFileAtRef,
  fetchMergeRequestChanges,
  generateAICompletion,
  type MergeRequestChange,
  postMergeRequestNote,
  searchRepository,
} from "./gitlab/services.js";

function printHelp(): void {
  process.stdout.write(
    [
      "gitlab-ai-review",
      "",
      "Usage:",
      "  gitlab-ai-review --ci",
      "  gitlab-ai-review --worktree",
      "  gitlab-ai-review --last-commit",
      "  gitlab-ai-review --diff-file=./changes.diff",
      "  gitlab-ai-review --help",
      "  gitlab-ai-review --debug",
      "  gitlab-ai-review --ci --ignore-ext=md,lock",
      "",
      "Modes (choose one):",
      "  --ci           Run in GitLab MR pipeline: fetch MR changes and post a new MR note.",
      "  --worktree     Review local uncommitted changes (staged + unstaged) and print to stdout.",
      "  --last-commit  Review last commit (HEAD) and print to stdout.",
      "  --diff-file    Review git-diff content from a file and print to stdout.",
      "",
      "Debug:",
      "  --debug        Print full error details (stack, API error fields).",
      "  --ignore-ext   Ignore file extensions (comma-separated only). Example: --ignore-ext=md,lock",
      "  --max-diffs=50",
      "  --max-diff-chars=16000",
      "  --max-total-prompt-chars=220000",
      "  --max-findings=5          Max findings in final review (CI multi-pass only).",
      "  --max-review-concurrency=5  Parallel per-file review calls (CI multi-pass only).",
      "",
      "Env vars:",
      "  OPENAI_API_KEY (required)  OpenAI API key.",
      "  OPENAI_BASE_URL (optional)  Custom OpenAI-compatible API base URL.",
      "  AI_MODEL      (optional)  OpenAI chat model, e.g. gpt-4o. Default: gpt-4o-mini.",
      "  PROJECT_ACCESS_TOKEN (optional)  GitLab Project/Personal Access Token for API calls (recommended for private projects).",
      "",
      "CI-only env vars (provided by GitLab):",
      "  CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_IID, CI_JOB_TOKEN (only if PROJECT_ACCESS_TOKEN is not set)",
      "",
      "Notes:",
      "  - If no mode is specified, it defaults to --ci when CI_MERGE_REQUEST_IID is set, otherwise --worktree.",
      "",
    ].join("\n"),
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function requireEnvs(names: string[]): Record<string, string> {
  const missing = names.filter((name) => {
    const value = process.env[name];
    return value == null || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const result: Record<string, string> = {};
  for (const name of names) {
    result[name] = process.env[name]!.trim();
  }
  return result;
}

function envOrDefault(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value == null) return defaultValue;
  const trimmed = value.trim();
  return trimmed === "" ? defaultValue : trimmed;
}

function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

type Mode = "ci" | "worktree" | "last-commit";

function hasDebugFlag(argv: string[]): boolean {
  const args = new Set(argv.slice(2));
  return args.has("--debug");
}

function parseIgnoreExtensions(argv: string[]): string[] {
  const parsed: string[] = [];
  const args = argv.slice(2);

  for (const current of args) {
    if (current === "--ignore-ext") {
      throw new Error("Use comma-separated format: --ignore-ext=md,lock");
    }
    if (!current.startsWith("--ignore-ext=")) continue;
    const value = current.slice("--ignore-ext=".length);
    if (value.trim() === "") continue;

    const pieces = value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);

    for (const piece of pieces) {
      parsed.push(piece.startsWith(".") ? piece : `.${piece}`);
    }
  }

  return Array.from(new Set(parsed));
}

function parseNumberFlag(
  argv: string[],
  flagName: string,
  defaultValue: number,
  minValue: number,
): number {
  const prefix = `--${flagName}=`;
  let value = defaultValue;
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith(prefix)) continue;
    const raw = arg.slice(prefix.length).trim();
    if (raw === "") {
      throw new Error(`Missing value for --${flagName}. Expected integer.`);
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < minValue) {
      throw new Error(
        `Invalid value for --${flagName}: "${raw}". Expected integer >= ${minValue}.`,
      );
    }
    value = parsed;
  }
  return value;
}

function parsePromptLimits(argv: string[]): PromptLimits {
  return {
    maxDiffs: parseNumberFlag(
      argv,
      "max-diffs",
      DEFAULT_PROMPT_LIMITS.maxDiffs,
      0,
    ),
    maxDiffChars: parseNumberFlag(
      argv,
      "max-diff-chars",
      DEFAULT_PROMPT_LIMITS.maxDiffChars,
      1,
    ),
    maxTotalPromptChars: parseNumberFlag(
      argv,
      "max-total-prompt-chars",
      DEFAULT_PROMPT_LIMITS.maxTotalPromptChars,
      1,
    ),
  };
}

function parseDiffFileFlag(argv: string[]): string | undefined {
  const args = argv.slice(2);
  for (const current of args) {
    if (current === "--diff-file") {
      throw new Error("Use equals format: --diff-file=./path/to/file.diff");
    }
    if (!current.startsWith("--diff-file=")) continue;
    const value = current.slice("--diff-file=".length).trim();
    if (value === "") {
      throw new Error(
        "Missing value for --diff-file. Example: --diff-file=./changes.diff",
      );
    }
    return value;
  }
  return undefined;
}

function hasModeFlag(argv: string[]): boolean {
  const args = new Set(argv.slice(2));
  return (
    args.has("--ci") || args.has("--worktree") || args.has("--last-commit")
  );
}

function hasIgnoredExtension(
  filePath: string,
  ignoredExtensions: readonly string[],
): boolean {
  const lowerPath = filePath.toLowerCase();
  return ignoredExtensions.some((ext) => lowerPath.endsWith(ext));
}

function buildGitExcludePathspecs(
  ignoredExtensions: readonly string[],
): string[] {
  return ignoredExtensions.map((ext) => `:(exclude,glob)**/*${ext}`);
}

function parseMode(argv: string[]): Mode {
  const args = new Set(argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    printHelp();
    process.exit(0);
  }
  const hasCi = args.has("--ci");
  const hasWorktree = args.has("--worktree");
  const hasLastCommit = args.has("--last-commit");

  const count = Number(hasCi) + Number(hasWorktree) + Number(hasLastCommit);
  if (count > 1) {
    throw new Error("Choose only one mode: --ci, --worktree, or --last-commit");
  }

  if (hasCi) return "ci";
  if (hasWorktree) return "worktree";
  if (hasLastCommit) return "last-commit";

  const mergeRequestIid = process.env.CI_MERGE_REQUEST_IID;
  if (mergeRequestIid != null && mergeRequestIid.trim() !== "") return "ci";
  return "worktree";
}

function logStep(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function getCliVersion(): Promise<string> {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJsonText = await readFile(packageJsonUrl, "utf8");
    const parsed = JSON.parse(packageJsonText) as { version?: string };
    if (parsed.version != null && parsed.version.trim() !== "") {
      return parsed.version.trim();
    }
  } catch {
    // Best-effort logging only.
  }
  return "unknown";
}

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
          stderr.trim() ||
            `git ${args.join(" ")} failed with exit code ${code}`,
        ),
      );
    });
  });
}

async function localDiffWorktree(): Promise<string> {
  const ignoreExtensions = parseIgnoreExtensions(process.argv);
  const pathspecs = buildGitExcludePathspecs(ignoreExtensions);
  const unstagedArgs =
    pathspecs.length > 0 ? ["diff", "--", ...pathspecs] : ["diff"];
  const stagedArgs =
    pathspecs.length > 0
      ? ["diff", "--staged", "--", ...pathspecs]
      : ["diff", "--staged"];
  const unstaged = await runGit(unstagedArgs);
  const staged = await runGit(stagedArgs);
  const combined = [staged.trim(), unstaged.trim()]
    .filter(Boolean)
    .join("\n\n");
  return combined;
}

async function localDiffLastCommit(): Promise<string> {
  const ignoreExtensions = parseIgnoreExtensions(process.argv);
  const pathspecs = buildGitExcludePathspecs(ignoreExtensions);
  // show patch for HEAD, but avoid commit message metadata
  const args =
    pathspecs.length > 0
      ? ["show", "--format=", "HEAD", "--", ...pathspecs]
      : ["show", "--format=", "HEAD"];
  return await runGit(args);
}

async function diffFromFile(filePath: string): Promise<string> {
  const text = await readFile(filePath, "utf8");
  return text;
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
      // Ignore common JS control keywords.
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
  const nearbyCalls = collectCallIdentifiersFromDiffLines(lines, [
    " ",
    "-",
    "+",
  ]);
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
  // De-duplicate repeated matches.
  return Array.from(
    new Map(findings.map((f) => [`${f.title}:${f.detail}`, f])).values(),
  ).slice(0, 3);
}

function injectDeterministicFindings(
  answer: string,
  findings: DeterministicFinding[],
): string {
  if (findings.length === 0) return answer;
  const noIssues = answer.includes(
    "No confirmed bugs or high-value optimizations found.",
  );
  if (!noIssues) return answer;
  const bullets = findings
    .map((f) => `- [high] ${f.title}: ${f.detail}`)
    .join("\n");
  const disclaimerIndex = answer.indexOf(
    "\n---\n_This comment was generated by an artificial intelligence duck._",
  );
  const disclaimer =
    disclaimerIndex >= 0
      ? answer.slice(disclaimerIndex)
      : "\n---\n_This comment was generated by an artificial intelligence duck._";
  return `${bullets}${disclaimer}`;
}

async function reviewDiffToConsole(
  diff: string,
  openaiApiKey: string,
  aiModel: ChatModel,
  promptLimits: PromptLimits,
): Promise<void> {
  if (diff.trim() === "") {
    process.stdout.write("No diff found. Skipping review.\n");
    return;
  }

  const messageParams = buildPrompt({
    changes: [{ diff }],
    limits: promptLimits,
  });

  const openaiInstance = new OpenAI({ apiKey: openaiApiKey });
  const completion = await generateAICompletion(
    messageParams,
    openaiInstance,
    aiModel,
  );
  const answer = buildAnswer(completion);
  const deterministicFindings = findDeterministicDiffFindings(diff);
  const finalAnswer = injectDeterministicFindings(
    answer,
    deterministicFindings,
  );
  process.stdout.write(`${finalAnswer}\n`);
}

const TOOL_NAME_GET_FILE = "get_file_at_ref";
const TOOL_NAME_GREP = "grep_repository";
const MAX_TOOL_ROUNDS = 12;

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

async function reviewMergeRequestWithTools(params: {
  openaiInstance: OpenAI;
  aiModel: ChatModel;
  promptLimits: PromptLimits;
  changes: MergeRequestChange[];
  refs: { base: string; head: string };
  gitLabProjectApiUrl: URL;
  projectId: string;
  headers: Record<string, string>;
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
  } = params;

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
            path: {
              type: "string",
              description: "Repository file path.",
            },
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
    const completion = await openaiInstance.chat.completions.create({
      model: aiModel,
      temperature: 0.2,
      stream: false,
      messages,
      tools,
      tool_choice: "auto",
    });
    const message = completion.choices[0]?.message;
    if (message == null) return buildAnswer(completion);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) return buildAnswer(completion);

    messages.push({
      role: "assistant",
      content: message.content ?? "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const argsRaw = toolCall.function.arguments ?? "{}";
      let toolContent: string;

      if (toolCall.function.name === TOOL_NAME_GET_FILE) {
        try {
          const parsed = JSON.parse(argsRaw) as { path?: string; ref?: string };
          const path = parsed.path?.trim();
          const ref = parsed.ref?.trim();
          if (path == null || path === "" || ref == null || ref === "") {
            toolContent = JSON.stringify({
              ok: false,
              error: "Both path and ref are required.",
            });
          } else {
            const fileText = await fetchFileAtRef({
              gitLabBaseUrl: gitLabProjectApiUrl,
              headers,
              filePath: path,
              ref,
            });
            if (fileText instanceof Error) {
              toolContent = JSON.stringify({
                ok: false,
                path,
                ref,
                error: fileText.message,
              });
            } else {
              toolContent = JSON.stringify({
                ok: true,
                path,
                ref,
                content: fileText.slice(0, 30000),
                truncated: fileText.length > 30000,
              });
            }
          }
        } catch (error: any) {
          toolContent = JSON.stringify({
            ok: false,
            error: `Failed to parse tool arguments: ${String(error?.message ?? error)}`,
            raw: argsRaw,
          });
        }
      } else if (toolCall.function.name === TOOL_NAME_GREP) {
        try {
          const parsed = JSON.parse(argsRaw) as {
            query?: string;
            ref?: string;
          };
          const query = parsed.query?.trim();
          if (query == null || query === "") {
            toolContent = JSON.stringify({
              ok: false,
              error: "query is required.",
            });
          } else {
            const ref = parsed.ref?.trim() || refs.head;
            const results = await searchRepository({
              gitLabBaseUrl: gitLabProjectApiUrl,
              headers,
              query,
              ref,
              projectId,
            });
            if (results instanceof Error) {
              toolContent = JSON.stringify({
                ok: false,
                query,
                ref,
                error: results.message,
              });
            } else {
              const trimmed = results.map((r) => ({
                path: r.path,
                startline: r.startline,
                data: r.data.slice(0, 2000),
              }));
              toolContent = JSON.stringify({
                ok: true,
                query,
                ref,
                matches: trimmed,
              });
            }
          }
        } catch (error: any) {
          toolContent = JSON.stringify({
            ok: false,
            error: `Failed to parse tool arguments: ${String(error?.message ?? error)}`,
            raw: argsRaw,
          });
        }
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
    }
  }

  // Graceful fallback: ask model for a final best-effort answer
  // using already collected context, without allowing more tool calls.
  messages.push({
    role: "user",
    content: `Tool-call limit reached (${MAX_TOOL_ROUNDS}). Do not call any tools. Provide your best-effort final review now, strictly following the required output format. If confidence is low, return the exact no-issues sentence.`,
  });
  const finalCompletion = await openaiInstance.chat.completions.create({
    model: aiModel,
    temperature: 0.2,
    stream: false,
    messages,
  });
  return buildAnswer(finalCompletion);
}

// ---------------------------------------------------------------------------
// Multi-pass pipeline: triage → per-file review → consolidate
// ---------------------------------------------------------------------------

const MAX_FILE_TOOL_ROUNDS = 5;

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
  } = params;

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
    const completion = await openaiInstance.chat.completions.create({
      model: aiModel,
      temperature: 0.2,
      stream: false,
      messages,
      tools,
      tool_choice: "auto",
    });
    const msg = completion.choices[0]?.message;
    if (msg == null) return extractCompletionText(completion) ?? "No issues found.";

    const toolCalls = msg.tool_calls ?? [];
    if (toolCalls.length === 0)
      return extractCompletionText(completion) ?? "No issues found.";

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const argsRaw = toolCall.function.arguments ?? "{}";
      let toolContent: string;

      if (toolCall.function.name === TOOL_NAME_GET_FILE) {
        toolContent = await handleGetFileTool(
          argsRaw,
          gitLabProjectApiUrl,
          headers,
        );
      } else if (toolCall.function.name === TOOL_NAME_GREP) {
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
          error: `Unknown tool "${toolCall.function.name}"`,
        });
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: toolContent,
      });
    }
  }

  messages.push({
    role: "user",
    content:
      "Tool-call limit reached. Provide your final review now without any tool calls.",
  });
  const final = await openaiInstance.chat.completions.create({
    model: aiModel,
    temperature: 0.2,
    stream: false,
    messages,
  });
  return extractCompletionText(final) ?? "No issues found.";
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
    if (!query) {
      return JSON.stringify({ ok: false, error: "query is required." });
    }
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

async function reviewMergeRequestMultiPass(params: {
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
  } = params;

  // --- Pass 1: Triage + Summary ---
  logStep(
    `Pass 1/3: triaging ${changes.length} file(s)`,
  );

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
    const triageCompletion = await openaiInstance.chat.completions.create({
      model: aiModel,
      temperature: 0.1,
      stream: false,
      messages: triageMessages,
      response_format: { type: "json_object" },
    });
    const triageText = extractCompletionText(triageCompletion);
    if (triageText != null) {
      triageResult = parseTriageResponse(triageText);
    }
  } catch (error: any) {
    logStep(`Triage pass failed: ${error?.message ?? error}. Falling back to single-pass.`);
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
    });
  }

  const triageMap = new Map(
    triageResult.files.map((f) => [f.path, f.verdict]),
  );
  const reviewFiles = changes.filter(
    (c) => triageMap.get(c.new_path) !== "SKIP",
  );
  const skippedCount = changes.length - reviewFiles.length;

  logStep(
    `Triage: ${reviewFiles.length} file(s) to review, ${skippedCount} skipped. Summary: ${triageResult.summary.slice(0, 120)}...`,
  );

  if (reviewFiles.length === 0) {
    const DISCLAIMER =
      "This comment was generated by an artificial intelligence duck.";
    return `No confirmed bugs or high-value optimizations found.\n\n---\n_${DISCLAIMER}_`;
  }

  // --- Pass 2: Per-file review (parallel with concurrency limit) ---
  logStep(
    `Pass 2/3: reviewing ${reviewFiles.length} file(s) (concurrency=${reviewConcurrency})`,
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
      });
      return { path: change.new_path, findings };
    },
  );

  // --- Pass 3: Consolidate ---
  logStep("Pass 3/3: consolidating findings");

  const consolidateMessages = buildConsolidatePrompt({
    perFileFindings,
    summary: triageResult.summary,
    maxFindings,
  });

  if (consolidateMessages == null) {
    const DISCLAIMER =
      "This comment was generated by an artificial intelligence duck.";
    return `No confirmed bugs or high-value optimizations found.\n\n---\n_${DISCLAIMER}_`;
  }

  try {
    const consolidateCompletion =
      await openaiInstance.chat.completions.create({
        model: aiModel,
        temperature: 0.1,
        stream: false,
        messages: consolidateMessages,
      });
    return buildAnswer(consolidateCompletion);
  } catch (error: any) {
    logStep(`Consolidation failed: ${error?.message ?? error}. Returning raw per-file findings.`);
    const DISCLAIMER =
      "This comment was generated by an artificial intelligence duck.";
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

async function main(): Promise<void> {
  const cliVersion = await getCliVersion();
  logStep(`gitlab-ai-review v${cliVersion}`);

  const diffFilePath = parseDiffFileFlag(process.argv);
  if (diffFilePath != null && hasModeFlag(process.argv)) {
    throw new Error(
      "Do not combine --diff-file with --ci/--worktree/--last-commit",
    );
  }
  const mode = diffFilePath != null ? "worktree" : parseMode(process.argv);
  const ignoredExtensions = parseIgnoreExtensions(process.argv);
  const promptLimits = parsePromptLimits(process.argv);
  const maxFindings = parseNumberFlag(
    process.argv,
    "max-findings",
    DEFAULT_MAX_FINDINGS,
    1,
  );
  const reviewConcurrency = parseNumberFlag(
    process.argv,
    "max-review-concurrency",
    DEFAULT_REVIEW_CONCURRENCY,
    1,
  );

  const aiModel = envOrDefault("AI_MODEL", "gpt-4o-mini") as ChatModel;

  if (diffFilePath != null) {
    logStep(`Reading diff file: ${diffFilePath}`);
    const openaiEnvs = requireEnvs(["OPENAI_API_KEY"]);
    const openaiApiKey = openaiEnvs["OPENAI_API_KEY"]!;
    const diff = await diffFromFile(diffFilePath);
    logStep(`Requesting AI completion with model: ${aiModel}`);
    await reviewDiffToConsole(diff, openaiApiKey, aiModel, promptLimits);
    return;
  }

  if (mode === "worktree") {
    logStep("Collecting local changes");
    const openaiEnvs = requireEnvs(["OPENAI_API_KEY"]);
    const openaiApiKey = openaiEnvs["OPENAI_API_KEY"]!;
    const diff = await localDiffWorktree();
    logStep(`Requesting AI completion with model: ${aiModel}`);
    await reviewDiffToConsole(diff, openaiApiKey, aiModel, promptLimits);
    return;
  }

  if (mode === "last-commit") {
    logStep("Collecting HEAD diff");
    const openaiEnvs = requireEnvs(["OPENAI_API_KEY"]);
    const openaiApiKey = openaiEnvs["OPENAI_API_KEY"]!;
    const diff = await localDiffLastCommit();
    logStep(`Requesting AI completion with model: ${aiModel}`);
    await reviewDiffToConsole(diff, openaiApiKey, aiModel, promptLimits);
    return;
  }

  const projectAccessToken =
    envOrUndefined("PROJECT_ACCESS_TOKEN") ?? envOrUndefined("GITLAB_TOKEN");

  const gitlabRequired: string[] = [
    "OPENAI_API_KEY",
    "CI_API_V4_URL",
    "CI_PROJECT_ID",
    "CI_MERGE_REQUEST_IID",
  ];
  if (projectAccessToken == null) {
    gitlabRequired.push("CI_JOB_TOKEN");
  }
  const gitlabEnvs = requireEnvs(gitlabRequired);

  const openaiApiKey = gitlabEnvs["OPENAI_API_KEY"]!;
  const ciApiV4Url = gitlabEnvs["CI_API_V4_URL"]!;
  const projectId = gitlabEnvs["CI_PROJECT_ID"]!;
  const mergeRequestIid = gitlabEnvs["CI_MERGE_REQUEST_IID"]!;
  const gitLabBaseUrl = new URL(ciApiV4Url);

  const headers: Record<string, string> = {};
  if (projectAccessToken != null) {
    headers["PRIVATE-TOKEN"] = projectAccessToken;
  } else {
    headers["JOB-TOKEN"] = gitlabEnvs["CI_JOB_TOKEN"]!;
  }

  logStep("Fetching merge request changes");
  const mrChanges = await fetchMergeRequestChanges({
    gitLabBaseUrl,
    headers,
    projectId,
    mergeRequestIid,
  });
  if (mrChanges instanceof Error) throw mrChanges;

  const changes = mrChanges.changes ?? [];
  const filteredChanges =
    ignoredExtensions.length === 0
      ? changes
      : changes.filter(
          (change) =>
            !hasIgnoredExtension(change.new_path, ignoredExtensions) &&
            !hasIgnoredExtension(change.old_path, ignoredExtensions),
        );

  if (filteredChanges.length === 0) {
    process.stdout.write(
      "No changes found in merge request. Skipping review.\n",
    );
    return;
  }

  logStep(`Requesting AI review with model: ${aiModel} (multi-pass pipeline)`);
  const openaiInstance = new OpenAI({ apiKey: openaiApiKey });
  const answer = await reviewMergeRequestMultiPass({
    openaiInstance,
    aiModel,
    promptLimits,
    changes: filteredChanges,
    refs: {
      base: mrChanges.diff_refs?.base_sha ?? "HEAD",
      head: mrChanges.diff_refs?.head_sha ?? "HEAD",
    },
    gitLabProjectApiUrl: new URL(`${ciApiV4Url}/projects/${projectId}`),
    projectId,
    headers,
    maxFindings,
    reviewConcurrency,
  });

  logStep("Posting AI review note to merge request");
  const noteRes = await postMergeRequestNote(
    {
      gitLabBaseUrl: new URL(`${ciApiV4Url}/projects/${projectId}`),
      headers,
      mergeRequestIid,
    },
    { body: answer },
  );
  if (noteRes instanceof Error) throw noteRes;

  process.stdout.write("Posted AI review comment to merge request.\n");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  const anyErr = err as any;

  if (anyErr?.name === "FAILED_TO_POST_COMMENT" && anyErr?.cause != null) {
    process.stderr.write(`Cause: ${JSON.stringify(anyErr.cause)}\n`);
  }

  if (hasDebugFlag(process.argv)) {
    if (err instanceof Error && err.stack != null) {
      process.stderr.write(`\nStack:\n${err.stack}\n`);
    }
    const debugInfo: Record<string, any> = {
      name: anyErr?.name,
      message: anyErr?.message,
      status: anyErr?.status,
      code: anyErr?.code,
      type: anyErr?.type,
      request_id: anyErr?.request_id,
      headers: anyErr?.headers,
      error: anyErr?.error,
      cause:
        anyErr?.cause instanceof Error
          ? {
              name: anyErr.cause.name,
              message: anyErr.cause.message,
              stack: anyErr.cause.stack,
            }
          : anyErr?.cause,
    };
    process.stderr.write(`\nDebug:\n${JSON.stringify(debugInfo, null, 2)}\n`);
  }
  process.exitCode = 1;
});
