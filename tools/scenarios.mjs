#!/usr/bin/env node
// Scenario tests: each scenario loads a save fixture from tools/fixtures/ into localStorage, boots the built
// game in headless Chromium and drives it through the game's own hooks (window.__gw; ?debug=1 when a
// scenario asks for it). A scenario fails on any console error, uncaught page error, crash or new entry in
// the game's own error log, as well as on its own checks.
//
// Prints one line per scenario and exits non-zero if any failed. Scenarios run a few at a time.
//
// Usage: node tools/scenarios.mjs [--page page.html] [--fixtures dir] [--jobs n] [name filter ...]
//   (npm run scenarios; a filter keeps the scenarios whose name contains any of the given words)
//
// Adding a scenario: append an object to SCENARIOS below.
//   name     what it proves, one line
//   fixture  a file name in tools/fixtures/ without ".json", or null for a fresh profile; omit both
//            fixture and run's session for a check that needs no browser (set browser: false)
//   debug    true to boot with ?debug=1 (instantCatch, giveClams and the other debug hooks)
//   run      async (session, { fixture, page }) => { ... }: throw an Error to fail. `session` is a
//            GameSession (tools/game-driver.mjs) that has booted to the title; `fixture` is the parsed save.

import { readFileSync } from "node:fs";
import * as acorn from "acorn";
import { join } from "node:path";
import { DEFAULT_PAGE, GameSession, ROOT, launchBrowser } from "./game-driver.mjs";

const BUDGET_MS = 180_000; // every scenario, launch to exit
const SCENARIO_TIMEOUT_MS = 150_000;
// Smaller than the smoke test's 480 x 270: SwiftShader draws every frame on the CPU, and several
// scenarios share it. The game's layout still fits (its phone layout).
const VIEWPORT = { width: 320, height: 180 };

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
};
const PAGE = option("--page", DEFAULT_PAGE);
const FIXTURES_DIR = option("--fixtures", join(ROOT, "tools", "fixtures"));
const JOBS = Math.max(1, Number(option("--jobs", 3)) || 3);
const FILTERS = args;

const check = (ok, message) => {
  if (!ok) throw new Error(message);
};

// ---- shared steps ---------------------------------------------------------------------------------------

// From the title, Continue and set out; checks the save was kept and the trip is on the barge's water.
async function continueToPlay(session, fixture) {
  const actions = await session.sail({ water: fixture.meta.loop.barge.water });
  const s = await session.eval(() => {
    const g = window.__gw;
    const loop = g.progression.loop.state();
    return {
      flow: g.flow,
      outing: g.state.run?.outing ?? null,
      active: g.state.run?.active === true,
      zone: g.state.run?.zone ?? null,
      barge: loop?.barge?.water ?? null,
      evenings: loop?.evenings ?? null,
      wick: loop?.wick ?? null,
    };
  });
  const want = fixture.meta.loop;
  check(s.flow === "playing", `flow is ${s.flow}, expected playing`);
  check(s.active && s.outing === "trip", `no active trip: ${JSON.stringify(s)}`);
  check(s.zone === want.barge.water, `the trip is on ${s.zone}, expected ${want.barge.water}`);
  check(
    s.evenings === want.evenings && s.wick === want.wick,
    `the save was not kept: evenings ${s.evenings} (fixture ${want.evenings}), Wick ${s.wick} (fixture ${want.wick})`,
  );
  return `${actions}; trip on ${s.zone}, evening ${s.evenings + 1}`;
}

// Visible text of the top modal (or of the whole body), whitespace collapsed.
const visibleText = (session, selector) =>
  session.eval((sel) => {
    const els = [...document.querySelectorAll(sel)].filter((el) => el.getBoundingClientRect().width > 0);
    return els.map((el) => el.textContent.replace(/\s+/g, " ").trim()).join(" | ");
  }, selector);

// The legend's old name and epithet, as they must no longer read anywhere a player can see.
const OLD_LEGEND_WORDS = /Matriarch|Tolls? for the Drowned|tolled for the drowned/i;
const NEW_LEGEND_NAME = "Bellhead Catfish";

// The parts of the built page a player can read: everything except script code, plus the two embedded
// field guides (JSON-encoded HTML documents) decoded. Code identifiers such as belled_matriarch and code
// comments are then removed: they are allowed to keep the old word.
function playerFacingMatches(html) {
  const hits = [];
  const report = (where, text, found) =>
    hits.push(`${where}: ...${text.slice(Math.max(0, found.index - 40), found.index + 60)}...`);
  // In code only string and template literals can reach the screen, so read those tokens alone.
  const lookInCode = (where, code, sourceType) => {
    for (const token of acorn.tokenizer(code, { ecmaVersion: "latest", sourceType, allowHashBang: true })) {
      if (token.type !== acorn.tokTypes.string && token.type !== acorn.tokTypes.template) continue;
      const words = String(token.value).replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g, " "); // snake_case ids
      const found = words.match(OLD_LEGEND_WORDS);
      if (found) report(where, words, found);
    }
  };
  const lookInDocument = (where, doc) => {
    for (const m of doc.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type="application\/json"/.test(m[1]))
        lookInDocument(`${where} embedded document`, JSON.parse(m[2]));
      else lookInCode(`${where} script`, m[2], /type="module"/.test(m[1]) ? "module" : "script");
    }
    const markup = doc.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ");
    const found = markup.match(OLD_LEGEND_WORDS);
    if (found) report(`${where} markup`, markup, found);
  };
  lookInDocument("page", html);
  return hits;
}

// ---- the scenarios --------------------------------------------------------------------------------------

const FIXTURE_NAMES = ["fresh-first-evening", "mid-mossmere", "legend-sold", "sporewood-crossed"];

const SCENARIOS = [
  ...FIXTURE_NAMES.map((name) => ({
    name: `${name} loads and reaches play without errors`,
    fixture: name,
    run: (session, { fixture }) => continueToPlay(session, fixture),
  })),

  {
    name: "legend-sold: the journal and the catch record name the Bellhead Catfish",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      const shown = [];
      const expectName = (where, text) => {
        check(
          text.includes(NEW_LEGEND_NAME),
          `${where} does not show "${NEW_LEGEND_NAME}": ${text.slice(0, 300)}`,
        );
        check(
          !OLD_LEGEND_WORDS.test(text),
          `${where} still shows the old name or epithet: ${text.slice(0, 300)}`,
        );
        shown.push(where);
      };
      // Her journal entry (the species page the Giants list and the lake page open).
      await session.eval(() => window.__gw.ui.openJournal({ sel: "belled_matriarch" }));
      await session.waitFor("her journal entry", 10_000, () => !!document.querySelector(".gw-jr-detail h3"));
      const entry = await visibleText(session, ".gw-jr-detail");
      expectName("journal entry", entry);
      check(
        /great catfish/i.test(entry),
        `her journal lore does not read as a catfish: ${entry.slice(0, 300)}`,
      );
      // The Prints and Giants tabs, which record her catch.
      for (const tab of ["prints", "giants"]) {
        await session.eval((t) => window.__gw.ui.openJournal({ tab: t }), tab);
        await session.pause(800);
        expectName(`journal ${tab} tab`, await visibleText(session, ".gw-m-catalogue"));
      }
      await session.eval(() => window.__gw.ui.closeAll());
      // The catch card when she is landed (again) on this save.
      await session.sail();
      check(
        await session.eval(() => window.__gw.debug.instantCatch("belled_matriarch")),
        "instantCatch(belled_matriarch) refused",
      );
      await session.waitFor("her catch card", 30_000, () =>
        [...document.querySelectorAll("button")].some(
          (b) => /Keep|Let go/.test(b.textContent) && b.getBoundingClientRect().width > 0,
        ),
      );
      expectName("catch card", await visibleText(session, ".gw-modal"));
      return `checked: ${shown.join(", ")}`;
    },
  },

  {
    name: 'built page: no player-facing "Matriarch" or old epithet',
    browser: false,
    run(_, { page }) {
      const html = readFileSync(page, "utf8");
      const hits = playerFacingMatches(html);
      check(hits.length === 0, `${hits.length} found:\n    ${hits.join("\n    ")}`);
      const named = html.split(NEW_LEGEND_NAME).length - 1;
      check(
        named >= 2,
        `"${NEW_LEGEND_NAME}" appears ${named} times in the page, expected the game and field guide`,
      );
      return `"${NEW_LEGEND_NAME}" appears ${named} times`;
    },
  },
];

// ---- the runner -----------------------------------------------------------------------------------------

const t0 = Date.now();
const secs = (ms) => (ms / 1000).toFixed(1);

async function runScenario(browser, scenario) {
  const started = Date.now();
  let session = null;
  let timer;
  try {
    const fixture = scenario.fixture
      ? readFileSync(join(FIXTURES_DIR, `${scenario.fixture}.json`), "utf8")
      : null;
    const context = { fixture: fixture ? JSON.parse(fixture) : null, page: PAGE };
    const work = async () => {
      if (scenario.browser === false) return scenario.run(null, context);
      session = await GameSession.open(browser, {
        page: PAGE,
        save: fixture,
        debug: !!scenario.debug,
        viewport: VIEWPORT,
      });
      await session.boot();
      const detail = await scenario.run(session, context);
      await session.pause(1000); // a moment more of play, then the error check
      await session.collectGameErrors();
      if (session.errors.length)
        throw new Error(`${session.errors.length} error(s):\n    ${session.errors.join("\n    ")}`);
      return detail;
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`over ${SCENARIO_TIMEOUT_MS / 1000}s`)), SCENARIO_TIMEOUT_MS);
    });
    const detail = await Promise.race([work(), timeout]);
    return {
      ok: true,
      line: `ok    ${scenario.name}${detail ? ` (${detail})` : ""} [${secs(Date.now() - started)}s]`,
    };
  } catch (e) {
    if (session) await session.collectGameErrors().catch(() => {});
    const extra = session?.errors.length ? `\n    errors: ${session.errors.join("\n    ")}` : "";
    return {
      ok: false,
      line: `FAIL  ${scenario.name}: ${e.message}${extra} [${secs(Date.now() - started)}s]`,
    };
  } finally {
    clearTimeout(timer);
    await session?.close().catch(() => {});
  }
}

async function main() {
  const chosen = SCENARIOS.filter((s) => !FILTERS.length || FILTERS.some((f) => s.name.includes(f)));
  if (!chosen.length) throw new Error(`no scenario matches ${FILTERS.join(", ")}`);
  console.log(`scenarios: ${chosen.length} on ${PAGE}, ${JOBS} at a time`);
  const browser = chosen.some((s) => s.browser !== false) ? await launchBrowser() : null;
  const budget = setTimeout(() => {
    console.error(`\nscenarios FAILED: over the ${BUDGET_MS / 1000}s budget`);
    process.exit(1);
  }, BUDGET_MS);
  let failed = 0;
  const queue = [...chosen];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      const result = await runScenario(browser, s);
      if (!result.ok) failed++;
      console.log(result.line);
    }
  };
  await Promise.all(Array.from({ length: Math.min(JOBS, chosen.length) }, worker));
  clearTimeout(budget);
  await browser?.close();
  console.log(
    `\nscenarios ${failed ? "FAILED" : "passed"}: ${chosen.length - failed} of ${chosen.length} in ${secs(Date.now() - t0)}s`,
  );
  return failed ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\nscenarios FAILED: ${e.stack || e}`);
    process.exit(1);
  });
