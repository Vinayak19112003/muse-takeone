// scripts/inline-scrollplan.mjs
//
// Transpiles src/compositor/scrollplan.ts (pure, no imports) to plain JS and
// inlines it as a string const in src/compositor/scrollplan.inline.ts, so the
// browser compositor page can embed it. Run via `npm run prebuild` or directly:
//   node scripts/inline-scrollplan.mjs
//
// The generated file is committed so tests (tsx) work without a build step.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcPath = join(root, "src", "compositor", "scrollplan.ts");
const outPath = join(root, "src", "compositor", "scrollplan.inline.ts");

const tmp = mkdtempSync(join(tmpdir(), "scrollplan-"));
try {
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      srcPath,
      "--outDir", tmp,
      "--target", "es2020",
      "--module", "es2020",
      "--skipLibCheck",
    ],
    { stdio: "pipe", cwd: tmp },
  );
  let js = readFileSync(join(tmp, "scrollplan.js"), "utf8");
  // Strip `export` prefixes so the code runs as a classic script.
  js = js.replace(/^export\s+/gm, "");
  // Drop the "use strict" directive; the page manages its own strictness.
  js = js.replace(/^"use strict";\s*\n/, "");

  const inline =
    `// Generated from src/compositor/scrollplan.ts — do not edit by hand.\n` +
    `// Regenerate with: node scripts/inline-scrollplan.mjs (also runs on prebuild).\n` +
    `export const scrollplanJs: string = ${JSON.stringify(js)};\n`;
  writeFileSync(outPath, inline);
  console.log(`wrote ${outPath} (${js.length} chars of JS)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
