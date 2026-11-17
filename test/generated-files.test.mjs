// Run with `pnpm test` (builds dist first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isGeneratedFile } from "../dist/cli/args.js";

test("lockfiles, minified bundles, source maps and snapshots are skipped; source is not", () => {
  for (const path of [
    "pnpm-lock.yaml",
    "web/package-lock.json",
    "Gemfile.lock",
    "go.sum",
    "public/app.MIN.js",
    "dist/app.js.map",
    "src/__snapshots__/view.test.ts.snap",
  ]) {
    assert.equal(isGeneratedFile(path), true, path);
  }
  for (const path of ["src/lock.ts", "yarn.lock.md", "config/pnpm-lock.yaml.example", "src/minify.js", "map.ts"]) {
    assert.equal(isGeneratedFile(path), false, path);
  }
});
