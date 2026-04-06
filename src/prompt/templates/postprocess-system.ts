/** @format */

export function buildConsolidateSystemLines(maxFindings: number): string[] {
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
    'If all findings are low quality or dubious after dedup, return exactly: "No confirmed bugs or high-value optimizations found."',
    "GitLab-flavoured markdown.",
  ];
}

export function buildVerificationSystemLines(maxFindings: number): string[] {
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
    'If no findings survive verification, return exactly: "No confirmed bugs or high-value optimizations found."',
    "GitLab-flavoured markdown.",
  ];
}
