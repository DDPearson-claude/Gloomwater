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
//   editSave (save) => { ... }: changes the parsed fixture before it is loaded, for a kind of save no
//            fixture holds
//   timeoutMs a longer time limit than SCENARIO_TIMEOUT_MS, for a scenario that opens many screens
//   run      async (session, { fixture, page }) => { ... }: throw an Error to fail. `session` is a
//            GameSession (tools/game-driver.mjs) that has booted to the title; `fixture` is the parsed save.

import { readFileSync } from "node:fs";
import * as acorn from "acorn";
import { join } from "node:path";
import { DEFAULT_PAGE, GameSession, ROOT, launchBrowser } from "./game-driver.mjs";

const BUDGET_MS = 1_500_000; // every scenario, launch to exit
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
function playerFacingMatches(html, words = OLD_LEGEND_WORDS) {
  const hits = [];
  const report = (where, text, found) =>
    hits.push(`${where}: ...${text.slice(Math.max(0, found.index - 40), found.index + 60)}...`);
  // In code only string and template literals can reach the screen, so read those tokens alone.
  const lookInCode = (where, code, sourceType) => {
    for (const token of acorn.tokenizer(code, { ecmaVersion: "latest", sourceType, allowHashBang: true })) {
      if (token.type !== acorn.tokTypes.string && token.type !== acorn.tokTypes.template) continue;
      const text = String(token.value).replace(/\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g, " "); // snake_case ids
      const found = text.match(words);
      if (found) report(where, text, found);
    }
  };
  const lookInDocument = (where, doc) => {
    for (const m of doc.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      if (/type="application\/json"/.test(m[1]))
        lookInDocument(`${where} embedded document`, JSON.parse(m[2]));
      else lookInCode(`${where} script`, m[2], /type="module"/.test(m[1]) ? "module" : "script");
    }
    const markup = doc.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, " ");
    const found = markup.match(words);
    if (found) report(`${where} markup`, markup, found);
  };
  lookInDocument("page", html);
  return hits;
}

// ---- the Bellhead Catfish's landing rules ----------------------------------------------------------------

const LEGEND_ID = "belled_matriarch";
const LANDING_CAP = 0.75;
const LINE_LOSS_TEXT = "That one got away! Your Braided Gut snaps by the rod. Only Waxed Silk will hold it.";
const FIGHT_LOSS_TEXT = "It shook free right under the raft. Everything held.";

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
// the hook tried again. With `lead` (seconds), the fight plays at its own pace that long before it is
// skipped to its end, so what the first moments show (the banner) is seen.
async function hookAndPlayOut(session, speciesId, outcome, { lead = 0 } = {}) {
  for (let tries = 0; tries < 5; tries++) {
    const result = await hookOnce(session, speciesId, outcome, lead);
    if (!result.find) return result;
    await session.clickButton(/^\d?Let go\b/);
    await session.pause(800);
    await session.closeGuides(4000);
  }
  throw new Error(`a find came up on every hook of ${speciesId}`);
}

async function hookOnce(session, speciesId, outcome, lead = 0) {
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
  for (const leadEnd = Date.now() + 60_000; lead > 0 && Date.now() < leadEnd; ) {
    const f = await session.eval(() => window.__gw.debug.fishing());
    if (f.state !== "reeling" || f.playT >= lead) break;
    await session.clickButton(/^Got it$/);
    await session.pause(300);
  }
  await session.eval(() => window.__gw.debug.fishPlayTo(0.995));
  const end = Date.now() + 150_000; // a landing show is slow when other sessions share the CPU
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

// ---- the thief stays hidden until she is landed -----------------------------------------------------------

// Words that would say what she is. Until she is landed the game says "the thief" and "Something ancient.".
const HER_WORDS = /Bellhead|cat\s?fish|\bwels\b|whisker|Matriarch|Tolls? for the Drowned/i;
const HER_LORE = "She's a wels catfish, the biggest fish in Mossmere.";
const HIDDEN_BANNER = "Something ancient.";

// What the open screens put in front of the player: all text outside scripts and styles (folded and hidden
// parts included), every element's label, the species that cards and rows stand for, and whether the Bell
// Pool's map card carries a fish picture.
const screenContents = (session) =>
  session.eval(() => {
    const texts = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest("script, style, template")
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node.nodeValue);
    const labels = [...document.querySelectorAll("[aria-label], [title], [alt], [placeholder]")].flatMap(
      (el) => ["aria-label", "title", "alt", "placeholder"].map((a) => el.getAttribute(a)).filter(Boolean),
    );
    const fish = [...document.querySelectorAll("[data-fish], [data-species]")].map(
      (el) => el.dataset.fish || el.dataset.species,
    );
    return {
      text: `${texts.join(" ")} ${labels.join(" | ")}`.replace(/\s+/g, " "),
      fish: [...new Set(fish)],
      bellPoolFishArt: !!document.querySelector(
        '[data-place="bell_pool"] .gw-plate-map, [data-place="bell_pool"] .gw-map-fish',
      ),
    };
  });

// Fails if the open screens show anything of her: her name or kind in words, a card or row for her, or a
// fish picture on the Bell Pool's map card.
async function expectHidden(session, where, seen) {
  const c = await screenContents(session);
  const found = c.text.match(HER_WORDS);
  check(
    !found,
    `${where} says "${found?.[0]}": ...${c.text.slice(Math.max(0, (found?.index ?? 0) - 80), (found?.index ?? 0) + 80)}...`,
  );
  check(!c.fish.includes(LEGEND_ID), `${where} has a card or row for her`);
  check(!c.bellPoolFishArt, `${where}: the Bell Pool's map card has a fish picture`);
  seen.push(where);
}

const clickAll = (session, selector, index) =>
  session.eval(
    ([sel, i]) => {
      const el = document.querySelectorAll(sel)[i];
      if (!el) return false;
      el.click();
      return true;
    },
    [selector, index],
  );
const countOf = (session, selector) => session.eval((sel) => document.querySelectorAll(sel).length, selector);

// Closes screens (Escape) until the barge at home is in front again, with Murk, Chart and Journal.
async function backToJetty(session) {
  for (let i = 0; i < 8; i++) {
    const top = await session.eval(
      () =>
        [...document.querySelectorAll(".gw-modal")]
          .filter((m) => m.classList.contains("gw-in") && !m.classList.contains("gw-covered"))
          .map((m) => m.dataset.modal)
          .pop() ?? null,
    );
    if (top === "jetty") return;
    await session.page.keyboard.press("Escape");
    await session.pause(500);
  }
  throw new Error(`could not get back to the barge; ${JSON.stringify(await session.state())}`);
}

// The field guide opens in a new tab. Pages through every species and returns what each page showed
// ({ name, lore, alt, locked }) and the picker's labels.
async function fieldGuidePages(session) {
  const opened = session.context.waitForEvent("page", { timeout: 20_000 });
  check(await session.clickButton(/^3D field guide$/), "the journal has no 3D field guide button");
  const guide = await opened;
  try {
    await guide.waitForFunction(() => document.getElementById("picker")?.options.length > 0, null, {
      timeout: 20_000,
    });
    return await guide.evaluate(() => {
      const picker = document.getElementById("picker");
      const pages = [];
      for (let i = 0; i < picker.options.length; i++) {
        document.getElementById("next").click();
        pages.push({
          name: document.getElementById("name").textContent,
          lore: document.getElementById("lore").textContent,
          alt: document.getElementById("plate").alt,
          locked: !document.getElementById("locked").hidden,
        });
      }
      return { options: [...picker.options].map((o) => o.textContent), pages };
    });
  } finally {
    await guide.close();
  }
}

// At home: opens every screen a player can reach and runs `look(where)` on each: the Journal and each of its
// tabs (the Wick's sheet page by page, its Odds page for every place and light), the field guide, Murk's
// shelf tab by tab, the chart and each of its marks, and settings.
async function visitEveryScreen(session, look) {
  await look("home");
  await session.eval(() => window.__gw.ui.openJournal({}));
  await session.waitFor("the journal", 10_000, () => !!document.querySelector(".gw-m-catalogue .gw-tab"));
  const tabs = ".gw-m-catalogue .gw-tab";
  for (let t = 0; t < (await countOf(session, tabs)); t++) {
    await clickAll(session, tabs, t);
    await session.pause(700);
    const tab = await session.eval(
      ([sel, i]) => {
        const el = document.querySelectorAll(sel)[i];
        return el?.dataset.tab || el?.getAttribute("aria-label") || el?.textContent.trim() || String(i);
      },
      [tabs, t],
    );
    await look(`journal tab ${tab}`);
    const pages = "[data-sheet-page]";
    for (let p = 0; p < (await countOf(session, pages)); p++) {
      const page = await session.eval(
        ([sel, i]) => document.querySelectorAll(sel)[i]?.dataset.sheetPage,
        [pages, p],
      );
      await clickAll(session, pages, p);
      await session.pause(500);
      await look(`journal sheet page ${page}`);
      if (page !== "odds") continue;
      // Every place, then every light.
      for (const pick of ["[data-where]", "[data-hour]"])
        for (let i = 0; i < (await countOf(session, pick)); i++) {
          await clickAll(session, pick, i);
          await session.pause(400);
          const picked = await session.eval(() =>
            [...document.querySelectorAll("[data-where][aria-pressed=true], [data-hour][aria-pressed=true]")]
              .map((b) => b.dataset.where || b.dataset.hour)
              .join(" "),
          );
          await look(`odds sheet, ${picked}`);
        }
    }
  }
  // The lake page again, for its field guide button.
  await session.eval(() => window.__gw.ui.openJournal({ zone: "mossmere" }));
  await session.pause(800);
  const guide = await fieldGuidePages(session);
  await backToJetty(session);
  // Murk's shelf, every tab.
  check(await session.clickButton(/^Murk$/), "no Murk button at home");
  await session.pause(1500);
  await session.closeGuides(3000);
  for (const tab of ["Tackle", "Raft", "Bait", "Maps", "Home"]) {
    if (!(await session.clickButton(new RegExp(`^${tab}$`)))) continue;
    await session.pause(800);
    await look(`Murk's ${tab} tab`);
  }
  await backToJetty(session);
  // The chart, and each place and purchase marked on it.
  const openChart = async () => {
    await session.waitFor("the Chart button", 10_000, () =>
      [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Chart"),
    );
    await session.clickButton(/^Chart$/);
    await session.waitFor("the chart", 10_000, () => !!document.querySelector(".gw-chart-hit"));
    await session.pause(800);
  };
  await openChart();
  await look("chart");
  const marks = await session.eval(() =>
    [...document.querySelectorAll(".gw-chart-hit")]
      .map((h) => h.dataset.id)
      .filter((id) => /^(place|buy|sealed):/.test(id)),
  );
  for (const mark of marks) {
    if (!(await session.eval(() => !!document.querySelector(".gw-chart-hit")))) {
      await backToJetty(session);
      await openChart();
    }
    await session.eval((id) => document.querySelector(`.gw-chart-hit[data-id="${id}"]`)?.click(), mark);
    await session.pause(900);
    await look(`chart mark ${mark}`);
  }
  await backToJetty(session);
  await session.eval(() => window.__gw.ui.openSettings());
  await session.pause(800);
  await look("settings");
  await backToJetty(session);
  return guide;
}

// The field guide's pages must show her only as a locked "Undiscovered" page.
function expectGuideHidden(guide) {
  const all = [...guide.options, ...guide.pages.flatMap((p) => [p.name, p.lore, p.alt])].join(" | ");
  const found = all.match(HER_WORDS);
  check(!found, `the field guide shows "${found?.[0]}"`);
  check(!all.includes(HER_LORE), "the field guide shows her lore");
}

// Her odds row on the Odds sheet at home, for the Bell Pool (owned, its mist lifted) by day with the
// Heartmoss Ball fitted: the place, light and bait she bites on today. Also the count of kinds not met.
async function bellPoolOdds(session) {
  const odds = await session.eval((id) => {
    const loop = window.__gw.progression.loop;
    loop.markLifted("bell_pool");
    const fitted = loop.fit("bait", "heartmoss")?.ok === true;
    const sheet = loop.sheet({ place: "bell_pool", light: "day" });
    return {
      fitted,
      place: sheet?.picks?.place ?? null,
      row: sheet?.odds?.rows?.find((r) => r.id === id) ?? null,
      unmet: sheet?.odds?.unmet ?? null,
    };
  }, LEGEND_ID);
  check(
    odds.fitted && odds.place === "bell_pool",
    `the Odds sheet is not on the Bell Pool with Heartmoss: ${JSON.stringify(odds)}`,
  );
  return odds;
}

// Records everything the hook-up, the fight and its end put on screen (every text or label added to the
// page, the banner included, and every toast) and, while she is on the line, whether her model is in the
// water. Read it back with heardOnWater.
const listenOnWater = (session) =>
  session.eval(() => {
    const said = (window.__thiefWatch = { lines: [], models: [], landedAt: null });
    const note = (t) => {
      const line = String(t ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (line && !said.lines.includes(line)) said.lines.push(line);
    };
    new MutationObserver((changes) => {
      for (const m of changes) {
        if (m.type === "characterData") note(m.target.textContent);
        if (m.type === "attributes") note(m.target.getAttribute(m.attributeName));
        for (const n of m.addedNodes || [])
          if (!n.parentElement?.closest?.("script, style")) note(n.textContent);
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "title", "alt"],
    });
    window.__gw.bus.on("toast", (e) => note(e?.text));
    window.__gw.bus.on("fish:landed", () => (said.landedAt ??= said.lines.length));
    // Her model during the fight: the fishing snapshot's model length is null while only a dark shape shows.
    said.timer = setInterval(() => {
      const f = window.__gw.debug.fishing?.();
      if (f?.species === "belled_matriarch")
        said.models.push({ state: f.state, revealed: f.revealed, model: f.fvLength ?? null });
    }, 250);
  });
const heardOnWater = (session) =>
  session.eval(() => {
    const { lines, models, landedAt } = window.__thiefWatch;
    return { lines, models, landedAt };
  });

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
        /wels catfish/i.test(entry),
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

  ...["fresh-first-evening", "mid-mossmere"].map((name) => ({
    name: `the thief stays hidden: ${name}, every screen at home`,
    fixture: name,
    debug: true,
    timeoutMs: 420_000,
    async run(session) {
      await session.toHome();
      const seen = [];
      const guide = await visitEveryScreen(session, (where) => expectHidden(session, where, seen));
      expectGuideHidden(guide);
      return `${seen.length} screens and ${guide.pages.length} field guide pages`;
    },
  })),

  {
    name: "the thief stays hidden: an old save that has seen and lost her, with the Bell Pool on Murk's shelf",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    // An older game marked her seen and lost; the two cheaper charts are owned, so the Bell Pool's map card
    // is the one Murk offers.
    editSave(save) {
      save.meta.journal[LEGEND_ID] = { caught: 0, biggest: 0, seen: true, gotAway: [{ zone: "mossmere" }] };
      save.meta.loop.maps.places.push("under_the_span", "buoy_lights");
      save.meta.loop.clams = 2000;
    },
    async run(session) {
      await session.toHome();
      const seen = [];
      const guide = await visitEveryScreen(session, (where) => expectHidden(session, where, seen));
      expectGuideHidden(guide);
      check(seen.includes("Murk's Maps tab"), `Murk's Maps tab was not opened: ${seen.join(", ")}`);
      const card = await session.eval(() =>
        window.__gw.progression.loop.mapCards().find((c) => c.placeId === "bell_pool"),
      );
      check(card && card.fish === null, `the Bell Pool's map card: ${JSON.stringify(card)}`);
      // Her own journal page does not open.
      await session.eval((id) => window.__gw.ui.openJournal({ sel: id }), LEGEND_ID);
      await session.pause(800);
      check(
        !(await session.eval(() => !!document.querySelector(".gw-jr-detail"))),
        "her journal page opened",
      );
      await expectHidden(session, "the journal opened at her page", seen);
      await backToJetty(session);
      // With the Bell Pool bought and the Heartmoss Ball fitted she can bite, but the Odds sheet has no row
      // for her: she counts as a kind not met.
      check(
        await session.eval(() => window.__gw.progression.loop.buy("place:bell_pool")?.ok === true),
        "Murk would not sell the Bell Pool",
      );
      const odds = await bellPoolOdds(session);
      check(odds.unmet >= 1, `the Odds sheet counts ${odds.unmet} kinds not met`);
      check(!odds.row, `the Odds sheet has a row for her: ${JSON.stringify(odds.row)}`);
      await session.eval(() => window.__gw.ui.openJournal({ tab: "sheet" }));
      await session.pause(800);
      await clickAll(session, '[data-sheet-page="odds"]', 0);
      await session.pause(500);
      await clickAll(session, '[data-where="bell_pool"]', 0);
      await session.pause(300);
      await clickAll(session, '[data-hour="day"]', 0);
      await session.pause(500);
      await expectHidden(session, "odds sheet, bell_pool day, Heartmoss Ball", seen);
      return `${seen.length} screens; Bell Pool card plain; odds: ${odds.unmet} not met, no row`;
    },
  },

  {
    name: 'the thief while hooked: "Something ancient." through the hook-up, a fight on Waxed Silk and its loss, no model',
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await session.sail();
      // The Sporewood seal built from her name reads as the thief too.
      const seal = await session.eval(() => {
        const req = window.__gw.data.ZONES.find((z) => z.id === "sporewood")?.unlock?.requires?.[0];
        const stored = req?.label;
        if (req) delete req.label;
        const built = window.__gw.progression.getGateInfo?.()?.requirements?.[0]?.label ?? null;
        if (req) req.label = stored;
        return { stored, built };
      });
      check(seal.stored === "Land the thief of the mere.", `the stored seal label reads "${seal.stored}"`);
      check(
        seal.built === "Land the thief of the mere.",
        `the seal label built from her name reads "${seal.built}"`,
      );
      await listenOnWater(session);
      const lost = await hookAndPlayOut(session, LEGEND_ID, "lose", { lead: 2 });
      check(lost.escape?.legendLossReason === "fight", `escape reason ${lost.escape?.legendLossReason}`);
      const shown = await escapeLine(session);
      check(shown === FIGHT_LOSS_TEXT, `escape line "${shown}", expected "${FIGHT_LOSS_TEXT}"`);
      const heard = await heardOnWater(session);
      check(
        heard.lines.some((l) => l.includes(HIDDEN_BANNER)),
        `"${HIDDEN_BANNER}" was never shown: ${heard.lines.join(" / ").slice(0, 400)}`,
      );
      const said = heard.lines.join(" / ");
      const found = said.match(HER_WORDS);
      check(
        !found,
        `the water showed "${found?.[0]}": ${said.slice(Math.max(0, found?.index - 120), found?.index + 80)}`,
      );
      check(!/\b(she|her)\b/i.test(shown), `the escape line calls her "she": ${shown}`);
      const fight = heard.models.filter((m) => m.state === "reeling" || m.state === "lost");
      check(fight.length > 0, "the fight was never sampled");
      check(
        fight.every((m) => m.model === null),
        `her model was in the water during the fight (${fight.filter((m) => m.model !== null).length} samples)`,
      );
      await expectHidden(session, "the water after she got away", []);
      // Home: Murk's tally of the evening says nothing of her either.
      for (const homeBy = Date.now() + 60_000; !(await session.eval(() => window.__gw.game.goHome())); ) {
        check(Date.now() < homeBy, `the game will not go home: ${JSON.stringify(await session.state())}`);
        await session.closeGuides(3000);
        await session.pause(1000);
      }
      const soldShown = () =>
        [...document.querySelectorAll("button")].some(
          (b) => b.textContent.trim() === "Sold" && b.getBoundingClientRect().width > 0,
        );
      await session.waitFor("Murk's tally", 90_000, soldShown);
      await expectHidden(session, "Murk's tally after she got away", []);
      return `banner "${HIDDEN_BANNER}", ${fight.length} samples of the fight and loss without her model, "${shown}"`;
    },
  },

  {
    name: "the thief revealed: hidden before, named on the catch card when landed, then shown in the Journal, Giants tab, Odds sheet and field guide",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    async run(session) {
      await session.toHome();
      // Before: no card, no Giants entry, no field guide page.
      const before = [];
      await session.eval(() => window.__gw.ui.openJournal({ zone: "mossmere" }));
      await session.pause(800);
      await expectHidden(session, "journal lake page before", before);
      const guideBefore = await fieldGuidePages(session);
      expectGuideHidden(guideBefore);
      await session.eval(() => window.__gw.ui.openJournal({ tab: "giants" }));
      await session.pause(800);
      await expectHidden(session, "journal Giants tab before", before);
      await backToJetty(session);
      // Landed: the hook-up still says "Something ancient."; the catch card names her and shows her model.
      await buyAtHome(session, ["line:1", "line:2"]);
      await session.sail();
      await listenOnWater(session);
      const landed = await hookAndPlayOut(session, LEGEND_ID, "land", { lead: 2 });
      check(landed.landed === LEGEND_ID, `she was not landed: ${JSON.stringify(landed)}`);
      const heard = await heardOnWater(session);
      check(
        heard.lines.some((l) => l.includes(HIDDEN_BANNER)),
        `"${HIDDEN_BANNER}" was never shown: ${heard.lines.join(" / ").slice(0, 400)}`,
      );
      const beforeLanding = heard.lines.slice(0, heard.landedAt ?? heard.lines.length).join(" / ");
      check(
        !HER_WORDS.test(beforeLanding),
        `she was named before she was landed: ${beforeLanding.slice(0, 400)}`,
      );
      const card = await visibleText(session, ".gw-modal");
      check(card.includes(NEW_LEGEND_NAME), `the catch card does not name her: ${card.slice(0, 300)}`);
      check(
        heard.models.some((m) => m.state === "reeling" && !m.revealed) &&
          heard.models.every((m) => m.revealed || m.model === null),
        `her model was in the water before the landing: ${JSON.stringify(heard.models.slice(0, 8))}`,
      );
      check(
        heard.models.some((m) => m.revealed && m.model > 0),
        `her model is not shown at the landing: ${JSON.stringify(heard.models.slice(-4))}`,
      );
      await session.clickButton(/^\d?Keep\b/);
      await session.pause(800);
      await session.closeGuides(5000);
      await session.goHomeAndTally();
      // After: her card on the lake page, her Giants entry, her own page with the new lore, her Odds row
      // and her field guide page.
      await session.eval(() => window.__gw.ui.openJournal({ zone: "mossmere" }));
      await session.pause(800);
      let c = await screenContents(session);
      check(c.fish.includes(LEGEND_ID), "the lake page has no card for her after the landing");
      await session.eval(() => window.__gw.ui.openJournal({ tab: "giants" }));
      await session.pause(800);
      c = await screenContents(session);
      check(
        c.fish.includes(LEGEND_ID) && c.text.includes(NEW_LEGEND_NAME),
        "the Giants tab does not show her",
      );
      await session.eval((id) => window.__gw.ui.openJournal({ sel: id }), LEGEND_ID);
      await session.waitFor("her journal page", 10_000, () => !!document.querySelector(".gw-jr-detail h3"));
      const entry = await visibleText(session, ".gw-jr-detail");
      check(entry.includes(NEW_LEGEND_NAME) && entry.includes(HER_LORE), `her page: ${entry.slice(0, 300)}`);
      await session.eval(() => window.__gw.ui.openJournal({ zone: "mossmere" }));
      await session.pause(800);
      const guide = await fieldGuidePages(session);
      const page = guide.pages.find((p) => p.name === NEW_LEGEND_NAME);
      check(
        page && !page.locked && page.lore.includes(HER_LORE),
        `her field guide page: ${JSON.stringify(page)}`,
      );
      check(guide.options.includes(NEW_LEGEND_NAME), "the field guide's picker does not name her");
      await session.eval(() => window.__gw.ui.closeAll());
      await buyAtHome(session, ["place:under_the_span", "place:buoy_lights", "place:bell_pool"]);
      const odds = await bellPoolOdds(session);
      check(odds.row?.legend === true && odds.row.share > 0, `her Odds row: ${JSON.stringify(odds)}`);
      return `hidden before; "${HIDDEN_BANNER}" on the hook; named on the catch card; shown after (odds share ${odds.row.share})`;
    },
  },

  {
    name: "legend-sold: she shows on the lake page, the Giants tab, the Odds sheet and the field guide",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      await session.eval(() => window.__gw.ui.openJournal({ zone: "mossmere" }));
      await session.pause(800);
      let c = await screenContents(session);
      check(c.fish.includes(LEGEND_ID), "the lake page has no card for her");
      const guide = await fieldGuidePages(session);
      const page = guide.pages.find((p) => p.name === NEW_LEGEND_NAME);
      check(page && page.lore.includes(HER_LORE), `her field guide page: ${JSON.stringify(page)}`);
      await session.eval(() => window.__gw.ui.openJournal({ tab: "giants" }));
      await session.pause(800);
      c = await screenContents(session);
      check(
        c.fish.includes(LEGEND_ID) && c.text.includes(NEW_LEGEND_NAME),
        "the Giants tab does not show her",
      );
      await session.eval(() => window.__gw.ui.closeAll());
      const odds = await bellPoolOdds(session);
      check(odds.row?.legend === true && odds.row.share > 0, `her Odds row: ${JSON.stringify(odds)}`);
      return `lake page, Giants tab, field guide and Odds row (share ${odds.row.share})`;
    },
  },

  {
    name: "built page: her old lines are gone and her new lore is in all three copies",
    browser: false,
    run(_, { page }) {
      const html = readFileSync(page, "utf8");
      const hits = playerFacingMatches(
        html,
        /Hook-Thief|Land the Bellhead|great catfish|Listen for a bell beneath/i,
      );
      check(hits.length === 0, `${hits.length} found:\n    ${hits.join("\n    ")}`);
      const copies = html.split(HER_LORE).length - 1;
      check(
        copies === 3,
        `her new lore appears ${copies} times, expected 3 (species, live record, field guide)`,
      );
      return `new lore in ${copies} copies`;
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
    let fixture = scenario.fixture
      ? readFileSync(join(FIXTURES_DIR, `${scenario.fixture}.json`), "utf8")
      : null;
    if (fixture && scenario.editSave) {
      const save = JSON.parse(fixture);
      scenario.editSave(save);
      fixture = JSON.stringify(save);
    }
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
      const limit = scenario.timeoutMs ?? SCENARIO_TIMEOUT_MS;
      timer = setTimeout(() => reject(new Error(`over ${limit / 1000}s`)), limit);
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
