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

const BUDGET_MS = 480_000; // every scenario, launch to exit
const SCENARIO_TIMEOUT_MS = 240_000;
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

// ---- the Bellhead Catfish's landing rules ----------------------------------------------------------------

const LEGEND_ID = "belled_matriarch";
const LANDING_CAP = 0.75;
const LINE_LOSS_TEXT =
  "She ran for the bell and rasped the Braided Gut through. Only Waxed Silk will hold her.";
const FIGHT_LOSS_TEXT = "The hook pulled at the bell. She'll remember it.";

// At home: gives clams and buys the given shelf items (e.g. "line:1") in order; returns the tackle tiers.
async function buyAtHome(session, ids) {
  const result = await session.eval((list) => {
    const loop = window.__gw.progression.loop;
    window.__gw.debug.loop.giveClams(5000);
    const refused = list.filter((id) => loop.buy(id)?.ok !== true);
    return { refused, tackle: { ...loop.state().tackle } };
  }, ids);
  check(!result.refused.length, `Murk's shelf refused ${result.refused.join(", ")}`);
  return result.tackle;
}

// On the water: hooks the species at once through the debug hooks (a struck strike) with the outcome forced
// ("land", "lose") or left to the game's roll (null), then plays the fight to its end. Returns the landing
// chance the strike rolled against and what happened: { p, escape } (the fish:escaped event) or { p, landed }.
// The cast's own snag roll can put a find on the hook instead (a certain catch, p 1); that one is let go and
// the hook tried again.
async function hookAndPlayOut(session, speciesId, outcome) {
  for (let tries = 0; tries < 5; tries++) {
    const result = await hookOnce(session, speciesId, outcome);
    if (!result.find) return result;
    await session.clickButton(/^\d?Let go\b/);
    await session.pause(800);
    await session.closeGuides(4000);
  }
  throw new Error(`a find came up on every hook of ${speciesId}`);
}

async function hookOnce(session, speciesId, outcome) {
  const hooked = await session.eval(
    ([id, forced]) => {
      const g = window.__gw;
      if (!window.__hookLog) {
        window.__hookLog = { escaped: [], landed: [] };
        g.bus.on("fish:escaped", (e) => window.__hookLog.escaped.push(JSON.parse(JSON.stringify(e))));
        g.bus.on("fish:landed", (e) => window.__hookLog.landed.push(e?.species?.id ?? null));
      }
      g.debug.fishOutcome(forced);
      const ok = g.debug.fishHook(id);
      return {
        ok,
        state: g.fishing.state,
        p: g.debug.fishChance(),
        escaped: window.__hookLog.escaped.length,
        landed: window.__hookLog.landed.length,
      };
    },
    [speciesId, outcome],
  );
  check(hooked.ok && hooked.state === "reeling", `could not hook ${speciesId}: ${JSON.stringify(hooked)}`);
  await session.eval(() => window.__gw.debug.fishPlayTo(0.995));
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    const now = await session.eval(() => ({
      escaped: window.__hookLog.escaped,
      landed: window.__hookLog.landed,
      card: [...document.querySelectorAll("button")].some(
        (b) => /Keep|Let go/.test(b.textContent) && b.getBoundingClientRect().width > 0,
      ),
    }));
    if (now.escaped.length > hooked.escaped) return { p: hooked.p, escape: now.escaped.at(-1) };
    if (hooked.p === 1 && now.card) return { find: true };
    if (now.landed.length > hooked.landed && now.card) return { p: hooked.p, landed: now.landed.at(-1) };
    await session.clickButton(/^Got it$/);
    await session.pause(400);
  }
  throw new Error(`the fight did not end; ${JSON.stringify(await session.state())}`);
}

// The escape line shown where the gear-limit message appears (the strike word, gw-strike-gear).
async function escapeLine(session) {
  await session.waitFor("the escape line", 10_000, () =>
    [...document.querySelectorAll(".gw-strike-gear")].some((el) => el.textContent.trim()),
  );
  return visibleText(session, ".gw-strike-gear");
}

const legendRecord = (session) =>
  session.eval(
    (id) => ({
      hunt: JSON.parse(JSON.stringify(window.__gw.progression.loop.state().hunt ?? null)),
      wounds: window.__gw.state.meta.legendWounds?.[id] ?? 0,
    }),
    LEGEND_ID,
  );

// Her landing odds as the journal's species page shows them ("Landing odds once hooked").
async function journalOdds(session) {
  await session.eval((id) => window.__gw.ui.openJournal({ sel: id }), LEGEND_ID);
  await session.waitFor("her odds on the journal page", 10_000, () => !!document.querySelector(".gw-odds"));
  const text = await visibleText(session, ".gw-odds");
  await session.eval(() => window.__gw.ui.closeAll());
  return text;
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

  {
    name: "hunt rules: an old save gains the hunt record; on Braided Gut she is always lost, with the line message, the lesson saved and no wound",
    fixture: "mid-mossmere",
    debug: true,
    async run(session, { fixture }) {
      // The old save (made before the hunt record existed) loads and gains it, the rest kept.
      check(fixture.meta.loop.hunt === undefined, "the fixture already has a hunt record");
      const loaded = await legendRecord(session);
      check(
        JSON.stringify(loaded.hunt) === JSON.stringify({ mossmere: { lineLesson: false } }),
        `the loaded save's hunt record: ${JSON.stringify(loaded.hunt)}`,
      );
      await session.toHome();
      const written = JSON.parse(await session.saved());
      check(
        written.meta.loop.hunt?.mossmere?.lineLesson === false,
        `the written save's hunt record: ${JSON.stringify(written.meta.loop.hunt)}`,
      );
      check(written.meta.loop.evenings === fixture.meta.loop.evenings, "the rest of the save was not kept");
      const tackle = await buyAtHome(session, ["line:1"]);
      check(tackle.line === 1, `the line is tier ${tackle.line}, expected Braided Gut (1)`);
      await session.sail();
      // Forced to "land": a line too weak for her must still lose.
      const hooked = await hookAndPlayOut(session, LEGEND_ID, "land");
      check(hooked.p === 0, `landing chance on Braided Gut is ${hooked.p}, expected 0`);
      check(hooked.escape, "she was landed on Braided Gut");
      check(
        hooked.escape.legendLossReason === "line",
        `escape reason ${hooked.escape.legendLossReason}, expected line`,
      );
      const shown = await escapeLine(session);
      check(shown === LINE_LOSS_TEXT, `escape line "${shown}", expected "${LINE_LOSS_TEXT}"`);
      const after = await legendRecord(session);
      check(
        after.hunt?.mossmere?.lineLesson === true,
        `the lesson was not set: ${JSON.stringify(after.hunt)}`,
      );
      check(after.wounds === 0, `a loss to the line added a wound (${after.wounds})`);
      const saved = JSON.parse(await session.saved());
      check(saved.meta.loop.hunt?.mossmere?.lineLesson === true, "the lesson is not in the written save");
      check(!saved.meta.legendWounds?.[LEGEND_ID], "the written save has a wound for her");
      return `old save gained the record; p 0, "${shown}", lineLesson saved, no wound`;
    },
  },

  {
    name: "hunt rules: landing odds and caps (her 0.75 and the line rule on the odds page; the Grove's 0.5; ordinary fish)",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      // The journal's odds for her follow the fitted line: nothing on Braided Gut, a chance on Waxed Silk.
      await buyAtHome(session, ["line:1"]);
      const gutOdds = await journalOdds(session);
      check(/(^|\D)0%/.test(gutOdds), `the journal odds on Braided Gut do not read 0%: ${gutOdds}`);
      const tackle = await buyAtHome(session, ["line:2"]);
      check(tackle.line === 2, `the line is tier ${tackle.line}, expected Waxed Silk (2)`);
      const silkOdds = await journalOdds(session);
      const silkPct = Number(silkOdds.match(/(\d+)%/)?.[1]);
      check(silkPct > 0 && silkPct <= 75, `the journal odds on Waxed Silk read ${silkOdds}`);
      const r = await session.eval((id) => {
        const parts = (species, cls, hold, strike, wounds = 0) =>
          window.__gw.data.catchParts(species, cls, { hold }, { strike, wounds });
        const strong = { rod: 1000, line: 1000, reel: 1000 };
        return {
          ceiling: parts(id, "legend", strong, "clean"),
          fullKit: parts(id, "legend", { rod: 5, line: 5, reel: 5 }, "clean", 3),
          silkAlone: parts(id, "legend", { rod: 0, line: 5, reel: 0 }, "struck"),
          onGut: parts(id, "legend", { rod: 1000, line: 2, reel: 1000 }, "clean", 3),
          grove: parts("drifting_grove", "legend", strong, "clean"),
          groveTwine: parts("drifting_grove", "legend", { rod: 5, line: 0, reel: 5 }, "clean"),
          pikeTwine: parts("reedjaw_pike", "trophy", { rod: 5, line: 0, reel: 5 }, "clean"),
        };
      }, LEGEND_ID);
      check(r.ceiling.cap === LANDING_CAP, `her cap is ${r.ceiling.cap}, expected ${LANDING_CAP}`);
      check(r.ceiling.p <= LANDING_CAP && r.ceiling.p > 0.74, `her ceiling is ${r.ceiling.p}`);
      check(Math.abs(r.fullKit.p - 0.728) < 0.001, `full kit, 3 wounds: ${r.fullKit.p}, expected 0.728`);
      check(
        Math.abs(r.silkAlone.p - 0.3937) < 0.001,
        `Waxed Silk alone, struck: ${r.silkAlone.p}, expected 0.3937`,
      );
      check(
        r.onGut.p === 0 && r.onGut.landingBlockedBy === "line",
        `on Braided Gut: ${JSON.stringify(r.onGut)}`,
      );
      check(
        r.grove.cap === 0.5 && r.grove.p <= 0.5 && r.grove.p > 0.49,
        `the Grove: ${JSON.stringify(r.grove)}`,
      );
      check(
        r.groveTwine.p > 0 && !r.groveTwine.landingBlockedBy,
        `the Grove on Twine: ${JSON.stringify(r.groveTwine)}`,
      );
      check(
        r.pikeTwine.p > 0 && r.pikeTwine.cap === 0.88 && !r.pikeTwine.landingBlockedBy,
        `pike: ${JSON.stringify(r.pikeTwine)}`,
      );
      return `journal ${gutOdds.match(/\d+%/)?.[0]} on Braided Gut, ${silkPct}% on Waxed Silk; her ceiling ${r.ceiling.p.toFixed(4)}; Grove cap ${r.grove.cap}`;
    },
  },

  {
    name: "hunt rules: on Waxed Silk a lost fight says so and wounds her",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await session.sail();
      const lost = await hookAndPlayOut(session, LEGEND_ID, "lose");
      check(lost.p > 0 && lost.p <= LANDING_CAP, `landing chance on Waxed Silk is ${lost.p}`);
      check(
        lost.escape?.legendLossReason === "fight",
        `escape reason ${lost.escape?.legendLossReason}, expected fight`,
      );
      const shown = await escapeLine(session);
      check(shown === FIGHT_LOSS_TEXT, `escape line "${shown}", expected "${FIGHT_LOSS_TEXT}"`);
      const record = await legendRecord(session);
      check(record.wounds === 1, `a lost fight gave ${record.wounds} wounds, expected 1`);
      check(record.hunt?.mossmere?.lineLesson === false, "a lost fight on Waxed Silk set the line lesson");
      return `lost at p ${lost.p.toFixed(3)}, "${shown}", wounds 1`;
    },
  },

  {
    name: "hunt rules: on Waxed Silk she can be landed",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await session.sail();
      const landed = await hookAndPlayOut(session, LEGEND_ID, "land");
      check(landed.p > 0 && landed.p <= LANDING_CAP, `landing chance on Waxed Silk is ${landed.p}`);
      check(landed.landed === LEGEND_ID, `she was not landed: ${JSON.stringify(landed)}`);
      return `landed at p ${landed.p.toFixed(3)}`;
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
