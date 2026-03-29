import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt/index.js";

describe("buildPrompt", () => {
  it("applies prompt limits and adds truncation marker", () => {
    const result = buildPrompt({
      oldFiles: [
        {
          fileName: "a.ts",
          fileContent: "A".repeat(40),
        },
      ],
      changes: [{ diff: "B".repeat(40) }, { diff: "C".repeat(40) }],
      limits: {
        maxOldFiles: 1,
        maxOldFileChars: 10,
        maxDiffs: 1,
        maxDiffChars: 10,
        maxTotalPromptChars: 6000,
      },
    });

    const userMessage = result[result.length - 1];
    expect(userMessage?.role).toBe("user");
    const content = String(userMessage?.content ?? "");

    expect(content).toContain('old file \\"a.ts\\" truncated');
    expect(content).toContain("diff #1 truncated");
    expect(content).not.toContain("diff #2");
  });

  it("applies final prompt cap", () => {
    const result = buildPrompt({
      changes: [{ diff: "X".repeat(5000) }],
      limits: {
        maxTotalPromptChars: 500,
      },
    });
    const userMessage = result[result.length - 1];
    const content = String(userMessage?.content ?? "");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("prompt payload truncated");
  });
});
