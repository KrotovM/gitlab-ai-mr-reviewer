#!/usr/bin/env node
/** @format */

import OpenAI from "openai";
import type { ChatModel } from "openai/resources/index.mjs";
import { buildAnswer, buildPrompt } from "./prompt/index.js";
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
      "",
      "Modes (choose one):",
      "  --ci           Run in GitLab MR pipeline: fetch MR changes and post a new MR note.",
      "  --worktree     Review local uncommitted changes (staged + unstaged) and print to stdout.",
      "  --last-commit  Review last commit (HEAD) and print to stdout.",
      "",
      "Debug:",
      "  --debug        Print full error details (stack, API error fields).",
      "",
      "Env vars:",
      "  OPENAI_API_KEY (required)  OpenAI API key.",
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
  const unstaged = await runGit(["diff"]);
  const staged = await runGit(["diff", "--staged"]);
  const combined = [staged.trim(), unstaged.trim()]
    .filter(Boolean)
    .join("\n\n");
  return combined;
}

async function localDiffLastCommit(): Promise<string> {
  // show patch for HEAD, but avoid commit message metadata
  return await runGit(["show", "--format=", "HEAD"]);
}

async function reviewDiffToConsole(
  diff: string,
  openaiApiKey: string,
  aiModel: ChatModel,
): Promise<void> {
  if (diff.trim() === "") {
    process.stdout.write("No diff found. Skipping review.\n");
    return;
  }

  const messageParams = buildPrompt({
    changes: [{ diff }],
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

  const openaiEnvs = requireEnvs(["OPENAI_API_KEY"]);
  const openaiApiKey = openaiEnvs["OPENAI_API_KEY"]!;
  const aiModel = envOrDefault("AI_MODEL", "gpt-4o-mini") as ChatModel;

  if (mode === "worktree") {
    const diff = await localDiffWorktree();
    await reviewDiffToConsole(diff, openaiApiKey, aiModel);
    return;
  }

  if (mode === "last-commit") {
    const diff = await localDiffLastCommit();
    await reviewDiffToConsole(diff, openaiApiKey, aiModel);
    return;
  }

  const projectAccessToken =
    envOrUndefined("PROJECT_ACCESS_TOKEN") ?? envOrUndefined("GITLAB_TOKEN");

  const gitlabRequired: string[] = [
    "CI_API_V4_URL",
    "CI_PROJECT_ID",
    "CI_MERGE_REQUEST_IID",
  ];
  if (projectAccessToken == null) {
    gitlabRequired.push("CI_JOB_TOKEN");
  }
  const gitlabEnvs = requireEnvs(gitlabRequired);

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

  const mrChanges = await fetchMergeRequestChanges({
    gitLabBaseUrl,
    headers,
    projectId,
    mergeRequestIid,
  });
  if (mrChanges instanceof Error) throw mrChanges;

  const changes = mrChanges.changes ?? [];
  if (changes.length === 0) {
    process.stdout.write(
      "No changes found in merge request. Skipping review.\n",
    );
    return;
  }

  const baseSha = mrChanges.diff_refs?.base_sha;
  const ref = baseSha ?? "HEAD";
  const changesOldPaths = changes.map((c) => c.old_path);

  const oldFiles = await fetchPreEditFiles({
    gitLabBaseUrl: new URL(`${ciApiV4Url}/projects/${projectId}`),
    headers,
    changesOldPaths,
    ref,
  });
  if (oldFiles instanceof Error) throw oldFiles;

  const messageParams = buildPrompt({
    oldFiles,
    changes: changes.map((c) => ({ diff: c.diff })),
  });

  const openaiInstance = new OpenAI({ apiKey: openaiApiKey });
  const completion = await generateAICompletion(
    messageParams,
    openaiInstance,
    aiModel,
  );

  const answer = buildAnswer(completion);

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

  if (hasDebugFlag(process.argv)) {
    if (err instanceof Error && err.stack != null) {
      process.stderr.write(`\nStack:\n${err.stack}\n`);
    }
    const anyErr = err as any;
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
