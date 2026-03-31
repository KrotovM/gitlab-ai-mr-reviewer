/** @format */

import { writeFile } from "node:fs/promises";

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
  const byLabel = new Map<string, Record<string, any>>();
  for (const response of responses) {
    if (typeof response.label === "string")
      byLabel.set(response.label, response);
  }

  const totalTokens = responses.reduce(
    (sum, r) => sum + Number(r?.response?.usage?.total_tokens ?? 0),
    0,
  );
  const tokenLine = responses
    .map((r) => {
      const label = String(r.label ?? "unknown");
      const tokens = Number(r?.response?.usage?.total_tokens ?? 0);
      return `${label}: ${tokens}`;
    })
    .join(" • ");

  function getContent(label: string): string {
    const content =
      byLabel.get(label)?.response?.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
  function getTokenTriplet(label: string): string {
    const usage = byLabel.get(label)?.response?.usage;
    if (usage == null) return "prompt: 0 • completion: 0 • total: 0";
    return `prompt: ${usage.prompt_tokens ?? 0} • completion: ${usage.completion_tokens ?? 0} • total: ${usage.total_tokens ?? 0}`;
  }
  function findTs(label: string): string {
    return String(byLabel.get(label)?.ts ?? "");
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

  function renderFindings(markdown: string): string {
    const trimmed = markdown.trim();
    if (trimmed === "") return "<pre>No data</pre>";
    const blocks = trimmed.split(/\n\s*\n/);
    const items: string[] = [];
    for (const block of blocks) {
      const lines = block.split("\n").map((l) => l.trimEnd());
      const title = lines[0] ?? "";
      const file = lines.find((l) => l.trimStart().startsWith("File:")) ?? "";
      const line = lines.find((l) => l.trimStart().startsWith("Line:")) ?? "";
      const why = lines.find((l) => l.trimStart().startsWith("Why:")) ?? "";
      if (!title.startsWith("- [")) continue;
      const isHigh = title.toLowerCase().includes("[high]");
      items.push(
        `<div class="finding${isHigh ? " high" : ""}"><div class="title">${escapeHtml(title)}</div><div class="meta">${escapeHtml(file)} • ${escapeHtml(line)}</div><div>${escapeHtml(why)}</div></div>`,
      );
    }
    if (items.length === 0) return `<pre>${escapeHtml(trimmed)}</pre>`;
    return items.join("\n");
  }

  const triageContent = getContent("triage_pass");
  const triageContentPretty = formatAsPrettyJsonIfPossible(triageContent);
  const fileServerLabel = Array.from(byLabel.keys()).find((k) =>
    k.startsWith("file_review_server.js_round_"),
  );
  const fileCiLabel = Array.from(byLabel.keys()).find((k) =>
    k.startsWith("file_review_.gitlab-ci.yml_round_"),
  );
  const consolidateLabel = "consolidate_pass";
  const verificationLabel = "verification_pass";

  const finalStatus =
    getContent(verificationLabel).trim() !== "" ? "Verified" : "Fallback";

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
    .k{color:var(--muted);font-size:12px;} .v{font-size:20px;font-weight:700;margin-top:4px;} .ok{color:var(--ok);}
    .section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:14px;}
    .row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px;}
    .badge{border:1px solid var(--line);background:#16223a;border-radius:999px;padding:2px 10px;font-size:12px;color:var(--muted);}
    .tokens{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--muted);}
    .finding{border-left:3px solid var(--med);background:#131f36;padding:10px 12px;border-radius:8px;margin:8px 0;} .finding.high{border-left-color:var(--high);}
    .finding .title{font-weight:700;} .meta{color:var(--muted);font-size:12px;margin:4px 0;}
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
      <div class="card"><div class="k">Requests</div><div class="v">${escapeHtml(String(records.filter((r) => r.kind === "openai_request").length))}</div></div>
      <div class="card"><div class="k">Responses</div><div class="v">${escapeHtml(String(responses.length))}</div></div>
      <div class="card"><div class="k">Final Status</div><div class="v ok">${escapeHtml(finalStatus)}</div></div>
    </div>

    <h2>Token Usage</h2>
    <div class="section">
      <div class="tokens">${escapeHtml(tokenLine)}</div>
      <div class="tokens" style="margin-top:6px;"><strong>Total:</strong> ${escapeHtml(totalTokens.toLocaleString())} tokens</div>
    </div>

    <h2>Pass 1 — Triage</h2>
    <div class="section">
      <div class="row"><span class="badge">label: triage_pass</span><span class="tokens">${escapeHtml(findTs("triage_pass"))}</span></div>
      <pre>${escapeHtml(triageContentPretty)}</pre>
    </div>

    <h2>Pass 2 — File Reviews</h2>
    ${
      fileServerLabel == null
        ? ""
        : `<div class="section"><div class="row"><span class="badge">label: ${escapeHtml(fileServerLabel)}</span><span class="tokens">${escapeHtml(getTokenTriplet(fileServerLabel))}</span></div>${renderFindings(getContent(fileServerLabel))}</div>`
    }
    ${
      fileCiLabel == null
        ? ""
        : `<div class="section"><div class="row"><span class="badge">label: ${escapeHtml(fileCiLabel)}</span><span class="tokens">${escapeHtml(getTokenTriplet(fileCiLabel))}</span></div>${renderFindings(getContent(fileCiLabel))}</div>`
    }

    <h2>Pass 3 — Consolidation</h2>
    <div class="section">
      <div class="row"><span class="badge">label: ${escapeHtml(consolidateLabel)}</span><span class="tokens">${escapeHtml(getTokenTriplet(consolidateLabel))}</span></div>
      ${renderFindings(getContent(consolidateLabel))}
    </div>

    <h2>Pass 4 — Verification</h2>
    <div class="section">
      <div class="row"><span class="badge">label: ${escapeHtml(verificationLabel)}</span><span class="tokens">${escapeHtml(getTokenTriplet(verificationLabel))}</span></div>
      ${renderFindings(getContent(verificationLabel))}
    </div>
  </div>
</body>
</html>`;
  await writeFile(artifactHtmlFile, html, "utf8");
}
