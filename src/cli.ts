#!/usr/bin/env node
/** @format */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readFile } from "node:fs/promises";
import {
  formatMergeRequestIntent,
  parsePromptProfile,
} from "./prompt/index.js";
import {
  envOrDefault,
  envOrUndefined,
  isGeneratedFile,
  parseCliArgs,
  requireEnvs,
} from "./cli/args.js";
import { DEFAULT_ANTHROPIC_MODEL } from "./cli/anthropic.js";
import {
  loadReviewInstructions,
  reviewMergeRequestMultiPass,
} from "./cli/ci-review.js";
import { postInlineFindings } from "./cli/inline-comments.js";
import {
  fetchMergeRequestChanges,
  upsertSummaryNote,
} from "./gitlab/services.js";
import { renderDebugArtifactsHtml } from "./cli/debug-artifacts-html.js";

function printHelp(): void {
  process.stdout.write(
    `gitlab-ai-review

Usage:
  gitlab-ai-review [options]

Options:
  --help, -h     Show this help.
  --debug        Print full error details (stack, API error fields).
  --include-artifacts  Generate local HTML artifact without printing payloads to console.
  --force-tools  Force at least one tool-call round in tool-enabled review paths (openai only).
  --ignore-ext   Ignore file extensions (comma-separated). Example: --ignore-ext=md,lock
  --max-diffs=50             Max file diffs in the single-pass fallback prompt.
  --max-diff-chars=16000     Max chars per file diff (per-file review and single-pass).
  --max-total-prompt-chars=220000  Prompt size cap (triage and single-pass).
  --triage-diff-chars=2000   Max chars per file diff in triage pass (Pass 1).
  --max-findings=5          Max findings in final review (CI multi-pass only).
  --max-review-concurrency=2  Parallel per-file review calls (CI multi-pass only).
  --inline-comments  Post findings on changed lines as resolvable diff threads; the rest stays in the summary comment.

Env vars:
  AI_PROVIDER   (optional)  "openai" | "anthropic". Default: openai.
  OPENAI_API_KEY (required for openai)  OpenAI API key.
  OPENAI_BASE_URL (optional)  Custom OpenAI-compatible API base URL.
  ANTHROPIC_API_KEY (required for anthropic)  Anthropic API key.
  AI_MODEL      (optional)  Chat model. Default: gpt-4o-mini (openai), ${DEFAULT_ANTHROPIC_MODEL} (anthropic).
  AI_REVIEW_CONCURRENCY (optional)  Same as --max-review-concurrency; the flag wins.
  AI_PROMPT_PROFILE (optional)  Prompt style: "default" | "weak". Default: default.
                              Use "weak" for small/quantized models — shorter prompts,
                              positive rules, and few-shot examples.
                              When unset, an unparseable triage response auto-retries
                              with "weak" and keeps it for the whole run.
  PROJECT_ACCESS_TOKEN (required)  GitLab project/personal access token with api scope (alias: GITLAB_TOKEN). CI_JOB_TOKEN can't post MR comments.

CI-only env vars (provided by GitLab):
  CI_API_V4_URL, CI_PROJECT_ID, CI_MERGE_REQUEST_PROJECT_ID, CI_MERGE_REQUEST_IID
`,
  );
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
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const logStep = (message: string): void => {
    process.stdout.write(`${message}\n`);
  };
  const logDebug = (message: string): void => {
    if (options.debug) process.stdout.write(`[debug] ${message}\n`);
  };

  const cliVersion = await getCliVersion();
  logStep(`gitlab-ai-review v${cliVersion}`);
  if (options.ignoredArgs.length > 0) {
    logStep(
      `Warning: ignoring unrecognized argument(s): ${options.ignoredArgs.join(", ")}. See --help for the supported flags.`,
    );
  }
  const { ignoredExtensions } = options;
  const provider = envOrDefault("AI_PROVIDER", "openai").toLowerCase();
  if (provider !== "openai" && provider !== "anthropic") {
    throw new Error(
      `AI_PROVIDER must be "openai" or "anthropic", got "${provider}".`,
    );
  }
  const aiModel = envOrDefault(
    "AI_MODEL",
    provider === "anthropic" ? DEFAULT_ANTHROPIC_MODEL : "gpt-4o-mini",
  );
  const promptProfile = parsePromptProfile(envOrUndefined("AI_PROMPT_PROFILE"));
  const allowProfileAutoDemote = envOrUndefined("AI_PROMPT_PROFILE") == null;
  logStep(
    `Prompt profile: ${promptProfile}${allowProfileAutoDemote ? " (auto: falls back to weak if triage JSON fails)" : ""}`,
  );
  const artifactHtmlFile = envOrDefault(
    "AI_REVIEW_ARTIFACT_HTML_FILE",
    "ai-review-report.html",
  );
  const artifactRecords: Record<string, any>[] = [];
  const debugRecordWriter = options.includeArtifacts
    ? (record: Record<string, unknown>) => {
        artifactRecords.push(record);
      }
    : undefined;

  const loggers = { logStep, logDebug };

  const projectAccessToken =
    envOrUndefined("PROJECT_ACCESS_TOKEN") ?? envOrUndefined("GITLAB_TOKEN");
  const apiKeyEnv =
    provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const gitlabRequired: string[] = [
    apiKeyEnv,
    "CI_API_V4_URL",
    "CI_PROJECT_ID",
    "CI_MERGE_REQUEST_IID",
  ];
  // CI_JOB_TOKEN can't post MR notes or call the search API, so a real token is required.
  if (projectAccessToken == null) gitlabRequired.push("PROJECT_ACCESS_TOKEN");
  const envs = requireEnvs(gitlabRequired);
  const apiKey = envs[apiKeyEnv]!;
  const ciApiV4Url = envs["CI_API_V4_URL"]!;
  // MR endpoints live in the MR's target project; in fork pipelines CI_PROJECT_ID is the fork.
  const projectId =
    envOrUndefined("CI_MERGE_REQUEST_PROJECT_ID") ?? envs["CI_PROJECT_ID"]!;
  const mergeRequestIid = envs["CI_MERGE_REQUEST_IID"]!;
  const gitLabProjectApiUrl = new URL(`${ciApiV4Url}/projects/${projectId}`);

  const headers: Record<string, string> = {
    "PRIVATE-TOKEN": projectAccessToken!,
  };

  try {
    logStep("Fetching merge request changes");
    const mrChanges = await fetchMergeRequestChanges({
      gitLabProjectApiUrl,
      headers,
      mergeRequestIid,
    });
    if (mrChanges instanceof Error) throw mrChanges;

    if (mrChanges.overflow === true) {
      logStep(
        "Warning: GitLab truncated this merge request's changes (diff size limits); only the returned files are reviewed.",
      );
    }
    const allChanges = mrChanges.changes ?? [];
    const reviewable = allChanges.filter(
      (change) => change.diff.trim() !== "" && !isGeneratedFile(change.new_path),
    );
    const skipped = allChanges
      .filter((change) => !reviewable.includes(change))
      .map((change) => change.new_path);
    if (skipped.length > 0) {
      logStep(
        `Skipping ${skipped.length} file(s) with no diff text (renames, binaries) or generated content (lockfiles, minified, snapshots): ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ", …" : ""}`,
      );
    }
    const ignored = (path: string) =>
      ignoredExtensions.some((ext) => path.toLowerCase().endsWith(ext));
    const filteredChanges = reviewable.filter(
      (change) => !ignored(change.new_path) && !ignored(change.old_path),
    );

    if (filteredChanges.length === 0) {
      process.stdout.write(
        "No changes found in merge request. Skipping review.\n",
      );
      return;
    }

    const reviewInstructions = await loadReviewInstructions({
      gitLabProjectApiUrl,
      headers,
      mr: mrChanges,
      logStep,
    });
    const mergeRequestIntent = formatMergeRequestIntent(mrChanges);
    logStep(
      mergeRequestIntent == null
        ? "MR has no title or description; reviewing without stated intent."
        : `Using MR title and description as stated intent (${mergeRequestIntent.length} chars).`,
    );

    logStep(
      `Requesting AI review with model: ${aiModel} (${provider}, multi-pass pipeline)`,
    );
    const answer = await reviewMergeRequestMultiPass({
      llm:
        provider === "anthropic"
          ? new Anthropic({ apiKey })
          : new OpenAI({ apiKey }),
      aiModel,
      promptLimits: options.promptLimits,
      triageDiffChars: options.triageDiffChars,
      changes: filteredChanges,
      refs: {
        base: mrChanges.diff_refs?.base_sha ?? "HEAD",
        head: mrChanges.diff_refs?.head_sha ?? "HEAD",
      },
      gitLabProjectApiUrl,
      headers,
      maxFindings: options.maxFindings,
      reviewConcurrency: options.reviewConcurrency,
      forceTools: options.forceTools,
      promptProfile,
      allowProfileAutoDemote,
      reviewInstructions,
      mergeRequestIntent,
      loggers,
      debugRecordWriter,
    });

    const note = options.inlineComments
      ? await postInlineFindings({
          answer,
          changes: filteredChanges,
          diffRefs: mrChanges.diff_refs,
          gitLabProjectApiUrl,
          headers,
          mergeRequestIid,
          logStep,
        })
      : answer;

    logStep("Posting AI review note to merge request");
    const noteRes = await upsertSummaryNote({
      gitLabProjectApiUrl,
      headers,
      mergeRequestIid,
      note,
      logStep,
    });
    if (noteRes instanceof Error) throw noteRes;

    process.stdout.write(
      noteRes === "updated"
        ? "Updated the AI review comment on the merge request.\n"
        : "Posted AI review comment to merge request.\n",
    );
  } finally {
    if (options.includeArtifacts) {
      try {
        await renderDebugArtifactsHtml({
          records: artifactRecords,
          artifactHtmlFile,
          cliVersion,
          aiModel,
        });
      } catch (artifactError: any) {
        const message =
          artifactError instanceof Error
            ? artifactError.message
            : String(artifactError);
        process.stderr.write(
          `Failed to write debug artifact "${artifactHtmlFile}": ${message}\n`,
        );
      }
    }
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  const anyErr = err as any;
  if (anyErr?.name === "FAILED_TO_POST_COMMENT" && anyErr?.cause != null) {
    process.stderr.write(`Cause: ${JSON.stringify(anyErr.cause)}\n`);
  }
  if (process.argv.includes("--debug")) {
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
