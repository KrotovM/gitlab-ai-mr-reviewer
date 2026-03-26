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
      "2. Triage files: skim every `diff --git` header to classify each file — files that modify logic or functionality need analysis; files with only cosmetic changes (formatting, renaming for clarity, comments) can be skipped. Prioritize files that alter exported function/method signatures, shared data structures, auth, data access, or concurrency.",
      "3. Analyze: for each triaged file, inspect `+` (added) and changed lines for wrong conditions, missing await, off-by-one, type mismatches, cross-file inconsistencies (renamed symbols with stale callers, changed exported signatures with mismatched callers, updated interfaces with mismatched implementations), security gaps, and clear perf regressions.",
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
      "- Pay special attention to alterations in signatures of exported functions, shared types/interfaces, and global data structures — these have the highest cross-file breakage potential.",
      "- On multi-file diffs: verify cross-file consistency — if a signature, interface, type, or enum changes in one file, check that callers/implementers in other changed files still match.",
      "",
      "OUTPUT FORMAT:",
      "- Each finding must use this 4-line markdown block:",
      "- `- [high|medium] <title>`",
      "- `  File: <path>`",
      "- `  Line: ~<N>`",
      "- `  Why: <one concise sentence with key evidence>`",
      "- No headings, no praise, no code blocks. Do not summarize or explain what changed — only report confirmed issues.",
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

// ---------------------------------------------------------------------------
// Multi-pass pipeline prompts
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_FINDINGS = 5;
export const DEFAULT_REVIEW_CONCURRENCY = 5;
export const DIFF_SNIPPET_CHARS = 300;

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

const TRIAGE_SYSTEM: ChatCompletionMessageParam = {
  role: "system",
  content: [
    "You are a senior developer triaging files in a merge request.",
    "For each file, decide whether it NEEDS_REVIEW (modifies logic, functionality, security, or performance) or can be SKIPPED (cosmetic-only: formatting, comments, renaming for clarity, docs, auto-generated files).",
    "",
    "Also produce a concise summary (2-4 sentences) of the entire merge request: what it does and which areas it touches.",
    "",
    "Respond with a JSON object (no markdown fences) in this exact schema:",
    '{ "summary": "<MR summary>", "files": [{ "path": "<file path>", "verdict": "NEEDS_REVIEW" | "SKIP" }] }',
    "",
    "Rules:",
    "- When in doubt, verdict is NEEDS_REVIEW.",
    "- Deleted files are SKIP unless the deletion could break dependents.",
    "- New files containing logic are NEEDS_REVIEW.",
    "- Test-only files are SKIP unless they cover security-critical or complex logic.",
    "- Config/CI/docs files are SKIP unless they modify build targets, env vars, or secrets.",
  ].join("\n"),
};

export function buildTriagePrompt(
  changes: TriageFileInput[],
): ChatCompletionMessageParam[] {
  const fileEntries = changes.map((c) => {
    const flags: string[] = [];
    if (c.new_file) flags.push("new");
    if (c.deleted_file) flags.push("deleted");
    if (c.renamed_file) flags.push("renamed");
    const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    const snippet = c.diff.slice(0, DIFF_SNIPPET_CHARS);
    const truncNote = c.diff.length > DIFF_SNIPPET_CHARS ? "..." : "";
    return `### ${c.path}${flagStr}\n\`\`\`\n${snippet}${truncNote}\n\`\`\``;
  });

  return [
    TRIAGE_SYSTEM,
    {
      role: "user",
      content: `Triage these ${changes.length} file(s):\n\n${fileEntries.join("\n\n")}`,
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

const FILE_REVIEW_SYSTEM: ChatCompletionMessageParam = {
  role: "system",
  content: [
    "You are a senior developer reviewing a single file's git diff for correctness bugs, security issues, and performance regressions.",
    "Return at most 2 findings for this file. Prefer no finding over a weakly supported one.",
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
    "- If a concept is consistently renamed (e.g. `*Type` -> `*Percent`), do not flag missing old-name checks without conflicting evidence in current (`+`) lines.",
    "- Do not report `missing dependency` when the dependency is removed from both usage and declarations.",
    "",
    "PRIORITY: (1) correctness (typo, wrong var, missing await, off-by-one), (2) security (secrets, unsafe eval, unvalidated input), (3) perf regressions (N+1 queries, unbounded loops, missing pagination).",
    "",
    "SEVERITY:",
    "- [high] = deterministic runtime or security issue visible in the diff.",
    "- [medium] = well-supported but probabilistic issue.",
    "",
    "QUICK CHECKS:",
    "- Compare added function/method calls against imports/exports for spelling mismatches.",
    "- Flag identifier typos that would cause runtime errors.",
    "- Check changes to exported function signatures, shared types, and global data structures for cross-file breakage.",
    "",
    "OUTPUT FORMAT:",
    "- Each finding must use this 4-line markdown block:",
    "- `- [high|medium] <title>`",
    "- `  File: <path>`",
    "- `  Line: ~<N>`",
    "- `  Why: <one concise sentence with key evidence>`",
    "- No headings, no praise, no code blocks. Do not summarize what changed.",
    '- If no confirmed issues: exactly "No issues found."',
    "- GitLab-flavoured markdown.",
  ].join("\n"),
};

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

  const otherFilesNote =
    otherChangedFiles.length > 0
      ? `\nOther files changed in this MR: ${otherChangedFiles.join(", ")}`
      : "";

  return [
    FILE_REVIEW_SYSTEM,
    {
      role: "user",
      content: [
        `MR Summary: ${summary}`,
        otherFilesNote,
        "",
        toolNote,
        "",
        `File: ${filePath}`,
        "Diff:",
        fileDiff,
        "",
        "Review this file now.",
      ].join("\n"),
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
      content: [
        "You consolidate per-file code review findings into a final ranked list.",
        `Select the top ${maxFindings} most important findings. Deduplicate overlapping issues.`,
        "Preserve this exact per-finding markdown block:",
        "`- [high|medium] <title>`",
        "`  File: <path>`",
        "`  Line: ~<N>`",
        "`  Why: <one concise sentence with key evidence>`",
        "Rank by: (1) [high] before [medium], (2) correctness > security > perf.",
        "Do not add new findings. Do not add headings, summaries, or commentary.",
        `If fewer than ${maxFindings} findings exist, return all of them.`,
        'If all findings are low quality after dedup, return exactly: "No confirmed bugs or high-value optimizations found."',
        "GitLab-flavoured markdown.",
      ].join("\n"),
    },
    {
      role: "user" as const,
      content: [
        `MR Summary: ${summary}`,
        "",
        "Per-file findings:",
        findingsText,
        "",
        `Return the top ${maxFindings} findings in the required bullet format.`,
      ].join("\n"),
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
