/** @format */

type TriageFileInputTemplate = {
  path: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  diff: string;
};

export function buildMainReviewUserContent(params: {
  stats: string;
  toolNote: string;
  changesText: string;
}): string {
  const { stats, toolNote, changesText } = params;
  return [
    `Review the following code changes (git diff format). ${stats}`,
    toolNote,
    "",
    "Changes:",
    changesText || "(no changes provided)",
    "",
    "Produce your review now. Follow the system instructions strictly.",
  ].join("\n");
}

export function buildTriageUserContent(changes: TriageFileInputTemplate[]): string {
  const fileEntries = changes.map((c) => {
    const flags: string[] = [];
    if (c.new_file) flags.push("new");
    if (c.deleted_file) flags.push("deleted");
    if (c.renamed_file) flags.push("renamed");
    const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
    const snippet = c.diff.slice(0, 300);
    const truncNote = c.diff.length > 300 ? "..." : "";
    return `### ${c.path}${flagStr}\n\`\`\`\n${snippet}${truncNote}\n\`\`\``;
  });
  return `Triage these ${changes.length} file(s):\n\n${fileEntries.join("\n\n")}`;
}

export function buildFileReviewUserContent(params: {
  filePath: string;
  fileDiff: string;
  summary: string;
  otherChangedFiles: string[];
  toolNote: string;
}): string {
  const { filePath, fileDiff, summary, otherChangedFiles, toolNote } = params;
  const otherFilesNote =
    otherChangedFiles.length > 0
      ? `\nOther files changed in this MR: ${otherChangedFiles.join(", ")}`
      : "";

  return [
    `MR Summary: ${summary}`,
    otherFilesNote,
    "",
    toolNote,
    "",
    `File: ${filePath}`,
    "Diff:",
    fileDiff,
    "",
    "Review this file now.",
  ].join("\n");
}

export function buildConsolidateUserContent(params: {
  summary: string;
  findingsText: string;
  maxFindings: number;
}): string {
  const { summary, findingsText, maxFindings } = params;
  return [
    `MR Summary: ${summary}`,
    "",
    "Per-file findings:",
    findingsText,
    "",
    `Return the top ${maxFindings} findings in the required bullet format.`,
  ].join("\n");
}

export function buildVerificationUserContent(params: {
  summary: string;
  findingsText: string;
  consolidatedFindings: string;
  refs: { base: string; head: string };
}): string {
  const { summary, findingsText, consolidatedFindings, refs } = params;
  return [
    `MR Summary: ${summary}`,
    "",
    `Refs for tools: head (post-change)="${refs.head}", base="${refs.base}". Prefer head when checking whether the issue exists in the MR.`,
    "",
    "Per-file findings (evidence pool):",
    findingsText,
    "",
    "Draft consolidated findings to verify:",
    consolidatedFindings,
    "",
    "Return only the verified final findings.",
  ].join("\n");
}
