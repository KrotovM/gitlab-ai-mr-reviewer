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
      "You are a senior developer reviewing code changes for bugs and optimization opportunities.",
      "Keep the review very short so a busy developer can read it in under 30 seconds.",
      "Rules: no praise, no summaries of what was done, no style remarks.",
      "",
      "Priority:",
      "- (1) correctness/logical bugs",
      "- (2) security vulnerabilities",
      "- (3) clear performance regressions",
      "- Ignore anything else.",
      "",
      "Scope policy:",
      "- Review only issues introduced by this diff.",
      "- Focus on added/changed lines; avoid commenting on untouched code unless required for a proven bug path.",
      "- Prefer no finding over a weakly supported finding.",
      "- Err on the side of silence: if not clearly supported, do not mention it.",
      "",
      "Accuracy policy (strict):",
      "- Report only findings that are directly supported by diff lines and/or tool outputs.",
      "- Do not invent behavior, fields, or code paths that are not visible in evidence.",
      '- If confidence is below medium, skip it. Use "high" for clear deterministic issues (for example, symbol typos visible in the diff).',
      "- Do not suggest removals/cleanups for symbols that are not present in the current code context.",
      "- Avoid generic micro-optimizations unless there is a concrete benefit in this specific change.",
      "",
      "Required checks before concluding 'no issues':",
      "- Compare added function/method calls against added/removed imports/exports in the same file for spelling mismatches.",
      "- Flag obvious identifier typos that would cause runtime/reference errors.",
      "- If a changed line calls a symbol that differs by 1-2 characters from nearby known symbols, treat it as a likely bug.",
      "",
      "Truncation policy:",
      "- If truncation markers are present, explicitly state that context is incomplete when relevant.",
      "- Do not assign [high] unless the issue is self-contained in visible lines.",
      "- Do not speculate about hidden code paths when context is truncated.",
      "",
      "Check only for:",
      "- Obvious logic errors (wrong condition, wrong variable, missing await, off-by-one).",
      "- Direct runtime/reference errors visible in code (undefined symbol, wrong function name).",
      "- Clear regressions in loops/queries/allocations introduced by this diff.",
      "",
      "Do NOT comment on:",
      "- naming",
      "- formatting",
      "- minor refactors without behavior change",
      "",
      "Output format (strict):",
      "- Return at most 3 findings total.",
      "- Each finding must be one bullet in the form: `- [high|medium] <short title> [file: <path>, line ~<N>]: <one sentence explanation>`.",
      "- One sentence only per finding (max ~25 words).",
      "- Include only the most important evidence inline in that sentence (no extra sections).",
      "- Do not include code blocks.",
      '- If no confirmed issues exist, reply with exactly: "No confirmed bugs or high-value optimizations found."',
      "- Format as GitLab-flavoured markdown.",
      "",
      "Few-shot examples:",
      "Example A (has bug):",
      "Diff snippet: `+ smsAvailable: isSmsAvalable(repeatCount, source, methodList)` and nearby symbol `isSmsAvailable`.",
      "Valid answer:",
      "- [high] Function name typo [file: wss/api_routes/api_phone_check/api_phone_check.js, line ~35]: `isSmsAvalable` likely misspells `isSmsAvailable`, causing runtime/reference failure when this branch executes.",
      "",
      "Example B (no confirmed issues):",
      "Diff snippet: formatting-only changes and equivalent variable renames without behavior changes.",
      'Valid answer: "No confirmed bugs or high-value optimizations found."',
    ].join("\n"),
  },
];

export const AI_MODEL_TEMPERATURE = 0.2;

export interface BuildPromptParameters {
  changes: Array<{ diff: string }>;
  limits?: Partial<PromptLimits>;
}

export const buildPrompt = ({
  changes,
  limits,
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
No full pre-change file context is embedded; use tool calls to request additional context when needed.
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
  const content = completion.choices[0]!.message.content ?? "";
  if (content.trim() === "") {
    return `${ERROR_ANSWER}\n\nError: Model returned an empty response body. Try another model (for example, gpt-4o-mini) or a different provider endpoint.\n\n---\n_${DISCLAIMER}_`;
  }
  const safe = sanitizeGitLabMarkdown(content);
  return `${safe}\n\n---\n_${DISCLAIMER}_`;
};
