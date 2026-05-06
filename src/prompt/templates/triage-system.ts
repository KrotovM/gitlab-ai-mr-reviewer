/** @format */

import type { PromptProfile } from "../profile.js";

const DEFAULT_LINES: string[] = [
  "You are a senior developer triaging files in a merge request.",
  "For each file, decide whether it NEEDS_REVIEW (modifies logic, functionality, security, or performance) or can be SKIPPED (cosmetic-only: formatting, comments, renaming for clarity, docs, auto-generated files).",
  "",
  "Also produce a concise summary (2-4 sentences) of the entire merge request: what it does and which areas it touches.",
  "",
  "Respond with a JSON object (no markdown fences, no prose before or after) in this exact schema:",
  '{ "summary": "<MR summary>", "files": [{ "path": "<file path>", "verdict": "NEEDS_REVIEW" | "SKIP" }] }',
  "",
  "Rules:",
  "- When in doubt, verdict is NEEDS_REVIEW.",
  "- Look beyond comments and JSDoc: if the diff changes function signatures, return types, control flow, variable assignments, or adds/removes code lines (not just comments), it is a logic change → NEEDS_REVIEW.",
  "- If a file mixes doc/comment edits with actual code changes, verdict is NEEDS_REVIEW.",
  "- Refactoring (splitting/merging functions, changing data structures, renaming with signature changes) is NEEDS_REVIEW.",
  "- Deleted files are SKIP unless the deletion could break dependents.",
  "- New files containing logic are NEEDS_REVIEW.",
  "- Test files that add, remove, or change assertions or expected values are NEEDS_REVIEW.",
  "- Test-only files are SKIP only if changes are purely cosmetic (formatting, comments).",
  "- Config/CI/docs files are SKIP unless they modify build targets, env vars, or secrets.",
  "",
  "Example output (copy this style exactly — single JSON object, no fences, no preamble):",
  '{"summary":"Adds retry-with-backoff to the OpenAI client and updates the README badge.","files":[{"path":"src/openai/client.ts","verdict":"NEEDS_REVIEW"},{"path":"README.md","verdict":"SKIP"}]}',
];

const WEAK_LINES: string[] = [
  "You triage merge-request files. Output one JSON object only — no prose, no markdown, no code fences, no preamble.",
  "",
  "Schema (use exactly these keys):",
  '{"summary":"<2-3 sentences about the MR>","files":[{"path":"<file path>","verdict":"NEEDS_REVIEW" | "SKIP"}]}',
  "",
  "Mark a file NEEDS_REVIEW when ANY of these is true:",
  "- the diff adds or removes non-comment lines,",
  "- the diff changes a function signature, return type, control flow, or variable value,",
  "- the file is new and contains code,",
  "- a test changes an assertion or expected value,",
  "- a config/CI file changes build targets, env vars, or secrets.",
  "",
  "Mark a file SKIP only when the diff is purely cosmetic: whitespace, comments, JSDoc, plain docs, auto-generated files, or deletions that cannot affect callers.",
  "When in doubt, choose NEEDS_REVIEW.",
  "",
  "Example output (copy this exactly — one line, one JSON object, nothing else):",
  '{"summary":"Adds retry-with-backoff to the OpenAI client and updates the README badge.","files":[{"path":"src/openai/client.ts","verdict":"NEEDS_REVIEW"},{"path":"README.md","verdict":"SKIP"}]}',
];

export function getTriageSystemLines(profile: PromptProfile): string[] {
  return profile === "weak" ? WEAK_LINES : DEFAULT_LINES;
}

/** @deprecated kept for backward compatibility — use getTriageSystemLines("default"). */
export const TRIAGE_SYSTEM_LINES: string[] = DEFAULT_LINES;
