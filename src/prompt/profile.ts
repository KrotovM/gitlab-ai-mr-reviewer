/** @format */

export type PromptProfile = "default" | "weak";

export const DEFAULT_PROMPT_PROFILE: PromptProfile = "default";

/** Canonical phrase the model is asked to emit when no findings survive
 *  review/verification. Parsers are tolerant of common synonyms. */
export const NO_FINDINGS_SENTENCE =
  "No confirmed bugs or high-value optimizations found.";

const NO_FINDINGS_PATTERNS: RegExp[] = [
  /\bno\s+(?:confirmed\s+)?(?:bugs?|issues?|findings?|defects?|problems?)\b[^.\n]{0,80}\b(?:found|detected|identified|reported)\b/i,
  /\bnothing\s+to\s+report\b/i,
  /\bno\s+high[- ]value\s+optimizations?\s+found\b/i,
  /\ball\s+clear\b/i,
];

const SEVERITY_HEADER_PATTERN = /\[(?:high|medium)\]/i;

/** Returns true when the model emitted a "no findings" sentinel (or a common
 *  synonym) and there are no severity bullets in the body. Severity bullets
 *  always win — a real finding is never treated as empty. */
export function isEmptyReviewBody(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  if (SEVERITY_HEADER_PATTERN.test(trimmed)) return false;
  return NO_FINDINGS_PATTERNS.some((re) => re.test(trimmed));
}

export function parsePromptProfile(value: string | undefined): PromptProfile {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "weak") return "weak";
  return "default";
}
