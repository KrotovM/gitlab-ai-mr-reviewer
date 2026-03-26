/** @format */

import {
  DEFAULT_PROMPT_LIMITS,
  type PromptLimits,
} from "../prompt/index.js";

export type Mode = "ci" | "worktree" | "last-commit";

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

export function parseDiffFileFlag(argv: string[]): string | undefined {
  const args = argv.slice(2);
  for (const current of args) {
    if (current === "--diff-file") {
      throw new Error("Use equals format: --diff-file=./path/to/file.diff");
    }
    if (!current.startsWith("--diff-file=")) continue;
    const value = current.slice("--diff-file=".length).trim();
    if (value === "") {
      throw new Error(
        "Missing value for --diff-file. Example: --diff-file=./changes.diff",
      );
    }
    return value;
  }
  return undefined;
}

export function hasModeFlag(argv: string[]): boolean {
  const args = new Set(argv.slice(2));
  return (
    args.has("--ci") || args.has("--worktree") || args.has("--last-commit")
  );
}

export function hasIgnoredExtension(
  filePath: string,
  ignoredExtensions: readonly string[],
): boolean {
  const lowerPath = filePath.toLowerCase();
  return ignoredExtensions.some((ext) => lowerPath.endsWith(ext));
}

export function buildGitExcludePathspecs(
  ignoredExtensions: readonly string[],
): string[] {
  return ignoredExtensions.map((ext) => `:(exclude,glob)**/*${ext}`);
}

export function parseMode(
  argv: string[],
  onHelp: () => void,
  mergeRequestIid: string | undefined,
): Mode {
  const args = new Set(argv.slice(2));
  if (args.has("--help") || args.has("-h")) {
    onHelp();
    process.exit(0);
  }
  const hasCi = args.has("--ci");
  const hasWorktree = args.has("--worktree");
  const hasLastCommit = args.has("--last-commit");

  const count = Number(hasCi) + Number(hasWorktree) + Number(hasLastCommit);
  if (count > 1) {
    throw new Error("Choose only one mode: --ci, --worktree, or --last-commit");
  }

  if (hasCi) return "ci";
  if (hasWorktree) return "worktree";
  if (hasLastCommit) return "last-commit";

  if (mergeRequestIid != null && mergeRequestIid.trim() !== "") return "ci";
  return "worktree";
}

