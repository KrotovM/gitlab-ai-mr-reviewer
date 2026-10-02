/** @format */

import { isEmptyReviewBody } from "../prompt/profile.js";
import {
  parseReviewFindings,
  renderReviewFinding,
  type ReviewFinding,
} from "../prompt/utils.js";
import {
  createMergeRequestDiscussion,
  fetchMergeRequestDiffRefs,
  listMergeRequestDiscussions,
  replyToMergeRequestDiscussion,
  resolveMergeRequestDiscussion,
  type DiffPosition,
  type MergeRequestChange,
  type MergeRequestDiscussion,
} from "../gitlab/services.js";
import { logToolFailure } from "./tooling.js";

/** Hidden marker that lets later runs recognise this tool's diff threads. */
export const INLINE_MARKER = "<!-- gitlab-ai-review:inline -->";
/** A finding this close to an existing AI thread counts as the same finding:
 *  model line numbers are approximate and titles vary between runs. */
const SAME_PLACE_LINES = 3;
const AUTO_RESOLVED_REPLY =
  "Resolved automatically: the code under this thread changed. If the review reports the issue again, it opens a new thread.";

type DiffRefs = Pick<DiffPosition, "base_sha" | "start_sha" | "head_sha">;

const sameRefs = (a: Partial<DiffRefs>, b: DiffRefs): boolean =>
  a.base_sha === b.base_sha &&
  a.start_sha === b.start_sha &&
  a.head_sha === b.head_sha;

/** Maps every new-side line a diff thread can sit on to its old-side line
 *  (context line) or null (added line). */
export function mapNewLines(diff: string): Map<number, number | null> {
  const lines = new Map<number, number | null>();
  let oldLine = 0;
  let newLine = 0;
  for (const text of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk != null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (newLine > 0 && text.startsWith("+")) {
      lines.set(newLine++, null);
    } else if (newLine > 0 && text.startsWith(" ")) {
      lines.set(newLine++, oldLine++);
    } else if (text.startsWith("-")) {
      oldLine++;
    }
  }
  return lines;
}

function positionFor(
  finding: ReviewFinding,
  changes: MergeRequestChange[],
  refs: DiffRefs,
): DiffPosition | null {
  const path = finding.file.replace(/`/g, "").replace(/^\.?\//, "");
  const line = Number(/\d+/.exec(finding.line)?.[0]);
  const change = changes.find((c) => c.new_path === path && !c.deleted_file);
  if (change == null || !Number.isInteger(line)) return null;
  const lines = mapNewLines(change.diff);
  if (!lines.has(line)) return null;
  const oldLine = lines.get(line);
  return {
    position_type: "text",
    ...refs,
    old_path: change.old_path,
    new_path: change.new_path,
    new_line: line,
    ...(oldLine != null ? { old_line: oldLine } : {}),
  };
}

export type InlinePlan = {
  /** Findings on changed lines with no AI thread at that place yet. */
  post: Array<{ finding: ReviewFinding; position: DiffPosition }>;
  /** Findings that already have an AI thread there, open or resolved (dismissed). */
  known: ReviewFinding[];
  /** Open AI threads whose code changed and that nobody replied to or reopened. */
  resolve: string[];
};

/** Findings that are not in `post` or `known` stay in the summary comment. */
export function planInlineComments(params: {
  findings: ReviewFinding[];
  changes: MergeRequestChange[];
  refs: DiffRefs;
  discussions: MergeRequestDiscussion[];
}): InlinePlan {
  const { findings, changes, refs, discussions } = params;
  const threads = discussions.flatMap((d) => {
    const note = d.notes[0];
    if (note?.position == null || !note.body.includes(INLINE_MARKER)) return [];
    return [
      {
        id: d.id,
        new_path: note.position.new_path,
        new_line: note.position.new_line,
        // GitLab moves a thread to the new diff version on every push while its
        // line is unchanged; a thread left on older refs is outdated.
        outdated: !sameRefs(note.position, refs),
        resolved: note.resolved === true,
        // GitLab adds its "changed this line" system note to the thread; any
        // other reply (a person, or our auto-resolve note) means hands off.
        untouched: d.notes.filter((n) => n.system !== true).length === 1,
      },
    ];
  });

  const plan: InlinePlan = { post: [], known: [], resolve: [] };
  for (const finding of findings) {
    const position = positionFor(finding, changes, refs);
    if (position == null) continue;
    const known = threads.some(
      (t) =>
        !t.outdated &&
        t.new_path === position.new_path &&
        t.new_line != null &&
        Math.abs(t.new_line - position.new_line) <= SAME_PLACE_LINES,
    );
    if (known) plan.known.push(finding);
    else plan.post.push({ finding, position });
  }
  plan.resolve = threads
    .filter((t) => t.outdated && !t.resolved && t.untouched)
    .map((t) => t.id);
  return plan;
}

function summarize(
  answer: string,
  covered: ReviewFinding[],
  counts: { posted: number; known: number; resolved: number },
): string {
  let body = answer;
  for (const finding of covered) {
    const block = renderReviewFinding(finding);
    body = body.replace(body.includes(`${block}\n\n`) ? `${block}\n\n` : block, "");
  }
  const parts = [
    counts.posted > 0 ? `${counts.posted} new` : "",
    counts.known > 0 ? `${counts.known} already reported (open or resolved)` : "",
    counts.resolved > 0 ? `${counts.resolved} outdated resolved` : "",
  ].filter(Boolean);
  if (parts.length === 0) return body;
  const note = `\n\n💬 Diff threads: ${parts.join(", ")}.`;
  const disclaimerAt = body.lastIndexOf("\n\n---\n_");
  return disclaimerAt === -1
    ? body + note
    : body.slice(0, disclaimerAt) + note + body.slice(disclaimerAt);
}

/** Posts findings that land on changed lines as resolvable diff threads,
 *  resolves AI threads whose code changed, and returns the summary comment
 *  without the findings now covered by threads. Falls back to the full
 *  summary comment when anything goes wrong. */
export async function postInlineFindings(params: {
  answer: string;
  changes: MergeRequestChange[];
  diffRefs: Partial<DiffRefs> | undefined;
  gitLabProjectApiUrl: URL;
  headers: Record<string, string>;
  mergeRequestIid: string;
  logStep: (message: string) => void;
}): Promise<string> {
  const { answer, changes, diffRefs, logStep } = params;
  const api = {
    gitLabProjectApiUrl: params.gitLabProjectApiUrl,
    headers: params.headers,
    mergeRequestIid: params.mergeRequestIid,
  };
  const fallBack = (error: unknown): string => {
    logToolFailure(logStep, "inline_comments", error);
    logStep("[inline] Posting all findings in the summary comment instead.");
    return answer;
  };
  const { base_sha, start_sha, head_sha } = diffRefs ?? {};
  if (base_sha == null || start_sha == null || head_sha == null) {
    return fallBack(new Error("merge request has no diff refs"));
  }
  const refs = { base_sha, start_sha, head_sha };

  try {
    // List threads before re-reading the MR: GitLab moves threads only after it
    // stores a new diff version, so a push that moved any thread we saw also
    // shows up in the refs read below and stops this run.
    const discussions = await listMergeRequestDiscussions(api);
    if (discussions instanceof Error) return fallBack(discussions);
    const current = await fetchMergeRequestDiffRefs(api);
    if (current instanceof Error) return fallBack(current);
    if (!sameRefs(current, refs)) {
      logStep("[inline] MR has a newer diff version; posting findings in the summary comment only.");
      return answer;
    }

    const findings = parseReviewFindings(answer);
    // Only a finding whose rendered block sits in the comment verbatim can move
    // to a thread without leaving a copy behind or unbalancing a code fence.
    const movable = findings.filter((f) => {
      const block = renderReviewFinding(f);
      return answer.includes(block) && (block.match(/```/g) ?? []).length % 2 === 0;
    });
    const plan = planInlineComments({ findings: movable, changes, refs, discussions });

    const posted: ReviewFinding[] = [];
    for (const { finding, position } of plan.post) {
      const body = `${renderReviewFinding(finding)}\n\n${INLINE_MARKER}`;
      const res = await createMergeRequestDiscussion({ ...api, body, position });
      // A rejected position leaves the finding in the summary comment.
      if (res instanceof Error) logToolFailure(logStep, "inline_comments", res);
      else posted.push(finding);
    }

    // Resolve only after a real review whose findings could all become threads:
    // a failed run, or an issue re-reported only in the summary, must not close
    // threads. Header and triage-summary lines can't pass for "no findings".
    const reviewed =
      movable.length === findings.length &&
      (findings.length > 0 || isEmptyReviewBody(answer.replace(/^[#>].*$/gm, "")));
    let resolved = 0;
    for (const discussionId of reviewed ? plan.resolve : []) {
      const res = await resolveMergeRequestDiscussion({ ...api, discussionId });
      if (res instanceof Error) {
        logToolFailure(logStep, "inline_comments", res);
        continue;
      }
      resolved += 1;
      // The reply also marks the thread as handled: if someone reopens it,
      // later runs leave it alone.
      const reply = await replyToMergeRequestDiscussion({
        ...api,
        discussionId,
        body: AUTO_RESOLVED_REPLY,
      });
      if (reply instanceof Error) logToolFailure(logStep, "inline_comments", reply);
    }

    logStep(
      `[inline] Diff threads: ${posted.length} new, ${plan.known.length} already reported, ${resolved} outdated resolved.`,
    );
    return summarize(answer, [...posted, ...plan.known], {
      posted: posted.length,
      known: plan.known.length,
      resolved,
    });
  } catch (error) {
    return fallBack(error);
  }
}
