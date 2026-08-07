/** @format */

import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/index.mjs";
import {
  buildFileReviewSystemMessage,
  buildMainSystemMessages,
  buildTriageSystemMessage,
} from "./messages.js";
import {
  extractFirstJsonObject,
  normalizeReviewFindingsMarkdown,
  sanitizeGitLabMarkdown,
  truncateWithMarker,
} from "./utils.js";
import {
  getConsolidateSystemLines,
  getVerificationSystemLines,
} from "./templates/postprocess-system.js";
import {
  buildConsolidateUserContent,
  buildFileReviewUserContent,
  buildMainReviewUserContent,
  buildTriageUserContent,
  buildVerificationUserContent,
} from "./templates/user-prompts.js";
import type { PromptProfile } from "./profile.js";
import { DEFAULT_PROMPT_PROFILE, isEmptyReviewBody } from "./profile.js";

export type { PromptProfile } from "./profile.js";
export {
  DEFAULT_PROMPT_PROFILE,
  NO_FINDINGS_SENTENCE,
  isEmptyReviewBody,
  parsePromptProfile,
} from "./profile.js";

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

/** Max chars of each file diff sent to the triage pass (Pass 1). */
export const DEFAULT_TRIAGE_DIFF_CHARS = 2000;

export const AI_MODEL_TEMPERATURE = 0.2;
export const AI_MAX_OUTPUT_TOKENS = 600;

export interface BuildPromptParameters {
  changes: Array<{ diff: string }>;
  limits?: Partial<PromptLimits>;
  allowTools?: boolean;
  profile?: PromptProfile;
}

export const buildPrompt = ({
  changes,
  limits,
  allowTools = false,
  profile = DEFAULT_PROMPT_PROFILE,
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
  return [
    ...buildMainSystemMessages(profile),
    { role: "user", content: boundedContent },
  ];
};

// ---------------------------------------------------------------------------
// Multi-pass pipeline prompts
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_FINDINGS = 5;
// ponytail: 2 keeps self-hosted gateways under their proxy timeout; raise via
// --max-review-concurrency on backends that batch well.
export const DEFAULT_REVIEW_CONCURRENCY = 2;
export interface TriageFileInput {
  path: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff: string;
}

export interface TriageFileVerdict {
  path: string;
  verdict: "NEEDS_REVIEW" | "SKIP";
  reason?: string;
}

export interface TriageResult {
  summary: string;
  files: TriageFileVerdict[];
}

export type TriageParseFailureReason =
  | "empty_response"
  | "invalid_json"
  | "invalid_schema";

export function buildTriagePrompt(
  changes: TriageFileInput[],
  profile: PromptProfile = DEFAULT_PROMPT_PROFILE,
  triageDiffChars: number = DEFAULT_TRIAGE_DIFF_CHARS,
): ChatCompletionMessageParam[] {
  return [
    buildTriageSystemMessage(profile),
    {
      role: "user",
      content: buildTriageUserContent(changes, triageDiffChars),
    },
  ];
}

export function parseTriageResponse(text: string): TriageResult | null {
  return parseTriageResponseDetailed(text).result;
}

export function parseTriageResponseDetailed(text: string): {
  result: TriageResult | null;
  reason: TriageParseFailureReason | null;
  parseError: string | null;
} {
  const cleaned = text
    .replace(/```json?\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();
  if (cleaned === "") {
    return { result: null, reason: "empty_response", parseError: null };
  }

  const tryParse = (
    src: string,
  ): { parsed: unknown; error: string | null } => {
    try {
      return { parsed: JSON.parse(src), error: null };
    } catch (e: unknown) {
      const msg =
        e instanceof Error
          ? e.message
          : typeof e === "string"
            ? e
            : JSON.stringify(e);
      return { parsed: null, error: msg };
    }
  };

  let attempt = tryParse(cleaned);

  // Some providers ignore JSON-mode and prefix prose like "Here is the JSON: {...}".
  // Recover by extracting the first balanced {...} block and parsing that.
  if (attempt.parsed == null) {
    const extracted = extractFirstJsonObject(cleaned);
    if (extracted != null && extracted !== cleaned) {
      attempt = tryParse(extracted);
    }
  }

  if (attempt.parsed == null || typeof attempt.parsed !== "object") {
    return {
      result: null,
      reason: "invalid_json",
      parseError: attempt.error,
    };
  }

  const parsed = attempt.parsed as { summary?: unknown; files?: unknown };
  if (typeof parsed.summary === "string" && Array.isArray(parsed.files)) {
    return {
      result: {
        summary: parsed.summary,
        files: parsed.files
          .filter(
            (
              f: unknown,
            ): f is { path: string; verdict: string; reason?: unknown } =>
              typeof f === "object" &&
              f != null &&
              typeof (f as { path?: unknown }).path === "string" &&
              ((f as { verdict?: unknown }).verdict === "NEEDS_REVIEW" ||
                (f as { verdict?: unknown }).verdict === "SKIP"),
          )
          .map((f) => ({
            path: f.path,
            verdict: f.verdict as "NEEDS_REVIEW" | "SKIP",
            ...(typeof f.reason === "string" && f.reason.trim() !== ""
              ? { reason: f.reason.trim() }
              : {}),
          })),
      },
      reason: null,
      parseError: null,
    };
  }
  return { result: null, reason: "invalid_schema", parseError: null };
}

export function buildFileReviewPrompt(params: {
  filePath: string;
  fileDiff: string;
  summary: string;
  otherChangedFiles: string[];
  allowTools?: boolean;
  profile?: PromptProfile;
}): ChatCompletionMessageParam[] {
  const {
    filePath,
    fileDiff,
    summary,
    otherChangedFiles,
    allowTools = false,
    profile = DEFAULT_PROMPT_PROFILE,
  } = params;

  const toolNote = allowTools
    ? "Tools (get_file_at_ref, grep_repository) are available to verify suspicions or read the full file."
    : "Tools are unavailable; rely only on visible diff evidence.";

  return [
    buildFileReviewSystemMessage(profile),
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
  profile?: PromptProfile;
}): ChatCompletionMessageParam[] | null {
  const {
    perFileFindings,
    summary,
    maxFindings,
    profile = DEFAULT_PROMPT_PROFILE,
  } = params;

  const meaningful = perFileFindings.filter((f) => !isEmptyReviewBody(f.findings));

  if (meaningful.length === 0) return null;

  const findingsText = meaningful
    .map((f) => `### ${f.path}\n${f.findings}`)
    .join("\n\n");

  return [
    {
      role: "system" as const,
      content: getConsolidateSystemLines(profile, maxFindings).join("\n"),
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
  profile?: PromptProfile;
}): ChatCompletionMessageParam[] {
  const {
    perFileFindings,
    summary,
    consolidatedFindings,
    maxFindings,
    refs,
    profile = DEFAULT_PROMPT_PROFILE,
  } = params;
  const findingsText = perFileFindings
    .map((f) => `### ${f.path}\n${f.findings}`)
    .join("\n\n");

  return [
    {
      role: "system" as const,
      content: getVerificationSystemLines(profile, maxFindings).join("\n"),
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
