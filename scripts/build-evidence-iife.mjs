// Build dist/evidence.iife.js: lib/evidence.js for pages that don't load modules. It defines globalThis.WorldLensEvidence.
// The module has no imports, so this is a straight wrap: drop the export keywords and collect the exported names.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const src = readFileSync(new URL("../lib/evidence.js", import.meta.url), "utf8");
if (/^\s*import\s/m.test(src)) throw new Error("lib/evidence.js must stay import-free to be wrapped");
const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_]+)/gm)].map(m => m[1]);
const body = src.replace(/^export\s+/gm, "");
mkdirSync(new URL("../dist/", import.meta.url), { recursive: true });
writeFileSync(new URL("../dist/evidence.iife.js", import.meta.url),
  `/* World Lens evidence packs — generated from lib/evidence.js by scripts/build-evidence-iife.mjs; do not edit */\n(function(){\n${body}\nglobalThis.WorldLensEvidence = Object.freeze({ ${names.join(", ")} });\n})();\n`);
console.log("dist/evidence.iife.js:", names.join(", "));
