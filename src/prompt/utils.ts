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

