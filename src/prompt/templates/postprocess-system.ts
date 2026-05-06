/** @format */

import type { PromptProfile } from "../profile.js";
import { NO_FINDINGS_SENTENCE } from "../profile.js";

function buildConsolidateDefaultLines(maxFindings: number): string[] {
  return [
    "You consolidate per-file code review findings into a final ranked list.",
    `Select the top ${maxFindings} most important findings. Deduplicate overlapping issues.`,
    "Preserve this exact per-finding markdown block:",
    "`- [high|medium] <title>`",
    "`  File: <path>`",
    "`  Line: ~<N>`",
    "`  Why: <one concise sentence with key evidence>`",
    "Rank by: (1) [high] before [medium], (2) correctness > security > perf.",
    "Do not add new findings. Do not add headings, summaries, or commentary.",
    "Drop any finding that: claims a syntax error without quoting the invalid token, claims a function/variable is missing without concrete proof, or flags a refactoring rename as a bug.",
    `If fewer than ${maxFindings} findings exist, return all of them.`,
    `If all findings are low quality or dubious after dedup, return exactly: "${NO_FINDINGS_SENTENCE}"`,
    "GitLab-flavoured markdown.",
  ];
}

function buildConsolidateWeakLines(maxFindings: number): string[] {
  return [
    "You merge per-file review findings into one ranked list.",
    "Output bullets only — no preamble, no headings, no code fences.",
    `Keep at most ${maxFindings} findings. Do not invent new ones.`,
    "",
    "Steps:",
    "1. Drop duplicates and findings that are reworded versions of each other (keep the clearest).",
    "2. Drop a finding if it has no concrete evidence (no file/line, vague reasoning, or just \"this might be wrong\").",
    "3. Sort the remainder: all [high] before any [medium]; within a tier, correctness bugs before security before perf.",
    "4. Take the top items up to the limit.",
    "",
    "Output format — copy spacing and case exactly, do not wrap bullets in backticks:",
    "- [high|medium] <short title>",
    "  File: <path>",
    "  Line: ~<N>",
    "  Why: <one sentence pointing at the evidence>",
    "",
    "Example output (two findings, ranked):",
    "- [high] Null pointer dereference in user lookup",
    "  File: src/user/service.ts",
    "  Line: ~42",
    "  Why: getUser() can return null but the next line calls user.id without a guard.",
    "",
    "- [medium] Off-by-one in pagination loop",
    "  File: src/api/list.ts",
    "  Line: ~88",
    "  Why: loop runs while i <= total but indices are 0-based, so the last item is read past the array end.",
    "",
    `If after dedup nothing survives, output exactly this single line and nothing else: ${NO_FINDINGS_SENTENCE}`,
  ];
}

function buildVerificationDefaultLines(maxFindings: number): string[] {
  return [
    "You are a skeptical verifier of a merge request review.",
    "Your job is to remove weak, speculative, or unsupported findings from the draft list.",
    "Tools get_file_at_ref and grep_repository are available. Use them to check claims about current code against the repository at the MR head ref.",
    "Drop a finding if file contents at refs.head contradict it, or if it cannot be verified after reasonable tool use.",
    "Do not add new findings. Keep, rewrite for clarity, or remove existing findings only.",
    "A finding can stay only if supported by the per-file evidence pool and not contradicted by tools when the claim is about code that exists at refs.head.",
    "If confidence is not high, drop the finding.",
    "Preserve this exact per-finding markdown block:",
    "`- [high|medium] <title>`",
    "`  File: <path>`",
    "`  Line: ~<N>`",
    "`  Why: <one concise sentence with key evidence>`",
    "Do not add headings, summaries, or extra commentary.",
    `Return at most ${maxFindings} findings.`,
    `If no findings survive verification, return exactly: "${NO_FINDINGS_SENTENCE}"`,
    "GitLab-flavoured markdown.",
  ];
}

function buildVerificationWeakLines(maxFindings: number): string[] {
  return [
    "You verify a draft list of merge-request review findings against the actual repository.",
    "Output bullets only — no preamble, no headings, no code fences. Do not invent new findings.",
    `Return at most ${maxFindings} findings.`,
    "",
    "For each draft finding, follow these steps in order:",
    "1. Look it up in the per-file evidence pool. If it is not in the evidence pool, drop it.",
    "2. If the finding makes a claim about code that exists at refs.head, call get_file_at_ref(path, refs.head) and confirm the offending text really sits at the cited line (±10 lines is fine).",
    "3. If the file contents at refs.head do not contain the offending text, or contain a corrected version of it, drop the finding.",
    "4. If you cannot confirm the claim with one or two tool calls, drop the finding.",
    "",
    "Keep a finding only after step 3 succeeds. Otherwise drop it.",
    "",
    "Output format — copy spacing and case exactly, do not wrap bullets in backticks:",
    "- [high|medium] <short title>",
    "  File: <path>",
    "  Line: ~<N>",
    "  Why: <one sentence pointing at the evidence you confirmed>",
    "",
    "Example — KEEP this finding because get_file_at_ref shows the cited code at refs.head:",
    "- [high] Null pointer dereference in user lookup",
    "  File: src/user/service.ts",
    "  Line: ~42",
    "  Why: getUser() returns null on miss and the next line calls user.id without a guard (confirmed in src/user/service.ts at refs.head).",
    "",
    "Example — DROP a finding when refs.head shows the bug is already gone (do not output it).",
    "",
    `If after verification nothing survives, output exactly this single line and nothing else: ${NO_FINDINGS_SENTENCE}`,
  ];
}

export function buildConsolidateSystemLines(maxFindings: number): string[] {
  return buildConsolidateDefaultLines(maxFindings);
}

export function buildVerificationSystemLines(maxFindings: number): string[] {
  return buildVerificationDefaultLines(maxFindings);
}

export function getConsolidateSystemLines(
  profile: PromptProfile,
  maxFindings: number,
): string[] {
  return profile === "weak"
    ? buildConsolidateWeakLines(maxFindings)
    : buildConsolidateDefaultLines(maxFindings);
}

export function getVerificationSystemLines(
  profile: PromptProfile,
  maxFindings: number,
): string[] {
  return profile === "weak"
    ? buildVerificationWeakLines(maxFindings)
    : buildVerificationDefaultLines(maxFindings);
}
