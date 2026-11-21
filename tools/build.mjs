#!/usr/bin/env node
// Assembles src/ into the single playable file Gloomwater-Mossmere.html.
//
//   src/shell.html        the page around the three embedded regions, with one placeholder per region
//   src/game.js           the <script type="module"> body (three.js and all game code)
//   src/field-guide.html  standalone document, stored in the page as a JSON string
//   src/spore-guide.html  standalone document, stored in the page as a JSON string
//
// Plain Node, no dependencies, no minification. The output is a pure function of the four inputs, so two
// builds from the same sources are byte-identical. Any problem fails the build with a message.
//
// Usage: node tools/build.mjs [--out <path>]   (default: <repo>/Gloomwater-Mossmere.html)

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const OUTPUT = join(ROOT, "Gloomwater-Mossmere.html");

// Placeholder token in src/shell.html  ->  source file and how it is embedded.
export const REGIONS = [
  { token: "@@GW_INCLUDE:game.js@@", file: "src/game.js", kind: "module" },
  { token: "@@GW_INCLUDE:field-guide.html@@", file: "src/field-guide.html", kind: "json" },
  { token: "@@GW_INCLUDE:spore-guide.html@@", file: "src/spore-guide.html", kind: "json" },
];

class BuildError extends Error {}
const fail = (msg) => {
  throw new BuildError(msg);
};

const utf8 = new TextDecoder("utf-8", { fatal: true });
function readText(rel) {
  let bytes;
  try {
    bytes = readFileSync(join(ROOT, rel));
  } catch (e) {
    fail(`cannot read ${rel}: ${e.message}`);
  }
  try {
    const text = utf8.decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) fail(`${rel} starts with a byte-order mark; remove it`);
    return text;
  } catch (e) {
    if (e instanceof BuildError) throw e;
    fail(`${rel} is not valid UTF-8`);
  }
}

function lineCol(text, index) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return `${line}:${index - before.lastIndexOf("\n")}`;
}

// The module body is inserted raw into <script type="module">. The HTML tokenizer knows nothing about JS, so
// these sequences must not appear anywhere in it, not even inside strings, comments or template literals:
//   "</script"  ends the script element early (matched case-insensitively, as the tokenizer does);
//   "<!--"      enters the script-data-escaped state, where a later "<script" makes the tokenizer skip the
//               next "</script>", so the element would run on past its real end;
//   "<script"   harmless without "<!--", but rejected as well so the rule stays simple. None occur today.
// To write such text in JS, break it up, for example "<\/script" or "<" + "script".
const FORBIDDEN_IN_MODULE = [
  { re: /<\/script/gi, why: 'a "</script" sequence would end the script element early' },
  { re: /<!--/g, why: 'a "<!--" sequence puts the HTML tokenizer into the escaped script state' },
  { re: /<script/gi, why: 'a "<script" sequence can stop the real "</script>" from closing the element' },
];

export function checkModule(code, rel = "src/game.js") {
  const problems = [];
  for (const { re, why } of FORBIDDEN_IN_MODULE) {
    re.lastIndex = 0;
    for (let m; (m = re.exec(code)); ) problems.push(`${rel}:${lineCol(code, m.index)}: ${why}`);
  }
  if (code.includes("@@GW_INCLUDE:")) problems.push(`${rel} contains a placeholder token "@@GW_INCLUDE:"`);
  if (problems.length) fail(`unsafe module script:\n  ${problems.join("\n  ")}`);
}

// Encodes a document the way the committed page stores it: a JSON string literal with every "<" and every
// non-ASCII UTF-16 code unit written as a lowercase \uXXXX escape. The result is pure ASCII and contains no
// "<", so it can never close or confuse the surrounding <script type="application/json"> element.
export function encodeDocument(text) {
  const json = JSON.stringify(text).replace(
    /[<\u007f-￿]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
  if (/[^\x20-\x7e]/.test(json) || json.includes("<"))
    fail("internal error: encoded document is not safe ASCII");
  if (JSON.parse(json) !== text) fail("internal error: encoded document does not decode to its source");
  return json;
}

export function build() {
  const shell = readText("src/shell.html");
  for (const { token } of REGIONS) {
    const n = shell.split(token).length - 1;
    if (n !== 1) fail(`src/shell.html must contain ${token} exactly once (found ${n})`);
  }
  const stray = shell.split("@@GW_INCLUDE:").length - 1;
  if (stray !== REGIONS.length) fail(`src/shell.html has an unknown @@GW_INCLUDE: placeholder`);

  let out = shell;
  for (const { token, file, kind } of REGIONS) {
    const src = readText(file);
    let body;
    if (kind === "module") {
      checkModule(src, file);
      body = src;
    } else {
      body = encodeDocument(src);
    }
    // Plain splice, not String.replace: replacement strings would give "$&" and friends a meaning.
    const at = out.indexOf(token);
    out = out.slice(0, at) + body + out.slice(at + token.length);
  }
  return Buffer.from(out, "utf8");
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function main(argv) {
  const i = argv.indexOf("--out");
  const out = i >= 0 ? resolve(argv[i + 1] ?? fail("--out needs a path")) : OUTPUT;
  const bytes = build();
  const tmp = `${out}.tmp-${process.pid}`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, out);
  console.log(`built ${relative(process.cwd(), out) || out}`);
  console.log(`  size   ${bytes.length} bytes`);
  console.log(`  sha256 ${sha256(bytes)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    console.error(`build FAILED: ${e.message}`);
    process.exit(1);
  }
}
