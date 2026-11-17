/** @format */

import { parseArgs } from "node:util";
import {
  DEFAULT_MAX_FINDINGS,
  DEFAULT_PROMPT_LIMITS,
  DEFAULT_REVIEW_CONCURRENCY,
  DEFAULT_TRIAGE_DIFF_CHARS,
} from "../prompt/index.js";

export function requireEnvs(names: string[]): Record<string, string> {
  const missing = names.filter((name) => envOrUndefined(name) == null);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  return Object.fromEntries(names.map((name) => [name, envOrUndefined(name)!]));
}

export function envOrUndefined(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

export function envOrDefault(name: string, defaultValue: string): string {
  return envOrUndefined(name) ?? defaultValue;
}

const CLI_OPTIONS = {
  help: { type: "boolean", short: "h" },
  debug: { type: "boolean" },
  "force-tools": { type: "boolean" },
  "include-artifacts": { type: "boolean" },
  "inline-comments": { type: "boolean" },
  "ignore-ext": { type: "string", multiple: true },
  "max-diffs": { type: "string" },
  "max-diff-chars": { type: "string" },
  "max-total-prompt-chars": { type: "string" },
  "triage-diff-chars": { type: "string" },
  "max-findings": { type: "string" },
  "max-review-concurrency": { type: "string" },
} as const;

/** Parses the command line. Unknown flags, positionals, a value on an on/off
 *  flag or a missing one on a valued flag don't fail the job (an upgrade must
 *  not break pipelines that pass an old flag): they are skipped and listed in
 *  `ignoredArgs` for a warning. Bad numbers still throw. */
export function parseCliArgs(args: string[]) {
  const { values, tokens } = parseArgs({
    args,
    options: CLI_OPTIONS,
    strict: false,
    allowPositionals: true,
    tokens: true,
  });

  const ignoredArgs: string[] = [];
  for (const token of tokens) {
    if (token.kind === "positional") {
      ignoredArgs.push(token.value);
    } else if (token.kind === "option") {
      const option = (CLI_OPTIONS as Record<string, { type: string }>)[token.name];
      const raw = token.inlineValue ? `${token.rawName}=${token.value}` : token.rawName;
      if (option == null) ignoredArgs.push(raw);
      else if (option.type === "boolean" && token.value !== undefined) ignoredArgs.push(raw);
      else if (option.type === "string" && token.value === undefined)
        ignoredArgs.push(`${token.rawName} (no value)`);
    }
  }

  const int = (name: string, defaultValue: number, minValue: number): number => {
    const raw = (values as Record<string, unknown>)[name];
    // Absent, or given without a value (already listed in ignoredArgs).
    if (typeof raw !== "string") return defaultValue;
    const text = String(raw).trim();
    const parsed = Number(text);
    if (text === "" || !Number.isInteger(parsed) || parsed < minValue) {
      throw new Error(
        `Invalid value for --${name}: "${text}". Expected integer >= ${minValue}.`,
      );
    }
    return parsed;
  };

  const ignoredExtensions = [
    ...new Set(
      [values["ignore-ext"] ?? []]
        .flat()
        .filter((value) => typeof value === "string")
        .flatMap((value) => value.split(","))
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean)
        .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`)),
    ),
  ];

  // AI_REVIEW_CONCURRENCY is the CI-variable form of the flag; the flag wins.
  const envConcurrency = Number(envOrUndefined("AI_REVIEW_CONCURRENCY"));

  return {
    help: values.help === true,
    debug: values.debug === true,
    forceTools: values["force-tools"] === true,
    includeArtifacts: values["include-artifacts"] === true,
    inlineComments: values["inline-comments"] === true,
    ignoredArgs,
    ignoredExtensions,
    promptLimits: {
      maxDiffs: int("max-diffs", DEFAULT_PROMPT_LIMITS.maxDiffs, 0),
      maxDiffChars: int("max-diff-chars", DEFAULT_PROMPT_LIMITS.maxDiffChars, 1),
      maxTotalPromptChars: int(
        "max-total-prompt-chars",
        DEFAULT_PROMPT_LIMITS.maxTotalPromptChars,
        1,
      ),
    },
    triageDiffChars: int("triage-diff-chars", DEFAULT_TRIAGE_DIFF_CHARS, 1),
    maxFindings: int("max-findings", DEFAULT_MAX_FINDINGS, 1),
    reviewConcurrency: int(
      "max-review-concurrency",
      Number.isFinite(envConcurrency) && envConcurrency >= 1
        ? Math.floor(envConcurrency)
        : DEFAULT_REVIEW_CONCURRENCY,
      1,
    ),
  };
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
