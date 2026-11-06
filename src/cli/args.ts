/** @format */

import {
  DEFAULT_PROMPT_LIMITS,
  DEFAULT_TRIAGE_DIFF_CHARS,
  parsePromptProfile as parsePromptProfileValue,
  type PromptLimits,
  type PromptProfile,
} from "../prompt/index.js";

export function requireEnvs(names: string[]): Record<string, string> {
  const missing = names.filter((name) => {
    const value = process.env[name];
    return value == null || value.trim() === "";
  });

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }

  const result: Record<string, string> = {};
  for (const name of names) {
    result[name] = process.env[name]!.trim();
  }
  return result;
}

export function envOrDefault(name: string, defaultValue: string): string {
  const value = process.env[name];
  if (value == null) return defaultValue;
  const trimmed = value.trim();
  return trimmed === "" ? defaultValue : trimmed;
}

export function envOrUndefined(name: string): string | undefined {
  const value = process.env[name];
  if (value == null) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function hasDebugFlag(argv: string[]): boolean {
  const args = new Set(argv.slice(2));
  return args.has("--debug");
}

export function hasForceToolsFlag(argv: string[]): boolean {
  const args = new Set(argv.slice(2));
  return args.has("--force-tools");
}

export function hasIncludeArtifactsFlag(argv: string[]): boolean {
  const args = new Set(argv.slice(2));
  return args.has("--include-artifacts");
}

export function hasInlineCommentsFlag(argv: string[]): boolean {
  const args = new Set(argv.slice(2));
  return args.has("--inline-comments");
}

export function parseIgnoreExtensions(argv: string[]): string[] {
  const parsed: string[] = [];
  const args = argv.slice(2);

  for (const current of args) {
    if (current === "--ignore-ext") {
      throw new Error("Use comma-separated format: --ignore-ext=md,lock");
    }
    if (!current.startsWith("--ignore-ext=")) continue;
    const value = current.slice("--ignore-ext=".length);
    if (value.trim() === "") continue;

    const pieces = value
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);

    for (const piece of pieces) {
      parsed.push(piece.startsWith(".") ? piece : `.${piece}`);
    }
  }

  return Array.from(new Set(parsed));
}

export function parseNumberFlag(
  argv: string[],
  flagName: string,
  defaultValue: number,
  minValue: number,
): number {
  const prefix = `--${flagName}=`;
  let value = defaultValue;
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith(prefix)) continue;
    const raw = arg.slice(prefix.length).trim();
    if (raw === "") {
      throw new Error(`Missing value for --${flagName}. Expected integer.`);
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < minValue) {
      throw new Error(
        `Invalid value for --${flagName}: "${raw}". Expected integer >= ${minValue}.`,
      );
    }
    value = parsed;
  }
  return value;
}

export function parsePromptLimits(argv: string[]): PromptLimits {
  return {
    maxDiffs: parseNumberFlag(
      argv,
      "max-diffs",
      DEFAULT_PROMPT_LIMITS.maxDiffs,
      0,
    ),
    maxDiffChars: parseNumberFlag(
      argv,
      "max-diff-chars",
      DEFAULT_PROMPT_LIMITS.maxDiffChars,
      1,
    ),
    maxTotalPromptChars: parseNumberFlag(
      argv,
      "max-total-prompt-chars",
      DEFAULT_PROMPT_LIMITS.maxTotalPromptChars,
      1,
    ),
  };
}

export function parseTriageDiffChars(argv: string[]): number {
  return parseNumberFlag(
    argv,
    "triage-diff-chars",
    DEFAULT_TRIAGE_DIFF_CHARS,
    1,
  );
}

/** Generated files that are never worth a model call: their diffs are long
 *  enough to crowd real code out of the triage prompt. */
const GENERATED_FILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
]);
const GENERATED_SUFFIXES = [".min.js", ".min.css", ".js.map", ".css.map", ".snap"];

export function isGeneratedFile(filePath: string): boolean {
  const name = filePath.slice(filePath.lastIndexOf("/") + 1);
  const lower = name.toLowerCase();
  return (
    GENERATED_FILE_NAMES.has(name) ||
    GENERATED_SUFFIXES.some((suffix) => lower.endsWith(suffix))
  );
}

export function hasIgnoredExtension(
  filePath: string,
  ignoredExtensions: readonly string[],
): boolean {
  const lowerPath = filePath.toLowerCase();
  return ignoredExtensions.some((ext) => lowerPath.endsWith(ext));
}

/** Reads AI_PROMPT_PROFILE (values: "default" | "weak"). Anything else falls
 *  back to the default profile. */
export function readPromptProfileFromEnv(): PromptProfile {
  return parsePromptProfileValue(process.env["AI_PROMPT_PROFILE"]);
}
