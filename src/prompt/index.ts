/** @format */

import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/index.mjs";
import {
  buildMainSystemMessages,
  FILE_REVIEW_SYSTEM,
  TRIAGE_SYSTEM,
} from "./messages.js";
import {
  normalizeReviewFindingsMarkdown,
  sanitizeGitLabMarkdown,
  truncateWithMarker,
} from "./utils.js";
import {
  buildConsolidateSystemLines,
  buildVerificationSystemLines,
} from "./templates/postprocess-system.js";
import {
  buildConsolidateUserContent,
  buildFileReviewUserContent,
  buildMainReviewUserContent,
  buildTriageUserContent,
  buildVerificationUserContent,
} from "./templates/user-prompts.js";

export interface PromptLimits {
  maxDiffs: number;
  maxDiffChars: number;
  maxTotalPromptChars: number;
}

export const DEFAULT_PROMPT_LIMITS: PromptLimits = {
  maxDiffs: 50,
  maxDiffChars: 16000,
  maxTotalPromptChars: 220000,
};

const MESSAGES: ChatCompletionMessageParam[] = buildMainSystemMessages();

export const AI_MODEL_TEMPERATURE = 0.2;
export const AI_MAX_OUTPUT_TOKENS = 600;

export interface BuildPromptParameters {
  changes: Array<{ diff: string }>;
  limits?: Partial<PromptLimits>;
  allowTools?: boolean;
}

export const buildPrompt = ({
  changes,
  limits,
  allowTools = false,
}: BuildPromptParameters): ChatCompletionMessageParam[] => {
  const effectiveLimits: PromptLimits = {
    ...DEFAULT_PROMPT_LIMITS,
    ...(limits ?? {}),
  };

  const totalFiles = changes.length;
  const capped = changes.slice(0, effectiveLimits.maxDiffs);
  const omittedFiles = totalFiles - capped.length;

  let truncatedCount = 0;
  const diffsTrimmed = capped.map((change, index) => {
    if (change.diff.length > effectiveLimits.maxDiffChars) truncatedCount += 1;
    return truncateWithMarker(
      change.diff,
      effectiveLimits.maxDiffChars,
      `diff #${index + 1}`,
    );
  });

  const changesText = diffsTrimmed.join("\n\n");

  const statsFragments = [`${capped.length} file diff(s) included.`];
  if (truncatedCount > 0)
    statsFragments.push(
      `${truncatedCount} diff(s) truncated due to size limits.`,
    );
  if (omittedFiles > 0)
    statsFragments.push(
      `${omittedFiles} additional file(s) omitted (max-diffs limit).`,
    );
  const stats = statsFragments.join(" ");

  const toolNote = allowTools
    ? "Tools (get_file_at_ref, grep_repository) are available — use them to verify suspicions and inspect truncated or omitted files."
    : "Tools are unavailable in this run; rely only on visible diff evidence.";

  const userContent = buildMainReviewUserContent({
    stats,
    toolNote,
    changesText,
  });

  const boundedContent = truncateWithMarker(
    userContent,
    effectiveLimits.maxTotalPromptChars,
    "prompt payload",
  );
  return [...MESSAGES, { role: "user", content: boundedContent }];
};

// ---------------------------------------------------------------------------
// Multi-pass pipeline prompts
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_FINDINGS = 5;
export const DEFAULT_REVIEW_CONCURRENCY = 5;
export interface TriageFileInput {
  path: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff: string;
}

export interface TriageResult {
  summary: string;
  files: Array<{ path: string; verdict: "NEEDS_REVIEW" | "SKIP" }>;
}

export function buildTriagePrompt(
  changes: TriageFileInput[],
): ChatCompletionMessageParam[] {
  return [
    TRIAGE_SYSTEM,
    {
      role: "user",
      content: buildTriageUserContent(changes),
    },
  ];
}

export function parseTriageResponse(text: string): TriageResult | null {
  try {
    const cleaned = text
      .replace(/```json?\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.summary === "string" && Array.isArray(parsed.files)) {
      return {
        summary: parsed.summary,
        files: parsed.files
          .filter(
            (f: any) =>
              typeof f.path === "string" &&
              (f.verdict === "NEEDS_REVIEW" || f.verdict === "SKIP"),
          )
          .map((f: any) => ({
            path: f.path as string,
            verdict: f.verdict as "NEEDS_REVIEW" | "SKIP",
          })),
      };
    }
  } catch {
    // JSON parse failure — caller will fall back to single-pass.
  }
  return null;
}

export function buildFileReviewPrompt(params: {
  filePath: string;
  fileDiff: string;
  summary: string;
  otherChangedFiles: string[];
  allowTools?: boolean;
}): ChatCompletionMessageParam[] {
  const {
    filePath,
    fileDiff,
    summary,
    otherChangedFiles,
    allowTools = false,
  } = params;

  const toolNote = allowTools
    ? "Tools (get_file_at_ref, grep_repository) are available to verify suspicions or read the full file."
    : "Tools are unavailable; rely only on visible diff evidence.";

  return [
    FILE_REVIEW_SYSTEM,
    {
      role: "user",
      content: buildFileReviewUserContent({
        filePath,
        fileDiff,
        summary,
        otherChangedFiles,
        toolNote,
      }),
    },
  ];
}

export function buildConsolidatePrompt(params: {
  perFileFindings: Array<{ path: string; findings: string }>;
  summary: string;
  maxFindings: number;
}): ChatCompletionMessageParam[] | null {
  const { perFileFindings, summary, maxFindings } = params;

  const meaningful = perFileFindings.filter(
    (f) =>
      !f.findings.includes("No issues found.") &&
      !f.findings.includes("No confirmed bugs"),
  );

  if (meaningful.length === 0) return null;

  const findingsText = meaningful
    .map((f) => `### ${f.path}\n${f.findings}`)
    .join("\n\n");

  return [
    {
      role: "system" as const,
      content: buildConsolidateSystemLines(maxFindings).join("\n"),
    },
    {
      role: "user" as const,
      content: buildConsolidateUserContent({
        summary,
        findingsText,
        maxFindings,
      }),
    },
  ];
}

export function buildVerificationPrompt(params: {
  perFileFindings: Array<{ path: string; findings: string }>;
  summary: string;
  consolidatedFindings: string;
  maxFindings: number;
  refs: { base: string; head: string };
}): ChatCompletionMessageParam[] {
  const {
    perFileFindings,
    summary,
    consolidatedFindings,
    maxFindings,
    refs,
  } = params;
  const findingsText = perFileFindings
    .map((f) => `### ${f.path}\n${f.findings}`)
    .join("\n\n");

  return [
    {
      role: "system" as const,
      content: buildVerificationSystemLines(maxFindings).join("\n"),
    },
    {
      role: "user" as const,
      content: buildVerificationUserContent({
        summary,
        findingsText,
        consolidatedFindings,
        refs,
      }),
    },
  ];
}

export function extractCompletionText(
  completion: ChatCompletion | Error | undefined,
): string | null {
  if (completion instanceof Error || completion == null) return null;
  if (completion.choices.length === 0) return null;
  const firstChoice = completion.choices[0] as any;
  const message = firstChoice?.message as any;
  const raw = message?.content;
  if (typeof raw === "string") return raw.trim() || null;
  if (Array.isArray(raw)) {
    const joined = raw
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part != null && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
    return joined.trim() || null;
  }
  return null;
}

const ERROR_ANSWER =
  "AI review could not be completed. Please ask a human to review this code change.";

const DISCLAIMER = "This comment was generated by AI review bot.";

export const buildAnswer = (
  completion: ChatCompletion | Error | undefined,
): string => {
  if (completion instanceof Error) {
    const maybeCause = (completion as any).cause;
    const causeMessage =
      maybeCause instanceof Error ? maybeCause.message : undefined;
    return `${ERROR_ANSWER}\n\nError: ${completion.message}${causeMessage != null ? `\nCause: ${causeMessage}` : ""}`;
  }
  if (completion == null || completion.choices.length === 0) {
    return `${ERROR_ANSWER}\n\n${DISCLAIMER}`;
  }
  const firstChoice = completion.choices[0] as any;
  const message = firstChoice?.message as any;

  const contentFromMessage = (() => {
    const raw = message?.content;
    if (typeof raw === "string") return raw;
    // Some OpenAI-compatible providers return multipart message content.
    if (Array.isArray(raw)) {
      const joined = raw
        .map((part) => {
          if (typeof part === "string") return part;
          if (part != null && typeof part.text === "string") return part.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return joined;
    }
    return "";
  })();

  // Compatibility fallback fields used by some providers.
  const fallbackText =
    (typeof message?.refusal === "string" ? message.refusal : "") ||
    (typeof firstChoice?.text === "string" ? firstChoice.text : "") ||
    "";

  const content = (contentFromMessage || fallbackText).trim();
  if (content === "") {
    return `${ERROR_ANSWER}\n\nError: Model returned an empty response body. Try another model (for example, gpt-4o-mini) or a different provider endpoint.\n\n---\n_${DISCLAIMER}_`;
  }
  const normalizedFindings = normalizeReviewFindingsMarkdown(content);
  const safe = sanitizeGitLabMarkdown(normalizedFindings);
  return `${safe}\n\n---\n_${DISCLAIMER}_`;
};
