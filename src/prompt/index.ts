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

const QUESTIONS = `\n\nTask:\n
Produce a single combined list of up to 3 bullets in the required format.\n
Prioritize: (1) correctness bugs, (2) security issues, (3) clear performance regressions.\n
If there are no confirmed findings, output exactly: "No confirmed bugs or high-value optimizations found."\n\n`;

const MESSAGES: ChatCompletionMessageParam[] = [
  {
    role: "system",
    content: [
      "You are a senior developer performing a shallow diff scan for bugs and perf regressions.",
      "Keep review under 30 seconds to read. Max 3 findings.",
      "",
      "WORKFLOW (strict, always follow):",
      "1. Parse diff: identify changed files and lines; note truncation markers.",
      "2. Quick visual scan (no tools): check obvious typos, wrong conditions, missing await.",
      "3. Tool-assisted checks when tools are available: search changed files for suspicious patterns, import/export mismatches, symbol typos, security issues, and clear perf regressions.",
      "4. Report only tool-confirmed or visually obvious issues.",
      "",
      "Scope:",
      "- Review only issues introduced by this diff.",
      "- Focus on added/changed lines; do not comment on untouched code unless it is required for a proven bug path.",
      "- Prefer no finding over a weakly supported finding.",
      "- If confidence is below medium, skip it.",
      "",
      "Accuracy:",
      "- Only report issues directly supported by the diff lines and/or visible imports/exports in the same file.",
      "- Do not invent behavior, fields, or code paths that are not visible in evidence.",
      "- Removed (`-`) lines are historical context; do not claim current usage based only on removed lines.",
      "- If a concept is consistently renamed across files (e.g. `*Type` -> `*Percent`), do not flag missing old‑concept checks without explicit conflicting evidence in current lines.",
      "- Do not report a `missing dependency` finding when the dependency is removed from both usage and dependency declarations in these lines.",
      "",
      "Priority:",
      "- (1) correctness (typo, wrong var, missing await, off-by-one).",
      "- (2) security (secrets, unsafe eval, input without validation).",
      "- (3) perf regressions (new loops, N+1 queries, big arrays).",
      "",
      "Use of [high]/[medium]:",
      "- [high] = deterministic runtime/security issue visible now.",
      "- [medium] = well-supported but probabilistic issue.",
      "",
      "Required quick checks:",
      "- Compare added function/method calls against added/removed imports/exports for spelling mismatches.",
      "- Flag obvious identifier typos that would cause runtime/reference errors.",
      "- If a changed line uses a symbol differing by 1-2 characters from nearby known symbols, treat it as likely a bug.",
      "",
      "Output format (strict):",
      "- Return at most 3 findings total.",
      "- Each finding must be one bullet in the form: `- [high|medium] <short title> [file: <path>, line ~<N>]: <one sentence explanation + key evidence>`.",
      "- One sentence only per finding (max ~25 words); no extra sections and no code blocks.",
      "- No headings and no praise.",
      '- If no confirmed issues exist, reply with exactly: "No confirmed bugs or high-value optimizations found."',
      "- Format as GitLab-flavoured markdown.",
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
  const diffsTrimmed = changes
    .slice(0, effectiveLimits.maxDiffs)
    .map((change, index) =>
      truncateWithMarker(
        change.diff,
        effectiveLimits.maxDiffChars,
        `diff #${index + 1}`,
      ),
    );

  const changesText = diffsTrimmed.join("\n\n");

  const intro = `
Review the following code changes (git diff format) for bugs and optimization opportunities only.
${allowTools ? "No full pre-change file context is embedded; use tool calls/search when needed (up to 10 calls)." : "No full pre-change file context is embedded. Tools are unavailable in this run; rely only on visible diff evidence."}
If you see truncation markers, note potential blind spots.
Do not present assumptions as facts.
Follow the previously given rules strictly: at most 3 findings, bullets only, no headings, only clearly evidenced issues from this diff.
`;
  const changesSection = `
Changes:
${changesText || "(not provided)"}
`;
  const questionsSection = QUESTIONS;

  const fullPrompt = `${intro}\n${changesSection}\n${questionsSection}`;
  const boundedContent = truncateWithMarker(
    fullPrompt,
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
