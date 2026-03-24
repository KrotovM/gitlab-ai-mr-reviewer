/** @format */

import type {
  ChatCompletionMessageParam,
  ChatCompletion,
} from "openai/resources/index.mjs";

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

function truncateWithMarker(
  value: string,
  maxChars: number,
  markerLabel: string,
): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n[... ${markerLabel} truncated, omitted ${omitted} chars ...]`;
}

const MESSAGES: ChatCompletionMessageParam[] = [
  {
    role: "system",
    content: [
      "You are a senior developer reviewing a git diff for correctness bugs, security issues, and performance regressions.",
      "Return at most 3 findings. Prefer no finding over a weakly supported one.",
      "",
      "WORKFLOW:",
      "1. Parse diff: identify all changed files and note any truncation markers (`[... diff #N truncated ...]` or `[... prompt payload truncated ...]`).",
      "2. Triage files: skim every `diff --git` header to build a map of the change. Prioritize business logic, auth, data access, and concurrency. Config, docs, and test-only files are lower priority unless they reveal issues in production code.",
      "3. Analyze: inspect `+` (added) and changed lines for wrong conditions, missing await, off-by-one, type mismatches, cross-file inconsistencies (renamed symbols with stale callers, updated interfaces with mismatched implementations), security gaps, and clear perf regressions.",
      "4. Tool-assisted verification (when tools are available): use get_file_at_ref to read full files (especially truncated ones) and grep_repository to confirm symbol usage or find callers. Do not guess when you can verify.",
      "5. Report only issues that are tool-confirmed or visually obvious from the diff.",
      "",
      "SCOPE:",
      "- Only flag issues introduced by this diff.",
      "- Focus on added/changed lines (`+`). Context lines (` `) and removed lines (`-`) are reference only.",
      "- Do not comment on untouched code unless required for a proven bug path.",
      "- If confidence is below medium, skip the finding.",
      "",
      "ACCURACY:",
      "- Only report issues directly supported by diff lines and/or visible imports/exports.",
      "- Do not invent behavior, fields, or code paths not visible in evidence.",
      "- Removed (`-`) lines are historical; do not claim current usage based solely on them.",
      "- If a concept is consistently renamed across files (e.g. `*Type` -> `*Percent`), do not flag missing old-name checks without explicit conflicting evidence in current (`+`) lines.",
      "- Do not report `missing dependency` when the dependency is removed from both usage and declarations in these diffs.",
      "- Truncated diffs may hide context. State uncertainty rather than assuming correctness or incorrectness. If tools are available, fetch the full file before reporting.",
      "",
      "PRIORITY: (1) correctness (typo, wrong var, missing await, off-by-one), (2) security (secrets, unsafe eval, unvalidated input), (3) perf regressions (N+1 queries, unbounded loops, missing pagination).",
      "",
      "SEVERITY:",
      "- [high] = deterministic runtime or security issue visible in the diff.",
      "- [medium] = well-supported but probabilistic issue.",
      "",
      "QUICK CHECKS (always perform):",
      "- Compare added function/method calls against imports/exports for spelling mismatches.",
      "- Flag identifier typos that would cause runtime errors (symbol differs by 1-2 chars from a nearby known symbol).",
      "- On multi-file diffs: verify cross-file consistency — if an interface/type/enum changes in one file, check that callers in other changed files still match.",
      "",
      "OUTPUT FORMAT:",
      "- Each finding: `- [high|medium] <title> [file: <path>, line ~<N>]: <one sentence, max ~25 words, with key evidence>`.",
      "- No headings, no praise, no code blocks.",
      '- If no confirmed issues: exactly "No confirmed bugs or high-value optimizations found."',
      "- GitLab-flavoured markdown.",
    ].join("\n"),
  },
];

export const AI_MODEL_TEMPERATURE = 0.2;

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

  const userContent = [
    `Review the following code changes (git diff format). ${stats}`,
    toolNote,
    "",
    "Changes:",
    changesText || "(no changes provided)",
    "",
    "Produce your review now. Follow the system instructions strictly.",
  ].join("\n");

  const boundedContent = truncateWithMarker(
    userContent,
    effectiveLimits.maxTotalPromptChars,
    "prompt payload",
  );
  return [...MESSAGES, { role: "user", content: boundedContent }];
};

const ERROR_ANSWER =
  "I'm sorry, I'm not feeling well today. Please ask a human to review this code change.";

const DISCLAIMER =
  "This comment was generated by an artificial intelligence duck.";

function sanitizeGitLabMarkdown(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  // If the model forgets to close a fenced code block, GitLab will render the rest (incl. disclaimer) inside it.
  const fenceCount = (normalized.match(/```/g) ?? []).length;
  const withClosedFence =
    fenceCount % 2 === 1 ? `${normalized}\n\`\`\`` : normalized;
  return withClosedFence;
}

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
  const safe = sanitizeGitLabMarkdown(content);
  return `${safe}\n\n---\n_${DISCLAIMER}_`;
};
