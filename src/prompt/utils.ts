/** @format */

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

const NO_ISSUES_SENTENCE = "No confirmed bugs or high-value optimizations found.";

export function normalizeReviewFindingsMarkdown(input: string): string {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  if (normalized === "" || normalized === NO_ISSUES_SENTENCE) return normalized;

  const lines = normalized.split("\n");
  const findings: Array<{
    severity: "high" | "medium";
    title: string;
    file: string;
    line: string;
    why: string;
  }> = [];

  const headerRe = /^\s*-?\s*\[(high|medium)\]\s+(.+?)\s*$/i;
  const fileRe = /^\s*[-*]?\s*File:\s*(.+?)\s*$/i;
  const lineRe = /^\s*[-*]?\s*Line:\s*(.+?)\s*$/i;
  const whyRe = /^\s*[-*]?\s*Why:\s*(.+?)\s*$/i;

  for (let i = 0; i < lines.length; i += 1) {
    const headerMatch = lines[i]!.match(headerRe);
    if (headerMatch == null) continue;

    const severity = headerMatch[1]!.toLowerCase() as "high" | "medium";
    const title = headerMatch[2]!.trim();
    let file: string | null = null;
    let line: string | null = null;
    let why: string | null = null;

    let j = i + 1;
    while (j < lines.length) {
      const nextHeader = lines[j]!.match(headerRe);
      if (nextHeader != null) break;

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
      j += 1;
    }

    if (file != null && line != null && why != null) {
      findings.push({ severity, title, file, line, why });
      i = j - 1;
    }
  }

  if (findings.length === 0) return normalized;

  return findings
    .map(
      (f) =>
        `- [${f.severity}] ${f.title}\n  File: ${f.file}\n  Line: ${f.line}\n  Why: ${f.why}`,
    )
    .join("\n\n");
}

