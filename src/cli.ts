#!/usr/bin/env node
/** @format */

import OpenAI from "openai";
import type { ChatModel } from "openai/resources/index.mjs";
import {
  buildAnswer,
  buildPrompt,
  DEFAULT_PROMPT_LIMITS,
  type PromptLimits,
} from "./prompt/index.js";
import {
  fetchMergeRequestChanges,
  fetchPreEditFiles,
  generateAICompletion,
  postMergeRequestNote,
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
      "  gitlab-ai-review --help",
      "  gitlab-ai-review --debug",
      "  gitlab-ai-review --ci --ignore-ext=md,lock",
      "",
      "Modes (choose one):",
      "  --ci           Run in GitLab MR pipeline: fetch MR changes and post a new MR note.",
      "  --worktree     Review local uncommitted changes (staged + unstaged) and print to stdout.",
      "  --last-commit  Review last commit (HEAD) and print to stdout.",
      "",
      "Debug:",
      "  --debug        Print full error details (stack, API error fields).",
      "  --ignore-ext   Ignore file extensions (comma-separated only). Example: --ignore-ext=md,lock",
      "  --max-old-files=30",
      "  --max-old-file-chars=12000",
      "  --max-diffs=50",
      "  --max-diff-chars=16000",
      "  --max-total-prompt-chars=220000",
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
    maxOldFiles: parseNumberFlag(
      argv,
      "max-old-files",
      DEFAULT_PROMPT_LIMITS.maxOldFiles,
      0,
    ),
    maxOldFileChars: parseNumberFlag(
      argv,
      "max-old-file-chars",
      DEFAULT_PROMPT_LIMITS.maxOldFileChars,
      1,
    ),
    maxDiffs: parseNumberFlag(argv, "max-diffs", DEFAULT_PROMPT_LIMITS.maxDiffs, 0),
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

function logCiStep(message: string): void {
  process.stdout.write(`[ci] ${message}\n`);
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
  process.stdout.write(`${answer}\n`);
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv);
  const ignoredExtensions = parseIgnoreExtensions(process.argv);
  const promptLimits = parsePromptLimits(process.argv);

  const aiModel = envOrDefault("AI_MODEL", "gpt-4o-mini") as ChatModel;

  if (mode === "worktree") {
    const openaiEnvs = requireEnvs(["OPENAI_API_KEY"]);
    const openaiApiKey = openaiEnvs["OPENAI_API_KEY"]!;
    const diff = await localDiffWorktree();
    await reviewDiffToConsole(diff, openaiApiKey, aiModel, promptLimits);
    return;
  }

  if (mode === "last-commit") {
    const openaiEnvs = requireEnvs(["OPENAI_API_KEY"]);
    const openaiApiKey = openaiEnvs["OPENAI_API_KEY"]!;
    const diff = await localDiffLastCommit();
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

  logCiStep("Fetching merge request changes");
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

  const baseSha = mrChanges.diff_refs?.base_sha;
  const ref = baseSha ?? "HEAD";
  const changesOldPaths = filteredChanges.map((c) => c.old_path);

  logCiStep("Fetching pre-edit file versions");
  const oldFiles = await fetchPreEditFiles({
    gitLabBaseUrl: new URL(`${ciApiV4Url}/projects/${projectId}`),
    headers,
    changesOldPaths,
    ref,
  });
  if (oldFiles instanceof Error) throw oldFiles;

  logCiStep("Building prompt");
  const messageParams = buildPrompt({
    oldFiles,
    changes: filteredChanges.map((c) => ({ diff: c.diff })),
    limits: promptLimits,
  });

  logCiStep(`Requesting AI completion with model: ${aiModel}`);
  const openaiInstance = new OpenAI({ apiKey: openaiApiKey });
  const completion = await generateAICompletion(
    messageParams,
    openaiInstance,
    aiModel,
  );

  const answer = buildAnswer(completion);

  logCiStep("Posting AI review note to merge request");
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
