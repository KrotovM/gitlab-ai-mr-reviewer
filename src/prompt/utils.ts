/** @format */

/** Extract the first balanced JSON object substring from arbitrary text.
 *  Useful when an LLM wraps JSON in prose ("Here is the result: { ... }").
 *  Returns null if no balanced object is found. */
export function extractFirstJsonObject(input: string): string | null {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        return input.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function truncateWithMarker(
  value: string,
  maxChars: number,
  markerLabel: string,
): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n\n[... ${markerLabel} truncated, omitted ${omitted} chars ...]`;
}

export function sanitizeGitLabMarkdown(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  // If the model forgets to close a fenced code block, GitLab will render the rest (incl. disclaimer) inside it.
  const fenceCount = (normalized.match(/```/g) ?? []).length;
  const withClosedFence =
    fenceCount % 2 === 1 ? `${normalized}\n\`\`\`` : normalized;
  return withClosedFence;
}

const NO_ISSUES_SENTENCE =
  "No confirmed bugs or high-value optimizations found.";

export type ReviewFinding = {
  severity: "high" | "medium";
  title: string;
  file: string;
  line: string;
  why: string;
};

/** Parse labeled (`- [high] … File:/Line:/Why:`) or pretty (`**🔴 High — …**`)
 *  finding blocks out of arbitrary model output. Returns [] when none match. */
export function parseReviewFindings(input: string): ReviewFinding[] {
  const normalized = input.replace(/\r\n/g, "\n").trim();

  // Some providers collapse each finding into one long line.
  // Expand inline markers so parser can recover structured blocks.
  const expanded = normalized
    .replace(/\s+(File:\s*)/gi, "\n$1")
    .replace(/\s+(Line:\s*)/gi, "\n$1")
    .replace(/\s+(Why:\s*)/gi, "\n$1")
    .replace(/(Why:\s*[^\n]+?)\s+([-*•]\s*\[(?:high|medium)\])/gi, "$1\n$2")
    .trim();

  const lines = expanded.split("\n");
  const findings: ReviewFinding[] = [];

  const headerRe = /^\s*(?:[-*•]\s*)?\[(high|medium)\]\s+(.+?)\s*$/i;
  // Already-rendered block (see renderer below) — parsing it too keeps this
  // function idempotent when a model echoes pretty findings back verbatim.
  const prettyHeaderRe =
    /^\s*(?:[-*•]\s*)?\*\*(?:🔴|🟠)?\s*(high|medium)\s*[—–-]\s*(.+?)\*\*\s*$/i;
  const matchHeader = (line: string) =>
    line.match(headerRe) ?? line.match(prettyHeaderRe);
  const fileRe = /^\s*[-*]?\s*File:\s*(.+?)\s*$/i;
  const lineRe = /^\s*[-*]?\s*Line:\s*(.+?)\s*$/i;
  const whyRe = /^\s*[-*]?\s*Why:\s*(.+?)\s*$/i;
  const prettyFileLineRe = /^\s*`([^`\n]+?):(~?[^`\n]*)`\s*$/;

  for (let i = 0; i < lines.length; i += 1) {
    const headerMatch = matchHeader(lines[i]!);
    if (headerMatch == null) continue;

    const severity = headerMatch[1]!.toLowerCase() as "high" | "medium";
    const title = headerMatch[2]!.trim();
    let file: string | null = null;
    let line: string | null = null;
    let why: string | null = null;

    let j = i + 1;
    while (j < lines.length) {
      const nextHeader = matchHeader(lines[j]!);
      if (nextHeader != null) break;

      if (file == null && line == null) {
        const m = lines[j]!.match(prettyFileLineRe);
        if (m != null) {
          file = m[1]!.trim();
          line = m[2]!.trim();
          j += 1;
          continue;
        }
      }
      if (file == null) {
        const m = lines[j]!.match(fileRe);
        if (m != null) {
          file = m[1]!.trim();
          j += 1;
          continue;
        }
      }
      if (line == null) {
        const m = lines[j]!.match(lineRe);
        if (m != null) {
          line = m[1]!.trim();
          j += 1;
          continue;
        }
      }
      if (why == null) {
        const m = lines[j]!.match(whyRe);
        if (m != null) {
          why = m[1]!.trim();
          j += 1;
          continue;
        }
      }
      // Pretty blocks carry the why as an unlabeled line after `file:line`.
      if (why == null && file != null && line != null) {
        const text = lines[j]!.trim();
        if (text !== "" && !/^(-{3,}|_)/.test(text)) {
          why = text;
          j += 1;
          continue;
        }
      }
      j += 1;
    }

    if (file != null && line != null && why != null) {
      findings.push({ severity, title, file, line, why });
      i = j - 1;
    }
  }

  return findings;
}

export function normalizeReviewFindingsMarkdown(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  if (normalized === "" || normalized === NO_ISSUES_SENTENCE) return normalized;

  const findings = parseReviewFindings(normalized);
  if (findings.length === 0) return normalized;

  const severityLabel: Record<"high" | "medium", string> = {
    high: "🔴 High",
    medium: "🟠 Medium",
  };
  return findings
    .map(
      (f) =>
        `- **${severityLabel[f.severity]} — ${f.title}**  \n  \`${f.file}:${f.line}\`  \n  ${f.why}`,
    )
    .join("\n\n");
}
