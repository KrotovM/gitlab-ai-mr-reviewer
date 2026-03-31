#!/usr/bin/env node
/** @format */

import OpenAI from "openai";
import type { ChatModel } from "openai/resources/index.mjs";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_MAX_FINDINGS,
  DEFAULT_REVIEW_CONCURRENCY,
} from "./prompt/index.js";
import {
  envOrDefault,
  envOrUndefined,
  hasDebugFlag,
  hasForceToolsFlag,
  hasIncludeArtifactsFlag,
  hasIgnoredExtension,
  parseIgnoreExtensions,
  parseNumberFlag,
  parsePromptLimits,
  requireEnvs,
} from "./cli/args.js";
import { reviewMergeRequestMultiPass } from "./cli/ci-review.js";
import {
  fetchMergeRequestChanges,
  postMergeRequestNote,
} from "./gitlab/services.js";
import { renderDebugArtifactsHtml } from "./cli/debug-artifacts-html.js";

function printHelp(): void {
  process.stdout.write(
    [
      "gitlab-ai-review",
      "",
      "Usage:",
      "  gitlab-ai-review",
      "  gitlab-ai-review --help",
      "  gitlab-ai-review --debug",
      "  gitlab-ai-review --ignore-ext=md,lock",
      "",
      "Debug:",
      "  --debug        Print full error details (stack, API error fields).",
      "  --include-artifacts  Generate local HTML artifact without printing payloads to console.",
      "  --force-tools  Force at least one tool-call round in tool-enabled review paths.",
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
      "  PROJECT_ACCESS_TOKEN (optional)  GitLab Project/Personal Access Token for API calls (required for most private repos; should have api scope).",
      "",
      "CI-only env vars (provided by GitLab):",
      "  CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_IID, CI_JOB_TOKEN (only if PROJECT_ACCESS_TOKEN is not set)",
      "",
    ].join("\n"),
  );
}

const DEBUG_MODE = hasDebugFlag(process.argv);
const FORCE_TOOLS = hasForceToolsFlag(process.argv);
const INCLUDE_ARTIFACTS = hasIncludeArtifactsFlag(process.argv);

function logStep(message: string): void {
  process.stdout.write(`${message}\n`);
}

function logDebug(message: string): void {
  if (!DEBUG_MODE) return;
  process.stdout.write(`[debug] ${message}\n`);
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

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    printHelp();
    return;
  }

  const cliVersion = await getCliVersion();
  logStep(`gitlab-ai-review v${cliVersion}`);
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
  const artifactHtmlFile = INCLUDE_ARTIFACTS
    ? envOrDefault("AI_REVIEW_ARTIFACT_HTML_FILE", ".ai-review-debug.html")
    : undefined;
  const artifactRecords: Record<string, any>[] = [];
  const debugRecordWriter = INCLUDE_ARTIFACTS
    ? async (record: Record<string, unknown>) => {
        artifactRecords.push(record as Record<string, any>);
      }
    : undefined;

  const loggers = { logStep, logDebug };

  const projectAccessToken =
    envOrUndefined("PROJECT_ACCESS_TOKEN") ?? envOrUndefined("GITLAB_TOKEN");
  const gitlabRequired: string[] = [
    "OPENAI_API_KEY",
    "CI_API_V4_URL",
    "CI_PROJECT_ID",
    "CI_MERGE_REQUEST_IID",
  ];
  if (projectAccessToken == null) gitlabRequired.push("CI_JOB_TOKEN");
  const envs = requireEnvs(gitlabRequired);
  const openaiApiKey = envs["OPENAI_API_KEY"]!;
  const ciApiV4Url = envs["CI_API_V4_URL"]!;
  const projectId = envs["CI_PROJECT_ID"]!;
  const mergeRequestIid = envs["CI_MERGE_REQUEST_IID"]!;

  const headers: Record<string, string> = {};
  if (projectAccessToken != null) headers["PRIVATE-TOKEN"] = projectAccessToken;
  else headers["JOB-TOKEN"] = envs["CI_JOB_TOKEN"]!;

  logStep("Fetching merge request changes");
  const mrChanges = await fetchMergeRequestChanges({
    gitLabBaseUrl: new URL(ciApiV4Url),
    headers,
    projectId,
    mergeRequestIid,
  });
  if (mrChanges instanceof Error) throw mrChanges;

  const filteredChanges = (mrChanges.changes ?? []).filter(
    (change) =>
      ignoredExtensions.length === 0 ||
      (!hasIgnoredExtension(change.new_path, ignoredExtensions) &&
        !hasIgnoredExtension(change.old_path, ignoredExtensions)),
  );

  if (filteredChanges.length === 0) {
    process.stdout.write(
      "No changes found in merge request. Skipping review.\n",
    );
    return;
  }

  logStep(`Requesting AI review with model: ${aiModel} (multi-pass pipeline)`);
  const answer = await reviewMergeRequestMultiPass({
    openaiInstance: new OpenAI({ apiKey: openaiApiKey }),
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
    forceTools: FORCE_TOOLS,
    loggers,
    debugRecordWriter,
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

  if (INCLUDE_ARTIFACTS && artifactHtmlFile != null) {
    await renderDebugArtifactsHtml({
      records: artifactRecords,
      artifactHtmlFile,
      cliVersion,
      aiModel,
    });
  }

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
