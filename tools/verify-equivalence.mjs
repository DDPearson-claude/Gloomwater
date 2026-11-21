#!/usr/bin/env node
// Proves that the built Gloomwater-Mossmere.html is the same program as a committed baseline.
//
//   (a) every byte outside the three embedded regions is identical;
//   (b) the two <script type="application/json"> template regions are byte-identical;
//   (c) the <script type="module"> bodies are the same program. Two tests, strictest first:
//       c1. whitespace-only: esbuild parses each body and prints it back with minifyWhitespace only (no
//           syntax minification, no identifier minification, no lowering); the two printed programs must
//           be equal strings. esbuild prints from its own AST, so this also evens out quote style, numeric
//           spelling and redundant parentheses, and it renames a local that would shadow a free global
//           reference (seen: a local tt printed as tt2 while the pre-fix code still read a global tt).
//           For the minified baseline against Prettier output this test fails (see c2), and says where.
//       c2. only if c1 fails: both bodies are parsed with acorn and the ESTree ASTs compared node by node,
//           ignoring source positions and the raw spelling of literals (their values must be equal).
//           Exactly one structural difference is tolerated: a chain of one logical operator (&&, || or ??)
//           may be grouped differently, a op (b op c) versus (a op b) op c. Prettier rebalances such chains
//           on purpose. The two groupings evaluate the same operands in the same order and short-circuit
//           at the same operand, so they always produce the same value and the same side effects.
//           Comments are compared too (same sequence, same text).
//       Every tolerated difference is counted and printed, with examples.
//
// A region is the exact content of its script element: everything between the ">" of the opening tag and
// the next "</script>". Regions are located independently in each file, not via src/shell.html.
//
// Usage: node tools/verify-equivalence.mjs [--base <git-rev>] [--built <path>]
//   --base   revision whose Gloomwater-Mossmere.html is the baseline (default HEAD)
//   --built  file to check (default: the repo's Gloomwater-Mossmere.html, which must then also equal a
//            fresh build of src/)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "acorn";
import { transform } from "esbuild";
import { build, OUTPUT, ROOT, sha256 } from "./build.mjs";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const baseRev = opt("--base", "HEAD");
const builtPath = resolve(opt("--built", OUTPUT));

const MODULE_OPEN = '<script type="module">';
const JSON_IDS = ["gw-field-guide-template", "gw-spore-guide-template"];
const CLOSE = Buffer.from("</script>");

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const note = (msg) => console.log(`  ..    ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

function onlyOnce(buf, str, label) {
  const needle = Buffer.from(str);
  const at = buf.indexOf(needle);
  if (at < 0) throw new Error(`${label}: ${str} not found`);
  if (buf.indexOf(needle, at + 1) >= 0) throw new Error(`${label}: ${str} occurs more than once`);
  return at + needle.length;
}

// Splits a page into the bytes outside the regions (4 segments) and the 3 region bodies.
function split(buf, label) {
  const starts = [
    { name: "module", start: onlyOnce(buf, MODULE_OPEN, label) },
    ...JSON_IDS.map((id) => ({
      name: id,
      start: onlyOnce(buf, `<script type="application/json" id="${id}">`, label),
    })),
  ].sort((x, y) => x.start - y.start);
  if (starts[0].name !== "module")
    throw new Error(`${label}: expected the module script before the templates`);
  const regions = {};
  const outside = [];
  let cursor = 0;
  for (const r of starts) {
    if (r.start < cursor) throw new Error(`${label}: regions overlap`);
    const end = buf.indexOf(CLOSE, r.start);
    if (end < 0) throw new Error(`${label}: ${r.name} has no </script>`);
    outside.push(buf.subarray(cursor, r.start));
    regions[r.name] = buf.subarray(r.start, end);
    cursor = end;
  }
  outside.push(buf.subarray(cursor));
  return { outside, regions };
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}
const around = (s, i) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
const lineOf = (code, pos) => code.slice(0, pos).split("\n").length;

// ---- c1: whitespace-only normalisation ---------------------------------------------------------------

async function whitespaceTest(a, b) {
  const norm = (code) =>
    transform(code, {
      loader: "js",
      minifyWhitespace: true, // the only transformation requested
      minifySyntax: false,
      minifyIdentifiers: false,
      target: "esnext", // no syntax lowering
      charset: "utf8",
      legalComments: "inline",
      logLevel: "silent",
    }).then((r) => r.code);
  const [na, nb] = await Promise.all([norm(a), norm(b)]);
  if (na.length < 1_000_000)
    throw new Error("normalised baseline is implausibly small; refusing a vacuous test");
  return { equal: na === nb, na, nb, at: firstDiff(na, nb) };
}

// ---- c2: AST comparison ------------------------------------------------------------------------------

const IGNORED_KEYS = new Set(["start", "end", "loc", "range"]);
const LOGICAL_CHAIN = "logical chain regrouped: a op (b op c) vs (a op b) op c, same operator";

function parseModule(code) {
  const comments = [];
  const ast = parse(code, { ecmaVersion: "latest", sourceType: "module", onComment: comments });
  return { ast, comments };
}

// Operands of a chain of one logical operator, in evaluation order, whatever the grouping.
function chainOperands(node, op, out = []) {
  if (node.type === "LogicalExpression" && node.operator === op) {
    chainOperands(node.left, op, out);
    chainOperands(node.right, op, out);
  } else out.push(node);
  return out;
}
// How a chain of one operator is grouped, ignoring what its operands are: "((x x) x)" versus "(x (x x))".
const grouping = (node, op) =>
  node.type === "LogicalExpression" && node.operator === op
    ? `(${grouping(node.left, op)} ${grouping(node.right, op)})`
    : "x";

// lineShiftB: lines of the built page above the module body, to report page line numbers.
function compareAst(A, B, codeA, codeB, lineShiftB = 0) {
  const tolerated = new Map(); // kind -> { count, examples }
  const tolerate = (kind, example) => {
    const t = tolerated.get(kind) ?? { count: 0, examples: [] };
    t.count++;
    if (t.examples.length < 6 && !t.examples.includes(example)) t.examples.push(example);
    tolerated.set(kind, t);
  };
  const mismatches = [];
  const mismatch = (path, what, na, nb) => {
    if (mismatches.length < 10)
      mismatches.push(
        `${path}: ${what}` +
          (na && nb
            ? `\n          baseline ${JSON.stringify(codeA.slice(na.start, na.start + 120))}` +
              `\n          built    ${JSON.stringify(codeB.slice(nb.start, nb.start + 120))}`
            : ""),
      );
    else mismatches.length === 10 && mismatches.push("...");
  };

  const walk = (a, b, path, na, nb) => {
    if (a === b) return;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      if (!Object.is(a, b)) mismatch(path, `${JSON.stringify(a)} !== ${JSON.stringify(b)}`, na, nb);
      return;
    }
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
        return mismatch(path, `list length ${a?.length} !== ${b?.length}`, na, nb);
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`, na, nb);
      return;
    }
    if (typeof a.type === "string") {
      na = a;
      nb = b;
      if (a.type !== b.type) return mismatch(path, `node ${a.type} !== ${b.type}`, na, nb);
      if (a.type === "Literal") {
        // Compare what the literal means, not how it is spelled.
        if (a.regex || b.regex) return walk(a.regex, b.regex, `${path}.regex`, na, nb);
        if (a.bigint !== undefined || b.bigint !== undefined)
          return walk(a.bigint, b.bigint, `${path}.bigint`, na, nb);
        if (!Object.is(a.value, b.value)) return mismatch(path, "literal value differs", na, nb);
        if (a.raw !== b.raw)
          tolerate(
            typeof a.value === "string"
              ? "string literal spelling (quote style, escapes)"
              : "numeric literal spelling",
            `${a.raw} -> ${b.raw}`,
          );
        return;
      }
      if (a.type === "LogicalExpression" && b.type === "LogicalExpression" && a.operator === b.operator) {
        if (grouping(a, a.operator) !== grouping(b, b.operator)) {
          const oa = chainOperands(a, a.operator);
          const ob = chainOperands(b, b.operator);
          if (oa.length !== ob.length)
            return mismatch(path, `${a.operator} chain has different operands`, na, nb);
          tolerate(
            LOGICAL_CHAIN,
            `built file line ${lineOf(codeB, b.start) + lineShiftB}: ${codeB.slice(b.start, b.end).replace(/\s+/g, " ").slice(0, 110)}`,
          );
          for (let i = 0; i < oa.length; i++) walk(oa[i], ob[i], `${path}{${a.operator}#${i}}`, oa[i], ob[i]);
          return;
        }
      }
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (IGNORED_KEYS.has(k)) continue;
      if (!(k in a) || !(k in b)) {
        mismatch(`${path}.${k}`, "property present on one side only", na, nb);
        continue;
      }
      walk(a[k], b[k], `${path}.${k}`, na, nb);
    }
  };
  walk(A.ast, B.ast, "Program", null, null);

  // Comments: same sequence of the same text.
  if (A.comments.length !== B.comments.length)
    mismatch("comments", `count ${A.comments.length} !== ${B.comments.length}`);
  else
    A.comments.forEach((c, i) => {
      const d = B.comments[i];
      if (c.type !== d.type || c.value !== d.value) mismatch(`comments[${i}]`, "comment text differs");
    });
  return { mismatches, tolerated };
}

// ---- main --------------------------------------------------------------------------------------------

async function main() {
  console.log(`baseline: git show ${baseRev}:Gloomwater-Mossmere.html`);
  console.log(`built:    ${builtPath}`);
  const base = execFileSync("git", ["show", `${baseRev}:Gloomwater-Mossmere.html`], {
    cwd: ROOT,
    maxBuffer: 256 * 1024 * 1024,
  });
  const built = readFileSync(builtPath);
  console.log(`  baseline ${base.length} bytes sha256 ${sha256(base)}`);
  console.log(`  built    ${built.length} bytes sha256 ${sha256(built)}`);

  if (builtPath === OUTPUT) {
    console.log("\n(0) the built file is up to date with src/");
    if (Buffer.compare(build(), built) === 0) ok("Gloomwater-Mossmere.html equals a fresh build of src/");
    else bad("Gloomwater-Mossmere.html differs from a fresh build of src/ (run: npm run build)");
  }

  const B = split(base, "baseline");
  const N = split(built, "built");

  console.log("\n(a) bytes outside the three regions");
  B.outside.forEach((seg, i) => {
    const d = firstDiff(seg, N.outside[i]);
    if (d < 0) ok(`segment ${i + 1}/4 identical (${seg.length} bytes)`);
    else bad(`segment ${i + 1}/4 differs at byte ${d}: ${around(seg.toString("latin1"), d)}`);
  });

  console.log("\n(b) JSON template regions");
  for (const id of JSON_IDS) {
    const d = firstDiff(B.regions[id], N.regions[id]);
    if (d < 0) ok(`${id} byte-identical (${B.regions[id].length} bytes, sha256 ${sha256(B.regions[id])})`);
    else bad(`${id} differs at byte ${d}`);
  }

  console.log("\n(c) module script");
  const fatal = new TextDecoder("utf-8", { fatal: true });
  const codeA = fatal.decode(B.regions.module);
  const codeB = fatal.decode(N.regions.module);
  console.log(`  baseline ${B.regions.module.length} bytes, built ${N.regions.module.length} bytes`);
  let passed = null;
  const ws = await whitespaceTest(codeA, codeB);
  if (ws.equal) {
    ok(
      `c1 whitespace-only test: esbuild minifyWhitespace output identical (sha256 ${sha256(Buffer.from(ws.na))})`,
    );
    passed = "c1 whitespace-only (esbuild minifyWhitespace, identical output)";
  } else {
    note(`c1 whitespace-only test: outputs differ at char ${ws.at}; falling back to c2`);
    note(`   baseline ${around(ws.na, ws.at)}`);
    note(`   built    ${around(ws.nb, ws.at)}`);
    const shift =
      built
        .subarray(0, built.indexOf(MODULE_OPEN) + MODULE_OPEN.length)
        .toString("latin1")
        .split("\n").length - 1;
    const { mismatches, tolerated } = compareAst(parseModule(codeA), parseModule(codeB), codeA, codeB, shift);
    if (mismatches.length) {
      bad(`c2 AST test: the programs differ:\n        ${mismatches.join("\n        ")}`);
    } else {
      ok("c2 AST test: ASTs equal (positions and literal spelling ignored), comments identical");
      passed = "c2 AST (acorn ESTree, positions and literal raw ignored, comments compared)";
      console.log("  tolerated differences:");
      if (!tolerated.size) console.log("    none");
      for (const [kind, { count, examples }] of tolerated) {
        console.log(`    ${count} x ${kind}`);
        for (const e of examples) console.log(`        e.g. ${e}`);
      }
      console.log(
        "    (and, by construction: whitespace, line breaks, semicolons, trailing commas and redundant",
      );
      console.log("     parentheses, none of which appear in an AST)");
    }
  }

  if (failures) console.log(`\nverify FAILED: ${failures} check(s) failed`);
  else console.log(`\nverify passed: same program as the baseline. Module test passed: ${passed}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(`verify FAILED: ${e.stack || e}`);
  process.exit(1);
});
