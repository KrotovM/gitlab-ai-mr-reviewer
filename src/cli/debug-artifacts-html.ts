/** @format */

import { writeFile } from "node:fs/promises";
import { parseReviewFindings } from "../prompt/utils.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export async function renderDebugArtifactsHtml(params: {
  records: Record<string, any>[];
  artifactHtmlFile: string;
  cliVersion: string;
  aiModel: string;
}): Promise<void> {
  const { records, artifactHtmlFile, cliVersion, aiModel } = params;
  const responses = records.filter((r) => r.kind === "openai_response");
  const requests = records.filter((r) => r.kind === "openai_request");
  const errors = records.filter((r) => r.kind === "openai_error");

  const byLabel = new Map<string, Record<string, any>>();
  for (const response of responses) {
    if (typeof response.label === "string")
      byLabel.set(response.label, response);
  }
  const requestTsByLabel = new Map<string, string>();
  for (const request of requests) {
    if (typeof request.label === "string" && !requestTsByLabel.has(request.label))
      requestTsByLabel.set(request.label, String(request.ts ?? ""));
  }

  type Usage = { prompt: number; completion: number; total: number };
  function usageOf(record: Record<string, any> | undefined): Usage | null {
    const u = record?.response?.usage;
    if (u == null) return null;
    return {
      prompt: Number(u.prompt_tokens ?? 0),
      completion: Number(u.completion_tokens ?? 0),
      total: Number(u.total_tokens ?? 0),
    };
  }
  function sumUsage(labels: string[]): { usage: Usage; reported: number } {
    const usage: Usage = { prompt: 0, completion: 0, total: 0 };
    let reported = 0;
    for (const label of labels) {
      const u = usageOf(byLabel.get(label));
      if (u == null) continue;
      reported += 1;
      usage.prompt += u.prompt;
      usage.completion += u.completion;
      usage.total += u.total;
    }
    return { usage, reported };
  }
  function tokensText(labels: string[]): string {
    const { usage, reported } = sumUsage(labels);
    if (reported === 0) return "tokens: not reported by backend";
    return `prompt: ${usage.prompt.toLocaleString()} • completion: ${usage.completion.toLocaleString()} • total: ${usage.total.toLocaleString()}`;
  }
  function parseTs(value: unknown): number | null {
    const ms = Date.parse(String(value ?? ""));
    return Number.isFinite(ms) ? ms : null;
  }
  function durationText(labels: string[]): string {
    const starts = labels
      .map((label) => parseTs(requestTsByLabel.get(label)))
      .filter((n): n is number => n != null);
    const ends = labels
      .map((label) => parseTs(byLabel.get(label)?.ts))
      .filter((n): n is number => n != null);
    if (starts.length === 0 || ends.length === 0) return "";
    return `${((Math.max(...ends) - Math.min(...starts)) / 1000).toFixed(1)}s`;
  }

  const allLabels = Array.from(byLabel.keys());
  const triageLabels = allLabels.filter((l) => l.startsWith("triage_pass"));
  const consolidateLabels = allLabels.filter((l) => l === "consolidate_pass");
  const verificationLabels = allLabels.filter((l) =>
    l.startsWith("verification_pass"),
  );
  const mainLabels = allLabels.filter((l) => l.startsWith("main_review"));

  // Per-file review request groups, in first-seen (chronological) order.
  const fileGroups = new Map<string, string[]>();
  const fileLabelRe = /^file_review_(.+?)_(?:round_\d+|final_after_tool_limit)$/;
  for (const response of responses) {
    const label = typeof response.label === "string" ? response.label : "";
    const match = label.match(fileLabelRe);
    if (match == null) continue;
    const group = fileGroups.get(match[1]!) ?? [];
    group.push(label);
    fileGroups.set(match[1]!, group);
  }

  function getContent(label: string): string {
    const content =
      byLabel.get(label)?.response?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
  function lastContent(labels: string[]): string {
    const finalLabel = labels.find((l) => l.endsWith("_final_after_tool_limit"));
    if (finalLabel != null && getContent(finalLabel).trim() !== "")
      return getContent(finalLabel);
    for (let i = labels.length - 1; i >= 0; i -= 1) {
      const content = getContent(labels[i]!);
      if (content.trim() !== "") return content;
    }
    return "";
  }

  function formatAsPrettyJsonIfPossible(value: string): string {
    const trimmed = value.trim();
    if (trimmed === "") return value;
    const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const normalized = (fencedMatch?.[1] ?? trimmed).trim();
    try {
      return JSON.stringify(JSON.parse(normalized), null, 2);
    } catch {
      return value;
    }
  }

  function renderTriageDecisions(): string {
    const decisionRecord = records.find((r) => r.kind === "triage_decision");
    if (decisionRecord == null) return "<pre>No triage decision record</pre>";

    const summary =
      typeof decisionRecord.summary === "string" ? decisionRecord.summary : "";
    const skipAllOverride = decisionRecord.skip_all_override === true;
    const triageDiffChars = Number(decisionRecord.triage_diff_chars ?? 0);
    const files = Array.isArray(decisionRecord.files) ? decisionRecord.files : [];

    const actionLabel = (action: unknown): string => {
      switch (action) {
        case "skipped":
          return "Skipped";
        case "reviewed_via_override":
          return "Reviewed (override)";
        case "review":
          return "Review";
        default:
          return String(action ?? "unknown");
      }
    };

    const rows = files
      .map((file: Record<string, unknown>) => {
        const path = typeof file.path === "string" ? file.path : "?";
        const verdict = typeof file.verdict === "string" ? file.verdict : "?";
        const reason = typeof file.reason === "string" ? file.reason : "";
        const action = actionLabel(file.review_action);
        return `<tr>
          <td><code>${escapeHtml(path)}</code></td>
          <td>${escapeHtml(verdict)}</td>
          <td>${escapeHtml(action)}</td>
          <td>${escapeHtml(reason)}</td>
        </tr>`;
      })
      .join("\n");

    const overrideNote = skipAllOverride
      ? `<p class="tokens" style="margin:0 0 10px;color:var(--med);">All files were marked SKIP — pipeline overrode and reviewed every file.</p>`
      : "";

    return `${overrideNote}
      <p class="tokens" style="margin:0 0 10px;">triage_diff_chars=${escapeHtml(String(triageDiffChars))}</p>
      <p style="margin:0 0 12px;">${escapeHtml(summary)}</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="text-align:left;color:var(--muted);">
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">File</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Verdict</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Action</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Reason</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function renderFindings(markdown: string): string {
    const trimmed = markdown.trim();
    if (trimmed === "") return "<pre>No data</pre>";
    const findings = parseReviewFindings(trimmed);
    if (findings.length === 0) return `<pre>${escapeHtml(trimmed)}</pre>`;
    return findings
      .map(
        (f) =>
          `<div class="finding${f.severity === "high" ? " high" : ""}"><div class="title">${escapeHtml(`[${f.severity}] ${f.title}`)}</div><div class="meta">${escapeHtml(`${f.file}:${f.line}`)}</div><div>${escapeHtml(f.why)}</div></div>`,
      )
      .join("\n");
  }

  function sectionHeader(badge: string, labels: string[]): string {
    const duration = durationText(labels);
    const parts = [
      tokensText(labels),
      duration === "" ? "" : `took ${duration}`,
      `${labels.length} request(s)`,
    ].filter((p) => p !== "");
    return `<div class="row"><span class="badge">${escapeHtml(badge)}</span><span class="tokens">${escapeHtml(parts.join(" • "))}</span></div>`;
  }

  function pickVerificationSection(): { label: string; content: string } {
    const afterLimit = getContent("verification_pass_final_after_tool_limit");
    if (afterLimit.trim() !== "")
      return {
        label: "verification_pass_final_after_tool_limit",
        content: afterLimit,
      };
    const roundLabels = verificationLabels
      .filter((k) => k.startsWith("verification_pass_round_"))
      .sort((a, b) => {
        const na = Number(a.replace("verification_pass_round_", ""));
        const nb = Number(b.replace("verification_pass_round_", ""));
        return na - nb;
      });
    for (let i = roundLabels.length - 1; i >= 0; i--) {
      const lbl = roundLabels[i]!;
      const c = getContent(lbl);
      if (c.trim() !== "") return { label: lbl, content: c };
    }
    const legacy = getContent("verification_pass");
    if (legacy.trim() !== "")
      return { label: "verification_pass", content: legacy };
    return { label: "verification_pass_round_1", content: "" };
  }

  const verificationSection = pickVerificationSection();
  const finalStatus =
    verificationSection.content.trim() !== "" ? "Verified" : "Fallback";

  // Per-pass token/duration summary table.
  const passRows: Array<[string, string[]]> = [
    ["Triage", triageLabels] as [string, string[]],
    ...Array.from(fileGroups.entries()).map(
      ([path, labels]): [string, string[]] => [`File review — ${path}`, labels],
    ),
    ["Consolidation", consolidateLabels] as [string, string[]],
    ["Verification", verificationLabels] as [string, string[]],
    ["Single-pass fallback", mainLabels] as [string, string[]],
  ].filter(([, labels]) => labels.length > 0);

  const cell = (value: string, opts?: { strong?: boolean }): string =>
    `<td style="padding:6px 8px;border-bottom:1px solid var(--line);${opts?.strong ? "font-weight:700;" : ""}">${value}</td>`;
  const usageCells = (labels: string[], strong?: boolean): string => {
    const { usage, reported } = sumUsage(labels);
    if (reported === 0)
      return `${cell("n/a", { strong })}${cell("n/a", { strong })}${cell("n/a", { strong })}`;
    return [usage.prompt, usage.completion, usage.total]
      .map((n) => cell(escapeHtml(n.toLocaleString()), { strong }))
      .join("");
  };
  const passTableRows = passRows
    .map(
      ([name, labels]) =>
        `<tr>${cell(escapeHtml(name))}${cell(String(labels.length))}${usageCells(labels)}${cell(escapeHtml(durationText(labels) || "—"))}</tr>`,
    )
    .join("\n");
  const totalRow = `<tr>${cell("Total", { strong: true })}${cell(String(allLabels.length), { strong: true })}${usageCells(allLabels, true)}${cell(escapeHtml(durationText(allLabels) || "—"), { strong: true })}</tr>`;

  const totalUsage = sumUsage(allLabels);
  const totalTokensText =
    totalUsage.reported === 0 ? "n/a" : totalUsage.usage.total.toLocaleString();
  const wallStarts = requests
    .map((r) => parseTs(r.ts))
    .filter((n): n is number => n != null);
  const wallEnds = [...responses, ...errors]
    .map((r) => parseTs(r.ts))
    .filter((n): n is number => n != null);
  const wallText =
    wallStarts.length > 0 && wallEnds.length > 0
      ? `${((Math.max(...wallEnds) - Math.min(...wallStarts)) / 1000).toFixed(1)}s`
      : "n/a";

  const fileSections = Array.from(fileGroups.entries())
    .map(
      ([path, labels]) =>
        `<div class="section">${sectionHeader(`file: ${path}`, labels)}${renderFindings(lastContent(labels))}</div>`,
    )
    .join("\n");

  const triageRawSections = triageLabels
    .map(
      (label) =>
        `<div class="section">${sectionHeader(`label: ${label}`, [label])}<pre>${escapeHtml(formatAsPrettyJsonIfPossible(getContent(label)))}</pre></div>`,
    )
    .join("\n");

  const errorSection =
    errors.length === 0
      ? ""
      : `<h2>Errors</h2>
    <div class="section">
      ${errors
        .map(
          (e) =>
            `<div class="finding high"><div class="title">${escapeHtml(String(e.label ?? "unknown"))}</div><div class="meta">${escapeHtml(String(e.ts ?? ""))}</div><div>${escapeHtml(`${e?.error?.name ?? ""} ${e?.error?.status ?? ""} ${e?.error?.message ?? ""}`.trim())}</div></div>`,
        )
        .join("\n")}
    </div>`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Review Debug Report</title>
  <style>
    :root { --bg:#0b1020; --panel:#121a2b; --muted:#8ea0c0; --text:#e8eefc; --ok:#2ecc71; --high:#ff6b6b; --med:#f4b942; --line:#24314f; --mono-bg:#0f1526; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 Inter,system-ui,sans-serif; padding:24px; }
    .wrap{max-width:1100px;margin:0 auto;} h1,h2{margin:0 0 10px;} h1{font-size:24px;} h2{font-size:18px;margin-top:26px;} .sub{color:var(--muted);margin-bottom:18px;}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:14px 0 22px;} .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px;}
    .k{color:var(--muted);font-size:12px;} .v{font-size:20px;font-weight:700;margin-top:4px;} .ok{color:var(--ok);} .bad{color:var(--high);}
    .section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px;}
    .row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;}
    .badge{border:1px solid var(--line);background:#16223a;border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted);}
    .tokens{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--muted);}
    .finding{border-left:3px solid var(--med);background:#131f36;padding:10px 12px;border-radius:8px;margin:8px 0;} .finding.high{border-left-color:var(--high);}
    .finding .title{font-weight:700;} .meta{color:var(--muted);font-size:12px;margin:4px 0;}
    table{width:100%;border-collapse:collapse;font-size:13px;}
    pre{margin:8px 0 0;white-space:pre-wrap;word-break:break-word;background:var(--mono-bg);border:1px solid var(--line);padding:10px;border-radius:8px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d7e3ff;}
    @media (max-width:900px){.grid{grid-template-columns:1fr 1fr;}} @media (max-width:520px){.grid{grid-template-columns:1fr;}}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>AI Review Debug Report</h1>
    <div class="sub">cli v${escapeHtml(cliVersion)} • model ${escapeHtml(aiModel)} • records ${records.length}</div>

    <div class="grid">
      <div class="card"><div class="k">Model</div><div class="v">${escapeHtml(aiModel)}</div></div>
      <div class="card"><div class="k">Requests</div><div class="v">${escapeHtml(String(requests.length))}</div></div>
      <div class="card"><div class="k">Files reviewed</div><div class="v">${escapeHtml(String(fileGroups.size))}</div></div>
      <div class="card"><div class="k">Errors</div><div class="v${errors.length > 0 ? " bad" : ""}">${escapeHtml(String(errors.length))}</div></div>
      <div class="card"><div class="k">Total tokens</div><div class="v">${escapeHtml(totalTokensText)}</div></div>
      <div class="card"><div class="k">Wall time</div><div class="v">${escapeHtml(wallText)}</div></div>
      <div class="card"><div class="k">Final Status</div><div class="v ok">${escapeHtml(finalStatus)}</div></div>
    </div>

    <h2>Token Usage by Pass</h2>
    <div class="section">
      <table>
        <thead>
          <tr style="text-align:left;color:var(--muted);">
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Pass</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Requests</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Prompt</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Completion</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Total</th>
            <th style="padding:6px 8px;border-bottom:1px solid var(--line);">Duration</th>
          </tr>
        </thead>
        <tbody>
${passTableRows}
${totalRow}
        </tbody>
      </table>
    </div>
    ${errorSection}

    <h2>Pass 1 — Triage Decisions</h2>
    <div class="section">
      ${renderTriageDecisions()}
    </div>

    <h2>Pass 1 — Triage (raw model output)</h2>
    ${triageRawSections}

    <h2>Pass 2 — File Reviews</h2>
    ${fileSections === "" ? "<div class=\"section\"><pre>No file review records</pre></div>" : fileSections}

    <h2>Pass 3 — Consolidation</h2>
    <div class="section">
      ${sectionHeader("label: consolidate_pass", consolidateLabels)}
      ${renderFindings(getContent("consolidate_pass"))}
    </div>

    <h2>Pass 4 — Verification</h2>
    <div class="section">
      ${sectionHeader(`label: ${verificationSection.label}`, verificationLabels)}
      ${renderFindings(verificationSection.content)}
    </div>
  </div>
</body>
</html>`;
  await writeFile(artifactHtmlFile, html, "utf8");
}
