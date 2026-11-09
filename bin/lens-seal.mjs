#!/usr/bin/env node
// Seal an evidence pack: fill in its snapshotHash and boundary fields, so capture scripts in any language can
// write the pack's contents and leave the hashing to the one implementation in lib/evidence.js.
//
//   node bin/lens-seal.mjs unsealed.json [-o pack.json]      (prints the pack if -o is not given)
import { readFile, writeFile } from "node:fs/promises";
import { sealPack } from "../lib/evidence.js";
const args = process.argv.slice(2), out = args.includes("-o") ? args[args.indexOf("-o") + 1] : null, input = args.find(a => a !== "-o" && a !== out);
if (!input) { console.error("usage: lens-seal <unsealed.json> [-o pack.json]"); process.exit(2); }
const pack = await sealPack(JSON.parse(await readFile(input, "utf8")));
const json = JSON.stringify(pack, null, 1) + "\n";
if (out) { await writeFile(out, json); console.log(`sealed ${pack.items.length} items on ${pack.screens.length} screens: snapshot ${pack.snapshotHash.slice(0, 12)}`); } else process.stdout.write(json);
