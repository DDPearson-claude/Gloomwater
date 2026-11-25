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
//   open     more options for GameSession.open: viewport, scale (pixel ratio), init scripts, gesture: false
//   run      async (session, { fixture, page, browser }) => { ... }: throw an Error to fail. `session` is a
//            GameSession (tools/game-driver.mjs) that has booted to the title; `fixture` is the parsed save;
//            `browser` opens a second session (a reload of a saved string).

import { readFileSync } from "node:fs";
import * as acorn from "acorn";
import { join } from "node:path";
import {
  DEFAULT_PAGE,
  GameSession,
  MURK_BOX_BUTTON,
  ROOT,
  SAVE_KEY,
  SLOW,
  launchBrowser,
} from "./game-driver.mjs";

const BUDGET_MS = 3_600_000 * SLOW; // every scenario, launch to exit (GW_SLOW stretches every limit)
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
const LINE_LOSS_TEXT = "That one got away! Your line snaps by the rod. You draw it in your notepad.";
const HOOK_LOSS_TEXT = "That one got away! Your hook comes back bare. You draw it in your notepad.";
const LEADER_LOSS_TEXT =
  "That one got away! Your line comes back worn at the end. You draw it beside Hob's old end.";
// A lost fight on a fully right rig: the dice. While it still wounds her, one more sentence says so.
const FIGHT_LOSS_TEXT =
  "It shook free right under the raft. Everything held. It will be a little weaker next time.";

// Gives the player the thief's hook and leader parts (and the Sounding Lead) and fits the hook and leader given:
// by default the two that hold her, so only the line and the dice decide a fight.
const fitHerParts = (session, { hook = "turnback_hook", leader = "chafe_gut", depth = null } = {}) =>
  session.eval(
    ([hook, leader, depth]) => {
      const s = window.__gw.progression.loop.state();
      for (const id of ["turnback_hook", "chafe_gut", "pike_wire", "sounding_lead"])
        s.parts.includes(id) || s.parts.push(id);
      (s.fitted.hook = hook), (s.fitted.leader = leader);
      depth && (s.fitted.depth = depth);
      return { ...s.fitted };
    },
    [hook, leader, depth],
  );

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
// `z` sets the fish's size (0 is an ordinary one), for a test that must not meet a fish over the line's limit.
async function hookAndPlayOut(session, speciesId, outcome, { lead = 0, z = null } = {}) {
  for (let tries = 0; tries < 5; tries++) {
    const result = await hookOnce(session, speciesId, outcome, lead, z);
    if (!result.find) return result;
    await session.clickButton(/^\d?Let go\b/);
    await session.pause(800);
    await session.closeGuides(4000);
  }
  throw new Error(`a find came up on every hook of ${speciesId}`);
}

async function hookOnce(session, speciesId, outcome, lead = 0, z = null) {
  const hooked = await session.eval(
    ([id, forced, size]) => {
      const g = window.__gw;
      if (!window.__hookLog) {
        window.__hookLog = { escaped: [], landed: [] };
        g.bus.on("fish:escaped", (e) => window.__hookLog.escaped.push(JSON.parse(JSON.stringify(e))));
        g.bus.on("fish:landed", (e) => window.__hookLog.landed.push(e?.species?.id ?? null));
      }
      g.debug.fishOutcome(forced);
      const ok = size == null ? g.debug.fishHook(id) : g.debug.fishHook(id, { z: size });
      return {
        ok,
        state: g.fishing.state,
        p: g.debug.fishChance(),
        loss: g.debug.fishPlay()?.loss ?? null,
        escaped: window.__hookLog.escaped.length,
        landed: window.__hookLog.landed.length,
      };
    },
    [speciesId, outcome, z],
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
    if (now.escaped.length > hooked.escaped)
      return { p: hooked.p, loss: hooked.loss, escape: now.escaped.at(-1) };
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

// At home: the chart closed with Escape leaves the barge's menu; and with every screen closed (as a sail or tow
// closes them), Escape, the pause key (a controller's B and Start) and a tap on the water each bring it back.
// Then the chart's Sail still sets out. Returns what was tried.
async function homeMenuComesBack(session, water) {
  const jettyUp = () => session.eval(() => !!document.querySelector('.gw-modal.gw-in[data-modal="jetty"]'));
  const tried = [];
  for (let n = 0; n < 3; n++) {
    await session.eval(() => document.querySelector('[data-modal="jetty"] [data-tile="chart"]')?.click());
    await session.waitFor(
      "the chart",
      10_000,
      () => !!document.querySelector('.gw-modal.gw-in[data-modal="chart"]'),
    );
    await session.pause(n * 400);
    await session.page.keyboard.press("Escape");
    await session.pause(900);
    check(await jettyUp(), `no barge's menu after Escape on the chart (try ${n + 1})`);
  }
  tried.push("chart and Escape x3");
  const view = session.page.viewportSize();
  for (const [name, act] of [
    ["Escape", () => session.page.keyboard.press("Escape")],
    ["P", () => session.page.keyboard.press("KeyP")],
    ["a tap", () => session.page.mouse.click(view.width / 2, view.height / 2)],
  ]) {
    await session.eval(() => window.__gw.ui.closeAll());
    await session.pause(900);
    check(!(await jettyUp()), "the barge's menu is still up after every screen was closed");
    await act();
    await session.waitFor(
      `the barge's menu after ${name}`,
      5_000,
      () => !!document.querySelector('.gw-modal.gw-in[data-modal="jetty"]'),
    );
    tried.push(name);
  }
  await session.sail({ water, timeoutMs: 200_000 });
  const zone = await session.eval(() => window.__gw.state.run?.zone ?? null);
  check(zone === water, `the trip after the menu came back is on ${zone}`);
  return tried.join(", ");
}

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
  const open = await session.eval(() =>
    [...document.querySelectorAll(".gw-modal")]
      .filter((m) => m.classList.contains("gw-in"))
      .map((m) => `${m.dataset.modal}${m.classList.contains("gw-covered") ? " (covered)" : ""}`),
  );
  throw new Error(
    `could not get back to the barge; open: ${open.join(", ") || "nothing"}; ${JSON.stringify(await session.state())}`,
  );
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

// Her odds row on the Odds sheet at home, for the Bell Pool (owned, its mist lifted) by night (or `light`)
// with the Worm Bunch on the Sounding Lead (the lead given if the save has none): the place, light and rig she
// bites on (by night, after the midnight bell). Also the count of kinds not met, and whether the sheet carries
// the line about her time.
async function bellPoolOdds(session, light = "night") {
  const odds = await session.eval(
    ([id, light]) => {
      const loop = window.__gw.progression.loop,
        s = loop.state();
      loop.markLifted("bell_pool");
      s.parts.includes("sounding_lead") || s.parts.push("sounding_lead");
      const fitted = loop.fit("bait", "heartmoss")?.ok === true && loop.fitDepth("lead")?.ok === true;
      const sheet = loop.sheet({ place: "bell_pool", light });
      return {
        fitted,
        place: sheet?.picks?.place ?? null,
        row: sheet?.odds?.rows?.find((r) => r.id === id) ?? null,
        unmet: sheet?.odds?.unmet ?? null,
        herTime: sheet?.odds?.herTime ?? null,
      };
    },
    [LEGEND_ID, light],
  );
  check(
    odds.fitted && odds.place === "bell_pool",
    `the Odds sheet is not on the Bell Pool with the Worm Bunch on the lead: ${JSON.stringify(odds)}`,
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

// ---- the midnight bell and her time ---------------------------------------------------------------------

const MIDNIGHT_AT = 60;
const MIDNIGHT_LINE = "Far off, the old bell on the toll-tower strikes midnight.";
const MISSING_LINE = "This is when things go missing.";
const STILL_LINE = "The water goes still again.";
const HOLD_FULL_LINE =
  "Your hold is full. You can still fish and let them go. The old bell strikes midnight soon.";
const BIRDS_LINE = "The birds by the Gatehouse scatter across the water.";
const HER_ODDS_LINE =
  "The Bellhead Catfish bites only in the few minutes after the old bell strikes midnight.";
// The Gatehouse roost (LOOP.wildlife.lampbills.groups[2]) and her centre, 20.4 m from it.
const ROOST = { x: 13.4, z: -24.6 };
const HER_CENTRE = { x: -4, z: -14 };

// Puts the raft at `at` and returns its distance from the Gatehouse roost.
const raftAt = (session, at) =>
  session.eval(
    ([at, roost]) => {
      const g = window.__gw;
      g.player.teleport(at, 0);
      return Math.hypot(g.player.position.x - roost.x, g.player.position.z - roost.z);
    },
    [at, ROOST],
  );
// How many times the Gatehouse birds have fled (the raft's flee and the bell's scatter both count).
const roostFlees = (session) =>
  session.eval(() =>
    (window.__gw.debug.wildlife?.()?.lampbills ?? [])
      .filter((b) => b.g === 2)
      .reduce((n, b) => n + b.flees, 0),
  );

// Records every toast's text from now on; read it back with toastsSeen.
const listenForToasts = (session) =>
  session.eval(() => {
    window.__toasts = [];
    window.__gw.bus.on("toast", (e) => window.__toasts.push(String(e?.text ?? "")));
  });
const toastsSeen = (session) => session.eval(() => window.__toasts.slice());

// Puts the trip at `t` seconds after dark (with `evening`, a new evening: the run's evening flags cleared),
// lets the game run two frames, and returns the run's midnight flags and the tower window's flare.
const atNight = (session, t, { evening = null } = {}) =>
  session.eval(
    async ([t, evening]) => {
      const g = window.__gw;
      const run = g.state.run;
      if (evening != null) {
        run.evening = evening;
        delete run.midnight;
      }
      if (run.phase !== "gloomtide") g.debug.setPhase("gloomtide");
      run.phaseTime = t;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return {
        midnight: run.midnight ? { ...run.midnight } : null,
        flare: g.world.tollTowerFlare?.() ?? null,
      };
    },
    [t, evening],
  );

// ---- the Sounding Lead (Mossmere gear, first step) -------------------------------------------------------

const LEAD = "sounding_lead";
const GIFT_LINE = "Not every fish looks up. A lead takes your worm down to the ones that don't.";
const BOTTOM = ["gutter_crayfish", "rustfin_sucker", "weeping_carp", "milkeye_perch", "bridgechain_sturgeon"];
const HIGH = ["dusk_minnow", "lampsipper", "reedjaw_pike"];
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

// Gives a save the lead (as the gift would) and, with fit, fits it: for scenarios about what it does.
const withLead =
  (fit = true) =>
  (save) => {
    const loop = save.meta.loop;
    loop.parts = ["cork_float", LEAD];
    loop.fitted = { ...loop.fitted, depth: fit ? "lead" : "float" };
  };

const leadRecord = (session) =>
  session.eval(() => {
    const s = window.__gw.progression.loop.state();
    // The Plain Knot and the Mere Hook are everyone's from the start (mossmere-gear-deeper.md B4): left out here,
    // where the Depth scenarios read the parts that are given.
    const given = (s.parts ?? []).filter((id) => id !== "plain_knot" && id !== "mere_hook");
    return { parts: given, depth: s.fitted?.depth ?? null, gift: s.lastTrip?.gift ?? null };
  });

// Goes home and reads Murk's tally once it has counted (the gift block's text, if any), then closes it.
async function tallyAndGift(session) {
  const homeBy = Date.now() + 60_000;
  while (!(await session.eval(() => window.__gw.game.goHome()))) {
    if (Date.now() > homeBy)
      throw new Error(`the game will not go home; ${JSON.stringify(await session.state())}`);
    await session.closeGuides(3000);
    await session.pause(1000);
  }
  const soldVisible = () =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.trim() === "Sold" && b.getBoundingClientRect().width > 0,
    );
  await session.waitFor("Murk's tally", 90_000, soldVisible);
  await session.clickButton(/^Sold$/); // finishes the count
  await session.pause(2500);
  const gift = await session.eval(() => {
    const el = document.querySelector(".gw-tally-gift");
    return el
      ? { text: el.textContent.replace(/\s+/g, " ").trim(), shown: el.classList.contains("gw-in") }
      : null;
  });
  const end = Date.now() + 60_000;
  while (Date.now() < end && (await session.eval(soldVisible))) {
    await session.clickButton(/^Sold$/);
    await session.pause(1500);
  }
  await session.closeGuides();
  return gift;
}

// Murk's shelf: the rod, line and reel cards ("line:2:Waxed Silk").
const tackleShelf = (session) =>
  session.eval(() =>
    (window.__gw.progression.loop.shelf().tabs.find((t) => t.id === "tackle")?.items || [])
      .filter((c) => /^(rod|line|reel):/.test(c.id))
      .map((c) => `${c.id}:${c.name}`),
  );

// A part's tray on the rig picture (the tackle screen, opened from the rack): its owned options [{ key, on }], the
// fitted option's lines, the tray's notes, what Murk's shelf adds (`more`, shelf ids) and each option's text; or
// null when the picture has no such part.
async function rigTray(session, part) {
  await session.eval(() => window.__gw.ui.loop.tackle.openScreen({ from: "rack" }));
  await session.pause(800);
  const opened = await session.eval((p) => {
    const node = document.querySelector(`.gw-rig-node[data-part="${p}"]`);
    node?.click();
    return !!node;
  }, part);
  if (!opened) return null;
  await session.pause(800);
  return session.eval((p) => {
    const tray = document.querySelector(`.gw-rig-tray[data-part="${p}"]`);
    if (!tray) return null;
    const opts = [...tray.querySelectorAll(".gw-rig-opt[data-owned=true]")];
    const on = opts.find((o) => o.getAttribute("aria-pressed") === "true");
    return {
      chips: opts.map((c) => ({ key: c.dataset.key, on: c.getAttribute("aria-pressed") === "true" })),
      lines: on
        ? [...on.querySelectorAll(".gw-rig-line:not(.gw-rig-log)")].map((n) => n.textContent.trim())
        : [],
      notes: [...tray.querySelectorAll(".gw-rig-note")].map((n) => n.textContent.trim()),
      more: [...tray.querySelectorAll(".gw-rig-shop")].map((c) => c.dataset.buy),
      text: Object.fromEntries(opts.map((c) => [c.dataset.key, c.textContent.replace(/\s+/g, " ").trim()])),
    };
  }, part);
}
// The Depth part's tray: { chips: [{ key, on }], lines } or null when the picture has no Depth part.
const depthRow = (session) => rigTray(session, "depth");

// The rig picture on the tackle screen (opened from the rack): its parts, what is drawn, the limit line and the
// "Here, now" strip; whether a tray is open, and whether any two part labels overlap. Leaves the screen open.
const GRAZERS = ["rustfin_sucker", "weeping_carp"];
async function rigScreen(session) {
  await session.eval(() => window.__gw.ui.loop.tackle.openScreen({ from: "rack" }));
  await session.pause(800);
  return session.eval(() => {
    const card = document.querySelector(".gw-rig"),
      has = (sel) => !!card?.querySelector(sel),
      limit = document.querySelector(".gw-rig-limit"),
      boxes = [...document.querySelectorAll(".gw-rig-node")].map((b) => {
        const r = b.getBoundingClientRect();
        return [Math.round(r.top), Math.round(r.bottom)];
      });
    return {
      nodes: [...document.querySelectorAll(".gw-rig-node")].map((b) => ({
        part: b.dataset.part,
        key: b.dataset.key,
        name: b.querySelector(".gw-rig-name")?.textContent ?? "",
      })),
      depth: card?.dataset.depth ?? null,
      drawn: {
        cork: has(".gw-rig-cork"),
        lead: has(".gw-rig-lead"),
        bell: has(".gw-rig-brass"),
        wire: has(".gw-rig-wire"),
        gut: has(".gw-rig-gut"),
        knot: has(".gw-rig-knot"),
        worm: has(".gw-rig-worm"),
        lure: has(".gw-rig-lure"),
        hook: card?.querySelectorAll(".gw-rig-hook").length ?? 0,
      },
      limit: limit ? { by: limit.dataset.by, cls: limit.dataset.cls, text: limit.textContent } : null,
      here: [...document.querySelectorAll(".gw-rig-fishname")].map((li) => li.dataset.species),
      unmetText: document.querySelector(".gw-rig-unmet")?.textContent ?? null,
      trayOpen: !!document.querySelector(".gw-rig-tray"),
      boxes,
      overlap: boxes.some((b, i) => i > 0 && b[0] < boxes[i - 1][1] - 1),
    };
  });
}
const closeTackle = (session) => session.eval(() => window.__gw.ui.loop.tackle.closeScreen());
// The rig picture's marks where it is open (`sel`: the tackle screen's picture, or a RIG_HOST): each marked part's
// label as "part:key:mark", and the parts the picture draws a red notch or a brass tick beside.
const rigMarksShown = (session, sel = ".gw-rig") =>
  session.eval((s) => {
    const host = document.querySelector(s);
    if (!host) return null;
    const drawn = (cls) => [...host.querySelectorAll(cls)].map((p) => p.dataset.part).sort();
    return {
      labels: [...host.querySelectorAll(".gw-rig-node[data-mark]")]
        .map((b) => `${b.dataset.part}:${b.dataset.key}:${b.dataset.mark}`)
        .sort(),
      notch: drawn(".gw-rig-notch"),
      tick: drawn(".gw-rig-tick"),
    };
  }, sel);
// The marks on the tackle screen's picture (opened from the rack, then closed).
async function rigScreenMarks(session) {
  await rigScreen(session);
  const marks = await rigMarksShown(session);
  await closeTackle(session);
  return marks;
}

// The saved rigs' tabs on the tackle screen (opened from the rack): each one's label, name, whether it is pressed,
// whether its bait has none left and whether its bait icon is greyed. Leaves the screen open.
async function rigTabsShown(session) {
  await session.eval(() => window.__gw.ui.loop.tackle.openScreen({ from: "rack" }));
  await session.pause(800);
  return session.eval(() =>
    [...document.querySelectorAll(".gw-rig-tab")].map((b) => ({
      label: b.querySelector(".gw-rig-tabn")?.textContent ?? "",
      name: b.querySelector(".gw-rig-tabname")?.textContent ?? "",
      on: b.getAttribute("aria-pressed") === "true",
      out: b.dataset.out === "true",
      greyed: !!b.querySelector(".gw-rig-ico--out"),
    })),
  );
}

// The foot lines of the Odds page (the Wick's sheet, opened as Murk's "Odds" button does).
async function oddsFoot(session) {
  await session.eval(() => window.__gw.ui.openTackle());
  await session.pause(1500);
  const lines = await session.eval(() =>
    [...document.querySelectorAll(".gw-sh-foot")].map((e) => e.textContent.trim()),
  );
  await backToJetty(session);
  return lines;
}
const LEAD_ODDS = "On the Sounding Lead: bottom feeders \u00d72, higher feeders \u00d70.5.";

// One Mire Worm bait roll at the raft (or a place), float or lead, through the game's own odds (fishPoolRoll).
const rollBoth = (session, opts) =>
  session.eval((o) => {
    const loop = window.__gw.progression.loop,
      d = window.__gw.debug;
    o.light && d.setPhase(o.light);
    const roll = (depth) => (loop.fitDepth(depth), d.fishPoolRoll(1, { bait: "mireworm", ...o.roll }));
    const float = roll("float"),
      lead = roll("lead");
    loop.fitDepth("float");
    return { float, lead };
  }, opts);

// ---- the Live Minnow and Murk's tin (Mossmere gear, step 3) ------------------------------------------------

const TIN = "minnow_tin";
const TIN_LINE_HUNTER =
  "Perch eat little fish. Here's a tin for live ones. Press \u201cInto the tin\u201d on a small Dusk Minnow.";
const TIN_LINE_PLAIN = "Here's a tin for live bait. Press \u201cInto the tin\u201d on a small Dusk Minnow.";
const LIVE_GOOD = "Good for: hunters such as perch, pike and bass.";
const LIVE_COST = "Costs you: you must catch it first, and grazers ignore it.";

// Gives a save the lead and the tin, as Murk's two gifts would, the float fitted.
const withTin = (save) => {
  withLead(false)(save);
  save.meta.loop.parts.push(TIN);
};

const liveInRun = (session) => session.eval(() => window.__gw.state.run?.bait?.live_minnow ?? 0);

// Lands a fish (z sets its size) and waits for its catch card. Returns the card's "Into the tin" text or null,
// the fish's size class and the creel's length, and leaves the card open.
async function catchCard(session, speciesId, z) {
  const ok = await session.eval(([id, z]) => window.__gw.debug.instantCatch(id, { z }), [speciesId, z]);
  if (!ok) throw new Error(`instantCatch(${speciesId}) refused; ${JSON.stringify(await session.state())}`);
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    await session.pause(400);
    if (await session.clickButton(/^Got it$/)) continue;
    const card = await session.eval(() => {
      const keep = document.querySelector(".gw-cc-keep");
      if (!keep || keep.getBoundingClientRect().width === 0) return null;
      const tin = document.querySelector(".gw-cc-tin");
      return {
        tin: tin ? tin.textContent.replace(/\s+/g, " ").trim() : null,
        creel: window.__gw.state.run?.creel?.length ?? 0,
      };
    });
    if (card) return card;
  }
  throw new Error(`no catch card for ${speciesId}; ${JSON.stringify(await session.state())}`);
}

// ---- the Worm Bunch and what the thief takes (Mossmere gear, step 4) --------------------------------------

const BUNCH = "heartmoss"; // the Worm Bunch keeps Heartmoss's id
const BUNCH_LINE = "A fistful of worms on a big hook. Too much for little mouths.";
const BUNCH_GOOD = "Good for: carp, suckers, crayfish and sturgeon.";
const BUNCH_COST = "Costs you: small fish mostly leave it.";

// The bait part of her bite check for a cast of `bait` released now, and `n` seeded rolls of it.
const legendBite = (session, bait, n = 0) =>
  session.eval(
    ([bait, n]) => (window.__gw.debug.fishSeed(20261122), window.__gw.debug.legendBite({ bait, n })),
    [bait, n],
  );

// ---- the scenarios --------------------------------------------------------------------------------------

const FIXTURE_NAMES = ["fresh-first-evening", "mid-mossmere", "legend-sold", "sporewood-crossed"];

// ---- the hunt: the tale, the notepad and Hob (mossmere-hunt-2.md sections 1, 2 and 5) --------------------------
const TALE =
  "Things go missing on Mossmere at night. Birds go, and floats, and once a whole rod. People say the gloom takes them.";
const TALE_MURK =
  "It's always just after the old bell strikes midnight. Hob on Mossbell Isle says it's a fish. Go and ask him.";
const PAD_INTRO =
  "This is your notepad. Each time you find a clue, you draw it here. Look at the pictures to work out what you're hunting, and where.";
const NEXT_HOB = "Hob's lamp is lit on Mossbell Isle. Sail close to talk to him.";
const NEXT_MIDNIGHT = "Be in Hob's part when the old bell strikes midnight.";
const MAP_WORDS = "Hob lost it somewhere in this shaded part, between the Gatehouse and the Sisters.";
const HOB_FIRST = [
  "Evening! I'm Hob. I've fished off this rock for forty years.",
  "I hooked something huge once, out in my old boat. It broke my line. I can't think now what it was.",
  "It was out this way, I'm nearly sure. Here, I'll draw it for you.",
  "My line came back like this, worn rough, not cut. You keep it.",
];
const HOB_ROD = "Another night it took my whole rod. It pulled it right over the side.";
const HOB_GREETING = "Any luck out there? Stay warm.";
const DRAWN = "You draw it in your notepad.";
const MURK_FIND_HOB = "Hob's lamp is lit on Mossbell Isle. Sail close and say hello.";
const MURK_MAP = "Hob always said it was between the Gatehouse and the Sisters. I've drawn it for you.";

// Setting out can take minutes when several sessions share the CPU.
const SLOW_SAIL = { timeoutMs: 300_000 };

// ---- her tries, refusals and losses ------------------------------------------------------------------------
const DRAWN_SWIRL = "Something huge turns under your rig, then sinks back down. You draw what you saw.";
const REFUSE_LURE = "Something huge swirls behind the lure, and sinks back down.";
const REFUSE_FLOAT_LIVE = "Something huge takes the minnow, feels the float pull, and lets go.";
const REFUSE_FLOAT_WORMS = "Something huge rises under the float, looks at the worms, and sinks back down.";
const REFUSE_BAIT = "Something heavy noses your worms on the bottom, and leaves them.";
const REFUSE_BUNCH = "Something mouths the Worm Bunch, and lets it go.";
const REFUSE_WIRE = "Something mouths the minnow, feels the wire, and lets it go.";
const REFUSE_LESSON = {
  hook: "Something mouths the minnow, and lets it go. It remembers the hook.",
  leader: "Something mouths the minnow, and lets it go. It remembers the leader.",
  line: "Something mouths the minnow, and lets it go. It remembers the line.",
};
const SWIRL_LURE_WORDS = "It turned away from the lure. It wants something real, down on the bottom.";
const BACK_WORDS = [
  "The hook pulled out of a soft mouth and came back bare.",
  "The end came back worn rough, just like Hob's.",
  "The line snapped by the rod, so it is too heavy for this line.",
];
const HELD_WORDS = "Your hook, your leader and your line all held.";
const NEXT_SWIRL = "Look again at the swirl in your notepad.";
const NEXT_SELLS = "Your notepad shows what broke. Murk sells what holds.";
const MURK_HOOK_HUNT = "Something out there grabs and runs. There's a new hook on the shelf.";

// Her answer to a cast released now in her water (the debug hook fishHerCast), with her roll fixed at u.
const herCast = (session, opts) => session.eval((o) => window.__gw.debug.fishHerCast(o), opts);
// On the water: fits the given depth, leader and hook, and puts on (or takes off, null) a lure.
const herRig = (session, rig) =>
  session.eval((r) => {
    const g = window.__gw,
      fitted = g.progression.loop.state().fitted;
    for (const slot of ["depth", "leader", "hook"]) r[slot] && (fitted[slot] = r[slot]);
    "lure" in r && (g.state.run.lure = r.lure);
  }, rig);

const huntOf = (session) => session.eval(() => window.__gw.progression.loop.state().hunt.mossmere);

// What the open notepad shows (the one that opened by itself, or the Journal's Notepad tab), or null.
const notepadShown = (session, where) =>
  session.eval((sel) => {
    const pad = document.querySelector(sel);
    if (!pad) return null;
    return {
      pages: [...pad.querySelectorAll(".gw-pad-tab")].map((b) => b.textContent.trim()),
      page: pad.querySelector(".gw-pad-page.gw-on")?.dataset.page ?? null,
      places: pad.querySelectorAll(".gw-pad-fig").length,
      drawn: [...pad.querySelectorAll(".gw-pad-fig[data-drawn]")].map((f) => f.dataset.sketch),
      blank: pad.querySelectorAll(".gw-pad-fig.gw-pad-blank").length,
      intro: pad.querySelector(".gw-pad-intro")?.textContent ?? null,
      next: pad.querySelector(".gw-pad-next em")?.textContent ?? null,
      words: [...pad.querySelectorAll(".gw-pad-cap")].map((c) => c.textContent),
    };
  }, where);

// Goes home and closes Murk's tally; returns the hunt lines the tally showed ("" for none) and what the notepad
// showed if it then opened by itself (closed with one press of its button), or null. `look` runs while it is open.
async function tallyAndPad(session, { look = null } = {}) {
  for (const homeBy = Date.now() + 60_000; !(await session.eval(() => window.__gw.game.goHome())); ) {
    check(Date.now() < homeBy, `the game will not go home; ${JSON.stringify(await session.state())}`);
    await session.closeGuides(3000);
    await session.pause(1000);
  }
  const soldVisible = () =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.trim() === "Sold" && b.getBoundingClientRect().width > 0,
    );
  await session.waitFor("Murk's tally", 90_000, soldVisible);
  await session.clickButton(/^Sold$/); // finishes the count
  await session.pause(2500);
  const hunt = await session.eval(
    () => document.querySelector(".gw-tally-hunt")?.textContent.replace(/\s+/g, " ").trim() ?? "",
  );
  for (const end = Date.now() + 60_000; Date.now() < end && (await session.eval(soldVisible)); )
    await session.clickButton(/^Sold$/), await session.pause(1500);
  // At the barge the notepad opens by itself if it has something new; guide cards are closed on the way.
  let pad = null;
  for (const end = Date.now() + 15_000; Date.now() < end; ) {
    pad = await notepadShown(session, '.gw-modal[data-modal="notepad"].gw-in .gw-pad');
    if (pad) break;
    // A guide card or Murk's box at the jetty comes first: one press each.
    await session.eval(
      (murkButton) =>
        (document.querySelector(".gw-m-guide .gw-guide-ok") || document.querySelector(murkButton))?.click(),
      MURK_BOX_BUTTON,
    );
    await session.pause(600);
  }
  if (pad) {
    if (look) await look();
    await session.eval(() => document.querySelector(".gw-pad-close").click());
    await session.pause(900);
    pad.closedByOnePress = !(await session.eval(
      () => !!document.querySelector('.gw-modal[data-modal="notepad"].gw-in'),
    ));
  }
  await session.closeGuides(4000);
  return { hunt, pad };
}

// Hob: the raft put near his rock on Mossbell Isle (the isle's middle is at -30, 14), or well away from it.
const nearHob = (session) => session.eval(() => window.__gw.player.teleport({ x: -30, z: 4 }, 0));
const awayFromHob = (session) => session.eval(() => window.__gw.player.teleport({ x: 0, z: 30 }, 0));
// Reads each of Hob's boxes and presses its button until he is done; [] if he says nothing within waitMs.
async function hearHob(session, waitMs = 20_000) {
  const lines = [];
  for (const end = Date.now() + waitMs; Date.now() < end; ) {
    const said = await session.eval(
      () => document.querySelector('.gw-modal[data-modal="hob"].gw-in .gw-hob-text')?.textContent ?? null,
    );
    if (said) {
      lines.push(said);
      await session.eval(() =>
        document.querySelector('.gw-modal[data-modal="hob"].gw-in .gw-hob-ok').click(),
      );
      await session.pause(600);
    } else if (lines.length) break;
    else await session.pause(500);
  }
  return lines;
}
// Sails away from Hob and back, so he may speak again.
async function passHobAgain(session, waitMs) {
  await awayFromHob(session);
  await session.pause(1500);
  await nearHob(session);
  return hearHob(session, waitMs);
}

// ---- her water: hidden until the theft, found by the boils, and remembered (mossmere-hunt-2.md section 4) -----
const TAKEN_FLOAT =
  "Taken! Something grabs your fish and pulls it under, float and all. Your line comes back empty.";
const SPARE_FLOAT = "You tie on a spare float.";
const CORK_LINE = "You drop a marker cork on the spot.";
const BELL_LINE = "An old harbour bell stands over the spot, cracked and silent.";
const BOIL_LINE =
  /^(Something big boils up on the water, (ahead of you|behind you|to your left|to your right)\.|Something huge boils up, right beside you\.)$/;
const TAKEN_WORDS =
  "Something took a fish off the line, right here. It happened just after the bell struck midnight.";
const TAKEN_SELF = "You found this spot yourself.";
const NEXT_BOILS = "After the bell, watch Hob's part for boils, and fish where they rise.";
const NEXT_SPOT = "Fish the marked spot after the bell, and watch your rig.";
const MURK_MIDNIGHT = "Be out in Hob's part when the old bell strikes midnight.";
const MURK_BOILS = "Watch for boils after the bell, and fish right under them.";
const MURK_FOUND = "Right off your line? I've marked the spot on your chart.";

// mid-mossmere (four evenings played) with the tale told at evening 2 and Hob's map drawn on evening 3; her
// water not found. The float is fitted, with worms.
const withMap = (save) => {
  withLead(false)(save);
  save.meta.loop.hunt = {
    mossmere: {
      lineLesson: false,
      taleAt: 2,
      hobMet: 3,
      hobNight: 3,
      mapBy: "hob",
      sketches: { map: 3, taken: 0, lineup: 0, swirl: 0, back: 0 },
    },
  };
};

// What marks her water on the water now, with the raft put at (x, z): the mist bank, the harbour frame, the
// marker cork, the dark tone over her hole, and what a cast there is (its place and any mist).
const herWaterMarks = (session, at = HER_CENTRE) =>
  session.eval(async (at) => {
    const g = window.__gw;
    g.player.teleport(at, 0);
    for (let i = 0; i < 4; i++) await new Promise((r) => requestAnimationFrame(r));
    const scene = g.render?.scene;
    let rim = null;
    scene?.traverse((o) => {
      const u = o.material?.uniforms?.uWcRim;
      if (u && rim === null) rim = u.value;
    });
    const banks = g.debug.loop.places()?.banks?.banks ?? [];
    const cast = g.debug.fishPoolRoll(3) ?? {};
    return {
      bank: banks.find((b) => b.id === "bell_pool") ?? null,
      frame: scene?.getObjectByName("Bell Pool oak frame")?.visible ?? null,
      cork: scene?.getObjectByName("Marker cork")?.visible ?? null,
      rim,
      castPlace: cast.place ?? null,
      castMist: cast.mist ?? null,
    };
  }, at);

// At home: the places the chart marks (its tap areas' data-place), then back to the barge.
// (A chart opened in the first moment can come up without its tap areas, a known fault: it is reopened.)
async function chartPlaces(session) {
  for (let tries = 0; ; tries++) {
    await session.waitFor("the Chart button", 10_000, () =>
      [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Chart"),
    );
    await session.clickButton(/^Chart$/);
    try {
      await session.waitFor("the chart", 5_000, () => !!document.querySelector(".gw-chart-hit"));
      break;
    } catch (err) {
      if (tries >= 2) throw err;
      await backToJetty(session);
    }
  }
  await session.pause(600);
  const places = await session.eval(() => [
    ...new Set([...document.querySelectorAll(".gw-chart-hit[data-place]")].map((b) => b.dataset.place)),
  ]);
  await backToJetty(session);
  return places;
}

// Hooks an ordinary fish through the debug hooks and plays the fight out (as hookOnce), with the raft put so the
// debug cast's float lands close to `spot`. A calibration hook first (from `spot`, forced to get away, before
// `then` runs) measures where the debug cast lands from the raft; `then` (for example: into her time) runs
// before each real hook. A find on the hook (the cast's own snag roll) is let go and the hook tried again.
// Returns hookOnce's result and where the thief took it (null if it did not).
async function hookNear(session, speciesId, spot, outcome, then = async () => {}) {
  const settle = () => session.pause(1500);
  // Plays the fight on the hook to its end, letting go of anything that comes up on a card.
  const playOut = async () => {
    await session.eval(() => window.__gw.debug.fishPlayTo(0.995));
    for (const end = Date.now() + 90_000; ; ) {
      check(Date.now() < end, `the fight did not end; ${JSON.stringify(await session.state())}`);
      if (await session.clickButton(/^\d?Let go\b/)) await session.pause(800);
      const idle = await session.eval(
        () => window.__gw.fishing.state === "idle" && !window.__gw.ui.isBlocking?.(),
      );
      if (idle) break;
      await session.closeGuides(1000);
      await session.pause(500);
    }
  };
  await session.eval((s) => window.__gw.player.teleport(s, 0), spot);
  await settle();
  const offset = await session.eval((id) => {
    const g = window.__gw;
    g.debug.fishOutcome("lose");
    if (!g.debug.fishHook(id)) return null;
    const f = g.debug.fishing(),
      raft = g.player.position;
    return { dx: f.bob.x - raft.x, dz: f.bob.z - raft.z };
  }, speciesId);
  check(offset, `the calibration hook of ${speciesId} failed`);
  await playOut();
  await session.eval(
    ([s, o]) => window.__gw.player.teleport({ x: s.x - o.dx, z: s.z - o.dz }, 0),
    [spot, offset],
  );
  await settle();
  for (let tries = 0; tries < 4; tries++) {
    await then();
    const result = await hookOnce(session, speciesId, outcome);
    if (result.find) {
      await playOut();
      continue;
    }
    const thiefAt = await session.eval(() => window.__gw.debug.fishing().thiefAt);
    return { ...result, thiefAt, offset };
  }
  throw new Error(`a find came up on every hook of ${speciesId}`);
}

// ---- the bird at midnight (mossmere-hunt-2.md section 1; decisions.md "The midnight cutscene") --------------
const BIRD_LINE = "A bird went under, and it didn't come back up. This is when it feeds.";

// mid-mossmere with Hob's map drawn and her water found by the theft on `foundEvening` (the Bell Pool owned,
// revealed and already lifted, so no lift waits at the set-out). The record has no birdCutsceneSeen: an older save.
const withFound =
  (foundEvening, extra = {}) =>
  (save) => {
    withMap(save);
    const loop = save.meta.loop;
    Object.assign(loop.hunt.mossmere, {
      found: true,
      foundEvening,
      foundBy: "theft",
      foundAt: { x: -2, z: -12 },
      takenOn: "float",
      ...extra,
    });
    loop.hunt.mossmere.sketches.taken = foundEvening;
    for (const list of [loop.maps.places, loop.places.revealed, loop.lifted])
      list.includes("bell_pool") || list.push("bell_pool");
  };

// Records the bird at midnight's phases and the later nights' mark from now on (and every toast).
const listenForBirdScene = (session) =>
  session.eval(() => {
    window.__toasts = [];
    window.__scene = [];
    const g = window.__gw;
    g.bus.on("toast", (e) => window.__toasts.push(String(e?.text ?? "")));
    g.bus.on("hunt:birdScene", (e) => window.__scene.push(e.phase + (e.skipped ? ":skipped" : "")));
    g.bus.on("hunt:herTimeMark", () => window.__scene.push("mark"));
  });
const birdSceneSeen = (session) =>
  session.eval(() => ({
    phases: window.__scene.slice(),
    toasts: window.__toasts.slice(),
    playing: window.__gw.game.birdScene(),
    seen: window.__gw.progression.loop.state().hunt.mossmere.birdCutsceneSeen,
  }));
// Rings midnight on `evening` (its first stroke on time) and lets the night run to `until` s after dark.
async function strikeMidnight(session, evening, until = MIDNIGHT_AT + 5) {
  await atNight(session, MIDNIGHT_AT - 1, { evening });
  await atNight(session, MIDNIGHT_AT + 0.05);
  await atNight(session, until);
  await session.pause(2000);
}

// ---- the Leader and the Hook for ordinary fish (mossmere-gear-deeper.md, gear step 3a) ---------------------

const HOOK_LINE = "Carp grab and run. There's a hook on the shelf that sets itself.";
const LEADERS_LINE = "Hob gave you his old line end? Leaders are on the shelf now.";
const WARY = ["likely_chub", "kissmark_trout", "rosefleck_trout", "milkeye_perch"];
const DELICATE = ["dusk_minnow", "lampsipper", "rainglass_darter"];
const LOSS_TEETH = "Bitten through. Pike Wire stops teeth.";
const LOSS_LIPS = "Worn through on its lips. Chafe Gut won't wear.";
const LOSS_RAN = "It ran before the hook was set. A Turnback Hook sets itself.";

// ---- Sporewood's Leader and Hook parts (sporewood-plan.md "Tackle") ----------------------------------------
const SPORE_PARTS = ["brass_trace", "mossthread_snood", "burl_hook"];
// Sporewood's shy fish (wary or delicate on both leaders), its toothy ones, its rough ones.
const SPORE_SHY = ["hushcap_koi", "falsesmile_barb", "netcloud_fry", "sleepspore_jelly"];
const SPORE_TOOTHY = ["sporebelly_puffer", "lostsea_mackerel", "mildew_angler", "festival_puffer"];
const SPORE_ROUGH = [
  "threadling_eel",
  "cindertail_catfish",
  "downcast_catfish",
  "velvet_ray",
  "nightbloom_carp",
  "harpstring_eel",
];
const TRACE_LINES = [
  "Fish with sharp teeth or rough lips, such as puffers and catfish, land more often.",
  "Shy fish, such as koi, barbs and fry, bite less often.",
];
const SNOOD_LINES = [
  "Shy fish, such as koi, barbs and fry, bite more often.",
  "Sharp teeth cut thread, so puffers and mackerel land less often.",
];
const BURL_LINES = [
  "Fish that grab and run, such as catfish, eels and koi, are always hooked clean.",
  "Quick nibblers, such as fry, barbs and puffers, are never hooked clean.",
];
const BURL_ARRIVAL = "Catfish grab and run here. There's a hook on the shelf that sets itself.";
const TRACE_ARRIVAL = "Puffer beaks cut line. The Brass Trace is on the shelf now.";
const SNOOD_ARRIVAL = "Shy fish come to soft thread. The Mossthread Snood is on the shelf now.";
const SPORE_LOSS_TEETH = "Bitten through. A Brass Trace stops teeth.";
const SPORE_LOSS_LIPS = "Worn through on its lips. A Brass Trace won't wear.";
const SPORE_LOSS_RAN = "It ran before the hook was set. A Burl Hook sets itself.";
// Gives a Sporewood save rig parts as if bought, the Spore Moth for lure casts, and optionally fits parts.
const withSporeParts =
  (parts, fitted = {}) =>
  (save) => {
    const loop = save.meta.loop;
    loop.parts = [...new Set([...(loop.parts || ["cork_float", "plain_knot", "mere_hook"]), ...parts])];
    loop.lures = [...new Set([...(loop.lures || []), "spore_moth"])];
    loop.fitted = { ...loop.fitted, ...fitted };
  };
// Each kind's share of a roll on `leader` over its share on the Plain Knot, against an untagged kind's (`base`):
// what the leader does to how often it bites. Checks each against want(id); returns how many moved.
function leaderRatios(rolls, leader, base, want, label) {
  const plain = rolls.plain_knot.shares,
    on = rolls[leader].shares,
    ref = on[base] / plain[base];
  check(plain[base] > 0, `${label}: no ${base} to compare against`);
  let moved = 0;
  for (const id of Object.keys(plain).filter((id) => plain[id] > 0)) {
    check(on[id] > 0, `${label}: ${id} bites on the Plain Knot but not on ${leader}`);
    const ratio = on[id] / plain[id] / ref,
      expect = want(id);
    check(
      near(ratio, expect, 1e-6),
      `${label}: ${id} ${ratio.toFixed(4)} times as often, expected ${expect}`,
    );
    expect !== 1 && moved++;
  }
  check(moved > 0, `${label}: no tagged fish here, so this proves nothing`);
  return moved;
}

// Gives a save rig parts as if bought (on top of whatever the loader adds), the Feather Fly for lure casts, and
// optionally fits parts.
const withParts =
  (parts, fitted = {}) =>
  (save) => {
    const loop = save.meta.loop;
    loop.parts = [...new Set([...(loop.parts || ["cork_float"]), ...parts])];
    loop.lures = [...new Set([...(loop.lures || []), "feather_fly"])];
    loop.fitted = { ...loop.fitted, ...fitted };
  };

// One roll of the game's own odds for each leader in turn (fishPoolRoll), then the Plain Knot back on.
const rollLeaders = (session, leaders, roll = {}) =>
  session.eval(
    ([leaders, roll]) => {
      const loop = window.__gw.progression.loop,
        d = window.__gw.debug,
        out = {};
      for (const id of leaders) {
        loop.fitPart("leader", id);
        out[id] = d.fishPoolRoll(1, roll);
      }
      loop.fitPart("leader", "plain_knot");
      return out;
    },
    [leaders, roll],
  );

// Hooks a small fish of this kind (well inside the gear's limits) through the debug hooks, forces it to get away,
// plays the fight out and returns the fish:escaped event.
async function loseSmallFish(session, speciesId) {
  const ok = await session.eval((id) => {
    const g = window.__gw;
    window.__lost = null;
    window.__lostListen ||
      ((window.__lostListen = true),
      g.bus.on("fish:escaped", (e) => (window.__lost = JSON.parse(JSON.stringify(e)))));
    g.debug.fishOutcome("lose");
    const hooked = g.debug.fishHook(id, { z: -0.5 });
    hooked && g.debug.fishPlayTo(0.995);
    return hooked;
  }, speciesId);
  check(ok, `could not hook ${speciesId}: ${JSON.stringify(await session.state())}`);
  const end = Date.now() + 150_000;
  while (Date.now() < end) {
    const lost = await session.eval(() => window.__lost);
    if (lost) return await session.eval(() => (window.__gw.debug.fishOutcome(null), window.__lost));
    await session.clickButton(/^Got it$/);
    await session.pause(400);
  }
  throw new Error(`the ${speciesId} did not get away; ${JSON.stringify(await session.state())}`);
}

// A part's tray ("leader", "hook") on the rig picture: { chips: [{ key, on }], lines } or null when there is none.
const partRow = (session, kind) => rigTray(session, kind);

// ---- the line-up and the bite marks (mossmere-hunt-2.md section 3, sketch 3) ---------------------------------

const LINEUP = ["reedjaw_pike", "milkeye_perch", "kissmark_trout", "weeping_carp", "bridgechain_sturgeon"];
const MURK_LINEUP = "I can think of five fish here big enough to pull a rod in. Catch them and see.";
const LINEUP_HEAD = "These five fish are big enough to pull a rod in.";
const LINEUP_FRAME = "It isn't any of these, so far.";
const LINEUP_NONE = "It's none of them. Nobody here has ever caught it.";
const STURGEON_WHY = "It is long, but its mouth is a small tube for snails.";
const PIKE_WHY = "Its teeth cut a line clean. Hob's line was worn, not cut.";
const RING_LINE =
  "This fish has a wide ring of fine scrapes, and no tooth holes. Something big had it in a soft, rough mouth.";
const PIKE_CARD = "Look at its teeth. They leave two rows of small cuts.";
const CUTS_OPEN = "Something leaves two rows of small cuts.";
const CUTS_MATCH = "A pike's teeth leave two rows of small cuts.";
const RING_OPEN = "Something else leaves a wide ring of fine scrapes.";
const KISS_PLAIN = "It is big, but its mouth could not take a bird.";
const KISS_RINGED = "It has the ring of scrapes on it. Something had it, and let go.";
const HOOK_HUNT_LINE = "Something out there grabs and runs. There's a new hook on the shelf.";

// withMap, with sketch 3 drawn at the tally of evening 3 as the game draws it: the fish already caught crossed
// out, and the Kissmark's ring with it. `forget` takes kinds out of the Journal first, so their first catch is
// still to come.
const withLineup =
  (forget = []) =>
  (save) => {
    withMap(save);
    const journal = save.meta.journal || {};
    for (const id of forget) delete journal[id];
    const h = save.meta.loop.hunt.mossmere;
    h.sketches.lineup = 3;
    h.crossed = Object.fromEntries(LINEUP.filter((id) => journal[id]?.caught > 0).map((id) => [id, 3]));
    // A Kissmark crossed out from the Journal carried no ring: about one in four does, and that one is noted
    // when it is landed.
    h.marks = { cuts: 0, holes: 0, ring: 0 };
    h.ringed = [];
  };

// What a notepad element shows on its line-up page: the head line, each fish's row (crossed out or not, its words,
// how many red strokes), the empty frame's line, and the marks strip.
const lineupIn = (session, where) =>
  session.eval((sel) => {
    const pad = document.querySelector(sel);
    if (!pad) return null;
    const rows = [...pad.querySelectorAll(".gw-pad-lu-row")];
    return {
      head: pad.querySelector(".gw-pad-lu-head")?.textContent ?? null,
      rows: rows
        .filter((r) => r.dataset.fish !== "?")
        .map((r) => ({
          fish: r.dataset.fish,
          out: r.classList.contains("gw-out"),
          why: r.querySelector(".gw-pad-why")?.textContent ?? "",
          reds: r.querySelectorAll(".pl.r").length,
        })),
      frame: rows.find((r) => r.dataset.fish === "?")?.querySelector(".gw-pad-why")?.textContent ?? null,
      marks: [...pad.querySelectorAll(".gw-pad-mark")].map((m) => ({
        mark: m.dataset.mark,
        words: m.textContent.trim(),
      })),
    };
  }, where);

// The line-up as the Journal's Notepad tab shows it.
async function lineupInJournal(session) {
  await session.eval(() => window.__gw.ui.openJournal({ tab: "notepad" }));
  await session.waitFor("the notepad tab", 10_000, () => !!document.querySelector(".gw-journal-pad .gw-pad"));
  const shown = await lineupIn(session, ".gw-journal-pad .gw-pad");
  await session.eval(() => window.__gw.ui.closeAll());
  await session.pause(600);
  return shown;
}

// Lands a fish through the debug hook and reads its catch card before keeping it: the line under the picture and
// the ink mark drawn on it (its class), or null for each.
async function catchAndReadCard(session, speciesId) {
  const ok = await session.eval((id) => window.__gw.debug.instantCatch(id), speciesId);
  check(ok, `instantCatch(${speciesId}) refused`);
  let card = null;
  for (const end = Date.now() + 30_000; Date.now() < end && !card; ) {
    await session.pause(400);
    if (await session.clickButton(/^Got it$/)) continue;
    card = await session.eval(() => {
      const keep = [...document.querySelectorAll("button")].some(
        (b) => /^\d?Keep\b/.test(b.textContent.trim()) && b.getBoundingClientRect().width > 0,
      );
      return keep
        ? {
            line: document.querySelector(".gw-cc-markline")?.textContent ?? null,
            ink: document.querySelector(".gw-cc-art .gw-cc-mark")?.getAttribute("class") ?? null,
          }
        : null;
    });
  }
  check(card, `no catch card for ${speciesId}; ${JSON.stringify(await session.state())}`);
  await session.clickButton(/^\d?Keep\b/);
  await session.pause(600);
  await session.closeGuides(8000);
  return card;
}

// ---- the end of the hunt: measure and release, the bounty, Hob's Lamp, Hob's rod, Sporewood opens ----------
const MEASURED = [
  "So that's the thief. She's a great wels catfish, the biggest fish in Mossmere.",
  "An old brass bell is grown into her head. A scrap of old line is still wound round it.",
];
const RELEASE_LINE = "You let her go. She sinks back down to her hole, slow and easy.";
const MURK_LANDED = "You landed the thief. Sit down, I'll count it twice.";
const MURK_LAMP = "Hob rowed over with this. He says you've earned it.";
const LAMP_LINE =
  "Hob lit it on his rock every night for forty years. New kinds of fish bite more often while it hangs on your raft. It goes with you to every lake.";
const ROD_LINES = [
  "Your hook catches on something heavy. It's an old rod, green with weed, and its bell is gone.",
  "Take it to Hob on Mossbell Isle.",
];
const HOB_LANDED = "A bell, on its head? Well, now. I had a bell like that once.";
const HOB_ROD_BACK = "My rod! And she's got my old bell. Well, she can keep it.";
const PAD_SOLVED = "You solved it. It was never the gloom. It was her.";
const NEXT_ROD = "Take it to Hob on Mossbell Isle.";
const RING_LANDED = "She leaves the wide ring of scrapes.";
const FRAME_LANDED = "It was her all along.";
const LAMP = "hobs_lamp";

// legend-sold as if she had never been landed: her sale and her catch record taken out. The Bell Pool stays
// owned, so her water is found, and the hunt is not over.
const unsold =
  (more = null) =>
  (save) => {
    save.meta.loop.legends.belled_matriarch = 0;
    delete save.meta.journal.belled_matriarch;
    if (save.meta.loop.prints) delete save.meta.loop.prints.belled_matriarch;
    more?.(save);
  };

// Takes Hob's Lamp away again (an older save that sold her is given it on loading), so that scenarios which
// compare bite rolls with the build before the lamp roll the same.
const dropLamp = (session) =>
  session.eval(() => {
    window.__gw.progression.loop.state().relics.length = 0;
  });

// The tally as the player sees it: goes home, finishes the count, and returns the hunt block's and the gift
// block's words, then closes the tally and anything that opens after it (the notepad included). With `hear`,
// it also returns the pages Murk's box speaks over the card (murk) and the order of the two blocks (order).
async function tallyWords(session, { hear = false } = {}) {
  for (const homeBy = Date.now() + 60_000; !(await session.eval(() => window.__gw.game.goHome())); ) {
    check(Date.now() < homeBy, `the game will not go home; ${JSON.stringify(await session.state())}`);
    await session.closeGuides(3000);
    await session.pause(1000);
  }
  const soldVisible = () =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.trim() === "Sold" && b.getBoundingClientRect().width > 0,
    );
  await session.waitFor("Murk's tally", 90_000, soldVisible);
  await session.clickButton(/^Sold$/);
  const murk = hear ? (await hearMurk(session)).map((p) => p.text) : null;
  await session.pause(2500);
  const shown = await session.eval(() => {
    const text = (sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() ?? "";
    return {
      hunt: text(".gw-tally-hunt"),
      gift: text(".gw-tally-gift"),
      rows: [...document.querySelectorAll(".gw-trow")].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
      order: [...document.querySelectorAll(".gw-tally-hunt, .gw-tally-gift")].map((el) =>
        el.classList.contains("gw-tally-hunt") ? "hunt" : "gift",
      ),
    };
  });
  if (murk) shown.murk = murk;
  for (const end = Date.now() + 60_000; Date.now() < end && (await session.eval(soldVisible)); )
    await session.clickButton(/^Sold$/), await session.pause(1500);
  for (let i = 0; i < 8; i++) {
    await session.eval(() =>
      document.querySelector('.gw-modal[data-modal="notepad"].gw-in .gw-pad-close')?.click(),
    );
    await session.closeGuides(1000);
    await session.pause(500);
  }
  return shown;
}

// Whether Hob's Lamp stands on the raft (its 3D object, by name) and whether his rock still shows it.
const lampsInWorld = (session) =>
  session.eval(() => {
    const g = window.__gw,
      scene = g.render?.scene;
    let raft = null,
      rock = null;
    scene?.traverse((o) => {
      o.name === "relic:hobsLamp" && (raft = o.visible);
      o.name === "Hob's lamp" && (rock = o.visible);
    });
    return { raft, rock, lit: g.progression.loop.hobLampLit(), here: g.progression.loop.hobHere() };
  });

// ---- practice orders on Murk's Order Board ----------------------------------------------------------------

// The parts that post practice orders, and the designer's table (mossmere-review-addendum.md section 3): the part,
// one of its fish, and Murk's line for it.
const PRACTICE_PARTS = ["minnow_tin", "sounding_lead", "turnback_hook", "chafe_gut"];
const PRACTICE_TABLE = [
  ["minnow_tin", "mossback_perch", "Bring me a Mossback Perch, taken on a live minnow."],
  ["minnow_tin", "milkeye_perch", "Bring me a Milkeye Perch, taken on a live minnow."],
  ["sounding_lead", "rustfin_sucker", "Bring me a Rustfin Sucker, caught on the bottom."],
  ["sounding_lead", "bridgechain_sturgeon", "Bring me a Bridgechain Sturgeon, caught on the bottom."],
  ["turnback_hook", "weeping_carp", "Bring me a Weeping Carp, caught on the Turnback Hook."],
  ["chafe_gut", "overbold_bass", "Bring me an Overbold Bass, caught on Chafe Gut."],
];
// The practice order for the Turnback Hook, as the board keeps it.
const PRACTICE_CARP = {
  id: "ord_practice_carp",
  speciesId: "weeping_carp",
  kind: "rig",
  n: 1,
  have: 0,
  part: "turnback_hook",
  rig: { hook: "turnback_hook" },
  said: true,
};
// A hash (FNV-1a) of the 40 seeded refills of a two-order board from mid-mossmere.json (practiceKit's rng, seed
// 12345), drawn by the build before practice orders (commit 41aa04a).
const BOARD_BEFORE = "9de5392b";

// Puts window.__practice in the page: a seeded rng, a copy of the loaded loop with a board and parts as asked,
// and the board's own refill (the game's Uy) for a water.
const practiceKit = (session) =>
  session.eval(() => {
    const g = window.__gw,
      D = g.data,
      base = JSON.parse(JSON.stringify(g.progression.loop.state()));
    window.__practice = {
      D,
      rng(seed) {
        return () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      },
      hash(text) {
        let h = 2166136261;
        for (const c of text) (h ^= c.charCodeAt(0)), (h = Math.imul(h, 16777619) >>> 0);
        return h.toString(16);
      },
      loop({ board = 1, parts = [], ready = parts, filled = [], places = null } = {}) {
        const l = JSON.parse(JSON.stringify(base));
        l.home.orders = board;
        l.parts = [...new Set([...l.parts, ...parts])];
        l.practice = { ready: [...ready], filled: [...filled] };
        l.orders = [];
        places && (l.maps.places = [...places]);
        return l;
      },
      refill(l, rng, water = "mossmere") {
        return D.refillOrders(D, l, { listFor: D.orderList, water, rng });
      },
    };
  });

// ---- each lake's own kit and purse (mossmere-gear-deeper.md B4 "Each lake's own kit and purse") ----------
// The live fields that are the kit of the lake the barge is in.
const KIT_KEYS = [
  "clams",
  "tackle",
  "fit",
  "holdSlots",
  "raft",
  "carry",
  "parts",
  "rigs",
  "activeRig",
  "fitted",
];
// The live kit, the stored kits, bait and the gear pointer, as plain data.
const kitNow = (session) =>
  session.eval((keys) => {
    const s = window.__gw.progression.loop.state(),
      kit = {};
    for (const k of keys) kit[k] = s[k];
    return JSON.parse(
      JSON.stringify({ kit, kits: s.kits, bait: s.bait, gearWater: s.gearWater, water: s.barge.water }),
    );
  }, KIT_KEYS);
// The state change of a tow, as the tow controller makes it (towBarge), without the animation.
const towKit = (session, water) => session.eval((w) => window.__gw.progression.loop.towBarge(w), water);
// Murk's Tackle and Raft tabs as id, price, which lake's piece and whether owned, and the fitted tackle's Grip
// and cast as the Sheet shows them (holdOf).
const shelfAndGrip = (session) =>
  session.eval(() => {
    const loop = window.__gw.progression.loop;
    return {
      items: loop
        .shelf()
        .tabs.filter((t) => t.id === "tackle" || t.id === "raft")
        .flatMap((t) =>
          t.items.map((i) => `${i.id}:${i.price}:${i.itemId ?? "-"}:${i.bought ? "owned" : "sale"}`),
        ),
      grip: loop.holdOf(),
    };
  });
// A Mossmere kit with something in every field: rod, line and reel tiers, a creel, oars, the lead and Pike Wire
// on Rig 1 with Rig 2 in use, and clams.
async function fillMossmereKit(session) {
  await buyAtHome(session, ["rod:1", "line:1", "reel:1", "hold:4", "oars:1"]);
  await session.eval(() => window.__gw.progression.loop.useRig(1));
}
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const NEW_GAME_PARTS = ["cork_float", "plain_knot", "mere_hook"];

// ---- the rig picture on Taper's Sheet and in Murk's Tackle tab ------------------------------------------------

// Opens the Sheet's Tackle page (as the rack does) or Murk's Tackle tab, and returns what its rig picture shows:
// the parts' nodes, the tabs, whether old plates or a hook row are left, and whether the picture says it is busy.
const RIG_HOST = { sheet: ".gw-sh-sec--tackle .gw-rig-host", shop: ".gw-mb-page--rig .gw-rig-host" };
async function openRigHost(session, where) {
  await session.eval(
    (w) =>
      w === "sheet"
        ? window.__gw.ui.openSheet({ from: "rack", section: "tackle" })
        : window.__gw.ui.loop.openShelf({ tab: "tackle" }),
    where,
  );
  await session.waitFor(
    `the rig picture (${where})`,
    15_000,
    (sel) => !!document.querySelector(sel),
    RIG_HOST[where],
  );
  await session.pause(500);
  return rigHostShown(session, where);
}
const rigHostShown = (session, where) =>
  session.eval((sel) => {
    const host = document.querySelector(sel);
    return host
      ? {
          nodes: [...host.querySelectorAll(".gw-rig-node")].map((b) => `${b.dataset.part}:${b.dataset.key}`),
          tabs: host.querySelectorAll(".gw-rig-tab").length,
          busy: host.classList.contains("gw-ts-busy"),
          tray: host.querySelector(".gw-rig-tray")?.dataset.part ?? null,
          plates: document.querySelectorAll(".gw-sh-sec--tackle .gw-sh-plate:not([data-plate^=note])").length,
          hookRow: !!document.querySelector(".gw-sh-sec--tackle .gw-sh-hookrow"),
        }
      : null;
  }, RIG_HOST[where]);
// Presses a part's node and returns its tray: each option's key or shelf id, whether it is pressed, its text and
// its price (a shelf piece), and the tray's notes.
async function rigHostTray(session, where, part) {
  await session.eval(
    ([sel, p]) => document.querySelector(`${sel} .gw-rig-node[data-part="${p}"]`)?.click(),
    [RIG_HOST[where], part],
  );
  await session.pause(700);
  return session.eval((sel) => {
    const tray = document.querySelector(`${sel} .gw-rig-tray`);
    if (!tray) return null;
    return {
      part: tray.dataset.part,
      owned: [...tray.querySelectorAll(".gw-rig-opt[data-owned=true]")].map((o) => ({
        key: o.dataset.key,
        on: o.getAttribute("aria-pressed") === "true",
        tag: o.querySelector(".gw-rig-owned")?.textContent ?? "",
        text: o.textContent.replace(/\s+/g, " ").trim(),
      })),
      shop: [...tray.querySelectorAll(".gw-rig-shop")].map((o) => ({
        id: o.dataset.buy,
        button: o.tagName === "BUTTON",
        price: Number((o.querySelector(".gw-rig-price")?.textContent || "").replace(/\D/g, "")),
        text: o.textContent.replace(/\s+/g, " ").trim(),
      })),
      notes: [...tray.querySelectorAll(".gw-rig-note")].map((n) => n.textContent.trim()),
    };
  }, RIG_HOST[where]);
}
const rigHostPress = (session, where, selector) =>
  session.eval(
    ([sel, s]) => {
      const el = document.querySelector(`${sel} .gw-rig-tray ${s}`);
      el?.click();
      return !!el;
    },
    [RIG_HOST[where], selector],
  );
const rigHostBack = (session, where) =>
  session.eval((sel) => document.querySelector(`${sel} .gw-rig-tray .gw-rig-back`)?.click(), RIG_HOST[where]);
const RIG_PARTS_SAVE = (save) => {
  withParts([])(save);
  // Every Leader and Hook part on Murk's shelf, and clams for them.
  save.meta.loop.arrivals = {
    seq: 3,
    beats: { turnback_hook: 1, pike_wire: 2, chafe_gut: 2 },
    shelved: ["turnback_hook", "pike_wire", "chafe_gut"],
  };
};

// ---- Murk's speech box: the box Hob talks in, at the tally and at the jetty --------------------------------
const MURK_BOX = '.gw-modal.gw-in[data-modal="murktalk"]';
const FIT_LINE = "To fit it, press the float on the Tackle screen.";
// From now until the page is left, notes every box that is ever on screen together with Murk's: a guide box,
// Hob's box or the notepad. murkSharedWith() reads the list.
const watchMurkAlone = (session) =>
  session.eval(() => {
    window.__murkShared = [];
    const on = (id) => !!document.querySelector(`.gw-modal.gw-in[data-modal="${id}"]`);
    setInterval(() => {
      if (!on("murktalk")) return;
      for (const id of ["guide", "hob", "notepad"])
        if (on(id) && !window.__murkShared.includes(id)) window.__murkShared.push(id);
    }, 40);
  });
const murkSharedWith = (session) => session.eval(() => window.__murkShared ?? null);
const murkBoxUp = (session) => session.eval((sel) => !!document.querySelector(sel), MURK_BOX);
// Waits for Murk's box, then reads each page and goes on until he is done. The first page is turned with the
// Escape key when `escapeFirst` (it must go on a page, never end the talk). Each page: { tag, text, button,
// tally } (tally: his card is open under the box).
async function hearMurk(session, { waitMs = 30_000, escapeFirst = false } = {}) {
  await session.waitFor("Murk's box", waitMs, (sel) => !!document.querySelector(sel), MURK_BOX);
  const pages = [];
  for (let i = 0; i < 12; i++) {
    const page = await session.eval((sel) => {
      const box = document.querySelector(sel);
      return box
        ? {
            tag: box.querySelector(".gw-speech-tag").textContent.trim(),
            text: box.querySelector(".gw-murk-text").textContent,
            button: box.querySelector(".gw-murk-ok").textContent.trim(),
            tally: !!document.querySelector('.gw-modal.gw-in[data-modal="tally"]'),
          }
        : null;
    }, MURK_BOX);
    if (!page) break;
    pages.push(page);
    if (escapeFirst && pages.length === 1) await session.page.keyboard.press("Escape");
    else await session.eval((sel) => document.querySelector(`${sel} .gw-murk-ok`).click(), MURK_BOX);
    await session.pause(700);
  }
  return pages;
}
// Saves, reloads the page and presses Continue: back at home as a player coming back to the game.
async function reloadToHome(session) {
  await session.eval(() => window.__gw.game.save());
  // A reloaded file page is sometimes handed an older copy of localStorage (the browser's fault, not the game's),
  // so the save just written is put back before the game boots.
  const saved = await session.saved();
  await session.context.addInitScript(([key, value]) => localStorage.setItem(key, value), [SAVE_KEY, saved]);
  await session.page.reload({ waitUntil: "domcontentloaded" });
  await session.boot();
  await session.clickButton(/^Continue$/);
  await session.waitFor("home", 60_000, () => window.__gw.flow === "home");
}

// ---- a controller alone, and a screen of another refresh rate (the Lenovo Legion Go and Go S) -----------------

// A standard-mapping gamepad (the Xbox layout) behind navigator.getGamepads, as the browser shows one once it is
// used. window.__padConnect() plugs it in and fires gamepadconnected; __padSet(button, down) presses a button by
// the standard mapping's number (PAD) and __padAxes([lx, ly, rx, ry]) moves the sticks.
const GAMEPAD_INIT = () => {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = {
    id: "Xbox 360 Controller (XInput STANDARD GAMEPAD)",
    index: 0,
    connected: true,
    mapping: "standard",
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons,
    vibrationActuator: { type: "dual-rumble", playEffect: () => Promise.resolve("complete") },
  };
  let on = false;
  Object.defineProperty(Navigator.prototype, "getGamepads", {
    configurable: true,
    value: () => (on ? [pad, null, null, null] : [null, null, null, null]),
  });
  window.__padConnect = () => {
    on = true;
    pad.timestamp = performance.now();
    const e = new Event("gamepadconnected");
    e.gamepad = pad;
    window.dispatchEvent(e);
  };
  window.__padSet = (i, down) => {
    Object.assign(buttons[i], { pressed: !!down, touched: !!down, value: down ? 1 : 0 });
    pad.timestamp = performance.now();
  };
  window.__padAxes = (a) => {
    pad.axes = a.slice();
    pad.timestamp = performance.now();
  };
};
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

const gameFrame = (session) => session.eval(() => window.__gw.time.frame);
async function waitFrames(session, n) {
  const until = (await gameFrame(session)) + n;
  for (const end = Date.now() + 120_000 * SLOW; Date.now() < end; await session.pause(20))
    if ((await gameFrame(session)) >= until) return;
  throw new Error(`${n} frames did not pass`);
}

// One press of a controller button: down for two frames (the game reads the pad once a frame), then up for two.
async function padPress(session, name, frames = 2) {
  await session.eval((i) => window.__padSet(i, true), PAD[name]);
  await waitFrames(session, frames);
  await session.eval((i) => window.__padSet(i, false), PAD[name]);
  await waitFrames(session, 2);
}

// What a controller player sees: the screen on top, the focused control and whether it is drawn on screen, the
// A and B glyphs shown, the sound card, and the sound's state.
const padView = (session) =>
  session.eval(() => {
    const g = window.__gw;
    const open = [...document.querySelectorAll(".gw-modal-layer > .gw-modal")].filter(
      (m) => !m.classList.contains("gw-out") && !m.dataset.held,
    );
    const f = document.querySelector(".gw-padfocus");
    const r = f?.getBoundingClientRect();
    return {
      flow: g.flow,
      fishing: g.fishing?.state ?? null,
      top: open.at(-1)?.dataset.modal ?? null,
      mode: g.debug.pad?.()?.mode ?? null,
      focus: f
        ? (f.getAttribute("aria-label") || f.textContent).trim().replace(/\s+/g, " ").slice(0, 40)
        : null,
      focusShown: !!r && r.width > 1 && r.height > 1 && r.bottom > 0 && r.top < innerHeight,
      glyphs: [...document.querySelectorAll(".gw-padg.gw-on")].map((c) => c.textContent),
      hush: !!document.querySelector(".gw-hush:not(.gw-out)"),
      sound: g.debug.audio?.()?.state ?? null,
      tab: [...(open.at(-1)?.querySelectorAll("[role=tab][aria-selected=true]") ?? [])]
        .map((t) => t.textContent.trim())
        .join(","),
    };
  });

// The page's clock for a test of real time: performance.now, Date.now, the timers and requestAnimationFrame all
// follow one clock, and the screen refreshes `hz` times a second of it however long a frame really takes here.
// Frames come as fast as the machine allows, so the game sees a perfect display at that rate.
const VIRTUAL_CLOCK = (hz) => {
  const step = 1000 / hz;
  const realTimeout = window.setTimeout.bind(window);
  const dateBase = Date.now() - performance.now();
  let now = performance.now();
  let nextId = 1;
  const timers = new Map();
  let frames = [];
  performance.now = () => now;
  Date.now = () => Math.floor(dateBase + now);
  window.setTimeout = (fn, ms = 0, ...args) => {
    timers.set(nextId, { due: now + Math.max(0, Number(ms) || 0), fn, args, every: 0 });
    return nextId++;
  };
  window.setInterval = (fn, ms = 0, ...args) => {
    const every = Math.max(1, Number(ms) || 0);
    timers.set(nextId, { due: now + every, fn, args, every });
    return nextId++;
  };
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  window.requestAnimationFrame = (cb) => (frames.push({ id: nextId, cb }), nextId++);
  window.cancelAnimationFrame = (id) => (frames = frames.filter((f) => f.id !== id));
  window.requestIdleCallback = (cb) =>
    window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 5 }), 1);
  window.cancelIdleCallback = (id) => timers.delete(id);
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    const target = now + step;
    for (let guard = 0; guard < 10000; guard++) {
      let next = null;
      for (const entry of timers)
        if (entry[1].due <= target && (!next || entry[1].due < next[1].due)) next = entry;
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.due);
      t.every ? (t.due += t.every) : timers.delete(id);
      try {
        t.fn(...t.args);
      } catch (e) {
        console.error(e);
      }
    }
    now = target;
    const due = frames;
    frames = [];
    for (const f of due)
      try {
        f.cb(now);
      } catch (e) {
        console.error(e);
      }
    window.__onFrame?.(now);
    realTimeout(() => channel.port2.postMessage(0), 0);
  };
  channel.port2.postMessage(0);
};

// On the water from mid-Mossmere, with the page on VIRTUAL_CLOCK: how long things take in the page's real time,
// counted only while nothing holds the game (a card, a guide box, the pause), so the moments a test takes to press
// a box away do not count. Returns { hz, dusk, window, fight, landing, sail } in milliseconds (sail in m/s).
async function timeRealPlay(session) {
  await session.eval(() => (window.__gw.render.render = () => {})); // the CPU-drawn picture only slows the test
  await session.sail();
  await session.eval(() => {
    const g = window.__gw;
    const rec = (window.__real = {
      states: [],
      phases: [],
      raft: [],
      free: 0,
      first: performance.now(),
      last: performance.now(),
      frames: 0,
    });
    let state = null;
    g.bus.on("phase:change", (e) => rec.phases.push([rec.free, e?.phase ?? null]));
    window.__onFrame = (t) => {
      const held = g.ui.isBlocking?.() === true || g.paused || g.flow !== "playing";
      held || (rec.free += t - rec.last);
      (rec.last = t), rec.frames++;
      g.fishing.state !== state && rec.states.push([rec.free, (state = g.fishing.state)]);
      rec.raftOn && rec.raft.push([rec.free, g.player.position.x, g.player.position.z]);
    };
  });
  const free = () => session.eval(() => window.__real.free);
  const waitFree = async (ms) => {
    const until = (await free()) + ms;
    for (const end = Date.now() + 240_000 * SLOW; (await free()) < until; await session.pause(40))
      if (Date.now() > end) throw new Error(`${ms} ms of play did not pass`);
  };
  const waitState = async (ok, what) => {
    for (const end = Date.now() + 240_000 * SLOW; ; await session.pause(30)) {
      if (ok(await session.eval(() => window.__gw.fishing.state))) return;
      if (Date.now() > end) throw new Error(`no ${what}; ${JSON.stringify(await session.state())}`);
      if (await session.eval(() => window.__gw.ui.isBlocking?.() === true))
        await session.clickButton(/^(Got it|Next)$/);
    }
  };
  const out = {};
  // The dusk: one whole part of the evening, between two changes of the light, with nothing pressed.
  for (const end = Date.now() + 600_000 * SLOW; ; await session.pause(500)) {
    const phases = await session.eval(() => window.__real.phases.slice());
    if (phases.length >= 2) {
      out.dusk = phases[1][0] - phases[0][0];
      break;
    }
    if (Date.now() > end) throw new Error(`the light did not change twice: ${JSON.stringify(phases)}`);
  }
  // The strike window: a bite left alone, from the float going under until the fish is gone.
  await session.eval(() => {
    window.__gw.debug.fishSeed(7);
    window.__real.states.length = 0;
    window.__gw.debug.forceBite("mossback_perch");
  });
  await waitState((st) => st === "bite", "bite");
  await waitState((st) => st !== "bite", "end of the bite");
  const states = await session.eval(() => window.__real.states.slice());
  const bite = states.findIndex((s) => s[1] === "bite");
  out.window = states[bite + 1][0] - states[bite][0];
  await session.closeGuides(3000);
  // A fight: the same fish, seed and outcome; from the hook to the landing, and the landing to the card.
  await session.eval(() => {
    const g = window.__gw;
    g.debug.fishSeed(11);
    g.debug.fishOutcome("land");
    window.__real.states.length = 0;
    g.debug.fishHook("mossback_perch", { z: 1 });
  });
  await waitState((st) => !["reeling", "landing", "hooked"].includes(st), "end of the fight");
  const fight = await session.eval(() => window.__real.states.slice());
  const at = (name) => fight.find((s) => s[1] === name)?.[0];
  out.fight = at("landing") - (at("reeling") ?? 0);
  out.landing = fight.find((s, i) => i > 0 && !["reeling", "landing"].includes(s[1]))[0] - at("landing");
  for (let i = 0; i < 30 && !(await session.clickButton(/^\d?Let go\b/)); i++) {
    await session.clickButton(/^Got it$/);
    await session.pause(300);
  }
  await session.closeGuides(4000);
  // Sailing: the left stick held forward; the raft's speed over the last two of three seconds.
  await session.eval(() => {
    window.__padConnect();
    window.__real.raftOn = true;
    window.__padAxes([0, -1, 0, 0]);
  });
  await waitFree(3000);
  const raft = await session.eval(() => {
    window.__padAxes([0, 0, 0, 0]);
    window.__real.raftOn = false;
    return window.__real.raft.slice();
  });
  const span = raft.filter((r) => r[0] >= raft.at(-1)[0] - 2000);
  let metres = 0;
  for (let i = 1; i < span.length; i++)
    metres += Math.hypot(span[i][1] - span[i - 1][1], span[i][2] - span[i - 1][2]);
  out.sail = (metres / (span.at(-1)[0] - span[0][0])) * 1000;
  out.hz = await session.eval(
    () => (window.__real.frames / (window.__real.last - window.__real.first)) * 1000,
  );
  return out;
}

const SCENARIOS = [
  {
    name: "gear: on the water with the lead: no float, the line slants in, the Tip Bell on every rod, the depth word, the tip answers, a real press strikes and lands",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 600_000,
    editSave: withLead(false),
    async run(session) {
      await session.toHome();
      check(
        !(await oddsFoot(session)).includes(LEAD_ODDS),
        "the Odds page gives the lead's numbers on the float",
      );
      // Fitted the way a player does it: the Sounding Lead in the Depth part's tray on the rig picture.
      await depthRow(session);
      await session.eval(() =>
        document
          .querySelector('.gw-rig-tray[data-part="depth"] .gw-rig-opt[data-key="sounding_lead"]')
          .click(),
      );
      await session.pause(800);
      const row = (await depthRow(session))?.lines ?? [];
      await closeTackle(session);
      check((await leadRecord(session)).depth === "lead", "the Depth chip did not fit the lead");
      check(
        row.join(" ") ===
          "Fish that feed on the bottom bite more often. Fish that feed higher bite less often, and there is no float to watch.",
        `the lead's lines: ${row}`,
      );
      // Its numbers are on the Odds page only.
      const odds = await oddsFoot(session);
      check(odds.includes(LEAD_ODDS), `the Odds page does not give the lead's numbers: ${odds}`);
      await buyAtHome(session, ["rod:1", "rod:2"]);
      await session.sail();
      // The Tip Bell sits on the tip of each of the three rods.
      const rods = [];
      for (const pick of ["willow_switch", "ashwood_rod", null]) {
        await session.eval((id) => window.__gw.progression.loop.fitTackle("rod", id), pick);
        await session.pause(1500);
        const r = await session.eval(() => {
          const a = window.__gw.actors.leadDebug();
          let model = null;
          window.__gw.render.scene.traverse((o) => {
            o.name === "rod-blank" && o.parent?.name === "rod" && (model = o.userData.tackleId);
          });
          return { model, bell: a.bell.visible, off: Math.hypot(...a.bell.at.map((v, i) => v - a.tip[i])) };
        });
        check(r.bell && r.off < 0.02, `the Tip Bell on ${r.model}: ${JSON.stringify(r)}`);
        rods.push(r.model);
      }
      check(new Set(rods).size === 3, `three rod models: ${rods}`);
      // A cast on the lead, watched to the bite; every line shown is recorded.
      await listenOnWater(session);
      await session.eval(() => {
        const g = window.__gw;
        window.__leadWatch = {
          events: [],
          maxNibbleLoad: 0,
          maxSwing: 0,
          float: false,
          ring: false,
          biteLoad: 0,
        };
        for (const n of ["fishing:nibble", "fishing:tell", "fishing:bite"])
          g.bus.on(n, (e) => window.__leadWatch.events.push(`${n}${e?.onLead ? ":lead" : ""}`));
        const p = g.player.position,
          yaw = g.render.getYaw();
        g.debug.castAt(p.x - Math.sin(yaw) * 9, p.z - Math.cos(yaw) * 9, 0.6);
        window.__leadTimer = setInterval(() => {
          const a = g.actors.leadDebug(),
            w = window.__leadWatch;
          if (g.fishing.state === "waiting" || g.fishing.state === "bite") {
            w.float ||= a.floatShown;
            w.ring ||= a.ringShown;
            w.sink = a.sink;
            w.lineDrop = a.lineDrop;
            w.events.length && (w.maxNibbleLoad = Math.max(w.maxNibbleLoad, a.tipLoad));
            w.maxSwing = Math.max(w.maxSwing, a.bell.swing);
          }
          g.fishing.state === "bite" && (w.biteLoad = Math.max(w.biteLoad, a.tipLoad));
        }, 50);
      });
      let state = "casting";
      for (const end = Date.now() + 240_000; Date.now() < end; ) {
        state = await session.eval(() => window.__gw.fishing.state);
        if (state === "bite" || state === "reeling" || state === "idle") break;
        await session.clickButton(/^Got it$/);
        await session.pause(120);
      }
      check(state === "bite", `no bite on the lead (state ${state})`);
      // The real strike input: a press on the water.
      // The test window is small, so the rig chip can sit mid-screen: press the first spot of open water.
      const box = await session.page.locator("canvas").first().boundingBox();
      const spot = await session.eval(
        (b) =>
          [
            [0.5, 0.6],
            [0.5, 0.78],
            [0.72, 0.62],
            [0.28, 0.78],
            [0.8, 0.5],
          ]
            .map(([fx, fy]) => [b.x + b.width * fx, b.y + b.height * fy])
            .find(([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS") ?? null,
        box,
      );
      check(spot, "no open water to press");
      await session.page.mouse.click(spot[0], spot[1]);
      await session.pause(1500);
      const watch = await session.eval(() => (clearInterval(window.__leadTimer), window.__leadWatch));
      const hooked = await session.eval(() => window.__gw.fishing.state);
      check(hooked === "reeling" || hooked === "landing", `the press did not strike: ${hooked}`);
      check(!watch.float && !watch.ring, `a float or its ring showed: ${JSON.stringify(watch)}`);
      check(
        watch.sink > 0.99 && watch.lineDrop > 0.3,
        `the lead did not settle, the line slanting in: ${JSON.stringify(watch)}`,
      );
      check(
        watch.events.includes("fishing:nibble:lead") &&
          watch.events.includes("fishing:tell:lead") &&
          watch.events.includes("fishing:bite:lead"),
        `the tells were not on the lead: ${watch.events}`,
      );
      check(
        watch.maxNibbleLoad > 0.2 && watch.maxSwing > 0.02,
        `the tip and bell did not answer: ${JSON.stringify(watch)}`,
      );
      check(watch.biteLoad > 0.5, `the tip did not pull round at the bite: ${watch.biteLoad}`);
      // Landed: the catch card. A fish can still get away (the landing roll is the game's); then cast again.
      const castAndStrike = async () => {
        await session.eval(() => {
          const g = window.__gw,
            p = g.player.position,
            yaw = g.render.getYaw();
          g.debug.castAt(p.x - Math.sin(yaw) * 9, p.z - Math.cos(yaw) * 9, 0.6);
        });
        for (const end = Date.now() + 240_000; Date.now() < end; ) {
          const st = await session.eval(() => window.__gw.fishing.state);
          if (st === "bite") break;
          await session.clickButton(/^Got it$/);
          await session.pause(120);
        }
        await session.page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6);
      };
      await session.eval(() => {
        window.__landed = { landed: 0, escaped: 0 };
        window.__gw.bus.on("fish:landed", () => window.__landed.landed++);
        window.__gw.bus.on("fish:escaped", () => window.__landed.escaped++);
      });
      let card = false,
        tries = 1;
      for (const end = Date.now() + 400_000; Date.now() < end && !card; ) {
        await session.clickButton(/^Got it$/);
        card = await session.eval(() =>
          [...document.querySelectorAll("button")].some(
            (b) => /Keep/.test(b.textContent) && b.getBoundingClientRect().width > 0,
          ),
        );
        const now = await session.eval(() => ({ ...window.__landed, state: window.__gw.fishing.state }));
        if (!card && now.escaped >= tries && now.state === "idle" && tries < 3) {
          tries++;
          await castAndStrike();
        }
        await session.pause(400);
      }
      check(card, `the fish was not landed in ${tries} tries`);
      await session.clickButton(/^\d?Keep\b/);
      const heard = await heardOnWater(session);
      const word = heard.lines.find((l) => /^(Shallow|Middling|Deep)$/.test(l));
      check(word, `no depth word after the cast: ${heard.lines.slice(0, 20).join(" | ")}`);
      // The guide's boxes are the first-play guide's own words and are not changed here; a save that never saw
      // its bite box (made before the guide) sees it at its first bite, on the lead too.
      const floaty = heard.lines.find(
        (l) => !/^Guide\b/.test(l) && /\bfloat|\bcork|\bunder\b|bobber/i.test(l),
      );
      check(!floaty, `a line on the lead speaks of a float: "${floaty}"`);
      // A hard take slams the tip and rings the bell hardest.
      const slam = await session.eval(async () => {
        const g = window.__gw;
        const p = g.player.position,
          yaw = g.render.getYaw();
        g.debug.castAt(p.x - Math.sin(yaw) * 9, p.z - Math.cos(yaw) * 9, 0.6);
        for (let k = 0; k < 400 && g.fishing.state !== "waiting"; k++)
          await new Promise((r) => setTimeout(r, 100));
        g.actors.takeLoad("hard");
        await new Promise((r) => setTimeout(r, 60));
        return g.actors.leadDebug().bell.speed;
      });
      check(slam > 3, `the bell did not ring at a hard take: ${slam}`);
      return `rods ${rods.join(", ")}; word "${word}"; tip ${watch.maxNibbleLoad.toFixed(2)} at a nibble, ${watch.biteLoad.toFixed(2)} at the bite; struck by a press and landed (${tries} ${tries > 1 ? "casts" : "cast"})`;
    },
  },
  {
    name: "rod looks: fitting each Mossmere rod changes the rod drawn on the raft at once, its blank ends at the tip the line leaves, a reload shows the fitted rod, and a seeded real cast reaches as far as before",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      // The reach each rod's cast had before rods had their own looks: the shop rods' casts in the kit data.
      const REACH = { willow_switch: 16, ashwood_rod: 17.5, whalebone_rod: 19 };
      await session.toHome();
      await buyAtHome(session, ["rod:1", "rod:2"]);
      await session.sail();
      await session.closeGuides(3000);
      const looks = [];
      for (const id of Object.keys(REACH)) {
        await session.closeGuides(2000);
        const r = await session.eval(async (id) => {
          const g = window.__gw;
          g.progression.loop.fitTackle("rod", id);
          await new Promise((done) => setTimeout(done, 1200));
          const look = g.actors.rodLook(),
            reach = g.progression.loop.holdOf().cast - (g.progression.loop.state().carry?.cast || 0);
          // (the blank's last ring leans with its sweep, so its top sits within 5 mm of the tip)
          // A real cast: the press starts the meter, the release lets it go. The seed fixes the cast's own rolls.
          g.debug.fishSeed(4242);
          const seen = [];
          const off = g.bus.on("fishing:cast", (e) => seen.push(e));
          // A press can meet a card or a moving raft and come to nothing: then it is tried again.
          for (let tries = 0; tries < 8 && !seen.length; tries++) {
            g.fishing.onPointerDown({ input: "mouse" });
            await new Promise((done) => setTimeout(done, 700));
            g.fishing.onPointerUp();
            await new Promise((done) => setTimeout(done, 400 + 800 * tries));
          }
          typeof off == "function" && off();
          const p = g.player.position,
            cast = seen[0],
            dist = cast ? Math.hypot(cast.target.x - p.x, cast.target.z - p.z) : null;
          const minDist = g.data?.LOOP?.cast?.minDist ?? 3;
          // Reeled in again for the next rod: a press while it waits brings the line in.
          for (let k = 0; k < 40 && g.fishing.state === "casting"; k++)
            await new Promise((done) => setTimeout(done, 100));
          if (g.fishing.state === "waiting")
            g.fishing.onPointerDown({ input: "mouse" }), g.fishing.onPointerUp();
          for (let k = 0; k < 40 && g.fishing.state !== "idle"; k++)
            await new Promise((done) => setTimeout(done, 250));
          return { look, reach, power: cast?.power ?? null, dist, minDist };
        }, id);
        check(r.look?.rod === id, `the rod drawn is ${r.look?.rod} with ${id} fitted`);
        check(
          Math.abs(r.look.top - r.look.length) < 0.005,
          `${id}: the blank ends at ${r.look.top}, the tip at ${r.look.length}`,
        );
        check(r.look.triangles <= 320, `${id}: ${r.look.triangles} triangles`);
        check(Math.abs(r.reach - REACH[id]) < 1e-9, `${id} reaches ${r.reach} m, ${REACH[id]} m before`);
        check(r.dist !== null, `${id}: no cast went out`);
        const want = Math.max(r.minDist, r.power * REACH[id]);
        check(
          Math.abs(r.dist - want) < 0.51,
          `${id}: the cast at ${r.power.toFixed(3)} power went ${r.dist.toFixed(2)} m, ${want.toFixed(2)} m before`,
        );
        looks.push(r);
      }
      const marks = looks.map((r) => `${r.look.rod}@${r.look.length}`);
      // Every rod the system draws, the found pole and the other lakes' rods too, stays near 300 triangles.
      const counts = await session.eval(() =>
        ["lamp_pole", "stalkwood", "amberheart", "glassreed_rod", "lantern_spine"].map((id) =>
          window.__gw.actors.rodLook(id),
        ),
      );
      const heavy = counts.filter((c) => !(c.triangles > 0 && c.triangles <= 320));
      check(!heavy.length, `over 320 triangles: ${heavy.map((c) => `${c.rod} ${c.triangles}`).join(", ")}`);
      check(new Set(marks).size === 3, `three rod looks: ${marks}`);
      // The save remembers the fitted rod: home, the save written, and the page loaded again.
      await session.goHomeAndTally();
      await reloadToHome(session);
      await session.sail();
      const loaded = await session.eval(() => window.__gw.actors.rodLook());
      check(loaded?.rod === "whalebone_rod", `after a reload the raft shows ${loaded?.rod}`);
      return (
        looks
          .map(
            (r) =>
              `${r.look.rod} ${r.look.length} m, ${r.look.triangles} tris, cast ${r.dist.toFixed(2)} m at ${r.power.toFixed(2)}`,
          )
          .join("; ") +
        `; ${counts.map((c) => `${c.rod} ${c.triangles} tris`).join(", ")}; reloaded: ${loaded.rod}`
      );
    },
  },
  {
    name: "raft looks: each keel and lantern level draws something different on the raft at once after it is bought, the lantern's frame grows and gains brass, and a reload shows the same raft",
    fixture: "legend-sold",
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      await session.toHome();
      // The raft redraws its parts from the save's levels (it looks twice a second): read through its debug hook
      // until it shows the level, for at most 3 s after the buy.
      const look = (want) =>
        session.eval(async (want) => {
          const g = window.__gw;
          let l = null;
          for (let t = 0; t < 30; t++) {
            l = g.actors.raftGear.debug();
            if (!want || l[want[0]] === want[1]) break;
            await new Promise((done) => setTimeout(done, 100));
          }
          return { ...l, saved: JSON.stringify(g.state.meta.loop.raft) };
        }, want);
      const sig = (l) => `${l.parts}|${l.frame}|${l.glass}|${l.brass}`;
      const seen = [{ id: "none", ...(await look()) }];
      for (const id of ["keel:1", "keel:2", "keel:3", "lantern:1", "lantern:2"]) {
        const [slot, level] = id.split(":");
        // Keel III is on the shelf's fourth tier, which no water in this build opens: it is written into the save
        // as the shelf would write it.
        if (id === "keel:3")
          await session.eval(() => {
            window.__gw.state.meta.loop.raft.keel = 3;
          });
        else await buyAtHome(session, [id]);
        const l = await look([slot, Number(level)]);
        check(
          l[slot] === Number(level),
          `after buying ${id} the raft draws ${slot} ${l[slot]} (the save has ${l.saved})`,
        );
        seen.push({ id, ...l });
      }
      check(
        new Set(seen.map(sig)).size === seen.length,
        `two levels look the same: ${seen.map(sig).join(", ")}`,
      );
      for (let i = 1; i < 4; i++)
        check(seen[i].parts > seen[i - 1].parts, `${seen[i].id} adds nothing to the raft's parts`);
      for (let i = 4; i < 6; i++) {
        const [a, b] = [seen[i - 1], seen[i]];
        check(b.frame > a.frame || b.brass > a.brass, `${b.id} adds nothing to the lantern's frame`);
        check(b.glass > a.glass, `${b.id}: the glass is ${b.glass}, ${a.glass} before`);
      }
      // A reload draws the same raft from the save.
      await reloadToHome(session);
      const loaded = await look(["lantern", 2]);
      check(
        sig(loaded) === sig(seen[5]),
        `after a reload the raft draws ${sig(loaded)}, ${sig(seen[5])} before`,
      );
      return (
        seen
          .map(
            (l) =>
              `${l.id}: parts ${l.parts} tris, frame ${l.frame} tris (${l.brass} brass), glass ${l.glass}`,
          )
          .join("; ") + `; reloaded ${sig(loaded)}`
      );
    },
  },
  {
    name: "gear: with the Cork Float fitted, a seeded run of bait casts bites exactly as before the Sounding Lead",
    fixture: "legend-sold",
    debug: true,
    timeoutMs: 360_000,
    async run(session, { fixture }) {
      // An older save that sold her has Hob's Lamp: taken away here, so the rolls compare with the build before it.
      await dropLamp(session);
      const want = JSON.parse(readFileSync(join(FIXTURES_DIR, "bite-sequence-float.json"), "utf8"));
      check(fixture.meta.loop.fitted.depth === undefined, "the fixture already knows the Depth part");
      await session.sail();
      const loaded = await leadRecord(session);
      check(
        loaded.depth === "float" && JSON.stringify(loaded.parts) === '["cork_float"]',
        `the old save does not load with the Cork Float: ${JSON.stringify(loaded)}`,
      );
      let rolls = 0;
      for (const [key, sequence] of Object.entries(want.sequences)) {
        const [light, place] = key.split("|");
        const got = await session.eval(
          ([light, place, n, seed, bait]) => {
            const d = window.__gw.debug;
            d.setPhase(light);
            d.fishSeed(seed);
            const seq = [];
            for (let k = 0; k < n; k++) {
              const r = d.fishPoolRoll(1, { place, bait });
              seq.push(r?.mist ? `mist:${r.mist}` : Object.keys(r?.counts ?? {})[0]);
            }
            return seq;
          },
          [light, place === "open" ? null : place, sequence.length, want.seed, want.bait],
        );
        // Two of these places are homes of local kinds (wo.localKinds): there a local kind may take its base
        // fish's bite, and is counted as that base fish; every other bite is as recorded.
        const home = LOCAL_HOMES[place];
        const at = got.findIndex((id, i) => (home && id === home ? LOCAL_BASES[id] : id) !== sequence[i]);
        check(at < 0, `${key}: roll ${at} drew ${got[at]}, the recorded build drew ${sequence[at]}`);
        rolls += got.length;
      }
      return `${rolls} rolls at 3 places and 2 lights match the recorded sequence`;
    },
  },

  {
    name: "gear: the Sounding Lead doubles bottom feeders and halves higher feeders in all three bite paths, and stops none",
    fixture: "legend-sold",
    debug: true,
    editSave: withLead(false),
    async run(session) {
      // An older save that sold her has Hob's Lamp: taken away here, so the rolls compare with the build before it.
      await dropLamp(session);
      await session.sail();
      // 1. Pool rows (l1), open water by day: each kind's share against an any-depth fish (Mossback Perch).
      const day = await rollBoth(session, { light: "calm", roll: {} });
      check(
        !day.float.onLead && day.lead.onLead,
        `the lead did not fish: ${JSON.stringify([day.float.onLead, day.lead.onLead])}`,
      );
      const f = day.float.shares,
        l = day.lead.shares,
        base = l.mossback_perch / f.mossback_perch,
        ratio = (id) => l[id] / f[id] / base;
      const kinds = Object.keys(f).filter((id) => f[id] > 0);
      for (const id of kinds) {
        check(l[id] > 0, `${id} bites on the float but not on the lead`);
        const want = BOTTOM.includes(id) ? 2 : HIGH.includes(id) ? 0.5 : 1;
        check(near(ratio(id), want, 1e-6), `${id}: ${ratio(id).toFixed(4)} times as often, expected ${want}`);
      }
      check(
        kinds.some((id) => BOTTOM.includes(id)) && kinds.some((id) => HIGH.includes(id)),
        "no mix of kinds here",
      );
      const sum = (s, ids) => ids.reduce((t, id) => t + (s[id] || 0), 0);
      check(sum(l, BOTTOM) > sum(f, BOTTOM) && sum(l, HIGH) < sum(f, HIGH), "the shares did not move");
      // 2. Guests (P7): the Lily Gardener's Notebook brings Nightbloom Carp (a bottom feeder) to the pads at night.
      await session.eval(() => {
        window.__gw.progression.loop.state().finds.got.lily_notebook = 1;
        window.__gw.player.teleport({ x: 40, z: 28 }, 0);
      });
      await session.pause(1500);
      const pads = await rollBoth(session, { light: "gloomtide", roll: {} });
      check(pads.float.area === "pads", `not on the pads: ${pads.float.area}`);
      const p = pads.float.shares.nightbloom_carp,
        guestWant = (2 * p) / (1 - p) / (1 + (2 * p) / (1 - p));
      check(p > 0, "no Nightbloom Carp on the float");
      check(
        near(pads.lead.shares.nightbloom_carp, guestWant, 1e-9),
        `Nightbloom Carp share ${pads.lead.shares.nightbloom_carp} on the lead, expected ${guestWant} (float ${p})`,
      );
      // 3. Sign and sight takes (_7): a prerolled sucker takes more surely, a minnow less.
      const sucker = await rollBoth(session, {
        light: "calm",
        roll: { preroll: { speciesId: "rustfin_sucker", base: 0.2 } },
      });
      const minnow = await rollBoth(session, {
        light: "calm",
        roll: { preroll: { speciesId: "dusk_minnow", base: 0.45 } },
      });
      check(
        near(sucker.lead.preroll, Math.min(0.9, 2 * sucker.float.preroll), 1e-9) &&
          sucker.lead.preroll > sucker.float.preroll,
        `sucker take ${sucker.float.preroll} -> ${sucker.lead.preroll}`,
      );
      check(
        near(minnow.lead.preroll, minnow.float.preroll / 2, 1e-9),
        `minnow take ${minnow.float.preroll} -> ${minnow.lead.preroll}`,
      );
      // Lure casts are untouched: with a lure fitted the lead does not fish.
      const lure = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          d = window.__gw.debug;
        loop.fitDepth("lead");
        loop.state().lures.includes("feather_fly") || loop.state().lures.push("feather_fly");
        loop.changeHook({ lure: "feather_fly" });
        const r = d.fishPoolRoll(1, {}),
          leadFishes = loop.leadFishes();
        loop.changeHook({ lure: null, bait: "mireworm" });
        return { onLead: r.onLead, leadFishes };
      });
      check(!lure.onLead && !lure.leadFishes, `the lead fished under a lure: ${JSON.stringify(lure)}`);
      return `pool: bottom x2, high x0.5 across ${kinds.length} kinds; guest ${p.toFixed(3)} -> ${pads.lead.shares.nightbloom_carp.toFixed(3)}; takes ${sucker.float.preroll} -> ${sucker.lead.preroll}, ${minnow.float.preroll} -> ${minnow.lead.preroll}`;
    },
  },

  {
    name: "gear: Murk gives the Sounding Lead at the next tally with his line, once, and an old save loads with the float",
    fixture: "fresh-first-evening",
    debug: true,
    timeoutMs: 720_000,
    async run(session, { fixture, page, browser }) {
      check(fixture.meta.loop.said.firstSale === true, "the fixture has not sold yet");
      await session.toHome();
      const loaded = await leadRecord(session);
      check(
        loaded.depth === "float" && JSON.stringify(loaded.parts) === '["cork_float"]',
        `the old save does not load with the Cork Float alone: ${JSON.stringify(loaded)}`,
      );
      check(
        (await depthRow(session)) === null,
        "the tackle screen offers a Depth choice before the lead is owned",
      );
      await closeTackle(session);
      await session.sail();
      await session.catchFish("dusk_minnow");
      const gift = await tallyAndGift(session);
      check(
        gift?.shown && gift.text.includes(GIFT_LINE),
        `the tally does not show Murk's gift: ${JSON.stringify(gift)}`,
      );
      check(gift.text.includes("Sounding Lead"), `the gift is not named: ${gift.text}`);
      const after = await leadRecord(session);
      check(
        after.gift === LEAD &&
          after.parts.filter((id) => id === LEAD).length === 1 &&
          after.depth === "float",
        `after the tally: ${JSON.stringify(after)}`,
      );
      // The tackle screen now offers Depth, the float fitted.
      const row = await depthRow(session);
      check(
        JSON.stringify(row?.chips) === '[{"key":"cork_float","on":true},{"key":"sounding_lead","on":false}]',
        `the Depth row: ${JSON.stringify(row)}`,
      );
      await closeTackle(session);
      // Reloaded, it is not given again.
      const saved = await session.saved();
      const again = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await again.boot();
        await again.sail();
        await again.catchFish("mossback_perch");
        const second = await tallyAndGift(again);
        const record = await leadRecord(again);
        // The next tally brings the next new thing (the Minnow Tin), never a second lead.
        check(!/Sounding Lead/.test(second?.text ?? ""), `a second lead: ${JSON.stringify(second)}`);
        check(
          record.gift !== LEAD && record.parts.filter((id) => id === LEAD).length === 1,
          `after reloading and another tally: ${JSON.stringify(record)}`,
        );
        await again.collectGameErrors();
        check(!again.errors.length, `errors after reloading: ${again.errors.join("; ")}`);
      } finally {
        await again.close();
      }
      return `"${gift.text.slice(0, 60)}..." at the next tally; once only after a reload`;
    },
  },

  {
    name: "gear: the gift waits for the first tally with a sale",
    fixture: "fresh-first-evening",
    debug: true,
    timeoutMs: 420_000,
    // A save that has never sold (its first tally had nothing to sell).
    editSave: (save) => delete save.meta.loop.said.firstSale,
    async run(session) {
      await session.sail();
      const empty = await tallyAndGift(session);
      const before = await leadRecord(session);
      check(
        empty === null && !before.parts.includes(LEAD),
        `the lead came at a tally with no sale: ${JSON.stringify(before)}`,
      );
      await session.sail();
      await session.catchFish("dusk_minnow");
      const gift = await tallyAndGift(session);
      const after = await leadRecord(session);
      check(
        gift?.text.includes(GIFT_LINE) && after.parts.includes(LEAD),
        `no gift at the first sale: ${JSON.stringify(after)}`,
      );
      return "nothing at an empty tally, the lead at the first sale";
    },
  },

  {
    name: "gear: mid-mossmere gets the lead at its next tally",
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.sail();
      await session.catchFish("dusk_minnow");
      const gift = await tallyAndGift(session);
      const after = await leadRecord(session);
      check(
        gift?.text.includes(GIFT_LINE) && after.gift === LEAD && after.depth === "float",
        `${JSON.stringify(after)}`,
      );
      return "given at the next tally";
    },
  },

  {
    name: "gear: Sporewood ignores depth and does not offer it",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: withLead(true),
    async run(session) {
      await session.toHome();
      check((await depthRow(session)) === null, "Sporewood's tackle screen offers Depth");
      await closeTackle(session);
      await session.sail({ water: "sporewood" });
      const r = await rollBoth(session, { light: "calm", roll: { bait: "spore_cake" } });
      check(
        !r.lead.onLead && JSON.stringify(r.lead.shares) === JSON.stringify(r.float.shares),
        `Sporewood odds moved: ${JSON.stringify(r)}`,
      );
      const leadFishes = await session.eval(() => window.__gw.progression.loop.leadFishes());
      check(leadFishes === false, "the lead fishes in Sporewood");
      return "no Depth row, odds unchanged";
    },
  },
  {
    name: "live minnow: Murk gives the tin at the tally after the lead's, never with it, with his perch line, and it survives a reload",
    fixture: "fresh-first-evening",
    debug: true,
    timeoutMs: 720_000,
    async run(session, { page, browser }) {
      await session.sail();
      await session.catchFish("mossback_perch");
      const first = await tallyAndGift(session);
      const atLead = await leadRecord(session);
      check(
        atLead.gift === LEAD && !atLead.parts.includes(TIN) && !first?.text.includes("Minnow Tin"),
        `the lead's tally: ${JSON.stringify({ atLead, first })}`,
      );
      await session.sail();
      await session.catchFish("mossback_perch", { keep: false });
      const second = await tallyAndGift(session);
      const atTin = await leadRecord(session);
      check(
        second?.shown && second.text.includes(TIN_LINE_HUNTER) && second.text.includes("Minnow Tin"),
        `the tin's tally: ${JSON.stringify(second)}`,
      );
      check(
        atTin.gift === TIN && atTin.parts.filter((id) => id === TIN).length === 1,
        `after the tin's tally: ${JSON.stringify(atTin)}`,
      );
      const saved = await session.saved();
      const again = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await again.boot();
        await again.toHome();
        const reloaded = await leadRecord(again);
        check(
          reloaded.parts.filter((id) => id === TIN).length === 1,
          `after a reload: ${JSON.stringify(reloaded)}`,
        );
        await again.collectGameErrors();
        check(!again.errors.length, `errors after reloading: ${again.errors.join("; ")}`);
      } finally {
        await again.close();
      }
      return "the lead first, the tin at the next tally with the perch line, kept after a reload";
    },
  },

  {
    name: "live minnow: an old save that owns the lead gets the tin at its next tally, with the plain line when no perch was landed",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withLead(false),
    timeoutMs: 420_000,
    async run(session) {
      await session.sail();
      await session.catchFish("dusk_minnow");
      const gift = await tallyAndGift(session);
      const after = await leadRecord(session);
      check(
        gift?.text.includes(TIN_LINE_PLAIN) && !gift.text.includes("Perch eat") && after.gift === TIN,
        `${JSON.stringify({ gift, after })}`,
      );
      return "given at the next tally with the plain line";
    },
  },

  {
    name: "live minnow: Into the tin shows only on a small or keeper Dusk Minnow with room, counts down, adds one and uses the fish up, and stops at three",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withTin,
    timeoutMs: 420_000,
    async run(session) {
      await session.sail();
      const seen = [];
      for (let k = 0; k < 3; k++) {
        const card = await catchCard(session, "dusk_minnow", -1.5);
        check(card.tin === `Into the tin (${3 - k} left)`, `minnow ${k + 1}: the button reads ${card.tin}`);
        await session.clickButton(/^Into the tin/);
        await session.pause(1200);
        await session.closeGuides(4000);
        const after = await session.eval(() => ({
          live: window.__gw.state.run.bait.live_minnow,
          creel: window.__gw.state.run.creel.length,
        }));
        check(
          after.live === k + 1 && after.creel === card.creel,
          `after minnow ${k + 1}: ${JSON.stringify({ card, after })}`,
        );
        seen.push(card.tin);
      }
      const full = await catchCard(session, "dusk_minnow", -1.5);
      check(full.tin === null, `the tin is full, yet the card shows ${full.tin}`);
      await session.clickButton(/^\d?Let go\b/);
      await session.pause(1000);
      check((await liveInRun(session)) === 3, "the tin holds more than three");
      const perch = await catchCard(session, "mossback_perch", -1.5);
      check(perch.tin === null, `a perch's card shows ${perch.tin}`);
      await session.clickButton(/^\d?Let go\b/);
      await session.pause(1000);
      // The rule itself, for sizes and owners a card is slow to reach.
      const rule = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          run = window.__gw.state.run,
          fish = (sizeClass, speciesId = "dusk_minnow") => ({ uid: `t-${sizeClass}`, speciesId, sizeClass });
        run.bait.live_minnow = 1;
        const keeper = loop.tinRoom(fish("keeper")),
          prize = loop.tinRoom(fish("prize")),
          chub = loop.tinRoom(fish("small", "likely_chub"));
        const parts = loop.state().parts;
        parts.splice(parts.indexOf("minnow_tin"), 1);
        const unowned = loop.tinRoom(fish("small"));
        parts.push("minnow_tin");
        return { keeper, prize, chub, unowned };
      });
      check(
        rule.keeper === 2 && rule.prize === null && rule.chub === null && rule.unowned === null,
        `tinRoom: ${JSON.stringify(rule)}`,
      );
      return `${seen.join(", ")}; none when full, none on a perch`;
    },
  },

  {
    name: "live minnow: with a Live Minnow fitted, who bites follows the Live column, and the tackle screen shows it with its two lines",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withTin,
    async run(session) {
      await session.sail();
      const rolls = await session.eval(() => {
        const d = window.__gw.debug,
          out = {};
        for (const light of ["calm", "gloomtide"]) {
          d.setPhase(light);
          out[light] = {
            worm: d.fishPoolRoll(1, { bait: "mireworm" }).shares,
            live: d.fishPoolRoll(1, { bait: "live_minnow" }).shares,
          };
        }
        return out;
      });
      const grazers = ["rustfin_sucker", "weeping_carp"];
      let wormGrazers = 0;
      for (const [light, r] of Object.entries(rolls)) {
        for (const id of grazers) {
          wormGrazers += r.worm[id] > 0 ? 1 : 0;
          check(!(r.live[id] > 0), `${light}: ${id} bites a Live Minnow (${r.live[id]})`);
        }
        check(r.live.mossback_perch > 0, `${light}: no Mossback Perch on a Live Minnow`);
        check(
          r.live.mossback_perch > r.worm.mossback_perch,
          `${light}: a perch is no likelier on a Live Minnow (${r.worm.mossback_perch} -> ${r.live.mossback_perch})`,
        );
        check(!(r.live.dusk_minnow > 0), `${light}: a Dusk Minnow bites a Live Minnow`);
      }
      check(wormGrazers > 0, "no grazer bites worms here, so the test proves nothing");
      // Fitted on the hook: the bait's tray on the rig picture lists it with its count and its two lines.
      const fitted = await session.eval(() => {
        const loop = window.__gw.progression.loop;
        window.__gw.state.run.bait.live_minnow = 2;
        const fit = loop.changeHook({ bait: "live_minnow" });
        return { fit: fit?.ok === true, item: window.__gw.data.CATCH_V3?.items?.live_minnow ?? null };
      });
      const tray = await rigTray(session, "bait");
      const row = {
        ...fitted,
        chip: tray?.text.live_minnow ?? null,
        on: !!tray?.chips.find((c) => c.key === "live_minnow")?.on,
        lines: tray?.lines ?? [],
      };
      await closeTackle(session);
      check(
        row.fit && row.on && /Live Minnow/.test(row.chip) && /2/.test(row.chip),
        `chip: ${JSON.stringify(row)}`,
      );
      check(JSON.stringify(row.lines) === JSON.stringify([LIVE_GOOD, LIVE_COST]), `lines: ${row.lines}`);
      check(
        row.item?.family === "predator" && row.item?.hold === 4,
        `CATCH_V3 item: ${JSON.stringify(row.item)}`,
      );
      return `grazers 0, perch ${rolls.calm.worm.mossback_perch.toFixed(3)} -> ${rolls.calm.live.mossback_perch.toFixed(3)}; chip "${row.chip}"`;
    },
  },

  {
    name: "live minnow: the tin is empty after the tally, and the hook goes back to worms",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withTin,
    timeoutMs: 420_000,
    async run(session) {
      await session.sail();
      await session.eval(() => {
        window.__gw.state.run.bait.live_minnow = 2;
        window.__gw.progression.loop.changeHook({ bait: "live_minnow" });
      });
      await session.catchFish("mossback_perch");
      await tallyAndGift(session);
      const after = await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        return { live: s.bait?.mossmere?.live_minnow ?? 0, fitted: s.fitted?.bait ?? null };
      });
      check(after.live === 0, `Live Minnows left after the tally: ${after.live}`);
      check(after.fitted === "mireworm", `the hook after the tally: ${after.fitted}`);
      await session.sail();
      check((await liveInRun(session)) === 0, "the next evening starts with Live Minnows");
      return "empty after the tally, worms fitted";
    },
  },

  {
    name: "live minnow: Sporewood has no tin, no button and no gift",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: withLead(false),
    timeoutMs: 420_000,
    async run(session) {
      await session.sail({ water: "sporewood" });
      const room = await session.eval(() =>
        window.__gw.progression.loop.tinRoom({ uid: "t", speciesId: "dusk_minnow", sizeClass: "small" }),
      );
      check(room === null, `a tin in Sporewood: ${room}`);
      await session.catchFish("netcloud_fry");
      const gift = await tallyAndGift(session);
      const after = await leadRecord(session);
      // Murk's tally there may shelve one of Sporewood's own Leader and Hook parts (its tackle arrivals), never a tin.
      check(
        (gift === null || gift.text.includes("Burl Hook")) && !after.parts.includes(TIN),
        `Sporewood's tally: ${JSON.stringify({ gift, after })}`,
      );
      return "no tin, no gift";
    },
  },
  {
    name: "worm bunch: Murk sells it at 20 clams for 10 with its new name and line, an old save's Heartmoss is the same count of Worm Bunch, and a cast spends one like any bait",
    fixture: "mid-mossmere",
    debug: true,
    async run(session, { fixture }) {
      const held = fixture.meta.loop.bait.mossmere[BUNCH];
      check(held > 0, "the fixture holds no Heartmoss, so the test proves nothing");
      await session.toHome();
      const shelf = await session.eval((id) => {
        const loop = window.__gw.progression.loop,
          tabs = loop.shelf().tabs,
          card = tabs.flatMap((t) => t.items || []).filter((c) => c.baitId === id);
        return {
          cards: card.map((c) => ({ id: c.id, tab: c.tab, name: c.name, line: c.line, price: c.price })),
          count: loop.state().bait.mossmere[id],
          baitTab: (tabs.find((t) => t.id === "bait")?.items || []).map((c) => c.id),
        };
      }, BUNCH);
      check(shelf.count === held, `the save holds ${shelf.count} Worm Bunch, the fixture ${held} Heartmoss`);
      const [card] = shelf.cards;
      check(shelf.cards.length === 1 && card.tab === "bait", `shelf cards: ${JSON.stringify(shelf)}`);
      check(
        card.name === "Worm Bunch" && card.line === BUNCH_LINE && card.price === 20,
        `the shelf card: ${JSON.stringify(card)}`,
      );
      const bought = await session.eval((cardId) => {
        const loop = window.__gw.progression.loop;
        window.__gw.debug.loop.giveClams(100);
        const before = loop.state().clams,
          ok = loop.buy(cardId)?.ok === true;
        return { ok, paid: before - loop.state().clams, count: loop.state().bait.mossmere.heartmoss };
      }, card.id);
      check(
        bought.ok && bought.paid === 20 && bought.count === held + 10,
        `buying a Worm Bunch: ${JSON.stringify(bought)}`,
      );
      // On the water: a cast spends one, as with Mire Worms, and an early reel-in gives it back.
      await session.sail();
      const cast = await session.eval((id) => {
        const g = window.__gw,
          run = g.state.run;
        g.progression.loop.changeHook({ bait: id });
        const before = run.bait[id],
          spent = g.progression.consumeBait(),
          after = run.bait[id],
          refunded = g.progression.refundBait(id) === true;
        return {
          before,
          spent,
          after,
          refunded,
          back: run.bait[id],
          legend: g.data.BAITS.find((b) => b.id === id),
        };
      }, BUNCH);
      check(
        cast.spent === BUNCH && cast.after === cast.before - 1,
        `a cast did not spend one: ${JSON.stringify(cast)}`,
      );
      check(cast.refunded && cast.back === cast.before, `no refund: ${JSON.stringify(cast)}`);
      check(
        cast.legend.legend === false &&
          !("consumeOnCast" in cast.legend) &&
          !("legendBiteChance" in cast.legend) &&
          cast.legend.name === "Worm Bunch",
        `its record: ${JSON.stringify(cast.legend)}`,
      );
      return `${held} Heartmoss -> ${shelf.count} Worm Bunch; "${card.name}" at ${card.price}; ${cast.before} -> ${cast.after} on a cast, refunded`;
    },
  },

  {
    name: "worm bunch: who bites follows the Bunch column (no Dusk Minnow or Reedjaw Pike, carp and sturgeon yes), and the tackle screen shows its two lines",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      // An older save that sold her has Hob's Lamp: taken away here, so the rolls compare with the build before it.
      await dropLamp(session);
      await session.sail();
      const rolls = await session.eval((id) => {
        const d = window.__gw.debug,
          out = {};
        for (const light of ["calm", "gloomtide"]) {
          d.setPhase(light);
          out[light] = {
            worm: d.fishPoolRoll(1, { bait: "mireworm" }).shares,
            bunch: d.fishPoolRoll(1, { bait: id }).shares,
            spanWorm: d.fishPoolRoll(1, { place: "under_the_span", bait: "mireworm" }).shares,
            spanBunch: d.fishPoolRoll(1, { place: "under_the_span", bait: id }).shares,
          };
        }
        return out;
      }, BUNCH);
      let wormSmall = 0;
      for (const [light, r] of Object.entries(rolls)) {
        for (const fish of ["dusk_minnow", "reedjaw_pike"]) {
          wormSmall += r.worm[fish] > 0 ? 1 : 0;
          check(!(r.bunch[fish] > 0), `${light}: ${fish} bites a Worm Bunch (${r.bunch[fish]})`);
        }
        check(r.bunch.weeping_carp > 0, `${light}: no Weeping Carp on a Worm Bunch`);
        check(r.spanBunch.bridgechain_sturgeon > 0, `${light}: no Bridgechain Sturgeon on a Worm Bunch`);
        check(
          r.spanBunch.bridgechain_sturgeon > r.spanWorm.bridgechain_sturgeon,
          `${light}: a sturgeon (grade 3) is no likelier on a Worm Bunch than on worms`,
        );
      }
      check(wormSmall > 0, "neither small fish bites worms here, so the test proves nothing");
      const fit = await session.eval(
        (id) => window.__gw.progression.loop.changeHook({ bait: id })?.ok === true,
        BUNCH,
      );
      const tray = await rigTray(session, "bait");
      const row = {
        fit,
        chip: tray?.text[BUNCH] ?? null,
        on: !!tray?.chips.find((c) => c.key === BUNCH)?.on,
        lines: tray?.lines ?? [],
      };
      await closeTackle(session);
      check(row.fit && row.on && /Worm Bunch/.test(row.chip), `chip: ${JSON.stringify(row)}`);
      check(JSON.stringify(row.lines) === JSON.stringify([BUNCH_GOOD, BUNCH_COST]), `lines: ${row.lines}`);
      return `carp ${rolls.calm.bunch.weeping_carp.toFixed(3)}, sturgeon ${rolls.calm.spanWorm.bridgechain_sturgeon.toFixed(3)} -> ${rolls.calm.spanBunch.bridgechain_sturgeon.toFixed(3)}; no minnow or pike; chip "${row.chip}"`;
    },
  },

  {
    name: "the thief's bait: on the lead a Live Minnow gives her 1 in 3 and a Worm Bunch 1 in 6; never on the Cork Float, under a lure or on any other bait; the Odds sheet agrees",
    fixture: "legend-sold",
    debug: true,
    editSave: withLead(true),
    async run(session) {
      // An older save that sold her has Hob's Lamp: taken away here, so the rolls compare with the build before it.
      await dropLamp(session);
      await session.sail();
      const N = 6000;
      await session.eval(() => (window.__gw.state.run.bait.live_minnow = 2));
      const live = await legendBite(session, "live_minnow", N),
        bunch = await legendBite(session, BUNCH, N);
      check(
        live.species === LEGEND_ID && live.onLead,
        `not her, or not on the lead: ${JSON.stringify(live)}`,
      );
      check(near(live.chance, 1 / 3, 1e-12), `Live Minnow on the lead: ${live.chance}`);
      check(near(bunch.chance, 1 / 6, 1e-12), `Worm Bunch on the lead: ${bunch.chance}`);
      // The seeded rolls land near their chance (about five standard deviations).
      check(Math.abs(live.hits - N / 3) < 5 * Math.sqrt((N * 2) / 9), `live hits ${live.hits} of ${N}`);
      check(Math.abs(bunch.hits - N / 6) < 5 * Math.sqrt((N * 5) / 36), `bunch hits ${bunch.hits} of ${N}`);
      for (const bait of ["mireworm", "lumen_moss", "cut_strip", "bare", null]) {
        const r = await legendBite(session, bait, 200);
        check(r.chance === 0 && r.hits === 0, `${bait} on the lead: ${JSON.stringify(r)}`);
      }
      // On the Cork Float, and under a lure with the lead still fitted.
      await session.eval(() => window.__gw.progression.loop.fitDepth("float"));
      for (const bait of ["live_minnow", BUNCH]) {
        const r = await legendBite(session, bait, 200);
        check(!r.onLead && r.chance === 0 && r.hits === 0, `${bait} on the float: ${JSON.stringify(r)}`);
      }
      await session.eval(() => {
        const loop = window.__gw.progression.loop;
        loop.fitDepth("lead");
        loop.state().lures.includes("feather_fly") || loop.state().lures.push("feather_fly");
        loop.changeHook({ lure: "feather_fly" });
      });
      for (const bait of ["live_minnow", BUNCH]) {
        const r = await legendBite(session, bait, 200);
        check(r.chance === 0 && r.hits === 0, `${bait} under a lure: ${JSON.stringify(r)}`);
      }
      // The Odds sheet (she has been landed, so she has a row) reads the same rule: the Bell Pool by night,
      // the only light her row is listed under.
      const sheet = await session.eval((id) => {
        const loop = window.__gw.progression.loop,
          share = (bait, depth) => {
            loop.changeHook({ lure: null, bait });
            loop.fitDepth(depth);
            return (
              loop.sheet({ place: "bell_pool", light: "night" })?.odds?.rows?.find((r) => r.id === id)
                ?.share ?? 0
            );
          };
        loop.markLifted("bell_pool");
        return {
          live: share("live_minnow", "lead"),
          bunch: share("heartmoss", "lead"),
          worm: share("mireworm", "lead"),
          bunchFloat: share("heartmoss", "float"),
        };
      }, LEGEND_ID);
      check(
        near(sheet.live, 1 / 3, 1e-9) &&
          near(sheet.bunch, 1 / 6, 1e-9) &&
          sheet.worm === 0 &&
          sheet.bunchFloat === 0,
        `her Odds row: ${JSON.stringify(sheet)}`,
      );
      return `live ${live.hits}/${N}, bunch ${bunch.hits}/${N}; float, lure and other baits 0; Odds ${sheet.live.toFixed(4)} and ${sheet.bunch.toFixed(4)}`;
    },
  },

  {
    name: "the thief's bait: Sporewood's legend still takes only its Glowcap Bulb, every time, lead or not",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: withLead(true),
    async run(session) {
      await session.sail({ water: "sporewood" });
      const bulb = await legendBite(session, "glowcap_bulb", 50),
        cake = await legendBite(session, "spore_cake", 50);
      check(
        bulb.species === "drifting_grove" && bulb.chance === 1 && bulb.hits === 50,
        `the bulb: ${JSON.stringify(bulb)}`,
      );
      check(cake.chance === 0 && cake.hits === 0, `Spore Cake: ${JSON.stringify(cake)}`);
      return `bulb ${bulb.hits}/50, cake 0`;
    },
  },

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
      // (The record has grown with the hunt: here only its first field and the unfound water matter.)
      check(
        loaded.hunt?.mossmere?.lineLesson === false &&
          loaded.hunt.mossmere.sketches?.map === 0 &&
          loaded.hunt.mossmere.found === false,
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
      // The hook and leader that hold her, so the line is the part that breaks.
      await fitHerParts(session);
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
      await fitHerParts(session);
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
    name: "hunt rules: on Waxed Silk she can be landed; each landing makes her next fight 2 harder, up to 10, and her Odds row and the Journal's odds are the fight's own chance; the save keeps the count",
    fixture: "legend-sold",
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await fitHerParts(session);
      // At home, the Odds page's row for her at night in the Bell Pool, against the Journal's chance, at her
      // count of landings so far and at the top step (five landings).
      const sheetAt = async (n) => {
        const kept = await session.eval((n) => {
          const h = window.__gw.progression.loop.state().hunt.mossmere,
            was = h.landings;
          n == null || (h.landings = n);
          return was;
        }, n);
        const sheet = await bellPoolOdds(session);
        const journal = await session.eval(
          (id) => window.__gw.debug.odds(id)?.odds?.legend ?? null,
          LEGEND_ID,
        );
        await session.eval(
          (was) => (window.__gw.progression.loop.state().hunt.mossmere.landings = was),
          kept,
        );
        return { row: sheet.row?.land?.legend ?? null, journal };
      };
      const sheetNow = await sheetAt(null),
        sheetTop = await sheetAt(5);
      check(
        near(sheetNow.row, sheetNow.journal, 1e-9) && near(sheetTop.row, sheetTop.journal, 1e-9),
        `the Odds row and the Journal: ${JSON.stringify({ sheetNow, sheetTop })}`,
      );
      await session.sail();
      // Her landing chance as the Journal reads it, her landings so far, and the fight's own numbers for this rig
      // at a given count of landings (catchParts, struck, with her wounds).
      const now = () =>
        session.eval((id) => {
          const g = window.__gw,
            s = g.progression.loop.state(),
            rig = g.debug.odds(id);
          return {
            odds: rig?.odds?.legend ?? null,
            landings: s.hunt.mossmere.landings,
            caught: g.state.meta.journal[id]?.caught ?? 0,
            sold: s.legends[id] ?? 0,
          };
        }, LEGEND_ID);
      const first = await now();
      // The fixture sold her once before the hunt was written: an old save, counted from her landings so far.
      check(
        first.landings === Math.max(1, first.caught, first.sold),
        `the old save's count: ${JSON.stringify(first)}`,
      );
      const landed = await hookAndPlayOut(session, LEGEND_ID, "land");
      check(landed.p > 0 && landed.p <= LANDING_CAP, `landing chance on Waxed Silk is ${landed.p}`);
      check(landed.landed === LEGEND_ID, `she was not landed: ${JSON.stringify(landed)}`);
      check(near(first.odds, landed.p, 1e-9), `the Journal said ${first.odds}, the fight played ${landed.p}`);
      await session.clickButton(/^\d?(Keep|Let go)\b/);
      await session.pause(800);
      await session.closeGuides(5000);
      // Landed once more: one more landing counted, and her next fight is harder; the Journal and the Odds row
      // say so before it is fought.
      const after = await now();
      const shown = await journalOdds(session);
      const again = await hookAndPlayOut(session, LEGEND_ID, "land");
      const pct = `${Math.floor(again.p * 100 + 1e-9)}%`;
      check(after.landings === first.landings + 1, `the count ${first.landings} then ${after.landings}`);
      check(
        after.odds < first.odds && near(after.odds, again.p, 1e-9),
        `odds ${first.odds} then ${after.odds}; the fight ${landed.p} then ${again.p}`,
      );
      check(shown.includes(pct), `the Journal's odds read "${shown}", the fight plays ${pct}`);
      await session.clickButton(/^\d?(Keep|Let go)\b/);
      await session.pause(800);
      await session.closeGuides(5000);
      // The rule by the fight's own numbers: her fight grows by 2 a landing, up to 10 (five steps), and her first
      // fight (no landings) is the hunt's. On this rig (the Journal's chance, from the fight's engine) she is still
      // landable at the top step and past it.
      const rule = await session.eval((id) => {
        const g = window.__gw,
          h = g.progression.loop.state().hunt.mossmere,
          kept = h.landings,
          out = { fight: [], p: [] };
        for (const n of [0, 1, 2, 3, 4, 5, 6, 9]) {
          h.landings = n;
          out.fight.push(
            g.data.catchParts(id, "legend", {}, { strike: "struck", landings: n })?.fight ?? null,
          );
          out.p.push(g.debug.odds(id)?.odds?.legend ?? null);
        }
        h.landings = kept;
        return out;
      }, LEGEND_ID);
      const ps = rule.p;
      check(
        sameJson(rule.fight, [16, 18, 20, 22, 24, 26, 26, 26]),
        `her fight by landings 0,1,2,3,4,5,6,9: ${JSON.stringify(rule.fight)}`,
      );
      check(
        ps.slice(0, 6).every((p, n) => n === 0 || p < ps[n - 1]) && near(ps[5], ps[6]) && near(ps[5], ps[7]),
        `her chance by landings 0,1,2,3,4,5,6,9: ${JSON.stringify(ps)}`,
      );
      check(ps[5] > 0.01, `at the top step her chance is ${ps[5]}`);
      // The top step in play: five landings counted, the Journal, the Odds row and the fight agree.
      await session.eval(() => (window.__gw.progression.loop.state().hunt.mossmere.landings = 5));
      const top = await now();
      check(
        near(top.odds, ps[5], 1e-9) && near(sheetTop.row, top.odds, 1e-9),
        `at the top step: the Journal ${top.odds}, the rule ${ps[5]}, the Odds row ${sheetTop.row}`,
      );
      const last = await hookAndPlayOut(session, LEGEND_ID, "land");
      check(
        last.landed === LEGEND_ID && near(last.p, top.odds, 1e-9),
        `the top step's fight: ${JSON.stringify(last)}`,
      );
      await session.eval(() => window.__gw.game.save());
      const saved = JSON.parse(await session.saved());
      check(
        saved.meta.loop.hunt.mossmere.landings === 6,
        `the save's count: ${saved.meta.loop.hunt.mossmere.landings}`,
      );
      return `landings ${first.landings} -> ${after.landings}: odds ${first.odds.toFixed(4)} -> ${after.odds.toFixed(4)} (${pct}); by landings 0-6, 9: ${ps.map((p) => p.toFixed(4)).join(", ")}`;
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
    name: "the thief stays hidden: an old save that has seen and lost her, with the two cheaper charts owned",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    // An older game marked her seen and lost; the two cheaper charts are owned. (Murk once offered the Bell
    // Pool's map card next; it is never sold now, so her water is given by the debug hook below.)
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
      check(!card, `Murk offers the Bell Pool's map card: ${JSON.stringify(card)}`);
      // Her own journal page does not open.
      await session.eval((id) => window.__gw.ui.openJournal({ sel: id }), LEGEND_ID);
      await session.pause(800);
      check(
        !(await session.eval(() => !!document.querySelector(".gw-jr-detail"))),
        "her journal page opened",
      );
      await expectHidden(session, "the journal opened at her page", seen);
      await backToJetty(session);
      // With the Bell Pool owned and the Worm Bunch on the lead she can bite, but the Odds sheet has no row
      // for her: she counts as a kind not met.
      check(
        await session.eval(() => window.__gw.debug.loop.own("bell_pool")?.includes("bell_pool") === true),
        "the debug hook did not give the Bell Pool",
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
      await expectHidden(session, "odds sheet, bell_pool day, Worm Bunch on the lead", seen);
      return `${seen.length} screens; no Bell Pool card; odds: ${odds.unmet} not met, no row`;
    },
  },

  {
    name: 'the thief while hooked: "Something ancient." through the hook-up, a fight on Waxed Silk and its loss, no model',
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await fitHerParts(session);
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
      await fitHerParts(session);
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
      // She is measured and let go (the measuring card has no Keep).
      await session.clickButton(/^\d?Let go\b/);
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
      await buyAtHome(session, ["place:under_the_span", "place:buoy_lights"]);
      await session.eval(() => window.__gw.debug.loop.own("bell_pool"));
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

  {
    name: "midnight: from evening 2 the bell strikes twelve times 60 s after dark, once an evening, with both lines while her water is unfound; never on evening 1",
    fixture: "mid-mossmere",
    debug: true,
    async run(session, { fixture }) {
      check(!fixture.meta.loop.maps.places.includes("bell_pool"), "the fixture owns the Bell Pool");
      await session.sail();
      await listenForToasts(session);
      // Evening 1: dark falls and a minute passes, and nothing strikes.
      const first = await atNight(session, MIDNIGHT_AT + 1, { evening: 1 });
      check(first.midnight === null, `the bell struck on evening 1: ${JSON.stringify(first.midnight)}`);
      // Evening 2: just before midnight, nothing; then the twelve strokes, 2.2 s apart.
      await atNight(session, MIDNIGHT_AT - 1, { evening: 2 });
      let toasts = await toastsSeen(session);
      check(!toasts.includes(MIDNIGHT_LINE), "the midnight line showed before midnight");
      const struck = [];
      let flared = 0;
      for (let k = 0; k < 12; k++) {
        const now = await atNight(session, MIDNIGHT_AT + k * 2.2 + 0.05);
        struck.push(now.midnight?.struck ?? 0);
        if (now.flare > 0.3) flared++;
      }
      check(
        JSON.stringify(struck) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
        `strokes counted at each due time: ${struck}`,
      );
      check(flared === 12, `the tower window flared on ${flared} of 12 strokes`);
      toasts = await toastsSeen(session);
      check(
        toasts.filter((t) => t === MIDNIGHT_LINE).length === 1 &&
          toasts.filter((t) => t === MISSING_LINE).length === 1,
        `the lines at the first stroke: ${JSON.stringify(toasts)}`,
      );
      check(
        toasts.indexOf(MIDNIGHT_LINE) < toasts.indexOf(MISSING_LINE),
        `the lines are out of order: ${JSON.stringify(toasts)}`,
      );
      // Once an evening: back before the strokes and through them again, nothing more.
      await atNight(session, MIDNIGHT_AT + 0.05);
      const again = await atNight(session, MIDNIGHT_AT + 5);
      toasts = await toastsSeen(session);
      check(
        again.midnight.struck === 12 && toasts.filter((t) => t === MIDNIGHT_LINE).length === 1,
        `the bell struck again: ${JSON.stringify({ again, toasts })}`,
      );
      return `no bell on evening 1; 12 strokes and flares on evening 2, the two lines once`;
    },
  },

  {
    name: "hunt: the tale is told once, at the tally of evening 2 and never on evening 1; the notepad then opens by itself, blank under Where, Suspects and Gear, and one press closes it",
    fixture: "fresh-first-evening",
    debug: true,
    timeoutMs: 720_000,
    // The first evening again (the lead already given, so no gift shares the tally).
    editSave(save) {
      withLead(false)(save);
      save.meta.loop.evenings = 0;
      save.meta.loop.eveningsAt = { ...save.meta.loop.eveningsAt, mossmere: 0 };
    },
    async run(session) {
      await session.sail(SLOW_SAIL);
      check(
        (await session.eval(() => window.__gw.progression.loop.hobLampLit())) === false,
        "Hob's lamp is lit on evening 1",
      );
      await nearHob(session);
      check((await hearHob(session, 5000)).length === 0, "Hob spoke on evening 1");
      const first = await tallyAndPad(session);
      check(first.hunt === "" && first.pad === null, `evening 1's tally: ${JSON.stringify(first)}`);
      check(
        (await session.eval(() => window.__gw.progression.loop.notepad())) === null,
        "the notepad exists after evening 1",
      );
      await session.sail(SLOW_SAIL);
      check(
        (await session.eval(() => window.__gw.progression.loop.hobLampLit())) === true,
        "Hob's lamp is not lit on evening 2",
      );
      const second = await tallyAndPad(session);
      check(
        second.hunt.includes(TALE) && second.hunt.includes(TALE_MURK),
        `evening 2's tally: "${second.hunt}"`,
      );
      const pad = second.pad;
      check(pad, "the notepad did not open by itself after the tale");
      check(pad.intro === PAD_INTRO, `its first line: ${pad.intro}`);
      check(
        pad.places === 5 && pad.blank === 5 && pad.drawn.length === 0 && pad.page === "where",
        `the notepad: ${JSON.stringify(pad)}`,
      );
      check(JSON.stringify(pad.pages) === '["Where","Suspects","Gear"]', `its pages: ${pad.pages}`);
      check(pad.next === NEXT_HOB, `What to try next: ${pad.next}`);
      check(pad.closedByOnePress, "one press did not close the notepad");
      const record = await huntOf(session);
      check(record.taleAt === 2 && record.padDue === false, `the record: ${JSON.stringify(record)}`);
      // The Journal has it too, under its own tab.
      await session.eval(() => window.__gw.ui.openJournal({ tab: "notepad" }));
      await session.pause(1200);
      const tab = await notepadShown(session, ".gw-m-catalogue .gw-pad");
      check(
        tab && tab.places === 5 && tab.blank === 5 && tab.next === NEXT_HOB && tab.intro === null,
        `the Journal's Notepad tab: ${JSON.stringify(tab)}`,
      );
      await backToJetty(session);
      return "no lamp, Hob or tale on evening 1; the tale and a blank notepad at evening 2's tally";
    },
  },

  {
    name: "murk speaks at the tally: his box over the card says the lead, where to fit it, the tale and his word, a page each in the card's order, every line of the tale his on the card too; Escape turns a page; the card keeps them; a reload does not speak them again; then the notepad opens by itself",
    fixture: "fresh-first-evening",
    debug: true,
    timeoutMs: 600_000,
    // Evening 2 with nothing caught: the lead (the save has sold before) and the tale share the tally, and the
    // empty tally's own line ("Nothing? ...") is said every time, so it stays on the card only.
    async run(session) {
      await session.sail(SLOW_SAIL);
      await watchMurkAlone(session);
      for (
        const homeBy = Date.now() + 60_000 * SLOW;
        !(await session.eval(() => window.__gw.game.goHome()));

      ) {
        check(Date.now() < homeBy, `the game will not go home; ${JSON.stringify(await session.state())}`);
        await session.closeGuides(3000);
        await session.pause(1000);
      }
      await session.waitFor("Murk's tally", 90_000, () => !!document.querySelector(".gw-tally-sold"));
      check(!(await murkBoxUp(session)), "Murk's box came up before the card");
      // One press of Sold finishes the count, as a player would; his box then comes up over the card by itself.
      await session.eval(() => document.querySelector(".gw-tally-sold").click());
      const pages = await hearMurk(session, { escapeFirst: true });
      const said = pages.map((p) => p.text);
      check(
        sameJson(said, [GIFT_LINE, FIT_LINE, TALE, TALE_MURK]),
        `Murk's box said ${JSON.stringify(said)}`,
      );
      check(
        pages.every((p) => p.tag === "Murk" && p.tally) &&
          sameJson(
            pages.map((p) => p.button),
            ["Next", "Next", "Next", "Got it"],
          ),
        `the pages: ${JSON.stringify(pages)}`,
      );
      const card = await session.eval(() => {
        const text = (sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() ?? "";
        return {
          open: !!document.querySelector('.gw-modal.gw-in[data-modal="tally"]'),
          gift: text(".gw-tally-gift"),
          hunt: text(".gw-tally-hunt"),
          // Each line of the tale on the card, and whether it is set as Murk's line (his quoted words).
          tale: [...document.querySelectorAll(".gw-tally-hunt > p")].map((p) => [
            p.textContent,
            p.classList.contains("gw-murk-line"),
          ]),
          spoken: window.__gw.progression.loop.state().lastTrip?.spoken === true,
        };
      });
      check(
        sameJson(card.tale, [
          [TALE, true],
          [TALE_MURK, true],
        ]),
        `the tale on the card is not all Murk's: ${JSON.stringify(card.tale)}`,
      );
      check(
        card.open &&
          card.gift.includes(GIFT_LINE) &&
          card.gift.includes(FIT_LINE) &&
          card.hunt.includes(TALE) &&
          card.hunt.includes(TALE_MURK) &&
          card.spoken,
        `after "Got it", the card: ${JSON.stringify(card)}`,
      );
      // A reload before Sold: the save keeps the tally as spoken, and his box stays down. (Today the game comes
      // back to the jetty, not to the card; if a card is shown, Sold closes it.)
      await reloadToHome(session);
      await watchMurkAlone(session);
      await session.pause(4000 * SLOW);
      check(!(await murkBoxUp(session)), "Murk's box spoke the tally again after a reload");
      const kept = await session.eval(() => window.__gw.progression.loop.state().lastTrip?.spoken === true);
      check(kept, "the save lost the tally's spoken mark");
      for (let i = 0; i < 3; i++) {
        await session.eval(() => document.querySelector(".gw-tally-sold")?.click());
        await session.pause(1500);
      }
      check(!(await murkBoxUp(session)), "Murk's box spoke the tally again after a reload");
      // At the jetty the notepad opens by itself.
      await session.waitFor(
        "the notepad, by itself",
        30_000,
        () => !!document.querySelector('.gw-modal.gw-in[data-modal="notepad"]'),
      );
      check(!(await murkBoxUp(session)), "Murk's box and the notepad are up together");
      await session.eval(() => document.querySelector(".gw-pad-close").click());
      const shared = await murkSharedWith(session);
      check(sameJson(shared, []), `Murk's box was on screen with: ${JSON.stringify(shared)}`);
      return `${said.length} pages over the card, kept on it, not again after a reload; then the notepad`;
    },
  },

  {
    name: "murk speaks at home: a new order in his box as soon as the jetty is up, before the guide's box and never with it; once only, so a reload brings no box",
    fixture: "mid-mossmere",
    debug: true,
    // The Order Board with one order Murk has not said yet, and the guide's box about Murk not yet seen: both
    // want the bare jetty at once.
    editSave(save) {
      const loop = save.meta.loop;
      loop.home = { ...loop.home, orders: 1 };
      loop.orders = [{ id: "murk-box", speciesId: "likely_chub", kind: "count", n: 1, have: 0 }];
      save.meta.guide.seen.murk = false;
    },
    async run(session) {
      await watchMurkAlone(session);
      await session.clickButton(/^Continue$/);
      await session.waitFor("home", 60_000, () => window.__gw.flow === "home");
      await session.waitFor("Murk's box", 30_000, (sel) => !!document.querySelector(sel), MURK_BOX);
      // The guide's box waits while he speaks.
      await session.pause(2500 * SLOW);
      const held = await session.eval(() => ({
        guide: !!document.querySelector('.gw-modal.gw-in[data-modal="guide"]'),
        jettyLine: document.querySelector(".gw-jetty-say .gw-murk-line")?.textContent ?? "",
      }));
      check(!held.guide, "the guide's box opened while Murk's box was up");
      const pages = await hearMurk(session);
      check(
        pages.length === 1 &&
          pages[0].tag === "Murk" &&
          pages[0].button === "Got it" &&
          /^Bring me .*Likely Chub.*\.$/.test(pages[0].text) &&
          pages[0].text === held.jettyLine,
        `Murk's box: ${JSON.stringify(pages)}; the jetty's line "${held.jettyLine}"`,
      );
      const said = await session.eval(() =>
        window.__gw.progression.loop.state().orders.every((o) => o.said === true),
      );
      check(said, "the order is not marked as said");
      // Then the guide's box, on its own.
      await session.waitFor(
        "the guide's box about Murk",
        20_000,
        () => !!document.querySelector('.gw-modal.gw-in[data-modal="guide"] .gw-guide--murk'),
      );
      check(!(await murkBoxUp(session)), "Murk's box is up with the guide's");
      await session.closeGuides();
      const shared = await murkSharedWith(session);
      check(sameJson(shared, []), `Murk's box was on screen with: ${JSON.stringify(shared)}`);
      // Coming home again with the same order: no box.
      await reloadToHome(session);
      await session.pause(5000 * SLOW);
      check(!(await murkBoxUp(session)), "Murk's box said the same order again after a reload");
      return `"${pages[0].text}" once, then the guide's box`;
    },
  },

  {
    name: "midnight: she can take only in her time (from the first stroke for three minutes, until she is hooked); the still-water line shows once; her Journal page says she feeds after the bell",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      // Her Journal page (she is landed in this save): the feeding line agrees with her lore.
      await session.toHome();
      await session.eval((id) => window.__gw.ui.openJournal({ sel: id }), LEGEND_ID);
      await session.waitFor("her journal page", 10_000, () => !!document.querySelector(".gw-jr-where"));
      const where = await visibleText(session, ".gw-jr-where");
      // Closed as a player closes it (closing every screen at once would also take the barge's own screen away).
      await backToJetty(session);
      check(
        where.includes("She feeds just after the old bell strikes midnight") && !/calm/i.test(where),
        `her Journal page's feeding line: "${where}"`,
      );
      // Her time as it runs while she is hunted: the hunt record taken back to before her landing.
      await session.eval(() => (window.__gw.progression.loop.state().hunt.mossmere.landed = 0));
      // She takes only a bait laid on the bottom: the Worm Bunch on the Sounding Lead, at 1 in 6.
      const rigged = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          s = loop.state();
        s.parts.includes("sounding_lead") || s.parts.push("sounding_lead");
        s.bait.mossmere.heartmoss = Math.max(5, s.bait.mossmere.heartmoss | 0);
        return loop.fit("bait", "heartmoss")?.ok === true && loop.fitDepth("lead")?.ok === true;
      });
      check(rigged, "could not fit the Worm Bunch on the Sounding Lead");
      await session.sail();
      await listenForToasts(session);
      const roll = () =>
        session.eval(
          () =>
            window.__gw.debug.fishLegendRoll({ place: "bell_pool", bait: "heartmoss", rolls: 400 }) ?? {
              none: true,
            },
        );
      const seen = {};
      // By day she no longer takes (today's "calm" rule is gone), nor at dusk, nor in the first minute of dark.
      await session.eval(() => window.__gw.debug.setPhase("calm"));
      seen.day = await roll();
      check(
        seen.day.place === "bell_pool" && !seen.day.mist,
        `the cast is not on the Bell Pool: ${JSON.stringify(seen.day)}`,
      );
      await session.eval(() => window.__gw.debug.setPhase("dusk"));
      seen.dusk = await roll();
      await atNight(session, MIDNIGHT_AT - 2);
      seen.beforeBell = await roll();
      // Her time: at the first stroke and near its end she takes at her own odds.
      await atNight(session, MIDNIGHT_AT + 0.5);
      seen.firstStroke = await roll();
      await atNight(session, MIDNIGHT_AT + 179);
      seen.lateInHerTime = await roll();
      let toasts = await toastsSeen(session);
      check(!toasts.includes(STILL_LINE), "the still-water line showed inside her time");
      // After the three minutes: closed, and the still-water line shows once. (Setting out re-reads the save
      // and marks her landed again, so the record is taken back once more.)
      await session.eval(() => (window.__gw.progression.loop.state().hunt.mossmere.landed = 0));
      await atNight(session, MIDNIGHT_AT + 181);
      seen.after = await roll();
      await atNight(session, MIDNIGHT_AT + 200);
      toasts = await toastsSeen(session);
      check(
        toasts.filter((t) => t === STILL_LINE).length === 1,
        `the still-water line: ${JSON.stringify(toasts)}`,
      );
      // A new evening on evening 1: no time for her at all.
      await atNight(session, MIDNIGHT_AT + 1, { evening: 1 });
      seen.eveningOne = await roll();
      // Hooked tonight: her time closes for the evening.
      await atNight(session, MIDNIGHT_AT + 1, { evening: 3 });
      seen.openAgain = await roll();
      await session.eval(() => (window.__gw.state.run.midnight.hooked = true));
      seen.hooked = await roll();
      for (const key of ["day", "dusk", "beforeBell", "after", "eveningOne", "hooked"])
        check(
          seen[key].may === false && seen[key].takes === 0,
          `${key}: she may take ${JSON.stringify(seen[key])}`,
        );
      for (const key of ["firstStroke", "lateInHerTime", "openAgain"]) {
        const takes = seen[key].takes;
        // Her own roll: the Worm Bunch on the lead at 1 in 6, so about 67 of 400.
        check(seen[key].may === true && takes >= 40 && takes <= 95, `${key}: ${JSON.stringify(seen[key])}`);
      }
      return `closed by day, dusk, before the bell, after 3 min, on evening 1 and once hooked; open in her time (${seen.firstStroke.takes}/400, ${seen.lateInHerTime.takes}/400); still line once; Journal "${where}"`;
    },
  },

  {
    name: "hunt: an old save loads with the hunt record filled in and hears the tale at its next tally; nothing on the notepad names the thief",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 600_000,
    // The lead already given: a tally with Murk's gift tells nothing else (one new thing a tally).
    editSave: withLead(false),
    async run(session) {
      await session.toHome();
      const loaded = await huntOf(session);
      check(
        loaded.taleAt === 0 &&
          JSON.stringify(loaded.sketches) === '{"map":0,"taken":0,"lineup":0,"swirl":0,"back":0}' &&
          Array.isArray(loaded.padUnseen) &&
          Array.isArray(loaded.hobLines) &&
          loaded.hobMet === 0,
        `the old save's hunt record: ${JSON.stringify(loaded)}`,
      );
      await session.sail(SLOW_SAIL);
      const seen = [];
      const { hunt, pad } = await tallyAndPad(session, {
        look: () => expectHidden(session, "the notepad as it opens by itself", seen),
      });
      check(hunt.includes(TALE) && hunt.includes(TALE_MURK), `the tally: "${hunt}"`);
      check(pad?.closedByOnePress && pad.blank === 5, `the notepad: ${JSON.stringify(pad)}`);
      check((await huntOf(session)).taleAt === 5, "the tale was not told at evening 5");
      await session.eval(() => window.__gw.ui.openJournal({ tab: "notepad" }));
      await session.pause(1200);
      await expectHidden(session, "the Journal's Notepad tab", seen);
      await backToJetty(session);
      return "back-filled, the tale at evening 5, the notepad says nothing of her";
    },
  },

  {
    name: "hunt: Hob talks once near his lit lamp and draws his map, which opens in the notepad at the next tally; next evening he says one new line, once; it all survives a reload",
    fixture: "fresh-first-evening",
    debug: true,
    timeoutMs: 900_000,
    editSave: withLead(false),
    async run(session, { page, browser }) {
      await session.sail(SLOW_SAIL);
      await nearHob(session);
      const talk = await hearHob(session);
      check(JSON.stringify(talk) === JSON.stringify(HOB_FIRST), `Hob's first talk: ${JSON.stringify(talk)}`);
      const toast = await session.eval(() =>
        [...document.querySelectorAll(".gw-toast")].map((t) => t.textContent.trim()).join(" | "),
      );
      check(toast.includes(DRAWN), `no "${DRAWN}" on the water: ${toast}`);
      const met = await huntOf(session);
      check(
        met.sketches.map === 2 && met.mapBy === "hob" && met.hobMet === 2 && met.padUnseen.includes("map"),
        `after the talk: ${JSON.stringify(met)}`,
      );
      // The same evening he only greets, once.
      const again = await passHobAgain(session, 15_000);
      check(
        JSON.stringify(again) === JSON.stringify([HOB_GREETING]),
        `passing again: ${JSON.stringify(again)}`,
      );
      check((await passHobAgain(session, 5000)).length === 0, "Hob spoke a third time in one evening");
      const { hunt, pad } = await tallyAndPad(session);
      check(hunt.includes(TALE), `the tally: "${hunt}"`);
      check(
        pad && pad.page === "where" && JSON.stringify(pad.drawn) === '["map"]' && pad.blank === 4,
        `the notepad at the tally: ${JSON.stringify(pad)}`,
      );
      check(pad.words.includes(MAP_WORDS) && pad.next === NEXT_MIDNIGHT, `its words: ${JSON.stringify(pad)}`);
      check(pad.closedByOnePress, "one press did not close the notepad");
      // Reloaded: the map and Hob's progress are kept; on evening 3 he says one new line, then only greets.
      const saved = await session.saved();
      const next = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await next.boot();
        await next.sail(SLOW_SAIL);
        const kept = await huntOf(next);
        check(
          kept.sketches.map === 2 && kept.hobMet === 2 && kept.padDue === false && kept.taleAt === 2,
          `after a reload: ${JSON.stringify(kept)}`,
        );
        await nearHob(next);
        const night = await hearHob(next);
        check(JSON.stringify(night) === JSON.stringify([HOB_ROD]), `evening 3: ${JSON.stringify(night)}`);
        const later = await passHobAgain(next, 15_000);
        check(
          JSON.stringify(later) === JSON.stringify([HOB_GREETING]),
          `evening 3 again: ${JSON.stringify(later)}`,
        );
        const record = await huntOf(next);
        check(JSON.stringify(record.hobLines) === '["rod"]' && record.hobNight === 3, JSON.stringify(record));
        await next.collectGameErrors();
        check(!next.errors.length, `errors after reloading: ${next.errors.join("; ")}`);
      } finally {
        await next.close();
      }
      return "four boxes and the map; a greeting once; the map at the tally; the rod line on evening 3";
    },
  },

  {
    name: "midnight: a hold that fills before midnight from evening 2 shows the full-hold line once",
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.sail();
      await listenForToasts(session);
      await session.eval(() => (window.__gw.state.run.evening = 2));
      for (let i = 0; i < 9 && !(await session.eval(() => window.__gw.progression.loop.holdFull())); i++)
        await session.catchFish("mossback_perch");
      check(await session.eval(() => window.__gw.progression.loop.holdFull()), "the hold did not fill");
      await session.pause(1500);
      const toasts = await toastsSeen(session);
      check(
        toasts.filter((t) => t === HOLD_FULL_LINE).length === 1,
        `the full-hold line: ${JSON.stringify(toasts)}`,
      );
      const flags = await session.eval(() => window.__gw.state.run.midnight);
      check(flags?.holdFullSaid === true, `the run's flag: ${JSON.stringify(flags)}`);
      return "the line showed once when the hold filled";
    },
  },

  {
    name: "hunt: Hob missed: after one evening Murk says where he is, after two Murk passes the map on",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 720_000,
    // The tale was told at evening 4's tally; Hob has not been met.
    editSave(save) {
      withLead(false)(save);
      save.meta.loop.hunt = { mossmere: { lineLesson: false, taleAt: 4 } };
    },
    async run(session) {
      await session.sail(SLOW_SAIL);
      const one = await tallyAndPad(session);
      check(one.hunt === MURK_FIND_HOB && one.pad === null, `after one evening: ${JSON.stringify(one)}`);
      const view = await session.eval(() => window.__gw.progression.loop.notepad());
      check(view?.next === "hob" && view.sketches.map === 0, `the notepad: ${JSON.stringify(view)}`);
      await session.sail(SLOW_SAIL);
      const two = await tallyAndPad(session);
      check(two.hunt === MURK_MAP, `after two evenings: "${two.hunt}"`);
      check(
        two.pad && JSON.stringify(two.pad.drawn) === '["map"]' && two.pad.next === NEXT_MIDNIGHT,
        `the notepad: ${JSON.stringify(two.pad)}`,
      );
      const record = await huntOf(session);
      check(
        record.mapBy === "murk" && record.sketches.map === 6 && record.murkNudged,
        JSON.stringify(record),
      );
      return "Murk's word at evening 5, the map at evening 6";
    },
  },

  {
    name: "midnight birds: at the first stroke the Gatehouse birds scatter, with their line once, only when the raft is within 30 m; never on evening 1",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    async run(session) {
      await session.sail();
      await listenForToasts(session);
      const frames = () =>
        session.eval(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const strike = async (evening) => {
        await atNight(session, MIDNIGHT_AT - 1, { evening });
        const before = await roostFlees(session);
        await atNight(session, MIDNIGHT_AT + 0.05);
        await frames();
        await atNight(session, MIDNIGHT_AT + 2.3);
        await frames();
        return (await roostFlees(session)) - before;
      };
      const farFrom = {
        x: ROOST.x + (HER_CENTRE.x - ROOST.x) * 2,
        z: ROOST.z + (HER_CENTRE.z - ROOST.z) * 2,
      };
      // The birds are drawn only above the lowest quality, and they only scatter where they can be seen.
      await session.eval(() => window.__gw.render.setQuality("medium"));
      // Evening 1: no bell, so no scatter, even close by.
      const nearOne = await raftAt(session, HER_CENTRE);
      const eveningOne = await strike(1);
      // Evening 2, about 41 m off: the bell strikes and the birds stay.
      const far = await raftAt(session, farFrom);
      const farFled = await strike(2);
      let toasts = await toastsSeen(session);
      check(
        toasts.includes(MIDNIGHT_LINE),
        `the bell did not strike on evening 2: ${JSON.stringify(toasts)}`,
      );
      // Evening 3, 20 m off (out of the raft's own 10 m reach): they scatter at the first stroke.
      const near = await raftAt(session, HER_CENTRE);
      const nearFled = await strike(3);
      // Later strokes and her time do not scatter them again or repeat the line.
      await atNight(session, MIDNIGHT_AT + 10);
      await frames();
      toasts = await toastsSeen(session);
      check(
        nearOne < 30 && near < 30 && near > 12 && far > 30,
        `raft distances: ${nearOne}, ${far}, ${near}`,
      );
      check(eveningOne === 0, `the birds fled on evening 1: ${eveningOne}`);
      check(farFled === 0, `the birds fled with the raft ${far.toFixed(1)} m off: ${farFled}`);
      check(
        nearFled === 3,
        `${nearFled} of the 3 Gatehouse birds fled with the raft ${near.toFixed(1)} m off`,
      );
      check(
        toasts.filter((t) => t === BIRDS_LINE).length === 1,
        `the birds' line: ${JSON.stringify(toasts)}`,
      );
      check(
        toasts.indexOf(BIRDS_LINE) > toasts.lastIndexOf(MIDNIGHT_LINE),
        `the birds' line came before the third evening's bell: ${JSON.stringify(toasts)}`,
      );
      return `evening 1: none; ${far.toFixed(0)} m: none; ${near.toFixed(0)} m: ${nearFled} fled and the line once`;
    },
  },

  {
    name: "midnight odds: once she is landed, her Odds row is under Night with the line about the bell, and not by day or dusk",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      await session.eval(() => window.__gw.ui.closeAll());
      const day = await bellPoolOdds(session, "day");
      const dusk = await bellPoolOdds(session, "dusk");
      const night = await bellPoolOdds(session, "night");
      check(!day.row && !day.herTime, `by day: ${JSON.stringify(day)}`);
      check(!dusk.row && !dusk.herTime, `at dusk: ${JSON.stringify(dusk)}`);
      check(
        night.row?.legend === true && night.row.share > 0 && night.herTime === true,
        `by night: ${JSON.stringify(night)}`,
      );
      // The sheet itself, as the player opens it: Odds, the Bell Pool, Night.
      await session.eval(() => window.__gw.ui.openJournal({ tab: "sheet" }));
      await session.pause(800);
      await clickAll(session, '[data-sheet-page="odds"]', 0);
      await session.pause(500);
      await clickAll(session, '[data-where="bell_pool"]', 0);
      await session.pause(300);
      const shown = {};
      for (const hour of ["day", "night"]) {
        await clickAll(session, `[data-hour="${hour}"]`, 0);
        await session.pause(500);
        shown[hour] = await session.eval(() => ({
          rows: [...document.querySelectorAll(".gw-sh-row")].map((r) => r.dataset.fish),
          foot: [...document.querySelectorAll(".gw-sh-foot")].map((p) => p.textContent),
        }));
      }
      check(
        !shown.day.rows.includes(LEGEND_ID) && !shown.day.foot.includes(HER_ODDS_LINE),
        `the sheet by day: ${JSON.stringify(shown.day)}`,
      );
      check(
        shown.night.rows.includes(LEGEND_ID) && shown.night.foot.includes(HER_ODDS_LINE),
        `the sheet by night: ${JSON.stringify(shown.night)}`,
      );
      return `no row by day or dusk; by night share ${night.row.share} and the line`;
    },
  },

  {
    name: "chart at once: a chart opened the moment home is free after Continue, before its art is ready, gets its tap areas",
    fixture: "sporewood-crossed",
    debug: true,
    timeoutMs: 420_000,
    async run(session, { fixture }) {
      const water = fixture.meta.loop.barge.water;
      // Hold the chart's art (its images decode only when released), so the chart is surely opened before
      // its art is ready, as it can be on a slow phone or a busy machine. Then boot again with the hold on.
      await session.context.addInitScript(() => {
        window.__holdChartArt = true;
        const decode = HTMLImageElement.prototype.decode;
        HTMLImageElement.prototype.decode = function () {
          return new Promise((done, fail) => {
            const go = () =>
              window.__holdChartArt ? setTimeout(go, 100) : decode.call(this).then(done, fail);
            go();
          });
        };
      });
      await session.page.reload({ waitUntil: "domcontentloaded" });
      await session.boot();
      await session.clickButton(/^Continue$/);
      // Press Chart on the first frame home is free, while the title screen is still fading out.
      const opened = await session.eval(
        () =>
          new Promise((done) => {
            const t0 = performance.now();
            const tick = () => {
              const g = window.__gw;
              const chart = [...document.querySelectorAll("button")].find(
                (b) => b.getBoundingClientRect().width > 0 && b.textContent.trim() === "Chart",
              );
              if (g.flow === "home" && !g.ui.isBlocking() && chart) return chart.click(), done(true);
              if (performance.now() - t0 > 60_000) return done(false);
              requestAnimationFrame(tick);
            };
            tick();
          }),
      );
      check(opened, "home was never free with a Chart button");
      await session.pause(1000);
      const before = await session.eval(() => ({
        status: window.__gw.debug.loop.chart()?.status ?? null,
        list: document.querySelectorAll(".gw-m-chart .gw-chart-row").length,
        hits: document.querySelectorAll(".gw-chart-hit").length,
      }));
      check(before.status === "loading" && before.hits === 0, `before the art: ${JSON.stringify(before)}`);
      await session.eval(() => (window.__holdChartArt = false));
      await session.waitFor(
        `the chart's tap area for ${water}`,
        20_000,
        (w) => !!document.querySelector(`.gw-chart-hit[data-id="water:${w}"]`),
        water,
      );
      const ids = await session.eval(() =>
        [...document.querySelectorAll(".gw-chart-hit")].map((h) => h.dataset.id),
      );
      return `the list (${before.list} rows) while the art loaded, then ${ids.length} tap areas: ${ids.join(" ")}`;
    },
  },

  {
    name: "sail: a trip refused after the sail-out glide brings the jetty back; with the sailing flag left set and nothing in flight, Sail from the chart still reaches the water",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    async run(session) {
      await session.toHome();
      const chartSail = () =>
        session.eval((murkButton) => {
          const button = (text) =>
            [...document.querySelectorAll("button")].find(
              (b) => b.getBoundingClientRect().width > 0 && b.textContent.trim() === text,
            );
          const murk = document.querySelector(murkButton);
          if (murk) return murk.click(), "hear Murk";
          if (button("Got it")) return button("Got it").click(), "close guide";
          if (button("Sail")) return button("Sail").click(), "sail";
          if (button("Chart") && !window.__gw.ui.isBlocking()) return button("Chart").click(), "chart";
          return "wait";
        }, MURK_BOX_BUTTON);
      const home = () => session.eval(() => window.__gw.debug.loop.homeState());
      // A refused trip: the next trip will not start. Chart, Sail, the glide out, then the jetty is back.
      const armed = await session.eval(() => window.__gw.debug.loop.sailStall("trip"));
      check(armed?.flow === "home" && !armed.sailing, `before the refused trip: ${JSON.stringify(armed)}`);
      let pressed = null;
      for (const end = Date.now() + 60_000 * SLOW; Date.now() < end && pressed !== "sail"; ) {
        pressed = await chartSail();
        await session.pause(500);
      }
      check(pressed === "sail", "the chart's Sail button never showed");
      await session.waitFor(
        "the refused trip",
        60_000,
        () => window.__gw.debug.loop.homeState().sailRefused === "trip",
      );
      await session.waitFor(
        "the jetty back after the refused trip",
        20_000,
        () =>
          !!document.querySelector('[data-loop="jetty"]') &&
          [...document.querySelectorAll("button")].some(
            (b) => b.getBoundingClientRect().width > 0 && b.textContent.trim() === "Chart",
          ),
      );
      const refused = await home();
      check(
        refused.flow === "home" && !refused.sailing && !refused.glide,
        `after the refused trip: ${JSON.stringify(refused)}`,
      );
      // The stuck state: the sailing flag set, no glide and no tow in flight. Sail from the chart still sails.
      const stuck = await session.eval(() => window.__gw.debug.loop.sailStall("flag"));
      check(stuck?.sailing === true && stuck.glide === null, `the stuck state: ${JSON.stringify(stuck)}`);
      const actions = await session.sail();
      const out = await session.eval(() => ({
        flow: window.__gw.flow,
        outing: window.__gw.state.run?.outing ?? null,
        home: window.__gw.debug.loop.homeState(),
      }));
      check(
        out.flow === "playing" && out.outing === "trip" && !out.home.sailing && out.home.sailRefused === null,
        `after Sail with the flag stuck: ${JSON.stringify(out)}`,
      );
      return `refused: ${refused.sailRefused}, jetty back; stuck flag: ${actions}`;
    },
  },

  {
    name: "her water: unfound, nothing marks it on the water or the chart, and Murk never sells the Bell Pool",
    fixture: "mid-mossmere",
    debug: true,
    editSave(save) {
      withMap(save);
      save.meta.loop.maps.places.push("under_the_span", "buoy_lights");
    },
    async run(session) {
      await session.toHome();
      const shelf = await session.eval(() => {
        const loop = window.__gw.progression.loop;
        window.__gw.debug.loop.giveClams(5000);
        return {
          card: loop.mapCards().find((c) => c.placeId === "bell_pool") ?? null,
          bought: loop.buy("place:bell_pool")?.ok === true,
          owned: loop.state().maps.places.includes("bell_pool"),
        };
      });
      check(!shelf.card && !shelf.bought && !shelf.owned, `Murk's shelf: ${JSON.stringify(shelf)}`);
      const chart = await chartPlaces(session);
      check(
        chart.includes("lily_maze") && !chart.includes("bell_pool"),
        `the chart marks ${chart.join(", ")}`,
      );
      await session.sail();
      // Over her hole by day and in her time: plain water.
      for (const when of ["day", "her time"]) {
        if (when === "her time") await atNight(session, MIDNIGHT_AT + 20, { evening: 5 });
        const marks = await herWaterMarks(session);
        check(
          marks.bank && marks.bank.op === 0 && marks.bank.target === 0,
          `${when}: the mist bank shows: ${JSON.stringify(marks.bank)}`,
        );
        check(marks.frame === false && marks.cork === false, `${when}: ${JSON.stringify(marks)}`);
        check(marks.rim === 0, `${when}: the water is shaded over her hole (uWcRim ${marks.rim})`);
        check(
          marks.castPlace === null && marks.castMist === null,
          `${when}: a cast there is not plain water: ${JSON.stringify(marks)}`,
        );
      }
      return "no shelf card or sale, no chart mark; no mist bank, frame, cork, dark tone or mist on a cast";
    },
  },

  {
    name: "her water: boils rise only with Hob's map and in her time, every 20 to 30 s within 6 m of her centre, with a word only within 25 m; twice as often and from 40 m on the nudge night",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withMap,
    async run(session) {
      await session.sail();
      await listenForToasts(session);
      await session.eval(() => {
        window.__boils = [];
        window.__gw.bus.on("hunt:boil", (b) => window.__boils.push(b));
      });
      const boilsNow = () => session.eval(() => window.__boils.length);
      // Steps to the next boil: the night clock put just past the run's next boil time.
      const nextBoil = async (raft) => {
        await session.eval((at) => window.__gw.player.teleport(at, 0), raft);
        const due = await session.eval(() => window.__gw.state.run.midnight?.boilAt ?? null);
        check(due != null, "no boil is due in her time");
        const before = await boilsNow();
        await atNight(session, due + 0.05);
        check((await boilsNow()) === before + 1, `no boil rose at ${due}`);
        return session.eval(() => ({
          boil: window.__boils.at(-1),
          toasts: window.__toasts.slice(),
          nextDue: window.__gw.state.run.midnight.boilAt,
        }));
      };
      // No map: nothing in her time.
      await session.eval(() => (window.__gw.state.meta.loop.hunt.mossmere.sketches.map = 0));
      await atNight(session, MIDNIGHT_AT + 1, { evening: 5 });
      await atNight(session, MIDNIGHT_AT + 60);
      check((await boilsNow()) === 0, "a boil rose before Hob's map was drawn");
      await session.eval(() => (window.__gw.state.meta.loop.hunt.mossmere.sketches.map = 3));
      // Before midnight and after her time: nothing.
      await atNight(session, MIDNIGHT_AT - 5, { evening: 5 });
      await atNight(session, MIDNIGHT_AT - 1);
      check((await boilsNow()) === 0, "a boil rose before midnight");
      // In her time: the next boil is 20 to 30 s off; far away, no word; 12 m off, a direction word.
      await atNight(session, MIDNIGHT_AT + 1);
      const far = await nextBoil({ x: 40, z: 30 });
      const near = await nextBoil({ x: HER_CENTRE.x, z: HER_CENTRE.z + 12 });
      // (Each gap is the next boil's time less the time this one rose.)
      const gaps = [far.nextDue - far.boil.t, near.nextDue - near.boil.t];
      for (const b of [far.boil, near.boil])
        check(
          Math.hypot(b.x - HER_CENTRE.x, b.z - HER_CENTRE.z) <= 6.01,
          `a boil 6 m off: ${JSON.stringify(b)}`,
        );
      check(
        gaps.every((g) => g >= 20 && g <= 30),
        `boil gaps ${gaps}`,
      );
      check(far.boil.word === null, `a word for a boil 50 m off: ${JSON.stringify(far.boil)}`);
      const boilToasts = (list) => list.filter((t) => BOIL_LINE.test(t));
      check(boilToasts(far.toasts).length === 0, `a boil line far off: ${JSON.stringify(far.toasts)}`);
      check(
        ["ahead", "behind", "left", "right"].includes(near.boil.word) && boilToasts(near.toasts).length === 1,
        `the near boil: ${JSON.stringify(near)}`,
      );
      // After her time: none.
      await atNight(session, MIDNIGHT_AT + 181);
      const after = await boilsNow();
      await atNight(session, MIDNIGHT_AT + 240);
      check((await boilsNow()) === after, "a boil rose after her time");
      // The nudge night: every 10 to 15 s, and a word from 32 m off.
      await session.eval(() => (window.__gw.state.meta.loop.hunt.mossmere.nudged.boost = 6));
      await atNight(session, MIDNIGHT_AT + 1, { evening: 6 });
      const nudged = await nextBoil({ x: HER_CENTRE.x, z: HER_CENTRE.z + 34 });
      const nudgedGap = nudged.nextDue - nudged.boil.t;
      check(nudgedGap >= 10 && nudgedGap <= 15, `the nudge night's gap ${nudgedGap}`);
      check(
        nudged.boil.word !== null,
        `no word 28 to 40 m off on the nudge night: ${JSON.stringify(nudged.boil)}`,
      );
      return `gaps ${gaps.map((g) => g.toFixed(1))}; far: none; near: "${near.boil.word}"; nudge night every ${nudgedGap.toFixed(1)} s`;
    },
  },

  {
    name: "her water: the theft takes the first fish hooked on the float within 8 m in her time, once; it draws sketch 2, finds her water and lifts it; frame, cork and chart ring then survive a reload",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 900_000,
    // The line-up was drawn at the tally after the map, so this tally has only its own word.
    editSave: withLineup(),
    async run(session, { page, browser }) {
      await session.sail(SLOW_SAIL);
      await listenForToasts(session);
      await session.eval(() => {
        window.__lifts = [];
        window.__gw.bus.on("place:lift", (e) => window.__lifts.push(`${e.placeId}:${e.phase}:${e.name}`));
      });
      const before = await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        return JSON.stringify({ tackle: s.tackle, parts: s.parts, fitted: s.fitted, lures: s.lures });
      });
      // Outside her time near her hole: no theft (the calibration hook is one such).
      const lost = await hookNear(session, "mossback_perch", HER_CENTRE, null, () =>
        atNight(session, MIDNIGHT_AT + 20, { evening: 5 }),
      );
      check(lost.thiefAt, `the hook was not taken: ${JSON.stringify(lost)}`);
      check(
        Math.hypot(lost.thiefAt.x - HER_CENTRE.x, lost.thiefAt.z - HER_CENTRE.z) <= 8,
        `taken ${JSON.stringify(lost.thiefAt)} more than 8 m from her centre`,
      );
      check(
        lost.escape?.reason === "thief" && lost.escape.onLead === false,
        `the escape: ${JSON.stringify(lost.escape)}`,
      );
      check(
        !lost.escape.overCap && !lost.escape.oldRivalId && !lost.escape.markedFish,
        JSON.stringify(lost.escape),
      );
      const found = await session.eval(() => {
        const g = window.__gw;
        const s = g.progression.loop.state();
        return {
          hunt: JSON.parse(JSON.stringify(s.hunt.mossmere)),
          owned: s.maps.places.includes("bell_pool"),
          revealed: s.places.revealed.includes("bell_pool"),
          took: g.state.run.midnight.thiefTook === true,
          wounds: g.state.meta.legendWounds?.belled_matriarch ?? 0,
          gear: JSON.stringify({ tackle: s.tackle, parts: s.parts, fitted: s.fitted, lures: s.lures }),
        };
      });
      const h = found.hunt;
      check(
        h.found === true && h.foundBy === "theft" && h.foundEvening === 5 && h.sketches.taken === 5,
        `the record: ${JSON.stringify(h)}`,
      );
      check(h.padUnseen.includes("taken") && h.takenOn === "float", `the record: ${JSON.stringify(h)}`);
      check(found.owned && found.revealed && found.took, `the find: ${JSON.stringify(found)}`);
      check(found.wounds === 0 && found.gear === before, `a wound or gear lost: ${JSON.stringify(found)}`);
      // The lines, then the lift with its title, then the cork and the bell.
      await session.waitFor("the lift of her water", 120_000, () =>
        window.__gw.progression.loop.lifted().includes("bell_pool"),
      );
      await session.pause(1500);
      const lifts = await session.eval(() => window.__lifts.slice());
      check(lifts.includes("bell_pool:title:The Bell Pool"), `the lift: ${JSON.stringify(lifts)}`);
      const toasts = await toastsSeen(session);
      const order = [TAKEN_FLOAT, SPARE_FLOAT, DRAWN, CORK_LINE, BELL_LINE].map((t) => toasts.indexOf(t));
      check(
        order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])),
        `the lines: ${JSON.stringify(toasts)}`,
      );
      // Never again: the next fish there is not taken, tonight or another night.
      await session.closeGuides(3000);
      const again = await hookNear(session, "mossback_perch", HER_CENTRE, "lose", () =>
        atNight(session, MIDNIGHT_AT + 60, { evening: 6 }),
      );
      check(!again.thiefAt && again.escape?.reason !== "thief", `taken again: ${JSON.stringify(again)}`);
      // Found: the frame, the cork and the dark tone show, and a cast there fishes the Bell Pool.
      const marks = await herWaterMarks(session);
      check(
        marks.frame && marks.cork && marks.rim === 1 && marks.castPlace === "bell_pool" && !marks.castMist,
        `after the find: ${JSON.stringify(marks)}`,
      );
      // Reloaded (the trip goes on): still found, with the frame and cork on the water. At the tally Murk
      // speaks of the find and the notepad opens on sketch 2; the chart then marks it (Murk's ring is drawn
      // with that mark).
      const saved = await session.saved();
      const next = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await next.boot();
        await next.sail(SLOW_SAIL);
        const kept = await huntOf(next);
        check(kept.found === true && kept.sketches.taken === 5, `after a reload: ${JSON.stringify(kept)}`);
        const after = await herWaterMarks(next);
        check(
          after.frame && after.cork && after.castPlace === "bell_pool",
          `after a reload: ${JSON.stringify(after)}`,
        );
        const { hunt, pad } = await tallyAndPad(next);
        check(hunt === MURK_FOUND, `the tally: "${hunt}"`);
        check(
          pad && pad.page === "where" && pad.drawn.includes("taken") && pad.words.includes(TAKEN_WORDS),
          `the notepad at the tally: ${JSON.stringify(pad)}`,
        );
        check(pad.next === NEXT_SPOT, `the notepad's foot: ${pad.next}`);
        const chart = await chartPlaces(next);
        check(chart.includes("bell_pool"), `the chart after a reload marks ${chart.join(", ")}`);
        await next.collectGameErrors();
        check(!next.errors.length, `errors after reloading: ${next.errors.join("; ")}`);
      } finally {
        await next.close();
      }
      return `taken ${Math.hypot(lost.thiefAt.x - HER_CENTRE.x, lost.thiefAt.z - HER_CENTRE.z).toFixed(1)} m off; found, lifted, lines in order; not again; kept after a reload`;
    },
  },

  {
    name: "the bird at midnight: it plays once, at the first midnight after the night her water was found; never on the night of the find or for unfound water, and not again after a reload",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 900_000,
    editSave: withFound(5),
    async run(session, { page, browser }) {
      await session.sail(SLOW_SAIL);
      await listenForBirdScene(session);
      check((await huntOf(session)).birdCutsceneSeen === false, "an older record was not given the flag");
      // The night of the find (evening 5): the bell and her time, and no cutscene.
      await strikeMidnight(session, 5, MIDNIGHT_AT + 20);
      let seen = await birdSceneSeen(session);
      check(
        !seen.phases.length && !seen.playing && !seen.seen,
        `the night of the find: ${JSON.stringify(seen)}`,
      );
      // Water that is not found: none, on a later night too.
      await session.eval(() => (window.__gw.state.meta.loop.hunt.mossmere.found = false));
      await strikeMidnight(session, 6, MIDNIGHT_AT + 20);
      seen = await birdSceneSeen(session);
      check(
        !seen.phases.length && !seen.playing && !seen.seen,
        `with her water unfound: ${JSON.stringify(seen)}`,
      );
      await session.eval(() => (window.__gw.state.meta.loop.hunt.mossmere.found = true));
      // The first night after the find: it plays through by itself, and the line shows once at its end.
      await strikeMidnight(session, 6);
      await session.waitFor("the bird at midnight to play", 240_000, () => window.__scene.includes("end"));
      seen = await birdSceneSeen(session);
      check(
        JSON.stringify(seen.phases) === JSON.stringify(["start", "take", "end"]) && seen.seen === true,
        `the cutscene: ${JSON.stringify(seen)}`,
      );
      check(
        seen.toasts.filter((t) => t === BIRD_LINE).length === 1 &&
          seen.toasts.lastIndexOf(MIDNIGHT_LINE) < seen.toasts.indexOf(BIRD_LINE),
        `the lines: ${JSON.stringify(seen.toasts)}`,
      );
      // Later in her time the same night: not again.
      await atNight(session, MIDNIGHT_AT + 90);
      await session.pause(2000);
      check((await birdSceneSeen(session)).phases.length === 3, "it started again the same night");
      // Reloaded, on a later night: the flag is kept and it does not play again.
      const saved = await session.saved();
      const next = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await next.boot();
        await next.sail(SLOW_SAIL);
        await listenForBirdScene(next);
        await strikeMidnight(next, 7, MIDNIGHT_AT + 20);
        const after = await birdSceneSeen(next);
        check(
          after.seen === true && !after.playing && !after.phases.includes("start"),
          `after a reload: ${JSON.stringify(after)}`,
        );
        await next.collectGameErrors();
        check(!next.errors.length, `errors after reloading: ${next.errors.join("; ")}`);
      } finally {
        await next.close();
      }
      return "not on the find night or for unfound water; once the next night with its line; not after a reload";
    },
  },

  {
    name: "the bird at midnight: it waits while a fish is on the line; while it plays the night clock stands still and the bird is on the water; one press skips it, the line shows once and play carries on",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 600_000,
    editSave: withFound(3),
    async run(session) {
      await session.sail(SLOW_SAIL);
      await listenForBirdScene(session);
      await listenOnWater(session);
      // A fish on the line through the first stroke: nothing plays until the fight is over.
      await atNight(session, MIDNIGHT_AT - 1, { evening: 5 });
      const hooked = await session.eval(() => {
        const g = window.__gw;
        g.debug.fishOutcome("lose");
        return g.debug.fishHook("mossback_perch") && g.fishing.state;
      });
      check(hooked === "reeling", `could not hook a fish: ${hooked}`);
      await atNight(session, MIDNIGHT_AT + 0.05);
      await atNight(session, MIDNIGHT_AT + 4);
      await session.pause(2000);
      const waiting = await birdSceneSeen(session);
      check(!waiting.phases.length && !waiting.playing, `it played over a fight: ${JSON.stringify(waiting)}`);
      await session.eval(() => window.__gw.debug.fishPlayTo(0.995));
      // The fight plays out (any guide card closed as a player would); then it starts by itself.
      for (const end = Date.now() + 240_000; !(await session.eval(() => !!window.__gw.game.birdScene())); ) {
        check(Date.now() < end, `it did not start after the fight: ${JSON.stringify(await session.state())}`);
        await session.clickButton(/^Got it$/);
        await session.pause(300);
      }
      const during = await session.eval(async () => {
        const g = window.__gw;
        const t0 = g.state.run.phaseTime;
        await new Promise((r) => setTimeout(r, 1200));
        return {
          t0,
          t1: g.state.run.phaseTime,
          cinematic: g.cinematic,
          camera: g.render.landmarkState?.().on ?? null,
          bird: g.debug.wildlife?.()?.staged ?? null,
          scene: g.game.birdScene(),
          fishing: g.fishing.state,
        };
      });
      check(during.t1 === during.t0, `the night clock moved: ${during.t0} to ${during.t1}`);
      check(
        during.cinematic && during.camera && during.bird?.shown && during.scene && during.fishing === "idle",
        `while it plays: ${JSON.stringify(during)}`,
      );
      check(!(await birdSceneSeen(session)).toasts.includes(BIRD_LINE), "the line showed before the end");
      // One press skips it.
      await session.page.keyboard.press("Enter");
      await session.pause(1000);
      const after = await session.eval(() => {
        const g = window.__gw;
        return { cinematic: g.cinematic, fishing: g.fishing.state, t: g.state.run.phaseTime };
      });
      const seen = await birdSceneSeen(session);
      check(
        !seen.playing && !after.cinematic && seen.phases.at(-1) === "end:skipped",
        `after the press: ${JSON.stringify({ ...seen, ...after })}`,
      );
      check(
        seen.toasts.filter((t) => t === BIRD_LINE).length === 1,
        `the line: ${JSON.stringify(seen.toasts)}`,
      );
      check(after.fishing === "idle", `the press cast the line: ${after.fishing}`);
      // Play carries on: the night clock runs again (a first-play guide box may open in the free moment after
      // the scene, and it holds the clock until it is closed).
      await session.closeGuides(3000);
      await session.pause(1500);
      const later = await session.eval(() => window.__gw.state.run.phaseTime);
      check(later > after.t, `the night clock stayed stopped at ${after.t}`);
      // Nothing on the water said or showed what it is.
      const { lines, models } = await heardOnWater(session);
      const named = lines.filter((l) => HER_WORDS.test(l));
      check(!named.length && !models.length, `named or shown: ${JSON.stringify({ named, models })}`);
      return `waited out the fight; clock held at ${during.t0.toFixed(1)} s; skipped with one press; the line once`;
    },
  },

  {
    name: "the bird at midnight: on the nights after it was seen, a splash and a ripple mark her spot at the first stroke, with no cutscene and no line",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    editSave: withFound(2, { birdCutsceneSeen: true }),
    async run(session) {
      await session.sail(SLOW_SAIL);
      await listenForBirdScene(session);
      await atNight(session, MIDNIGHT_AT - 1, { evening: 5 });
      check(!(await birdSceneSeen(session)).phases.length, "a mark before midnight");
      await strikeMidnight(session, 5, MIDNIGHT_AT + 30);
      await atNight(session, MIDNIGHT_AT + 90);
      await session.pause(1500);
      const seen = await birdSceneSeen(session);
      check(JSON.stringify(seen.phases) === JSON.stringify(["mark"]), `the marks: ${JSON.stringify(seen)}`);
      check(
        !seen.playing && !seen.toasts.includes(BIRD_LINE),
        `a cutscene or its line: ${JSON.stringify(seen)}`,
      );
      return "one splash at the first stroke; no cutscene, no line";
    },
  },

  {
    name: "the theft's own words: a fish the thief takes shows no got-away toast, card or gear word and joins no got-away list; a fish that gets away still shows its gear word",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withMap,
    async run(session) {
      await session.sail(SLOW_SAIL);
      // An escape as the fight sends it (fish:escaped), for a trophy fish the thief took and for one that threw
      // the hook. What shows and what the save keeps after each.
      const escape = (reason) =>
        session.eval(async (reason) => {
          const g = window.__gw;
          const meta = g.state.meta;
          const count = () => ({
            journal: meta.journal?.mossback_perch?.gotAway?.length ?? 0,
            run: g.state.run?.flags?.gotAway?.length ?? 0,
            lastAway: JSON.stringify(meta.lastAway ?? null),
          });
          const before = count();
          const word = "Worn through on its lips. Chafe Gut won't wear.";
          g.bus.emit("fish:escaped", {
            speciesId: "mossback_perch",
            sizeClass: "trophy",
            ancient: false,
            z: 1.6,
            approxLength: 40,
            reason,
            place: null,
            x: -3,
            zPos: -13,
            markedFish: false,
            legendary: false,
            zone: "mossmere",
            partLossText: word,
            ...(reason === "thief" ? { onLead: false } : {}),
          });
          await new Promise((r) => setTimeout(r, 600));
          const on = (sel) => !!document.querySelector(`${sel}.gw-on`);
          return {
            before,
            after: count(),
            toast: on(".gw-away"),
            card: on(".gw-gotaway"),
            word: on(".gw-strike") && document.querySelector(".gw-strike-w")?.textContent === word,
          };
        }, reason);
      const taken = await escape("thief");
      check(!taken.toast && !taken.card && !taken.word, `the theft showed: ${JSON.stringify(taken)}`);
      check(
        JSON.stringify(taken.after) === JSON.stringify(taken.before),
        `the theft joined a got-away list: ${JSON.stringify(taken)}`,
      );
      // The same fish getting away the ordinary way still shows its gear word. (On a trip the game keeps no
      // got-away list for ordinary fish either, so only the word tells them apart.)
      const lost = await escape("thrown");
      check(lost.word, `an ordinary escape: ${JSON.stringify(lost)}`);
      return "theft: nothing shown or kept; an ordinary escape: its word shown";
    },
  },

  {
    name: "her water: an old save that owns the Bell Pool loads as found, with sketches 1 and 2 drawn and sketch 2 saying it found the spot itself",
    fixture: "legend-sold",
    // Her hunt is not over: she has never been landed in this copy of the save.
    editSave: unsold(),
    debug: true,
    async run(session) {
      await session.toHome();
      const h = await huntOf(session);
      check(
        h.found === true &&
          h.foundBy === "chart" &&
          h.sketches.map > 0 &&
          h.sketches.taken > 0 &&
          h.murkFound,
        `the record: ${JSON.stringify(h)}`,
      );
      await session.eval(() => window.__gw.ui.openJournal({ tab: "notepad" }));
      await session.waitFor(
        "the notepad tab",
        10_000,
        () => !!document.querySelector(".gw-journal-pad .gw-pad"),
      );
      const pad = await notepadShown(session, ".gw-journal-pad .gw-pad");
      // Back to the barge as a player gets there. (closeAll would shut the barge's own menu too, and the Chart
      // button with it.)
      await backToJetty(session);
      check(
        JSON.stringify(pad?.drawn) === '["map","taken"]' && pad.words.includes(TAKEN_SELF),
        `the notepad: ${JSON.stringify(pad)}`,
      );
      check(
        !pad.words.includes(TAKEN_WORDS) && pad.next === NEXT_SPOT,
        `the notepad: ${JSON.stringify(pad)}`,
      );
      const chart = await chartPlaces(session);
      check(chart.includes("bell_pool"), `the chart marks ${chart.join(", ")}`);
      return `found by its chart; sketches ${pad.drawn.join(", ")}; "${TAKEN_SELF}"`;
    },
  },

  {
    name: "her water: the nudges: with the map but not in Hob's part at midnight, Murk says to be there; in it with no find, he says to watch for boils; the notepad's foot moves on with them",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 720_000,
    // The line-up was drawn at the tally after the map, so this tally has only its own word.
    editSave: withLineup(),
    async run(session) {
      // Evening 5: away from Hob's part all night.
      await session.sail(SLOW_SAIL);
      await session.eval(() => window.__gw.player.teleport({ x: 30, z: 30 }, 0));
      await atNight(session, MIDNIGHT_AT + 30);
      const one = await tallyAndPad(session);
      check(one.hunt === MURK_MIDNIGHT, `after an evening away: "${one.hunt}"`);
      let view = await session.eval(() => window.__gw.progression.loop.notepad());
      check(view?.next === "midnight", `the notepad's foot: ${JSON.stringify(view)}`);
      // Evening 6: in Hob's part in her time, and nothing found.
      await session.sail(SLOW_SAIL);
      await session.eval((c) => window.__gw.player.teleport({ x: c.x - 10, z: c.z - 4 }, 0), HER_CENTRE);
      await atNight(session, MIDNIGHT_AT + 30);
      const partAt = (await huntOf(session)).partAt;
      check(partAt === 6, `in Hob's part at midnight: partAt ${partAt}`);
      const two = await tallyAndPad(session);
      check(two.hunt === MURK_BOILS, `after an evening there: "${two.hunt}"`);
      view = await session.eval(() => window.__gw.progression.loop.notepad());
      check(view?.next === "boils", `the notepad's foot: ${JSON.stringify(view)}`);
      const record = await huntOf(session);
      check(record.nudged.midnight === 5 && record.nudged.boils === 6, JSON.stringify(record.nudged));
      return "Murk's midnight line at evening 5, his boils line at evening 6";
    },
  },

  {
    name: "leader: Pike Wire and Chafe Gut shift bites by their tags in all three bite paths, on bait and on lures, never to zero, and add Grip to toothy and rough fish",
    fixture: "legend-sold",
    debug: true,
    editSave: withParts(["sounding_lead", "pike_wire", "chafe_gut"]),
    async run(session) {
      // An older save that sold her has Hob's Lamp: taken away here, so the rolls compare with the build before it.
      await dropLamp(session);
      await session.sail(SLOW_SAIL);
      const ratioCheck = (rolls, leader, want, label) => {
        const plain = rolls.plain_knot.shares,
          on = rolls[leader].shares,
          base = on.mossback_perch / plain.mossback_perch;
        check(plain.mossback_perch > 0, `${label}: no Mossback Perch to compare against`);
        let moved = 0;
        for (const id of Object.keys(plain).filter((id) => plain[id] > 0)) {
          check(on[id] > 0, `${label}: ${id} bites on the Plain Knot but not on ${leader}`);
          const ratio = on[id] / plain[id] / base,
            expect = want(id);
          check(
            near(ratio, expect, 1e-6),
            `${label}: ${id} ${ratio.toFixed(4)} times as often, expected ${expect}`,
          );
          expect !== 1 && moved++;
        }
        check(moved > 0, `${label}: no tagged fish here, so this proves nothing`);
        return moved;
      };
      // 1. Pool rows (l1), bait: wary fish x0.7 on Pike Wire, delicate x0.7 on Chafe Gut, the rest unchanged.
      await session.eval(() => window.__gw.debug.setPhase("calm"));
      const bait = await rollLeaders(session, ["plain_knot", "pike_wire", "chafe_gut"], { bait: "mireworm" });
      check(
        bait.pike_wire.leader === "pike_wire" && bait.plain_knot.leader === null,
        "the leader did not fish",
      );
      const wary = ratioCheck(bait, "pike_wire", (id) => (WARY.includes(id) ? 0.7 : 1), "bait, Pike Wire");
      const dainty = ratioCheck(
        bait,
        "chafe_gut",
        (id) => (DELICATE.includes(id) ? 0.7 : 1),
        "bait, Chafe Gut",
      );
      // On the Sounding Lead too: a Dusk Minnow (a high feeder, x0.5) on Chafe Gut (x0.7) is at the 0.35 floor.
      const lead = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          d = window.__gw.debug;
        loop.fitDepth("lead");
        const roll = (id) => (loop.fitPart("leader", id), d.fishPoolRoll(1, { bait: "mireworm" }).shares);
        const out = { plain: roll("plain_knot"), gut: roll("chafe_gut") };
        loop.fitPart("leader", "plain_knot");
        loop.fitDepth("float");
        return out;
      });
      const leadRatio =
        lead.gut.dusk_minnow / lead.plain.dusk_minnow / (lead.gut.mossback_perch / lead.plain.mossback_perch);
      check(
        near(leadRatio, 0.7, 1e-6) && lead.gut.dusk_minnow > 0,
        `the lead and Chafe Gut on a Dusk Minnow: ${leadRatio}`,
      );
      // 2. Sign and sight takes (_7): a prerolled chub takes 0.7 times as surely on wire; on the lead with Chafe Gut a
      // Dusk Minnow takes at 0.35 of its float chance, never 0.
      const takes = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          d = window.__gw.debug,
          take = (sp, base) =>
            d.fishPoolRoll(1, { bait: "mireworm", preroll: { speciesId: sp, base } }).preroll;
        const chubPlain = take("likely_chub", 0.45);
        loop.fitPart("leader", "pike_wire");
        const chubWire = take("likely_chub", 0.45);
        const perchWire = take("mossback_perch", 0.45);
        loop.fitPart("leader", "plain_knot");
        const perchPlain = take("mossback_perch", 0.45);
        const minnowFloat = take("dusk_minnow", 0.45);
        loop.fitDepth("lead");
        loop.fitPart("leader", "chafe_gut");
        const minnowFloor = take("dusk_minnow", 0.45);
        loop.fitPart("leader", "plain_knot");
        loop.fitDepth("float");
        return { chubPlain, chubWire, perchPlain, perchWire, minnowFloat, minnowFloor };
      });
      check(
        near(takes.chubWire, takes.chubPlain * 0.7, 1e-9),
        `chub take ${takes.chubPlain} -> ${takes.chubWire}`,
      );
      check(
        takes.perchPlain > 0 && near(takes.perchWire, takes.perchPlain, 1e-9),
        `an untagged perch's take moved: ${JSON.stringify(takes)}`,
      );
      check(
        takes.minnowFloor > 0 && near(takes.minnowFloor, takes.minnowFloat * 0.35, 1e-9),
        `minnow take on the lead and gut ${takes.minnowFloor}, float ${takes.minnowFloat}`,
      );
      // 3. Guests (P7): the Veil Notebook's Rosefleck Trout (wary) at the inflow by day bites 0.7 times as often.
      await session.eval(() => {
        window.__gw.progression.loop.state().finds.got.veil_notebook = 1;
        window.__gw.player.teleport({ x: 54, z: 4 }, 0);
      });
      await session.pause(1500);
      const guest = await rollLeaders(session, ["plain_knot", "pike_wire"], { bait: "mireworm" });
      const odds = (p) => p / (1 - p),
        g0 = guest.plain_knot.shares.rosefleck_trout,
        g1 = guest.pike_wire.shares.rosefleck_trout;
      check(g0 > 0, `no Rosefleck Trout guest at ${guest.plain_knot.area}`);
      check(near(odds(g1), 0.7 * odds(g0), 1e-9), `guest share ${g0} -> ${g1}, expected odds x0.7`);
      // 4. A lure cast: the leader still counts.
      const lure = await session.eval(() => {
        const loop = window.__gw.progression.loop;
        window.__gw.player.teleport({ x: 0, z: 30 }, 0);
        loop.changeHook({ lure: "feather_fly" });
        return true;
      });
      await session.pause(1500);
      const lureRolls = await rollLeaders(session, ["plain_knot", "pike_wire"], {});
      await session.eval(() => window.__gw.progression.loop.changeHook({ lure: null, bait: "mireworm" }));
      check(lure && lureRolls.pike_wire.leader === "pike_wire", "no leader on the lure cast");
      const onLure = ratioCheck(
        lureRolls,
        "pike_wire",
        (id) => (WARY.includes(id) ? 0.7 : 1),
        "lure, Pike Wire",
      );
      // 5. Grip when landing: +4 for toothy fish on wire and rough mouths on gut, nothing else, never for her.
      const grip = await session.eval(() => {
        const parts = (id, leader) =>
          window.__gw.data.catchParts(
            id,
            "keeper",
            { hold: { rod: 5, line: 5, reel: 5 } },
            { strike: "clean", lake: "mossmere", leader },
          );
        const gain = (id, leader) => parts(id, leader).hold - parts(id, null).hold;
        const her = (leader) =>
          window.__gw.data.catchParts(
            "belled_matriarch",
            "legend",
            { hold: { rod: 5, line: 5, reel: 5 } },
            { strike: "clean", leader },
          ).hold;
        return {
          pikeWire: gain("reedjaw_pike", "pike_wire"),
          milkeyeWire: gain("milkeye_perch", "pike_wire"),
          carpGut: gain("weeping_carp", "chafe_gut"),
          carpWire: gain("weeping_carp", "pike_wire"),
          perchWire: gain("mossback_perch", "pike_wire"),
          pikeP: [parts("reedjaw_pike", null).p, parts("reedjaw_pike", "pike_wire").p],
          her: her("chafe_gut") - her(null),
        };
      });
      check(
        grip.pikeWire === 4 &&
          grip.milkeyeWire === 4 &&
          grip.carpGut === 4 &&
          grip.carpWire === 0 &&
          grip.perchWire === 0 &&
          grip.her === 0,
        `Grip: ${JSON.stringify(grip)}`,
      );
      check(grip.pikeP[1] > grip.pikeP[0], `a pike lands no more often on wire: ${grip.pikeP}`);
      return `bait: ${wary} wary and ${dainty} dainty kinds x0.7; lead floor 0.35; takes ${takes.chubPlain} -> ${takes.chubWire}; guest odds x0.7; lure ${onLure} kinds; Grip +4`;
    },
  },

  {
    name: "hook: on the Turnback Hook a self-setter's struck strike is clean (a hard take too) and a quick nibbler's clean is struck, on bait only",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withParts(["turnback_hook"], { hook: "turnback_hook" }),
    timeoutMs: 420_000,
    async run(session) {
      await session.sail(SLOW_SAIL);
      const grades = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          d = window.__gw.debug,
          set = (grade, speciesId) => d.fishHookSet({ grade, speciesId });
        const out = {
          carpStruck: set("struck", "weeping_carp"),
          pikeStruck: set("struck", "reedjaw_pike"),
          carpClean: set("clean", "weeping_carp"),
          carpEarly: set("early", "weeping_carp"),
          chubClean: set("clean", "likely_chub"),
          chubStruck: set("struck", "likely_chub"),
          perchStruck: set("struck", "mossback_perch"),
          perchClean: set("clean", "mossback_perch"),
        };
        loop.fitPart("hook", "mere_hook");
        out.mereCarp = set("struck", "weeping_carp");
        out.mereChub = set("clean", "likely_chub");
        loop.fitPart("hook", "turnback_hook");
        loop.changeHook({ lure: "feather_fly" });
        out.lureCarp = set("struck", "weeping_carp");
        out.lureChub = set("clean", "likely_chub");
        loop.changeHook({ lure: null, bait: "mireworm" });
        return out;
      });
      const want = {
        carpStruck: ["clean", "turnback_hook"],
        pikeStruck: ["clean", "turnback_hook"],
        carpClean: ["clean", "turnback_hook"],
        carpEarly: ["early", "turnback_hook"],
        chubClean: ["struck", "turnback_hook"],
        chubStruck: ["struck", "turnback_hook"],
        perchStruck: ["struck", "turnback_hook"],
        perchClean: ["clean", "turnback_hook"],
        mereCarp: ["struck", null],
        mereChub: ["clean", null],
        lureCarp: ["struck", null],
        lureChub: ["clean", null],
      };
      for (const [k, [grade, hook]] of Object.entries(want))
        check(
          grades[k]?.grade === grade && grades[k]?.hook === hook,
          `${k}: ${JSON.stringify(grades[k])}, expected ${grade} on ${hook}`,
        );
      // At the real strike: the debug hook strikes "struck", as a hard take does (Nn("struck", null, true)). On the
      // Turnback Hook a carp's strike becomes clean, with the word "Set itself".
      await session.eval(() => {
        window.__setItself = 0;
        window.__gw.bus.on("fishing:setItself", () => window.__setItself++);
      });
      const carp = await loseSmallFish(session, "weeping_carp");
      const seen = await session.eval(() => window.__setItself);
      check(
        carp?.grade === "clean" && seen === 1,
        `the carp on the Turnback: ${JSON.stringify({ grade: carp?.grade, seen })}`,
      );
      return `struck -> clean for carp and pike, clean -> struck for chub, nothing on the Mere Hook or a lure; a real carp strike clean`;
    },
  },

  {
    name: "tackle arrival: one piece a tally, the hook after its beat or on a quiet tally after the tin, the leaders after Hob's map and never Chafe Gut sooner, Pike Wire alone after a first pike",
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.boot();
      const r = await session.eval(() => {
        const g = window.__gw.data,
          arrive = g.rigArrivalAtTally,
          beat = g.noteArrivalBeat,
          loop = (parts = ["cork_float", "plain_knot", "mere_hook"], map = 0) => ({
            parts: [...parts],
            arrivals: { seq: 0, beats: { turnback_hook: 0, pike_wire: 0, leaders: 0 }, shelved: [] },
            hunt: { mossmere: { sketches: { map } } },
          }),
          tallies = (l, n, water = "mossmere") => Array.from({ length: n }, () => arrive(l, water));
        const out = {};
        // Nothing due and no tin yet: nothing. With the tin: the hook on the next quiet tally, then nothing.
        out.noTin = tallies(loop(), 2);
        let l = loop(["cork_float", "plain_knot", "mere_hook", "sounding_lead", "minnow_tin"]);
        out.quiet = tallies(l, 2);
        // A carp ran (the hook's beat) before Hob's map: the hook, then the leaders.
        l = loop();
        beat(l, "turnback_hook");
        l.hunt.mossmere.sketches.map = 3;
        out.hookThenLeaders = tallies(l, 3);
        // The map first, then a pike: both leaders together, and no Pike Wire alone after.
        l = loop();
        l.hunt.mossmere.sketches.map = 2;
        out.mapFirst = arrive(l, "mossmere");
        beat(l, "pike_wire");
        out.afterMap = arrive(l, "mossmere");
        out.mapShelf = [...l.arrivals.shelved];
        // A pike first: Pike Wire alone, and Chafe Gut only after the map, named alone.
        l = loop();
        beat(l, "pike_wire");
        out.pikeAlone = tallies(l, 3);
        out.gutWaits = l.arrivals.shelved.includes("chafe_gut");
        l.hunt.mossmere.sketches.map = 5;
        out.gutAfterMap = arrive(l, "mossmere");
        // A tie goes to the hook.
        l = loop();
        l.arrivals.beats = { turnback_hook: 4, pike_wire: 4, leaders: 4 };
        out.tie = tallies(l, 3);
        // Sporewood: its own Burl Hook on a quiet tally, never Mossmere's Turnback Hook.
        l = loop(["cork_float", "plain_knot", "mere_hook", "minnow_tin"]);
        beat(l, "turnback_hook");
        out.sporewood = arrive(l, "sporewood");
        return out;
      });
      const key = (a) => (a ? `${a.gift}:${a.giftSay}` : null);
      const seq = (list) => JSON.stringify(list.map(key));
      check(seq(r.noTin) === "[null,null]", `no tin: ${seq(r.noTin)}`);
      check(seq(r.quiet) === '["turnback_hook:quiet",null]', `quiet: ${seq(r.quiet)}`);
      check(
        seq(r.hookThenLeaders) === '["turnback_hook:beat","leaders:beat",null]',
        `hook beat then map: ${seq(r.hookThenLeaders)}`,
      );
      check(
        key(r.mapFirst) === "leaders:beat" && r.afterMap === null,
        `map first: ${key(r.mapFirst)}, then ${key(r.afterMap)}`,
      );
      check(
        JSON.stringify(r.mapShelf) === '["pike_wire","chafe_gut"]',
        `the shelf after the map: ${r.mapShelf}`,
      );
      check(
        seq(r.pikeAlone) === '["pike_wire:beat",null,null]' && !r.gutWaits,
        `pike first: ${seq(r.pikeAlone)}, gut ${r.gutWaits}`,
      );
      check(key(r.gutAfterMap) === "leaders:gutOnly", `the gut after the map: ${key(r.gutAfterMap)}`);
      check(seq(r.tie) === '["turnback_hook:beat","pike_wire:beat","leaders:gutOnly"]', `tie: ${seq(r.tie)}`);
      check(key(r.sporewood) === "burl_hook:quiet", `Sporewood: ${key(r.sporewood)}`);
      return "one a tally in beat order, a tie to the hook, the quiet hook after the tin, Chafe Gut only after the map";
    },
  },

  {
    name: "tackle arrival at the tally: the Turnback Hook on a quiet tally after the tin with Murk's line, then the leaders after Hob's map, on the shelf at 40 and 60, and kept after a reload",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withTin,
    timeoutMs: 720_000,
    async run(session, { page, browser }) {
      await session.sail(SLOW_SAIL);
      const before = await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        return {
          parts: [...s.parts],
          fitted: { ...s.fitted },
          arrivals: JSON.parse(JSON.stringify(s.arrivals)),
        };
      });
      check(
        before.parts.includes("plain_knot") &&
          before.parts.includes("mere_hook") &&
          before.fitted.leader === "plain_knot" &&
          before.fitted.hook === "mere_hook",
        `the old save did not gain the defaults: ${JSON.stringify(before)}`,
      );
      await session.catchFish("mossback_perch");
      const first = await tallyAndGift(session);
      check(
        first?.text.includes(HOOK_LINE) && first.text.includes("Turnback Hook"),
        `the first tally: ${JSON.stringify(first)}`,
      );
      // Hob's map is drawn (as his first talk does): at the next tally the leaders arrive.
      await session.eval(() => {
        const loop = window.__gw.progression.loop.state();
        loop.hunt.mossmere.sketches.map = loop.evenings;
        loop.hunt.mossmere.mapBy = "hob";
      });
      await session.sail(SLOW_SAIL);
      await session.catchFish("mossback_perch");
      const second = await tallyAndGift(session);
      check(
        second?.text.includes(LEADERS_LINE) && second.text.includes("Pike Wire and Chafe Gut"),
        `the second tally: ${JSON.stringify(second)}`,
      );
      const shelf = (s) =>
        s.eval(() =>
          (window.__gw.progression.loop.shelf().tabs.find((t) => t.id === "tackle")?.items || [])
            .filter((c) => c.id.startsWith("part:"))
            .map((c) => `${c.id}:${c.price}:${c.bought}`),
        );
      const cards = await shelf(session);
      check(
        JSON.stringify(cards) ===
          '["part:turnback_hook:40:false","part:pike_wire:60:false","part:chafe_gut:60:false"]',
        `the shelf: ${JSON.stringify(cards)}`,
      );
      const saved = await session.saved();
      const again = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await again.boot();
        await again.toHome();
        const kept = await shelf(again);
        check(JSON.stringify(kept) === JSON.stringify(cards), `after a reload: ${JSON.stringify(kept)}`);
        await again.collectGameErrors();
        check(!again.errors.length, `errors after reloading: ${again.errors.join("; ")}`);
      } finally {
        await again.close();
      }
      return `"${HOOK_LINE}" then "${LEADERS_LINE}"; ${cards.length} parts on the shelf, kept after a reload`;
    },
  },

  {
    name: "tackle screen: the Leader and Hook rows show only once there is a choice, fitting works, a bought part is fitted, and a lure carries its own hook",
    fixture: "mid-mossmere",
    debug: true,
    editSave: (save) => {
      withParts([])(save);
      save.meta.loop.arrivals = { seq: 1, beats: { turnback_hook: 1 }, shelved: ["turnback_hook"] };
    },
    async run(session) {
      await session.toHome();
      check(
        (await partRow(session, "leader")) === null && (await partRow(session, "hook")) === null,
        "a row with no choice",
      );
      await closeTackle(session);
      const bought = await session.eval(() => {
        const loop = window.__gw.progression.loop;
        window.__gw.debug.loop.giveClams(500);
        const r = loop.buy("part:turnback_hook");
        return { ok: r?.ok === true, fitted: loop.state().fitted.hook, parts: [...loop.state().parts] };
      });
      check(
        bought.ok && bought.fitted === "turnback_hook" && bought.parts.includes("turnback_hook"),
        `buying: ${JSON.stringify(bought)}`,
      );
      const row = await partRow(session, "hook");
      check(
        JSON.stringify(row?.chips) === '[{"key":"mere_hook","on":false},{"key":"turnback_hook","on":true}]' &&
          JSON.stringify(row.lines) ===
            JSON.stringify([
              "Fish that grab and run, such as carp, bass and pike, are always hooked clean.",
              "Quick nibblers, such as minnows and chub, are never hooked clean.",
            ]),
        `the Hook row: ${JSON.stringify(row)}`,
      );
      check((await partRow(session, "leader")) === null, "a Leader row with only the Plain Knot");
      // Pressing the Mere Hook fits it.
      await session.eval(() =>
        document.querySelector('.gw-rig-tray[data-part="hook"] .gw-rig-opt[data-key="mere_hook"]').click(),
      );
      await session.pause(800);
      const after = await session.eval(() => window.__gw.progression.loop.state().fitted.hook);
      const row2 = await partRow(session, "hook");
      check(
        after === "mere_hook" && row2?.chips[0]?.on === true,
        `after pressing the Mere Hook: ${after} ${JSON.stringify(row2)}`,
      );
      await closeTackle(session);
      // With a lure on, the Hook merges into the lure: no Hook part, and the lure's tray says why.
      await session.eval(() => window.__gw.progression.loop.changeHook({ lure: "feather_fly" }));
      const hookUnderLure = await partRow(session, "hook");
      const lureRow = await rigTray(session, "lure");
      await closeTackle(session);
      check(
        hookUnderLure === null && lureRow?.notes.includes("Lures carry their own hooks."),
        `with a lure: ${JSON.stringify({ hookUnderLure, lureRow })}`,
      );
      return "no rows with one option; the Hook row with both, its lines, a press fits; one line under a lure";
    },
  },

  {
    name: "loss words: once the part is on the shelf, a pike bitten through, a rough mouth worn through and a hard take that ran each say why on the default part, once a night",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    async run(session) {
      await session.sail(SLOW_SAIL);
      const r = await session.eval(() => {
        const g = window.__gw,
          loop = g.progression.loop,
          word = (speciesId, hardTake = false) => g.debug.fishLossWord({ speciesId, hardTake });
        const out = { before: [word("reedjaw_pike"), word("weeping_carp"), word("weeping_carp", true)] };
        loop.state().arrivals.shelved.push("pike_wire", "chafe_gut", "turnback_hook");
        out.pike = [word("reedjaw_pike"), word("reedjaw_pike"), word("milkeye_perch")];
        out.carp = [word("weeping_carp"), word("overbold_bass")];
        out.perch = word("mossback_perch", true);
        out.ran = [word("kissmark_trout", true), word("weeping_carp", true)];
        (g.state.run.flags ||= {}).partWords = {};
        loop.state().parts.push("pike_wire");
        loop.fitPart("leader", "pike_wire");
        out.onWire = [word("reedjaw_pike"), word("weeping_carp")];
        loop.fitPart("leader", "plain_knot");
        (g.state.run.flags ||= {}).partWords = {};
        loop.state().lures.includes("feather_fly") || loop.state().lures.push("feather_fly");
        loop.changeHook({ lure: "feather_fly" });
        out.lureRan = word("kissmark_trout", true);
        loop.changeHook({ lure: null, bait: "mireworm" });
        (g.state.run.flags ||= {}).partWords = {};
        return out;
      });
      check(JSON.stringify(r.before) === "[null,null,null]", `before the shelf: ${JSON.stringify(r.before)}`);
      check(
        r.pike[0] === LOSS_TEETH && r.pike[1] === null && r.pike[2] === null,
        `pike: ${JSON.stringify(r.pike)}`,
      );
      check(r.carp[0] === LOSS_LIPS && r.carp[1] === null, `carp: ${JSON.stringify(r.carp)}`);
      check(r.perch === null, `a perch said: ${r.perch}`);
      check(r.ran[0] === LOSS_RAN && r.ran[1] === null, `ran: ${JSON.stringify(r.ran)}`);
      check(r.onWire[0] === null && r.onWire[1] === null, `on Pike Wire: ${JSON.stringify(r.onWire)}`);
      check(r.lureRan === null, `on a lure: ${r.lureRan}`);
      // A real loss on the water: a pike lost on the Plain Knot carries the words and shows them by the float.
      const lost = await loseSmallFish(session, "reedjaw_pike");
      check(lost?.partLossText === LOSS_TEETH && !lost.overCap, `the pike's loss: ${JSON.stringify(lost)}`);
      return "each once a night, only with the part on the shelf, never on the better part or a lure";
    },
  },
  // ---- Sporewood's Leader and Hook parts (sporewood-plan.md "Tackle") ------------------------------------

  {
    name: "Sporewood's leaders: the Brass Trace and the Mossthread Snood shift bites by their tags on bait, on lures and in sign and sight takes, never to zero, and change Grip on toothy and rough fish; the Plain Knot's losses name the Brass Trace",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: withSporeParts(["brass_trace", "mossthread_snood"]),
    timeoutMs: 420_000,
    async run(session) {
      await session.sail(SLOW_SAIL);
      const LEADERS = ["plain_knot", "brass_trace", "mossthread_snood"];
      // 1. Pool rows, bait, by day: shy fish x0.7 on the trace and x1.4 on the snood; toothy and rough fish bite as
      // on the Plain Knot (their tags are Grip only). The crayfish has no tag.
      await session.eval(() => window.__gw.debug.setPhase("calm"));
      const bait = await rollLeaders(session, LEADERS, { bait: "spore_cake" });
      check(
        bait.brass_trace.leader === "brass_trace" && bait.plain_knot.leader === null,
        `the leader did not fish: ${bait.brass_trace.leader}`,
      );
      const shy = (mult) => (id) => (SPORE_SHY.includes(id) ? mult : 1);
      const onTrace = leaderRatios(bait, "brass_trace", "capshell_crayfish", shy(0.7), "bait, Brass Trace");
      const onSnood = leaderRatios(bait, "mossthread_snood", "capshell_crayfish", shy(1.4), "bait, Snood");
      // 2. Sign and sight takes: a prerolled barb takes 0.7 times as surely on the trace and 1.4 times on the snood
      // (raised, never past 0.9); an untagged crayfish's take does not move.
      const takes = await session.eval((LEADERS) => {
        const loop = window.__gw.progression.loop,
          d = window.__gw.debug,
          take = (sp) =>
            d.fishPoolRoll(1, { bait: "spore_cake", preroll: { speciesId: sp, base: 0.45 } }).preroll,
          out = {};
        for (const id of LEADERS) {
          loop.fitPart("leader", id);
          out[id] = { barb: take("falsesmile_barb"), cray: take("capshell_crayfish") };
        }
        loop.fitPart("leader", "plain_knot");
        return out;
      }, LEADERS);
      const p0 = takes.plain_knot;
      check(
        p0.barb > 0 &&
          near(takes.brass_trace.barb, p0.barb * 0.7, 1e-9) &&
          near(takes.mossthread_snood.barb, Math.min(0.9, p0.barb * 1.4), 1e-9) &&
          near(takes.brass_trace.cray, p0.cray, 1e-9) &&
          near(takes.mossthread_snood.cray, p0.cray, 1e-9),
        `sign takes: ${JSON.stringify(takes)}`,
      );
      // 3. A lure cast at dusk (the Spore Moth): the leader still counts. The Plumgill Perch has no leader tag.
      await session.eval(() => {
        window.__gw.debug.setPhase("dusk");
        window.__gw.progression.loop.changeHook({ lure: "spore_moth" });
      });
      const lure = await rollLeaders(session, LEADERS, {});
      await session.eval(() => window.__gw.progression.loop.changeHook({ lure: null, bait: "spore_cake" }));
      const lureTrace = leaderRatios(lure, "brass_trace", "plumgill_perch", shy(0.7), "lure, Brass Trace");
      leaderRatios(lure, "mossthread_snood", "plumgill_perch", shy(1.4), "lure, Snood");
      // 4. Grip when landing: +4 for toothy and rough fish on the trace, -4 for toothy fish on the snood.
      const grip = await session.eval(() => {
        const parts = (id, leader) =>
          window.__gw.data.catchParts(
            id,
            "keeper",
            { hold: { rod: 5, line: 5, reel: 5 } },
            { strike: "clean", lake: "sporewood", leader },
          );
        const gain = (id, leader) => parts(id, leader).hold - parts(id, null).hold;
        return {
          puffTrace: gain("sporebelly_puffer", "brass_trace"),
          puffSnood: gain("sporebelly_puffer", "mossthread_snood"),
          catTrace: gain("cindertail_catfish", "brass_trace"),
          catSnood: gain("cindertail_catfish", "mossthread_snood"),
          eelTrace: gain("threadling_eel", "brass_trace"),
          barbTrace: gain("falsesmile_barb", "brass_trace"),
          barbSnood: gain("falsesmile_barb", "mossthread_snood"),
          crayTrace: gain("capshell_crayfish", "brass_trace"),
          puffP: ["mossthread_snood", null, "brass_trace"].map((l) => parts("sporebelly_puffer", l).p),
        };
      });
      check(
        grip.puffTrace === 4 &&
          grip.puffSnood === -4 &&
          grip.catTrace === 4 &&
          grip.catSnood === 0 &&
          grip.eelTrace === 4 &&
          grip.barbTrace === 0 &&
          grip.barbSnood === 0 &&
          grip.crayTrace === 0 &&
          grip.puffP[0] < grip.puffP[1] &&
          grip.puffP[1] < grip.puffP[2],
        `Grip: ${JSON.stringify(grip)}`,
      );
      // 5. On the Plain Knot, with the Brass Trace owned, a puffer and a catfish lost say so, once a night each;
      // on the trace or the snood nothing is said.
      const words = await session.eval(() => {
        const g = window.__gw,
          loop = g.progression.loop,
          word = (speciesId) => g.debug.fishLossWord({ speciesId });
        const out = {
          knot: [word("sporebelly_puffer"), word("cindertail_catfish"), word("lostsea_mackerel")],
        };
        (g.state.run.flags ||= {}).partWords = {};
        loop.fitPart("leader", "mossthread_snood");
        out.snood = [word("sporebelly_puffer"), word("cindertail_catfish")];
        loop.fitPart("leader", "plain_knot");
        out.cray = word("capshell_crayfish");
        (g.state.run.flags ||= {}).partWords = {};
        return out;
      });
      check(
        sameJson(words.knot, [SPORE_LOSS_TEETH, SPORE_LOSS_LIPS, null]) &&
          sameJson(words.snood, [null, null]) &&
          words.cray === null,
        `loss words: ${JSON.stringify(words)}`,
      );
      return `bait: ${onTrace} shy kinds x0.7 on the trace, ${onSnood} x1.4 on the snood; takes ${p0.barb} -> ${takes.brass_trace.barb} / ${takes.mossthread_snood.barb}; lure ${lureTrace} kinds; Grip +4 / -4`;
    },
  },

  {
    name: "Burl Hook: in Sporewood a self-setter's struck strike is clean (a hard take too) and a quick nibbler's clean is struck, on bait only; a hard take lost on the Mere Hook names it",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: withSporeParts(["burl_hook"], { hook: "burl_hook" }),
    timeoutMs: 420_000,
    async run(session) {
      await session.sail(SLOW_SAIL);
      const grades = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          d = window.__gw.debug,
          set = (grade, speciesId) => d.fishHookSet({ grade, speciesId });
        const out = {
          catStruck: set("struck", "cindertail_catfish"),
          eelStruck: set("struck", "threadling_eel"),
          koiStruck: set("struck", "hushcap_koi"),
          catClean: set("clean", "cindertail_catfish"),
          catEarly: set("early", "cindertail_catfish"),
          fryClean: set("clean", "netcloud_fry"),
          puffClean: set("clean", "sporebelly_puffer"),
          fryStruck: set("struck", "netcloud_fry"),
          giantStruck: set("struck", "festival_puffer"),
        };
        loop.fitPart("hook", "mere_hook");
        out.mereCat = set("struck", "cindertail_catfish");
        out.mereFry = set("clean", "netcloud_fry");
        loop.fitPart("hook", "burl_hook");
        loop.changeHook({ lure: "spore_moth" });
        out.lureCat = set("struck", "cindertail_catfish");
        out.lureFry = set("clean", "netcloud_fry");
        loop.changeHook({ lure: null, bait: "spore_cake" });
        return out;
      });
      const want = {
        catStruck: ["clean", "burl_hook"],
        eelStruck: ["clean", "burl_hook"],
        koiStruck: ["clean", "burl_hook"],
        catClean: ["clean", "burl_hook"],
        catEarly: ["early", "burl_hook"],
        fryClean: ["struck", "burl_hook"],
        puffClean: ["struck", "burl_hook"],
        fryStruck: ["struck", "burl_hook"],
        giantStruck: ["struck", "burl_hook"],
        mereCat: ["struck", null],
        mereFry: ["clean", null],
        lureCat: ["struck", null],
        lureFry: ["clean", null],
      };
      for (const [k, [grade, hook]] of Object.entries(want))
        check(
          grades[k]?.grade === grade && grades[k]?.hook === hook,
          `${k}: ${JSON.stringify(grades[k])}, expected ${grade} on ${hook}`,
        );
      // At the real strike (the debug hook strikes "struck", as a hard take does), a catfish's strike becomes
      // clean on the Burl Hook, with the word "Set itself".
      await session.eval(() => {
        window.__setItself = 0;
        window.__gw.bus.on("fishing:setItself", () => window.__setItself++);
      });
      const cat = await loseSmallFish(session, "cindertail_catfish");
      const seen = await session.eval(() => window.__setItself);
      check(
        cat?.grade === "clean" && seen === 1,
        `the catfish: ${JSON.stringify({ grade: cat?.grade, seen })}`,
      );
      // On the Mere Hook, with the Burl Hook owned, a hard take that ran says so, once a night.
      const ran = await session.eval(() => {
        const g = window.__gw;
        (g.state.run.flags ||= {}).partWords = {};
        g.progression.loop.fitPart("hook", "mere_hook");
        const out = [
          g.debug.fishLossWord({ speciesId: "downcast_catfish", hardTake: true }),
          g.debug.fishLossWord({ speciesId: "velvet_ray", hardTake: true }),
          g.debug.fishLossWord({ speciesId: "netcloud_fry", hardTake: true }),
        ];
        g.progression.loop.fitPart("hook", "burl_hook");
        return out;
      });
      check(sameJson(ran, [SPORE_LOSS_RAN, null, null]), `the loss words: ${JSON.stringify(ran)}`);
      return "struck -> clean for catfish, eel and koi, clean -> struck for fry and puffer, nothing on the Mere Hook or a lure; a real strike clean";
    },
  },

  {
    name: "tackle arrival in Sporewood: one piece a tally, the Burl Hook, the Brass Trace and the Mossthread Snood on quiet tallies in that order; a toothy fish brings the trace sooner and a catfish that ran the hook; never Mossmere's parts",
    fixture: "sporewood-crossed",
    debug: true,
    timeoutMs: 420_000,
    async run(session) {
      await session.boot();
      const r = await session.eval(() => {
        const g = window.__gw.data,
          arrive = g.rigArrivalAtTally,
          beat = g.noteArrivalBeat,
          loop = (parts = []) => ({
            parts: ["cork_float", "plain_knot", "mere_hook", ...parts],
            arrivals: { seq: 0, beats: {}, shelved: [] },
            hunt: {},
          }),
          tallies = (l, n, water = "sporewood") => Array.from({ length: n }, () => arrive(l, water));
        const out = {};
        let l = loop();
        out.quiet = tallies(l, 4);
        out.shelf = [...l.arrivals.shelved];
        // A toothy fish first: the trace, then the hook and the snood.
        l = loop();
        beat(l, "brass_trace");
        out.traceFirst = tallies(l, 4);
        // A catfish ran, then a puffer: the hook, then the trace (their beats' order), then the snood.
        l = loop();
        beat(l, "burl_hook");
        beat(l, "brass_trace");
        out.beats = tallies(l, 4);
        // One owned already is skipped.
        l = loop(["brass_trace"]);
        out.owned = tallies(l, 3);
        // Mossmere's beats bring nothing here, and Sporewood's nothing to Mossmere.
        l = loop();
        beat(l, "turnback_hook");
        beat(l, "pike_wire");
        out.mossBeats = arrive(l, "sporewood");
        l = loop(["minnow_tin"]);
        beat(l, "brass_trace");
        out.inMossmere = tallies(l, 2, "mossmere");
        out.mossShelf = [...l.arrivals.shelved];
        // A new game's record has every lake's beats.
        out.fresh = Object.keys(window.__gw.progression.loop.state().arrivals.beats);
        return out;
      });
      const key = (a) => (a ? `${a.gift}:${a.giftSay}` : null);
      const seq = (list) => JSON.stringify(list.map(key));
      check(
        seq(r.quiet) === '["burl_hook:quiet","brass_trace:quiet","mossthread_snood:quiet",null]' &&
          sameJson(r.shelf, ["burl_hook", "brass_trace", "mossthread_snood"]),
        `quiet: ${seq(r.quiet)}, shelf ${r.shelf}`,
      );
      check(
        seq(r.traceFirst) === '["brass_trace:beat","burl_hook:quiet","mossthread_snood:quiet",null]',
        `a toothy fish first: ${seq(r.traceFirst)}`,
      );
      check(
        seq(r.beats) === '["burl_hook:beat","brass_trace:beat","mossthread_snood:quiet",null]',
        `two beats: ${seq(r.beats)}`,
      );
      check(seq(r.owned) === '["burl_hook:quiet","mossthread_snood:quiet",null]', `owned: ${seq(r.owned)}`);
      check(key(r.mossBeats) === "burl_hook:quiet", `Mossmere's beats in Sporewood: ${key(r.mossBeats)}`);
      check(
        seq(r.inMossmere) === '["turnback_hook:quiet",null]' && sameJson(r.mossShelf, ["turnback_hook"]),
        `Sporewood's beat in Mossmere: ${seq(r.inMossmere)}, ${r.mossShelf}`,
      );
      check(
        sameJson(r.fresh, [
          "turnback_hook",
          "pike_wire",
          "leaders",
          "burl_hook",
          "brass_trace",
          "mossthread_snood",
        ]),
        `a new game's beats: ${r.fresh}`,
      );
      // On the water: a Sporebelly Puffer landed is the trace's beat, a catfish that ran before the hook was set
      // (struck, on the Mere Hook) the hook's.
      await session.sail(SLOW_SAIL);
      await session.catchFish("sporebelly_puffer");
      await loseSmallFish(session, "cindertail_catfish");
      const beats = await session.eval(() => ({ ...window.__gw.progression.loop.state().arrivals.beats }));
      check(
        beats.brass_trace > 0 && beats.burl_hook > beats.brass_trace && !beats.mossthread_snood,
        `the beats on the water: ${JSON.stringify(beats)}`,
      );
      return "quiet: hook, trace, snood; a beat first goes first; Mossmere's and Sporewood's beats stay in their own lake";
    },
  },

  {
    name: "tackle arrival at a Sporewood tally: the Brass Trace after a puffer with Murk's line, the Burl Hook on the next quiet tally, then the Mossthread Snood; on the shelf at 230, 150 and 230, and kept after a reload",
    fixture: "sporewood-crossed",
    debug: true,
    timeoutMs: 900_000,
    async run(session, { page, browser }) {
      await session.sail(SLOW_SAIL);
      await session.catchFish("sporebelly_puffer");
      const first = await tallyAndGift(session);
      check(
        first?.text.includes(TRACE_ARRIVAL) && first.text.includes("Brass Trace"),
        `the first tally: ${JSON.stringify(first)}`,
      );
      await session.sail(SLOW_SAIL);
      await session.catchFish("netcloud_fry");
      const second = await tallyAndGift(session);
      check(
        second?.text.includes(BURL_ARRIVAL) && second.text.includes("Burl Hook"),
        `the second tally: ${JSON.stringify(second)}`,
      );
      await session.sail(SLOW_SAIL);
      await session.catchFish("netcloud_fry");
      const third = await tallyAndGift(session);
      check(
        third?.text.includes(SNOOD_ARRIVAL) && third.text.includes("Mossthread Snood"),
        `the third tally: ${JSON.stringify(third)}`,
      );
      const shelf = (s) =>
        s.eval(() =>
          (window.__gw.progression.loop.shelf().tabs.find((t) => t.id === "tackle")?.items || [])
            .filter((c) => c.id.startsWith("part:"))
            .map((c) => `${c.id}:${c.price}:${c.bought}`),
        );
      const cards = await shelf(session);
      check(
        sameJson(cards, [
          "part:brass_trace:230:false",
          "part:burl_hook:150:false",
          "part:mossthread_snood:230:false",
        ]),
        `the shelf: ${JSON.stringify(cards)}`,
      );
      // A fourth tally brings nothing new.
      await session.sail(SLOW_SAIL);
      await session.catchFish("netcloud_fry");
      const fourth = await tallyAndGift(session);
      check(fourth === null, `the fourth tally: ${JSON.stringify(fourth)}`);
      const saved = await session.saved();
      const again = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await again.boot();
        await again.toHome();
        const kept = await shelf(again);
        check(sameJson(kept, cards), `after a reload: ${JSON.stringify(kept)}`);
        await again.collectGameErrors();
        check(!again.errors.length, `errors after reloading: ${again.errors.join("; ")}`);
      } finally {
        await again.close();
      }
      return `"${TRACE_ARRIVAL}", "${BURL_ARRIVAL}", "${SNOOD_ARRIVAL}"; ${cards.length} parts on the shelf, kept after a reload`;
    },
  },

  {
    name: "tackle screen in Sporewood: the Leader and Hook rows show once there is a choice, fitting works, a bought part is fitted, and the rig picture draws the brass trace, the green snood and the dark burl hook",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: (save) => {
      withSporeParts([])(save);
      save.meta.loop.arrivals = { seq: 0, beats: {}, shelved: [...SPORE_PARTS] };
    },
    async run(session) {
      await session.toHome();
      check(
        (await partRow(session, "leader")) === null && (await partRow(session, "hook")) === null,
        "a row with no choice",
      );
      await closeTackle(session);
      const buy = (id) =>
        session.eval((id) => {
          const loop = window.__gw.progression.loop;
          window.__gw.debug.loop.giveClams(500);
          const r = loop.buy(`part:${id}`);
          return { ok: r?.ok === true, fitted: { ...loop.state().fitted }, parts: [...loop.state().parts] };
        }, id);
      // The rig picture's end tackle: which looks it draws.
      const looks = async () => {
        await rigScreen(session);
        const drawn = await session.eval(() => {
          const card = document.querySelector(".gw-rig");
          const has = (sel) => !!card?.querySelector(sel);
          return {
            trace: has(".gw-rig-trace") && has(".gw-rig-crimp"),
            snood: has(".gw-rig-snood"),
            burl: has(".gw-rig-burl") && has(".gw-rig-burl-knot"),
            wire: has(".gw-rig-wire"),
            gut: has(".gw-rig-gut"),
            knot: has(".gw-rig-knot"),
          };
        });
        await closeTackle(session);
        return drawn;
      };
      const trace = await buy("brass_trace");
      check(trace.ok && trace.fitted.leader === "brass_trace", `buying the trace: ${JSON.stringify(trace)}`);
      const row = await partRow(session, "leader");
      check(
        sameJson(row?.chips, [
          { key: "plain_knot", on: false },
          { key: "brass_trace", on: true },
        ]) && sameJson(row.lines, TRACE_LINES),
        `the Leader row: ${JSON.stringify(row)}`,
      );
      await closeTackle(session);
      const drawnTrace = await looks();
      check(
        drawnTrace.trace && !drawnTrace.snood && !drawnTrace.wire && !drawnTrace.gut && !drawnTrace.knot,
        `the trace drawn: ${JSON.stringify(drawnTrace)}`,
      );
      const snood = await buy("mossthread_snood");
      const row2 = await partRow(session, "leader");
      check(
        snood.fitted.leader === "mossthread_snood" &&
          row2?.chips.length === 3 &&
          row2.chips[2].on &&
          sameJson(row2.lines, SNOOD_LINES),
        `the snood: ${JSON.stringify({ snood, row2 })}`,
      );
      await closeTackle(session);
      const drawnSnood = await looks();
      check(drawnSnood.snood && !drawnSnood.trace, `the snood drawn: ${JSON.stringify(drawnSnood)}`);
      const burl = await buy("burl_hook");
      const hookRow = await partRow(session, "hook");
      check(
        burl.fitted.hook === "burl_hook" &&
          sameJson(hookRow?.chips, [
            { key: "mere_hook", on: false },
            { key: "burl_hook", on: true },
          ]) &&
          sameJson(hookRow.lines, BURL_LINES),
        `the Hook row: ${JSON.stringify({ burl, hookRow })}`,
      );
      await closeTackle(session);
      const drawnBurl = await looks();
      check(drawnBurl.burl && drawnBurl.snood, `the burl hook drawn: ${JSON.stringify(drawnBurl)}`);
      // Pressing the Mere Hook and the Plain Knot fits them, and the plain look comes back.
      await partRow(session, "hook");
      await session.eval(() =>
        document.querySelector('.gw-rig-tray[data-part="hook"] .gw-rig-opt[data-key="mere_hook"]').click(),
      );
      await session.pause(800);
      await closeTackle(session);
      await partRow(session, "leader");
      await session.eval(() =>
        document.querySelector('.gw-rig-tray[data-part="leader"] .gw-rig-opt[data-key="plain_knot"]').click(),
      );
      await session.pause(800);
      await closeTackle(session);
      const fitted = await session.eval(() => ({ ...window.__gw.progression.loop.state().fitted }));
      const plain = await looks();
      check(
        fitted.hook === "mere_hook" &&
          fitted.leader === "plain_knot" &&
          plain.knot &&
          !plain.burl &&
          !plain.snood,
        `back to plain: ${JSON.stringify({ fitted, plain })}`,
      );
      // With a lure on, the Hook merges into the lure.
      await session.eval(() => window.__gw.progression.loop.changeHook({ lure: "seedpod_twirl" }));
      const hookUnderLure = await partRow(session, "hook");
      const lureRow = await rigTray(session, "lure");
      await closeTackle(session);
      check(
        hookUnderLure === null && lureRow?.notes.includes("Lures carry their own hooks."),
        `with a lure: ${JSON.stringify({ hookUnderLure, lureRow })}`,
      );
      return "no rows with one option; each bought part fitted with its lines and its own look; a press fits; one line under a lure";
    },
  },

  {
    name: "practice orders in Sporewood: its board posts only its own parts' orders, the Burl Hook's and the Mossthread Snood's, naming a fish each truly helps, in Murk's words; the right fish on the part fills it and pays double",
    fixture: "sporewood-crossed",
    debug: true,
    timeoutMs: 600_000,
    editSave(save) {
      withSporeParts(["burl_hook", "mossthread_snood"], { hook: "burl_hook" })(save);
      save.meta.loop.home.orders = 1;
      save.meta.loop.practice = { filled: [], ready: ["burl_hook", "mossthread_snood"] };
    },
    async run(session) {
      await session.boot();
      await practiceKit(session);
      const r = await session.eval(
        (ALL) => {
          const P = window.__practice,
            D = P.D,
            seeded = P.rng(777),
            posted = {},
            texts = new Set();
          let rig = 0;
          for (let k = 0; k < 300; k++) {
            const l = P.loop({ board: 1, parts: ALL });
            P.refill(l, seeded, "sporewood");
            for (const o of l.orders.filter((o) => o.kind === "rig")) {
              rig++;
              posted[`${o.part}:${o.speciesId}`] = (posted[`${o.part}:${o.speciesId}`] || 0) + 1;
              texts.add(D.orderLine(D, [o]).line);
              texts.add(D.orderBoardText(D, o));
            }
          }
          return { rig, posted, texts: [...texts].sort() };
        },
        [...PRACTICE_PARTS, "burl_hook", "mossthread_snood"],
      );
      const allowed = new Set([
        "burl_hook:cindertail_catfish",
        "burl_hook:threadling_eel",
        "mossthread_snood:falsesmile_barb",
        "mossthread_snood:hushcap_koi",
      ]);
      check(
        r.rig > 60 && r.rig < 240 && Object.keys(r.posted).every((k) => allowed.has(k)),
        `Sporewood's practice orders: ${JSON.stringify(r)}`,
      );
      check(
        Object.keys(r.posted).some((k) => k.startsWith("burl_hook:")) &&
          Object.keys(r.posted).some((k) => k.startsWith("mossthread_snood:")),
        `both parts post: ${JSON.stringify(r.posted)}`,
      );
      const WORDS = [
        "A Cindertail Catfish, caught on the Burl Hook.",
        "Bring me a Cindertail Catfish, caught on the Burl Hook.",
        "A Falsesmile Barb, caught on the Mossthread Snood.",
        "Bring me a Falsesmile Barb, caught on the Mossthread Snood.",
      ];
      for (const w of WORDS) check(r.texts.includes(w), `"${w}" is not said: ${JSON.stringify(r.texts)}`);
      // On the water: the board holds the Burl Hook's order; a catfish on the Burl Hook fills it at the tally.
      await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        s.orders = [
          {
            id: "ord_practice_cat",
            speciesId: "cindertail_catfish",
            kind: "rig",
            n: 1,
            have: 0,
            part: "burl_hook",
            rig: { hook: "burl_hook" },
            water: "sporewood",
            said: true,
          },
        ];
      });
      await session.sail(SLOW_SAIL);
      const landed = await hookAndPlayOut(session, "cindertail_catfish", "land", { z: 0 });
      check(landed.landed === "cindertail_catfish", `the catfish was not landed: ${JSON.stringify(landed)}`);
      check(await session.clickButton(/^\d?Keep\b/), "no Keep on the catfish's card");
      await session.pause(800);
      await session.closeGuides(8000);
      const rec = await session.eval(() =>
        window.__gw.state.run.creel.find((f) => f.speciesId === "cindertail_catfish"),
      );
      check(rec?.castRig?.hook === "burl_hook", `the catfish's record: ${JSON.stringify(rec?.castRig)}`);
      await session.goHomeAndTally();
      const after = await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        return {
          line: s.lastTrip.lines.find((l) => l.speciesId === "cindertail_catfish"),
          filled: [...s.practice.filled],
          board: s.orders.map((o) => o.id),
        };
      });
      check(
        after.line?.order &&
          after.line.clams === after.line.base * 2 &&
          sameJson(after.filled, ["burl_hook"]),
        `after the tally: ${JSON.stringify(after)}`,
      );
      return `${r.rig} practice orders in 300 refills: ${Object.keys(r.posted).join(", ")}; paid ${after.line.clams} for ${after.line.base}`;
    },
  },

  {
    name: "signs on the water in Sporewood: rises, swirls, nervous water and sighted fish come up by day, at dusk and at night, each made only by a Sporewood fish that bites there and then",
    fixture: "sporewood-crossed",
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      await session.sail(SLOW_SAIL);
      await session.eval(() => {
        const g = window.__gw,
          loop = g.progression.loop;
        g.debug.loop.giveClams(9000);
        loop.buy("place:veilwater");
        loop.markLifted("veilwater");
      });
      const r = {};
      for (const phase of ["calm", "dusk", "gloomtide"])
        r[phase] = await session.eval((phase) => {
          const d = window.__gw.debug,
            SPORE = new Set(
              window.__gw.data.SPECIES.filter((sp) => sp.zone === "sporewood").map((sp) => sp.id),
            );
          d.setPhase(phase);
          d.fishSeed(1124);
          const out = { forms: {}, makers: {}, sighted: {}, bad: [], n: 0 };
          for (let x = -108; x <= 108; x += 8)
            for (let z = -66; z <= 66; z += 8) {
              const at = d.fishSignPool({ x, z });
              if (!at?.area) continue;
              const s = d.sign(null, { x, z });
              if (!s) continue;
              out.n++;
              const form = `${s.kind}/${s.form}`;
              out.forms[form] = (out.forms[form] || 0) + 1;
              const pre = d.fishSigns().find((f) => f.id === s.id)?.preroll?.speciesId ?? null;
              const live = (s.makers || []).filter((id) => at.pool[id] > 0);
              for (const id of pre ? [pre] : live) out.makers[id] = (out.makers[id] || 0) + 1;
              const notOurs = (s.makers || []).filter((id) => !SPORE.has(id));
              if (s.kind !== "gas" && (!live.length || notOurs.length || (pre && !(at.pool[pre] > 0))))
                out.bad.push({ form, area: at.area, makers: s.makers, pre });
              if (["margin", "pads", "stones", "reeds", "inflow", "lullaby"].includes(at.area)) {
                const f = d.sight(null, { x, z });
                if (f) {
                  out.sighted[f.speciesId] = (out.sighted[f.speciesId] || 0) + 1;
                  (!SPORE.has(f.speciesId) || !(at.pool[f.speciesId] > 0)) &&
                    out.bad.push({ sight: f.speciesId, area: at.area });
                }
                d.sightClear();
              }
            }
          return out;
        }, phase);
      for (const [phase, v] of Object.entries(r)) check(!v.bad.length, `${phase}: ${JSON.stringify(v.bad)}`);
      const has = (phase, ids) => ids.every((id) => r[phase].makers[id] > 0);
      const never = (phase, ids) => ids.every((id) => !r[phase].makers[id] && !r[phase].sighted[id]);
      check(
        has("calm", ["netcloud_fry", "falsesmile_barb", "cindertail_catfish", "velvet_ray"]) &&
          never("calm", ["plumgill_perch", "hushcap_koi", "mildew_angler", "nightbloom_carp"]),
        `by day: ${JSON.stringify(r.calm)}`,
      );
      check(
        has("dusk", ["netcloud_fry", "falsesmile_barb", "plumgill_perch", "downcast_catfish"]) &&
          never("dusk", ["hushcap_koi", "mildew_angler", "nightbloom_carp"]),
        `at dusk: ${JSON.stringify(r.dusk)}`,
      );
      check(
        has("gloomtide", ["netcloud_fry", "plumgill_perch", "hushcap_koi", "mildew_angler"]) &&
          never("gloomtide", [
            "falsesmile_barb",
            "sporebelly_puffer",
            "lostsea_mackerel",
            "downcast_catfish",
          ]),
        `at night: ${JSON.stringify(r.gloomtide)}`,
      );
      check(
        r.calm.sighted.netcloud_fry > 0 &&
          r.calm.sighted.falsesmile_barb > 0 &&
          r.calm.sighted.capshell_crayfish > 0 &&
          r.gloomtide.sighted.plumgill_perch > 0,
        `sighted fish: ${JSON.stringify({ day: r.calm.sighted, night: r.gloomtide.sighted })}`,
      );
      for (const phase of ["calm", "dusk", "gloomtide"])
        check(
          Object.keys(r[phase].forms).length >= 7,
          `${phase}: few kinds of sign: ${JSON.stringify(r[phase].forms)}`,
        );
      return Object.entries(r)
        .map(
          ([p, v]) =>
            `${p}: ${v.n} signs of ${Object.keys(v.forms).length} kinds by ${Object.keys(v.makers).length} fish, ${Object.keys(v.sighted).length} kinds sighted`,
        )
        .join("; ");
    },
  },
  // ---- the thief's tries, refusals and losses (mossmere-hunt-2.md section 2, B3) -------------------------

  {
    name: "her tries: three a night, counted only on a rig that could bring her; her time then closes for the night",
    fixture: "legend-sold",
    // Her hunt is not over: she has never been landed in this copy of the save.
    editSave: unsold(),
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await fitHerParts(session, { depth: "lead" });
      await session.sail();
      await atNight(session, MIDNIGHT_AT + 5, { evening: 4 });
      const miss = (bait) => herCast(session, { bait, u: 0.9 });
      // Never a try: Pike Wire, the Cork Float, a bait she never takes, a lure.
      const none = [];
      await herRig(session, { leader: "pike_wire" });
      none.push(await miss("live_minnow"));
      await herRig(session, { leader: "chafe_gut", depth: "float" });
      none.push(await miss("live_minnow"));
      await herRig(session, { depth: "lead" });
      none.push(await miss("mireworm"));
      await herRig(session, { lure: "bent_spoon" });
      none.push(await miss("live_minnow"));
      await herRig(session, { lure: null });
      check(
        none.every((a) => a && a.tried === false && a.tries === 0 && a.open === true),
        `a wrong rig used a try: ${JSON.stringify(none)}`,
      );
      // On the right rig every cast is a try, whether her roll comes or not, the Worm Bunch's too.
      const t = [await miss("live_minnow"), await miss("heartmoss"), await miss("live_minnow")];
      check(
        t.map((a) => `${a?.tried}:${a?.tries}:${a?.open}`).join(" ") ===
          "true:1:true true:2:true true:3:false",
        `the three tries: ${JSON.stringify(t)}`,
      );
      // Then her time is closed for the night: no take, no refusal, nothing.
      const after = await herCast(session, { bait: "live_minnow", u: 0 });
      check(after === null, `a cast after her three tries: ${JSON.stringify(after)}`);
      const roll = await session.eval(() =>
        window.__gw.debug.fishLegendRoll({ place: "bell_pool", bait: "live_minnow", rolls: 50 }),
      );
      check(roll && roll.may === false && roll.takes === 0, `after her tries: ${JSON.stringify(roll)}`);
      // A new night brings three more, and the first can bring her.
      await atNight(session, MIDNIGHT_AT + 5, { evening: 5 });
      const fresh = await herCast(session, { bait: "live_minnow", u: 0 });
      check(fresh?.take === true && fresh.tries === 1, `the next night: ${JSON.stringify(fresh)}`);
      return `wrong rigs used none; three tries then closed; the next night took on try 1`;
    },
  },

  {
    name: "her refusals: a lure, the Cork Float, a bait she won't take, the Worm Bunch's weak half and Pike Wire each swirl with their own line once a night and use no try; the first draws sketch 4",
    fixture: "legend-sold",
    // Her hunt is not over: she has never been landed in this copy of the save.
    editSave: unsold(),
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await fitHerParts(session, { depth: "lead" });
      await session.sail();
      await atNight(session, MIDNIGHT_AT + 5, { evening: 4 });
      check((await huntOf(session)).sketches.swirl === 0, "sketch 4 is drawn before any refusal");
      const said = [];
      const cast = async (rig, bait, u, expect) => {
        await herRig(session, rig);
        const a = await herCast(session, { bait, u });
        said.push(a?.said ?? null);
        check(
          a && a.part === expect.part && a.said === expect.said && a.take === false,
          `${JSON.stringify(rig)} ${bait}: ${JSON.stringify(a)}, expected ${JSON.stringify(expect)}`,
        );
        return a;
      };
      // The first refusal draws sketch 4, with the lure's words.
      await cast({ lure: "bent_spoon" }, "live_minnow", 0, { part: "lure", said: DRAWN_SWIRL });
      const drawn = await huntOf(session);
      check(
        drawn.sketches.swirl === 4 && drawn.swirlKind === "lure" && drawn.padUnseen.includes("swirl"),
        `sketch 4: ${JSON.stringify({ s: drawn.sketches, k: drawn.swirlKind, u: drawn.padUnseen })}`,
      );
      // Each part's own line, once a night.
      await cast({ lure: "bent_spoon" }, "live_minnow", 0, { part: "lure", said: REFUSE_LURE });
      await cast({ lure: "bent_spoon" }, "live_minnow", 0, { part: "lure", said: null });
      await cast({ lure: null, depth: "float" }, "live_minnow", 0, {
        part: "depth",
        said: REFUSE_FLOAT_LIVE,
      });
      await cast({ depth: "lead" }, "mireworm", 0, { part: "bait", said: REFUSE_BAIT });
      const bunch = await cast({}, "heartmoss", 0.2, { part: "bunch", said: REFUSE_BUNCH });
      await cast({ leader: "pike_wire" }, "live_minnow", 0, { part: "wire", said: REFUSE_WIRE });
      await cast({}, "live_minnow", 0, { part: "wire", said: null });
      const tries = await session.eval(() => window.__gw.state.run.midnight.tries);
      check(
        bunch.tried === true && tries === 1,
        `tries after the refusals: ${tries} (only the Worm Bunch's)`,
      );
      // On the second evening of the sketch 4 nudge the line shows on every refusal.
      await session.eval(() => (window.__gw.progression.loop.state().hunt.mossmere.nudged.swirlBoost = 4));
      await cast({ leader: "chafe_gut", lure: "bent_spoon" }, "live_minnow", 0, {
        part: "lure",
        said: REFUSE_LURE,
      });
      // A new night: the float line again, for worms this time.
      await atNight(session, MIDNIGHT_AT + 5, { evening: 5 });
      await cast({ lure: null, depth: "float" }, "mireworm", 0, { part: "depth", said: REFUSE_FLOAT_WORMS });
      const lines = said.filter(Boolean).join(" / ");
      check(!HER_WORDS.test(lines) && !/slate|credit/i.test(lines), `a refusal line names her: ${lines}`);
      // The notepad: sketch 4 with the lure's words, and the foot points back to it.
      await session.eval(() => window.__gw.ui.openJournal({ tab: "notepad" }));
      await session.waitFor(
        "the notepad tab",
        10_000,
        () => !!document.querySelector(".gw-journal-pad .gw-pad"),
      );
      const pad = await notepadShown(session, ".gw-journal-pad .gw-pad");
      await session.eval(() => window.__gw.ui.closeAll());
      check(
        pad?.drawn.includes("swirl") && pad.words.includes(SWIRL_LURE_WORDS) && pad.next === NEXT_SWIRL,
        `the notepad: ${JSON.stringify(pad)}`,
      );
      return `${said.filter(Boolean).length} lines, one try (the Worm Bunch); sketch 4 "${SWIRL_LURE_WORDS}"`;
    },
  },

  {
    name: "her first take waits until the Turnback Hook and Chafe Gut are both shelved or owned; until then a right rig is no bite and no try",
    fixture: "legend-sold",
    // Her hunt is not over: she has never been landed in this copy of the save.
    editSave: unsold(),
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      // The lead only: neither part on the shelf.
      await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        s.parts.includes("sounding_lead") || s.parts.push("sounding_lead");
        s.fitted.depth = "lead";
        s.arrivals.shelved = [];
      });
      await session.sail();
      await atNight(session, MIDNIGHT_AT + 5, { evening: 4 });
      const take = () => herCast(session, { bait: "live_minnow", u: 0 });
      const none = await take();
      const shelve = (id) =>
        session.eval((x) => window.__gw.progression.loop.state().arrivals.shelved.push(x), id);
      await shelve("turnback_hook");
      const hookOnly = await take();
      await shelve("chafe_gut");
      const both = await take();
      check(
        none?.part === "gate" && !none.take && none.said == null && !none.tried && none.tries === 0,
        `nothing shelved: ${JSON.stringify(none)}`,
      );
      check(hookOnly?.part === "gate" && !hookOnly.take, `the hook alone: ${JSON.stringify(hookOnly)}`);
      check(both?.take === true && both.tries === 1, `both shelved: ${JSON.stringify(both)}`);
      // The theft that finds her water is the Turnback Hook's beat, with Murk's line for it at the tally.
      const r = await session.eval(() => {
        const d = window.__gw.data,
          loop = () => ({
            parts: ["cork_float", "plain_knot", "mere_hook", "sounding_lead", "minnow_tin"],
            arrivals: { seq: 0, beats: { turnback_hook: 0, pike_wire: 0, leaders: 0 }, shelved: [] },
            maps: { lakes: ["mossmere"], places: [] },
            places: { revealed: [] },
            evenings: 4,
            hunt: {
              mossmere: { sketches: { map: 3, taken: 0 }, padUnseen: [], found: false, hookByTheft: false },
            },
          });
        const l = loop();
        d.findHerWater(l, null, { x: -4, z: -14, water: "mossmere" });
        const shelvedFirst = loop();
        shelvedFirst.arrivals.shelved.push("turnback_hook");
        d.findHerWater(shelvedFirst, null, { x: -4, z: -14, water: "mossmere" });
        return {
          beat: l.arrivals.beats.turnback_hook,
          byTheft: l.hunt.mossmere.hookByTheft,
          tally: d.rigArrivalAtTally(l, "mossmere"),
          shelvedFirst: [shelvedFirst.arrivals.beats.turnback_hook, shelvedFirst.hunt.mossmere.hookByTheft],
          line: d.TEXT_LOOP.arrivals.lines.hookHunt,
        };
      });
      check(r.beat > 0 && r.byTheft === true, `the theft's beat: ${JSON.stringify(r)}`);
      check(
        r.tally?.gift === "turnback_hook" && r.tally.giftSay === "hunt" && r.line === MURK_HOOK_HUNT,
        `the tally: ${JSON.stringify(r)}`,
      );
      check(JSON.stringify(r.shelvedFirst) === "[0,false]", `already shelved: ${JSON.stringify(r)}`);
      return `no bite until both; the theft brings the hook with "${r.line}"`;
    },
  },

  {
    name: "her losses: the Mere Hook early, a leader not Chafe Gut halfway, a weak line at the end; each named, taught, drawn into sketch 5, no wound; then she turns away at the bite",
    fixture: "legend-sold",
    // Her hunt is not over: she has never been landed in this copy of the save.
    editSave: unsold(),
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1"]);
      await fitHerParts(session, { hook: "mere_hook", leader: "plain_knot", depth: "lead" });
      await session.sail();
      const steps = [
        { rig: { hook: "mere_hook", leader: "plain_knot" }, part: "hook", frac: 0.15, text: HOOK_LOSS_TEXT },
        {
          rig: { hook: "turnback_hook", leader: "plain_knot" },
          part: "leader",
          frac: 0.5,
          text: LEADER_LOSS_TEXT,
        },
        {
          rig: { hook: "turnback_hook", leader: "chafe_gut" },
          part: "line",
          frac: null,
          text: LINE_LOSS_TEXT,
        },
      ];
      const done = [];
      let evening = 3;
      for (const step of steps) {
        await herRig(session, step.rig);
        // Forced to "land": the wrong part must still lose.
        const hooked = await hookAndPlayOut(session, LEGEND_ID, "land");
        check(
          hooked.p === 0 && hooked.escape?.legendLossReason === step.part,
          `${step.part}: ${JSON.stringify({ p: hooked.p, escape: hooked.escape, loss: hooked.loss })}`,
        );
        check(
          step.frac == null ? hooked.loss?.frac > 0.5 : Math.abs(hooked.loss?.frac - step.frac) < 0.001,
          `${step.part}: she got away at ${hooked.loss?.frac} of the fight`,
        );
        const shown = await escapeLine(session);
        check(shown === step.text, `${step.part}: the line "${shown}", expected "${step.text}"`);
        done.push(step.part);
        const rec = await legendRecord(session);
        const h = rec.hunt.mossmere;
        check(rec.wounds === 0, `${step.part}: a wound (${rec.wounds})`);
        check(
          h.lessons[step.part] === true &&
            JSON.stringify(h.back) === JSON.stringify(done) &&
            h.sketches.back > 0,
          `${step.part}: ${JSON.stringify({ lessons: h.lessons, back: h.back, s: h.sketches })}`,
        );
        // Another night, the same part still wrong: she turns away at the bite. No try, no fight.
        await session.closeGuides(3000);
        await atNight(session, MIDNIGHT_AT + 5, { evening: ++evening });
        const again = await herCast(session, { bait: "live_minnow", u: 0 });
        check(
          again?.part === "lesson" && !again.take && !again.tried && again.said === REFUSE_LESSON[step.part],
          `${step.part} after its loss: ${JSON.stringify(again)}`,
        );
        await atNight(session, 10, { evening: ++evening });
      }
      const saved = JSON.parse(await session.saved()).meta.loop.hunt.mossmere;
      check(
        JSON.stringify(saved.back) === '["hook","leader","line"]' && saved.lessons.line && saved.lineLesson,
        `the written save: ${JSON.stringify({ back: saved.back, lessons: saved.lessons })}`,
      );
      // Hob's line about the worn end waits for it, and comes now.
      const hob = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          h = loop.state().hunt.mossmere;
        (h.hobMet = 1), (h.hobNight = 0), (h.hobLines = ["rod", "bell", "taken"]);
        return loop.hobTalk();
      });
      check(hob?.line === "worn", `Hob's line: ${JSON.stringify(hob)}`);
      // The notepad: the three parts in fight order, each with its sentence; the foot sends you to Murk.
      await session.eval(() => window.__gw.ui.openJournal({ tab: "notepad" }));
      await session.waitFor(
        "the notepad tab",
        10_000,
        () => !!document.querySelector(".gw-journal-pad .gw-pad"),
      );
      const pad = await notepadShown(session, ".gw-journal-pad .gw-pad");
      await session.eval(() => window.__gw.ui.closeAll());
      const order = BACK_WORDS.map((w) => pad?.words.indexOf(w));
      check(
        order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])) && pad.next === NEXT_SELLS,
        `the notepad: ${JSON.stringify(pad)}`,
      );
      return `lost to ${done.join(", ")}; taught; no wound; turned away after each; notepad in order`;
    },
  },

  {
    name: "her right rig: a lost fight says everything held and wounds her; landed with no loss, sketch 5 reads What held",
    fixture: "legend-sold",
    // Her hunt is not over: she has never been landed in this copy of the save.
    editSave: unsold(),
    debug: true,
    timeoutMs: 420_000,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await fitHerParts(session, { depth: "lead" });
      await session.sail();
      const lost = await hookAndPlayOut(session, LEGEND_ID, "lose");
      check(lost.p > 0 && lost.escape?.legendLossReason === "fight", `the dice: ${JSON.stringify(lost)}`);
      const shown = await escapeLine(session);
      check(shown === FIGHT_LOSS_TEXT, `the line "${shown}"`);
      let rec = await legendRecord(session);
      let h = rec.hunt.mossmere;
      check(rec.wounds === 1, `wounds ${rec.wounds}, expected 1`);
      check(
        h.back.length === 0 && Object.values(h.lessons).every((v) => v === false),
        `the dice taught a part: ${JSON.stringify({ back: h.back, lessons: h.lessons })}`,
      );
      // Landed with no loss behind it: the page is drawn at the landing as "What held".
      await session.eval(() => {
        const h = window.__gw.progression.loop.state().hunt.mossmere;
        (h.sketches.back = 0), (h.padUnseen = h.padUnseen.filter((k) => k !== "back"));
      });
      await session.closeGuides(3000);
      const landed = await hookAndPlayOut(session, LEGEND_ID, "land");
      check(landed.landed === LEGEND_ID, `she was not landed: ${JSON.stringify(landed)}`);
      h = await huntOf(session);
      check(
        h.sketches.back > 0 && h.back.length === 0 && h.padUnseen.includes("back"),
        JSON.stringify(h.sketches),
      );
      await session.clickButton(/^\d?(Keep|Let go)\b/);
      await session.pause(800);
      await session.closeGuides(5000);
      await session.eval(() => window.__gw.ui.openJournal({ tab: "notepad" }));
      await session.waitFor(
        "the notepad tab",
        10_000,
        () => !!document.querySelector(".gw-journal-pad .gw-pad"),
      );
      const pad = await session.eval(() => ({
        title:
          document.querySelector('.gw-journal-pad [data-sketch="back"] .gw-pad-fig-h')?.textContent ?? null,
        words: [...document.querySelectorAll('.gw-journal-pad [data-sketch="back"] .gw-pad-cap')].map(
          (c) => c.textContent,
        ),
      }));
      await session.eval(() => window.__gw.ui.closeAll());
      check(
        pad.title === "5What held" && JSON.stringify(pad.words) === JSON.stringify([HELD_WORDS]),
        `sketch 5: ${JSON.stringify(pad)}`,
      );
      return `"${shown}", wounds 1; landed; sketch 5 "${HELD_WORDS}"`;
    },
  },

  {
    name: "her lessons in an old save: a line lesson from before the notepad carries over, taught and drawn into sketch 5",
    fixture: "mid-mossmere",
    debug: true,
    editSave(save) {
      save.meta.loop.hunt = { mossmere: { lineLesson: true, taleAt: 2 } };
    },
    async run(session) {
      await session.toHome();
      const h = await huntOf(session);
      check(
        h.lessons?.line === true &&
          h.lessons.hook === false &&
          JSON.stringify(h.back) === '["line"]' &&
          h.sketches.back > 0 &&
          h.lineLesson === true,
        `the loaded record: ${JSON.stringify({ lessons: h.lessons, back: h.back, s: h.sketches })}`,
      );
      return `lessons ${JSON.stringify(h.lessons)}, back ${JSON.stringify(h.back)}`;
    },
  },
  {
    name: "line-up: Murk names the five fish once, at the first tally after Hob's map (not the tale's tally, nor the one that passes the map on); sketch 3 opens with the fish already caught crossed out",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 720_000,
    // An older record, from before the line-up: Hob's map on evening 3, no crossed or marks fields.
    editSave: withMap,
    async run(session) {
      await session.sail(SLOW_SAIL);
      const filled = await huntOf(session);
      check(
        JSON.stringify(filled.crossed) === "{}" &&
          JSON.stringify(filled.marks) === '{"cuts":0,"holes":0,"ring":0}' &&
          filled.sketches.lineup === 0,
        `the old record was not filled in: ${JSON.stringify(filled)}`,
      );
      // The game's own tally rule on copies of the record: a map drawn before the tale waits past the tale's
      // tally; a map Murk passes on waits past that tally; then it comes once.
      const rule = await session.eval(() => {
        const g = window.__gw.data,
          base = JSON.parse(JSON.stringify(window.__gw.progression.loop.state().hunt.mossmere)),
          rec = (over) => ({ ...JSON.parse(JSON.stringify(base)), ...over }),
          tally = (r, evening) => {
            const loop = { hunt: { mossmere: r }, evenings: evening };
            const beat = g.huntTallyBeat(loop, { zone: "mossmere", evening }, undefined, { journal: {} });
            return beat ? Object.keys(beat).join("+") + (beat.murk ? ":" + beat.murk : "") : "none";
          },
          early = rec({ taleAt: 0, sketches: { ...base.sketches, map: 2 } }),
          passed = rec({ taleAt: 4, murkNudged: true, sketches: { ...base.sketches, map: 0 } });
        return {
          taleTally: tally(early, 2),
          afterTale: tally(early, 3),
          again: tally(early, 4),
          passTally: tally(passed, 6),
          afterPass: tally(passed, 7),
          sporewood: g.huntTallyBeat(
            { hunt: { mossmere: rec({}) } },
            { zone: "sporewood", evening: 5 },
            undefined,
            { journal: {} },
          ),
        };
      });
      check(
        rule.taleTally === "tale" &&
          rule.afterTale.includes("lineup") &&
          !rule.again.includes("lineup") &&
          rule.passTally === "murk:mapPassed" &&
          rule.afterPass.includes("lineup") &&
          rule.sporewood === null,
        `the tally rule: ${JSON.stringify(rule)}`,
      );
      // The real tally of evening 5: Murk's line, and the notepad opens on Suspects with sketch 3.
      let look = null;
      const { hunt, pad } = await tallyAndPad(session, {
        look: async () => (look = await lineupIn(session, '.gw-modal[data-modal="notepad"].gw-in .gw-pad')),
      });
      check(hunt.includes(MURK_LINEUP), `the tally: "${hunt}"`);
      check(
        pad && pad.page === "suspects" && pad.drawn.includes("lineup") && pad.drawn.includes("map"),
        `the notepad at the tally: ${JSON.stringify(pad)}`,
      );
      const caught = ["reedjaw_pike", "milkeye_perch", "kissmark_trout", "weeping_carp"];
      check(look?.head === LINEUP_HEAD && look.rows.length === 5, `the line-up: ${JSON.stringify(look)}`);
      for (const row of look.rows) {
        const out = caught.includes(row.fish);
        check(
          row.out === out && (out ? row.why.length > 10 && row.reds >= 1 : row.why === "" && row.reds === 0),
          `the ${row.fish} row: ${JSON.stringify(row)}`,
        );
      }
      check(look.frame === LINEUP_FRAME, `the empty frame: ${look.frame}`);
      // A Kissmark known only from the Journal is crossed out for its small mouth, and no ring is claimed.
      const kissRow = look.rows.find((r) => r.fish === "kissmark_trout");
      check(kissRow?.why === KISS_PLAIN, `the Kissmark's reason: ${JSON.stringify(kissRow)}`);
      check(look.marks.length === 0, `the marks strip: ${JSON.stringify(look.marks)}`);
      const record = await huntOf(session);
      check(
        record.sketches.lineup === 5 &&
          JSON.stringify(Object.keys(record.crossed).sort()) === JSON.stringify([...caught].sort()) &&
          record.marks.ring === 0 &&
          record.ringed.length === 0 &&
          record.padUnseen.length === 0,
        `the record: ${JSON.stringify(record)}`,
      );
      return `"${MURK_LINEUP}" at evening 5; four crossed out on the page; the rule waits past the tale and the pass`;
    },
  },

  {
    name: "line-up: a first catch of a line-up fish crosses it out with its reason and the sketch line; all five crossed out changes the frame's line; the notepad opens on it at the tally",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 720_000,
    editSave: withLineup(),
    async run(session) {
      await session.sail(SLOW_SAIL);
      await listenForToasts(session);
      await session.catchFish("bridgechain_sturgeon");
      await session.pause(1200);
      let toasts = await toastsSeen(session);
      const why = toasts.indexOf(STURGEON_WHY);
      check(why >= 0 && toasts.indexOf(DRAWN, why) > why, `the lines: ${JSON.stringify(toasts)}`);
      let record = await huntOf(session);
      check(
        record.crossed.bridgechain_sturgeon === 5 && record.padUnseen.includes("cross:bridgechain_sturgeon"),
        `the record: ${JSON.stringify(record)}`,
      );
      // A line-up fish already crossed out is not crossed again.
      await session.catchFish("reedjaw_pike");
      await session.pause(1200);
      toasts = await toastsSeen(session);
      check(
        !toasts.includes(PIKE_WHY) && toasts.filter((t) => t === DRAWN).length === 1,
        `a second crossing: ${JSON.stringify(toasts)}`,
      );
      let look = null;
      const { pad } = await tallyAndPad(session, {
        look: async () => (look = await lineupIn(session, '.gw-modal[data-modal="notepad"].gw-in .gw-pad')),
      });
      check(pad && pad.page === "suspects", `the notepad at the tally: ${JSON.stringify(pad)}`);
      check(
        look && look.rows.every((r) => r.out && r.reds >= 1),
        `not every fish crossed out: ${JSON.stringify(look)}`,
      );
      check(
        look.rows.find((r) => r.fish === "bridgechain_sturgeon")?.why === STURGEON_WHY,
        `the sturgeon's words: ${JSON.stringify(look.rows)}`,
      );
      check(look.frame === LINEUP_NONE, `the frame: ${look.frame}`);
      record = await huntOf(session);
      check(record.padUnseen.length === 0 && !record.padDue, `after the notepad: ${JSON.stringify(record)}`);
      return "the sturgeon crossed out with its words; all five out; the frame says none of them";
    },
  },

  {
    name: "bite marks: the roll puts cuts and holes only on their fish, in their places and light, about 1 in 8; the ring on about one Kissmark in four; near her water only in her time and with Hob's map, about 1 in 2",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withMap,
    async run(session) {
      await session.boot();
      const r = await session.eval(() => {
        const g = window.__gw.data;
        let seed = 7;
        const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
        const N = 8000,
          share = (fn) => {
            const n = {};
            for (let i = 0; i < N; i++) {
              const m = fn() ?? "none";
              n[m] = (n[m] || 0) + 1;
            }
            return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v / N]));
          },
          roll = (id, area, phase) =>
            share(() => g.catchMarkRoll(id, area, phase, rng, g.LOOP.hunts.mossmere.marks));
        const loop = window.__gw.progression.loop.state(),
          noMap = { hunt: { mossmere: { ...loop.hunt.mossmere, sketches: { map: 0 } } } },
          run = (t, over = {}) => ({
            outing: "trip",
            zone: "mossmere",
            evening: 5,
            phase: "gloomtide",
            phaseTime: t,
            ...over,
          }),
          near = (l, rn, id = "weeping_carp", x = -4 + 10, z = -14) =>
            share(() => g.catchMarkFor(l, rn, { speciesId: id, area: "open", phase: rn.phase, x, z }, rng));
        return {
          cutsReeds: roll("mossback_perch", "reeds", "calm"),
          cutsPads: roll("lampsipper", "pads", "dusk"),
          cutsOpen: roll("mossback_perch", "open", "calm"),
          cutsWrongFish: roll("weeping_carp", "reeds", "calm"),
          holesNight: roll("rustfin_sucker", "deep", "gloomtide"),
          holesDuskDrop: roll("dusk_minnow", "dropoff", "dusk"),
          holesDay: roll("rustfin_sucker", "deep", "calm"),
          holesWrongFish: roll("likely_chub", "deep", "gloomtide"),
          kissmark: roll("kissmark_trout", "open", "calm"),
          herTime: near(loop, run(75)),
          beforeMidnight: near(loop, run(30)),
          afterHerTime: near(loop, run(60 + 200)),
          tooFar: near(loop, run(75), "weeping_carp", -4 + 17, -14),
          noMap: near(noMap, run(75)),
          kissmarkNoMap: near(noMap, run(75), "kissmark_trout"),
          legend: g.catchMarkFor(loop, run(75), {
            speciesId: "belled_matriarch",
            legendary: true,
            x: -4,
            z: -14,
          }),
          sporewood: g.catchMarkFor(loop, run(75, { zone: "sporewood" }), { speciesId: "kissmark_trout" }),
        };
      });
      const about = (v, want) => Math.abs((v || 0) - want) < 0.025;
      check(about(r.cutsReeds.cuts, 1 / 8) && about(r.cutsPads.cuts, 1 / 8), `cuts: ${JSON.stringify(r)}`);
      check(
        about(r.holesNight.holes, 1 / 8) && about(r.holesDuskDrop.holes, 1 / 8),
        `holes: ${JSON.stringify(r)}`,
      );
      for (const k of [
        "cutsOpen",
        "cutsWrongFish",
        "holesDay",
        "holesWrongFish",
        "beforeMidnight",
        "afterHerTime",
        "tooFar",
        "noMap",
        "kissmarkNoMap",
      ])
        check(r[k].none === 1, `${k} carried a mark: ${JSON.stringify(r[k])}`);
      check(about(r.kissmark.ring, 0.25), `the Kissmark: ${JSON.stringify(r.kissmark)}`);
      check(
        about(r.herTime.ring, 0.5) && about(r.herTime.none, 0.5),
        `near her water: ${JSON.stringify(r.herTime)}`,
      );
      check(r.legend === null && r.sporewood === null, `her or Sporewood: ${r.legend} ${r.sporewood}`);
      return `cuts ${r.cutsReeds.cuts.toFixed(3)}, holes ${r.holesNight.holes.toFixed(3)}, near her ${r.herTime.ring.toFixed(3)}`;
    },
  },

  {
    name: "bite marks: a mark shows on the catch card with its line and is kept on the catch; its first sighting adds it to the strip; the pike's card names its cuts and matches them; all kept after a reload",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 720_000,
    editSave: withLineup(["kissmark_trout", "reedjaw_pike"]),
    async run(session, { page, browser }) {
      await session.sail(SLOW_SAIL);
      await listenForToasts(session);
      // About one Kissmark in four carries the ring: make this one carry it.
      await session.eval(() => (window.__gw.data.LOOP.hunts.mossmere.marks.ring.oftenChance = 1));
      const kiss = await catchAndReadCard(session, "kissmark_trout");
      check(
        kiss.line === RING_LINE && /gw-cc-mark--ring/.test(kiss.ink || ""),
        `the Kissmark's card: ${JSON.stringify(kiss)}`,
      );
      await session.pause(1000);
      const toasts = await toastsSeen(session);
      check(toasts.includes(DRAWN), `no "${DRAWN}": ${JSON.stringify(toasts)}`);
      let record = await huntOf(session);
      check(
        record.marks.ring === 5 &&
          record.padUnseen.includes("mark:ring") &&
          record.padUnseen.includes("cross:kissmark_trout") &&
          record.ringed.includes("kissmark_trout"),
        `after the Kissmark: ${JSON.stringify(record)}`,
      );
      const kept = await session.eval(() =>
        window.__gw.state.run.creel.map((f) => `${f.speciesId}:${f.mark ?? ""}`),
      );
      check(kept.includes("kissmark_trout:ring"), `the creel: ${JSON.stringify(kept)}`);
      // Landed with the ring on it, the Kissmark is crossed out for that.
      const kissRow = (await lineupInJournal(session)).rows.find((r) => r.fish === "kissmark_trout");
      check(
        kissRow?.out && kissRow.why === KISS_RINGED,
        `the ringed Kissmark's row: ${JSON.stringify(kissRow)}`,
      );
      await session.eval(() => window.__gw.ui.closeAll());
      // A fish with no mark has no line; the cuts seen once (put in the record as a sighting would), then the pike.
      const carp = await catchAndReadCard(session, "weeping_carp");
      check(carp.line === null && carp.ink === null, `the carp's card: ${JSON.stringify(carp)}`);
      await session.eval(() => (window.__gw.progression.loop.state().hunt.mossmere.marks.cuts = 5));
      let strip = (await lineupInJournal(session)).marks;
      check(
        JSON.stringify(strip) ===
          JSON.stringify([
            { mark: "cuts", words: CUTS_OPEN },
            { mark: "ring", words: RING_OPEN },
          ]),
        `the strip before the pike: ${JSON.stringify(strip)}`,
      );
      const pike = await catchAndReadCard(session, "reedjaw_pike");
      check(pike.line === PIKE_CARD && pike.ink === null, `the pike's card: ${JSON.stringify(pike)}`);
      strip = (await lineupInJournal(session)).marks;
      check(
        strip[0]?.words === CUTS_MATCH && strip[1]?.words === RING_OPEN,
        `the strip after: ${JSON.stringify(strip)}`,
      );
      // Reloaded, the trip goes on: the marks, the crossings and the scraped Kissmark in the creel are kept.
      const saved = await session.saved();
      const next = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await next.boot();
        await next.sail(SLOW_SAIL);
        const h = await huntOf(next);
        check(
          h.marks.ring === 5 &&
            h.marks.cuts === 5 &&
            h.crossed.kissmark_trout === 5 &&
            h.crossed.reedjaw_pike === 5,
          `after a reload: ${JSON.stringify(h)}`,
        );
        const creel = await next.eval(() =>
          (window.__gw.state.run.creel || []).map((f) => `${f.speciesId}:${f.mark ?? ""}`),
        );
        check(creel.includes("kissmark_trout:ring"), `the creel after a reload: ${JSON.stringify(creel)}`);
        await next.collectGameErrors();
        check(!next.errors.length, `errors after reloading: ${next.errors.join("; ")}`);
      } finally {
        await next.close();
      }
      return "the ring on the Kissmark's card and in the strip; the pike's card; the cuts matched; kept";
    },
  },

  {
    name: "bite marks: the first ring of scrapes is a beat for the Turnback Hook, which Murk then brings with his hunt line; Sporewood catches note nothing",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withMap,
    async run(session) {
      await session.boot();
      const r = await session.eval(() => {
        const g = window.__gw.data,
          base = JSON.parse(JSON.stringify(window.__gw.progression.loop.state().hunt.mossmere)),
          loop = () => ({
            parts: ["cork_float", "plain_knot", "mere_hook", "sounding_lead", "minnow_tin"],
            evenings: 4,
            arrivals: {
              seq: 0,
              beats: { turnback_hook: 0, pike_wire: 0, leaders: 0 },
              shelved: ["pike_wire", "chafe_gut"],
            },
            hunt: { mossmere: JSON.parse(JSON.stringify(base)) },
          }),
          trip = { zone: "mossmere", evening: 5 };
        const ring = loop(),
          noted = g.noteHuntCatch(ring, trip, "mossback_perch", { mark: "ring" }),
          beat = ring.arrivals.beats.turnback_hook,
          gift = g.rigArrivalAtTally(ring, "mossmere"),
          again = g.noteHuntCatch(ring, trip, "mossback_perch", { mark: "ring" });
        const cuts = loop();
        g.noteHuntCatch(cuts, trip, "mossback_perch", { mark: "cuts" });
        const spore = loop(),
          sporeNoted = g.noteHuntCatch(spore, { zone: "sporewood", evening: 5 }, "kissmark_trout", {
            mark: "ring",
          });
        return {
          noted,
          beat,
          gift,
          again,
          cutsBeat: cuts.arrivals.beats.turnback_hook,
          cutsMarks: cuts.hunt.mossmere.marks,
          sporeNoted,
          sporeMarks: spore.hunt.mossmere.marks,
          line: window.__gw.data.TEXT_LOOP.arrivals.lines.hookHunt,
        };
      });
      check(r.noted?.mark === "ring" && r.beat === 1 && r.again === null, `the ring: ${JSON.stringify(r)}`);
      check(
        r.gift?.gift === "turnback_hook" && r.gift.giftSay === "hunt" && r.line === HOOK_HUNT_LINE,
        `the tally: ${JSON.stringify(r.gift)}`,
      );
      check(r.cutsBeat === 0 && r.cutsMarks.cuts === 5, `the cuts: ${JSON.stringify(r)}`);
      check(r.sporeNoted === null && r.sporeMarks.ring === 0, `Sporewood: ${JSON.stringify(r)}`);
      return `the ring noted the hook's beat; Murk says "${HOOK_HUNT_LINE}"`;
    },
  },
  // ---- the end of the hunt (mossmere-hunt-2.md sections 1, 5 and 6, B4 to B6) ----------------------------

  {
    name: "ending: landed, she gets the measuring card with her name and bell and one Let go, is never in the hold, opens Sporewood with no sale; the tally pays 900 once with Murk's line, said before he gives Hob's Lamp",
    fixture: "legend-sold",
    debug: true,
    editSave: unsold(),
    timeoutMs: 600_000,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await fitHerParts(session, { depth: "lead" });
      const before = await session.eval(() => {
        const loop = window.__gw.progression.loop;
        return {
          open: loop.isOpen("sporewood"),
          lakes: [...loop.state().maps.lakes],
          landings: loop.state().hunt.mossmere.landings,
        };
      });
      check(
        before.open === false && !before.lakes.includes("sporewood") && before.landings === 0,
        `before: ${JSON.stringify(before)}`,
      );
      await session.sail();
      await listenForToasts(session);
      const hooked = await hookOnce(session, LEGEND_ID, "land");
      check(hooked.landed === LEGEND_ID, `she was not landed: ${JSON.stringify(hooked)}`);
      const card = await session.eval(() => {
        const el = document.querySelector('.gw-modal[data-modal="catch"]');
        return {
          name: el?.querySelector(".gw-catch-name")?.textContent.trim() ?? null,
          words: [...(el?.querySelectorAll(".gw-cc-measured-words p") || [])].map((p) => p.textContent),
          length: el?.querySelector(".gw-cc-len")?.textContent.trim() ?? "",
          weight: el?.querySelector(".gw-cc-hero")?.getAttribute("aria-label") ?? "",
          buttons: [...(el?.querySelectorAll(".gw-catch-actions button") || [])].map((b) =>
            b.textContent.trim(),
          ),
        };
      });
      check(card.name === "Bellhead Catfish", `the card's name: ${JSON.stringify(card)}`);
      check(
        JSON.stringify(card.words) === JSON.stringify(MEASURED),
        `the card's lines: ${JSON.stringify(card)}`,
      );
      check(/\d/.test(card.length) && /\d/.test(card.weight), `length and weight: ${JSON.stringify(card)}`);
      check(card.buttons.length === 1 && /^\d?Let go$/.test(card.buttons[0]), `the buttons: ${card.buttons}`);
      // Keeping her is refused even when asked for directly.
      const kept = await session.eval(
        (id) => window.__gw.progression.fishAction({ uid: "her-test", speciesId: id }, "keep")?.ok ?? null,
        LEGEND_ID,
      );
      check(kept === false, `keeping her was not refused: ${kept}`);
      await session.clickButton(/^\d?Let go\b/);
      await session.pause(1500);
      const after = await session.eval((id) => {
        const g = window.__gw,
          loop = g.progression.loop,
          s = loop.state();
        return {
          creel: (g.state.run.creel || []).map((f) => f.speciesId),
          landed: s.hunt.mossmere.landed,
          landings: s.hunt.mossmere.landings,
          sold: s.legends[id] | 0,
          open: loop.isOpen("sporewood"),
          clams: s.clams,
        };
      }, LEGEND_ID);
      const toasts = await toastsSeen(session);
      check(toasts.includes(RELEASE_LINE), `no release line: ${JSON.stringify(toasts)}`);
      check(!after.creel.includes(LEGEND_ID), `she is in the hold: ${after.creel}`);
      check(
        after.landed > 0 && after.sold === 0 && after.landings === 1,
        `landed ${after.landed}, sold ${after.sold}, landings ${after.landings}`,
      );
      check(after.open === true, "Sporewood is not open after the landing");
      // At the tally: the bounty row and Murk's line, then Hob's Lamp with his line. His box says his line about
      // her first, then the lamp's two lines, and the card lists them in that order.
      const tally = await tallyWords(session, { hear: true });
      const trip = await session.eval(() => window.__gw.progression.loop.lastTrip());
      const home = await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        return { clams: s.clams, relics: [...s.relics], paid: s.hunt.mossmere.bountyPaid };
      });
      check(tally.hunt.includes(MURK_LANDED), `the tally's hunt words: ${tally.hunt}`);
      check(
        sameJson(tally.murk, [MURK_LANDED, MURK_LAMP, LAMP_LINE]) && sameJson(tally.order, ["hunt", "gift"]),
        `Murk's line is not before the lamp: ${JSON.stringify({ murk: tally.murk, order: tally.order })}`,
      );
      check(
        tally.gift.includes("Hob's Lamp") && tally.gift.includes(MURK_LAMP) && tally.gift.includes(LAMP_LINE),
        `the tally's gift: ${tally.gift}`,
      );
      check(
        tally.rows.some((r) => r.includes("Bellhead Catfish") && r.includes("Bounty") && r.includes("900")),
        `the tally's rows: ${JSON.stringify(tally.rows)}`,
      );
      check(trip.bounty === 900 && trip.gift === LAMP, `the trip: ${JSON.stringify(trip)}`);
      check(
        home.clams - after.clams === trip.total && trip.total >= 900,
        `clams ${after.clams} -> ${home.clams}`,
      );
      check(home.relics.includes(LAMP) && home.paid === true, `after the tally: ${JSON.stringify(home)}`);
      // The next evening: the lamp on the raft and not on Hob's rock; the next tally pays nothing more.
      await session.sail();
      await session.pause(1500);
      const lamps = await lampsInWorld(session);
      check(lamps.raft === true && lamps.rock === false, `the lamps: ${JSON.stringify(lamps)}`);
      const again = await tallyWords(session);
      const trip2 = await session.eval(() => window.__gw.progression.loop.lastTrip());
      check(
        trip2.bounty === undefined && !again.hunt.includes(MURK_LANDED) && trip2.gift !== LAMP,
        `the next tally: ${JSON.stringify({ trip2, again })}`,
      );
      const saved = JSON.parse(await session.saved());
      check(
        saved.meta.loop.relics.includes(LAMP) && saved.meta.loop.hunt.mossmere.landed > 0,
        "the written save lost the lamp or the landing",
      );
      return `card "${card.name}", ${card.length}, ${card.weight}; bounty ${trip.bounty} once; lamp on the raft`;
    },
  },

  {
    name: "Hob's Lamp: kept on loading, it makes a never-caught kind bite 1.5 times as often in all three bite paths, never a legend, never a kind already caught",
    fixture: "mid-mossmere",
    debug: true,
    editSave: (save) => {
      withLead(false)(save);
      save.meta.loop.relics = [LAMP];
    },
    async run(session) {
      await session.sail();
      const kept = await session.eval(() => [...window.__gw.progression.loop.state().relics]);
      check(JSON.stringify(kept) === JSON.stringify([LAMP]), `the relics after loading: ${kept}`);
      const lamps = await lampsInWorld(session);
      check(lamps.raft === true && lamps.rock === false, `the lamps: ${JSON.stringify(lamps)}`);
      const roll = (opts) =>
        session.eval(
          ([o, lamp]) => {
            const g = window.__gw,
              s = g.progression.loop.state();
            s.relics.length = 0;
            lamp && s.relics.push("hobs_lamp");
            g.debug.setPhase("calm");
            return g.debug.fishPoolRoll(1, { bait: "mireworm", ...o });
          },
          [opts, opts.lamp],
        );
      const caught = (id) => session.eval((id) => (window.__gw.state.meta.journal[id]?.caught | 0) > 0, id);
      // 1. Pool rows (l1): each kind's share against a caught kind's (Mossback Perch).
      const off = await roll({ lamp: false }),
        on = await roll({ lamp: true });
      const base = on.shares.mossback_perch / off.shares.mossback_perch;
      const kinds = Object.keys(off.shares).filter((id) => off.shares[id] > 0);
      let unmet = 0;
      for (const id of kinds) {
        const want = (await caught(id)) ? 1 : 1.5;
        want > 1 && unmet++;
        const ratio = on.shares[id] / off.shares[id] / base;
        check(near(ratio, want, 1e-6), `${id}: ${ratio.toFixed(4)} times as often, expected ${want}`);
      }
      check(unmet > 0 && unmet < kinds.length, `no mix of met and unmet kinds here: ${kinds}`);
      // 2. Guests (P7): the Lily Gardener's Notebook brings the Nightbloom Carp (never caught) to the pads at night.
      await session.eval(() => {
        window.__gw.progression.loop.state().finds.got.lily_notebook = 1;
        window.__gw.player.teleport({ x: 40, z: 28 }, 0);
      });
      await session.pause(1500);
      const night = (lamp) =>
        session.eval((lamp) => {
          const g = window.__gw,
            s = g.progression.loop.state();
          s.relics.length = 0;
          lamp && s.relics.push("hobs_lamp");
          g.debug.setPhase("gloomtide");
          return g.debug.fishPoolRoll(1, { bait: "mireworm" });
        }, lamp);
      const p0 = (await night(false)).shares.nightbloom_carp,
        p1 = (await night(true)).shares.nightbloom_carp;
      check(p0 > 0 && !(await caught("nightbloom_carp")), `no Nightbloom Carp guest here: ${p0}`);
      // A guest's weight is the pool's times x = p / (1 - p), so the lamp makes x half again as large.
      const x0 = p0 / (1 - p0),
        x1 = p1 / (1 - p1);
      check(near(x1 / x0, 1.5, 1e-6), `the guest ${p0} -> ${p1}: x times ${x1 / x0}`);
      // 3. Sign and sight takes (_7): an unmet kind's prerolled take rises by half; a met kind's stays.
      const take = async (speciesId, lamp) =>
        (await roll({ lamp, roll: undefined, preroll: { speciesId, base: 0.2 } })).preroll;
      await session.eval(() => window.__gw.player.teleport({ x: 0, z: 30 }, 0));
      await session.pause(1200);
      check(!(await caught("gutter_crayfish")), "the Gutter Crayfish has been caught in this save");
      const u0 = await take("gutter_crayfish", false),
        u1 = await take("gutter_crayfish", true),
        m0 = await take("mossback_perch", false),
        m1 = await take("mossback_perch", true);
      check(near(u1, Math.min(0.9, 1.5 * u0), 1e-9) && u1 > u0, `the crayfish's take ${u0} -> ${u1}`);
      check(near(m0, m1, 1e-12), `a caught kind's take moved: ${m0} -> ${m1}`);
      // Never a legend, whatever the journal says.
      const rule = await session.eval(() => {
        const g = window.__gw.data,
          lamp = g.lampOf({ loop: { relics: ["hobs_lamp"] }, journal: {} });
        return {
          her: g.lampBiteMult({ id: "belled_matriarch", rarity: "legendary" }, lamp),
          grove: g.lampBiteMult({ id: "drifting_grove", rarity: "legendary" }, lamp),
          pike: g.lampBiteMult({ id: "reedjaw_pike", rarity: "rare" }, lamp),
          none: g.lampOf({ loop: { relics: [] }, journal: {} }),
        };
      });
      check(
        rule.her === 1 && rule.grove === 1 && rule.pike === 1.5 && rule.none === null,
        `the rule: ${JSON.stringify(rule)}`,
      );
      return `pool: ${unmet} unmet kinds x1.5 of ${kinds.length}; guest ${p0.toFixed(3)} -> ${p1.toFixed(3)}; take ${u0} -> ${u1}`;
    },
  },

  {
    name: "ending, old save: a save that sold her loads with every sketch drawn, the hunt landed and Hob's Lamp; no tale, line-up, nudge or bounty; Sporewood is open and the lamp crosses with the tow",
    fixture: "legend-sold",
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      await session.toHome();
      const r = await session.eval(() => {
        const g = window.__gw,
          loop = g.progression.loop,
          s = loop.state(),
          h = s.hunt.mossmere,
          evening = s.evenings + 1;
        return {
          h: JSON.parse(JSON.stringify(h)),
          relics: [...s.relics],
          lakes: [...s.maps.lakes],
          open: loop.isOpen("sporewood"),
          beat: g.data.huntTallyBeat(JSON.parse(JSON.stringify(s)), { zone: "mossmere", evening }),
          next: loop.notepad()?.next ?? null,
        };
      });
      check(
        Object.values(r.h.sketches).every((v) => v > 0),
        `sketches: ${JSON.stringify(r.h.sketches)}`,
      );
      check(
        r.h.landed > 0 && r.h.landedBy === "save" && r.h.bountyPaid === true,
        `the record: ${JSON.stringify(r.h)}`,
      );
      check(r.h.birdCutsceneSeen === true && r.h.taleAt > 0, `cutscene or tale due: ${JSON.stringify(r.h)}`);
      check(r.relics.includes(LAMP), `no lamp: ${r.relics}`);
      check(r.lakes.includes("sporewood") && r.open === true, `Sporewood: ${JSON.stringify(r)}`);
      check(r.beat === null, `a tally would say ${JSON.stringify(r.beat)}`);
      check(r.next === "solved", `the notepad's foot: ${r.next}`);
      // The notepad in the Journal: its last line, the frame's line and the ring's line once she is landed.
      await session.eval(() => {
        const h = window.__gw.progression.loop.state().hunt.mossmere;
        h.marks.ring = h.marks.ring || 1;
      });
      await session.eval(() => window.__gw.ui.openJournal({ tab: "notepad" }));
      await session.waitFor(
        "the notepad tab",
        10_000,
        () => !!document.querySelector(".gw-journal-pad .gw-pad"),
      );
      const pad = await session.eval(() => ({
        foot: document.querySelector(".gw-journal-pad .gw-pad-next")?.textContent.trim() ?? "",
        words: [...document.querySelectorAll(".gw-journal-pad .gw-pad-cap")].map((c) => c.textContent),
        text: document.querySelector(".gw-journal-pad")?.textContent ?? "",
      }));
      await session.eval(() => window.__gw.ui.closeAll());
      check(pad.foot === PAD_SOLVED, `the foot: "${pad.foot}"`);
      check(
        pad.words.includes(FRAME_LANDED) && pad.words.includes(RING_LANDED),
        `captions: ${JSON.stringify(pad.words)}`,
      );
      check(!/What to try next/i.test(pad.foot), "the foot still has its heading");
      // To Sporewood: the first tow leaves its kit behind, but not the lamp.
      await session.sail({ water: "sporewood" });
      await session.pause(1500);
      const there = await session.eval(() => ({
        water: window.__gw.state.run?.zone,
        relics: [...window.__gw.progression.loop.state().relics],
      }));
      const lamps = await lampsInWorld(session);
      check(
        there.water === "sporewood" && there.relics.includes(LAMP),
        `in Sporewood: ${JSON.stringify(there)}`,
      );
      check(lamps.raft === true, `the raft's lamp in Sporewood: ${JSON.stringify(lamps)}`);
      return `all five drawn, landed, lamp kept through the tow; foot "${pad.foot}"`;
    },
  },

  {
    name: "Hob's rod: the first cast in her water after the landing brings it up with its two lines, once; at Mossbell Isle Hob says his last lines once and the notepad ends; her time no longer runs",
    fixture: "legend-sold",
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await fitHerParts(session, { depth: "lead" });
      await session.sail();
      await listenForToasts(session);
      // After the landing, in her time: a wrong rig uses no try and says nothing; no boil, no still-water line.
      await atNight(session, MIDNIGHT_AT + 5, { evening: 6 });
      await herRig(session, { lure: "bent_spoon" });
      const lure = await herCast(session, { bait: "live_minnow", u: 0 });
      await herRig(session, { lure: null });
      const worms = await herCast(session, { bait: "mireworm", u: 0 });
      check(
        [lure, worms].every((a) => !a || (!a.said && !a.part && a.tries === 0)),
        `after the landing she still refuses or counts tries: ${JSON.stringify([lure, worms])}`,
      );
      await atNight(session, MIDNIGHT_AT + 200);
      await session.pause(800);
      let toasts = await toastsSeen(session);
      check(
        !toasts.includes(STILL_LINE) && !toasts.some((t) => BOIL_LINE.test(t)),
        `her time ran: ${JSON.stringify(toasts)}`,
      );
      // The rod: cast into her water.
      await session.eval(() => {
        const g = window.__gw;
        g.progression.loop.markLifted?.("bell_pool");
        g.debug.setPhase("calm");
        g.player.teleport({ x: -4, z: -3 }, 0);
      });
      await session.pause(1500);
      await session.closeGuides(3000);
      const castOnce = () =>
        session.eval(async () => {
          const g = window.__gw,
            found = () => g.progression.loop.state().hunt.mossmere.rodFound;
          const before = found();
          g.debug.castAt(-4, -14, 0.6);
          for (let i = 0; i < 400 && g.fishing.state !== "waiting"; i++)
            await new Promise((r) => setTimeout(r, 25));
          const f = g.debug.fishing(),
            snagged = !!f.rodDue;
          // The game's clock runs slowly in a software-rendered browser: wait for the snag on its own clock.
          for (let i = 0; i < 300 && snagged && found() === before; i++) {
            // A guide card holds the game's clock: close any that opens.
            document.querySelector(".gw-m-guide .gw-guide-ok")?.click();
            await new Promise((r) => setTimeout(r, 100));
          }
          return {
            place: f.place,
            snagged,
            state: g.fishing.state,
            rodFound: found(),
            rodDue: g.debug.fishing().rodDue,
            paused: !!g.paused,
            top: document.querySelector(".gw-modal.gw-in")?.dataset.modal ?? null,
          };
        });
      const first = await castOnce();
      toasts = await toastsSeen(session);
      check(first.rodFound > 0, `no rod: ${JSON.stringify(first)}`);
      check(
        ROD_LINES.every((l) => toasts.filter((t) => t === l).length === 1),
        `the rod's lines: ${JSON.stringify(toasts)}`,
      );
      check(
        (await session.eval(() => window.__gw.progression.loop.notepad().next)) === "rod",
        "the foot does not point to Hob",
      );
      await session.eval(() => window.__gw.fishing.reelInQuiet?.());
      await session.pause(800);
      await castOnce();
      toasts = await toastsSeen(session);
      check(
        ROD_LINES.every((l) => toasts.filter((t) => t === l).length === 1),
        "the rod came up twice",
      );
      await session.eval(() => window.__gw.fishing.reelInQuiet?.());
      // To Hob: his last lines, once; then only his greeting.
      await session.pause(800);
      await session.closeGuides(5000);
      await nearHob(session);
      const lines = await hearHob(session);
      const why = lines.length
        ? null
        : await session.eval(() => {
            const g = window.__gw;
            return {
              fishing: g.fishing.state,
              top: document.querySelector(".gw-modal.gw-in")?.dataset.modal ?? null,
              paused: !!g.paused,
              cinematic: !!g.cinematic,
              here: g.progression.loop.hobHere(),
              pos: g.player.position,
              hunt: g.ui?.debug?.hunt?.() ?? null,
              flow: g.flow,
            };
          });
      check(
        lines.length >= 2 && lines.at(-2) === HOB_LANDED && lines.at(-1) === HOB_ROD_BACK,
        `Hob said: ${JSON.stringify(lines)} ${JSON.stringify(why)}`,
      );
      const again = await passHobAgain(session, 12_000);
      check(
        !again.includes(HOB_ROD_BACK) && !again.includes(HOB_LANDED),
        `Hob again: ${JSON.stringify(again)}`,
      );
      const h = await huntOf(session);
      check(h.rodReturned > 0, `the rod was not given back: ${JSON.stringify(h)}`);
      check((await session.eval(() => window.__gw.progression.loop.notepad().next)) === "solved", "the foot");
      return `rod found, Hob: ${JSON.stringify(lines)}; again: ${JSON.stringify(again)}`;
    },
  },
  // ---- the rig picture (mossmere-gear.md "The rig picture" and B6; mossmere-gear-deeper.md) ---------------

  {
    name: "rig picture: it draws the fitted rig, the float or the lead, the bait or the lure, and the leader and hook only when there is a choice",
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.toHome();
      const plain = await rigScreen(session);
      await closeTackle(session);
      check(
        JSON.stringify(plain.nodes.map((n) => n.part)) === '["rod","reel","line","bait"]' &&
          plain.nodes[3].key === "mireworm" &&
          plain.depth === "float" &&
          plain.drawn.cork &&
          !plain.drawn.lead &&
          plain.drawn.worm &&
          !plain.drawn.wire &&
          !plain.drawn.gut &&
          !plain.drawn.knot &&
          plain.drawn.hook === 1,
        `the starting rig: ${JSON.stringify(plain)}`,
      );
      // The lead, a second leader and a second hook owned: Depth, Leader and Hook become parts, drawn as fitted.
      await session.eval(() => {
        const loop = window.__gw.progression.loop,
          s = loop.state();
        for (const id of ["sounding_lead", "pike_wire", "turnback_hook"])
          s.parts.includes(id) || s.parts.push(id);
        loop.fitDepth("lead"), loop.fitPart("leader", "pike_wire"), loop.fitPart("hook", "turnback_hook");
      });
      const full = await rigScreen(session);
      await closeTackle(session);
      check(
        JSON.stringify(full.nodes.map((n) => `${n.part}:${n.key}`).slice(3)) ===
          '["depth:sounding_lead","leader:pike_wire","hook:turnback_hook","bait:mireworm"]' &&
          full.depth === "lead" &&
          full.drawn.lead &&
          full.drawn.bell &&
          !full.drawn.cork &&
          full.drawn.wire &&
          full.drawn.hook === 1,
        `the full rig: ${JSON.stringify(full)}`,
      );
      // A lure: the Depth and the Hook merge into it; the leader stays.
      await session.eval(() => window.__gw.progression.loop.changeHook({ lure: "bent_spoon" }));
      const lure = await rigScreen(session);
      await closeTackle(session);
      check(
        JSON.stringify(lure.nodes.map((n) => `${n.part}:${n.key}`).slice(3)) ===
          '["leader:pike_wire","lure:bent_spoon"]' &&
          lure.depth === "lure" &&
          lure.drawn.lure &&
          !lure.drawn.cork &&
          !lure.drawn.lead &&
          !lure.drawn.worm &&
          lure.drawn.hook === 0,
        `the lure rig: ${JSON.stringify(lure)}`,
      );
      // The labels do not overlap one another.
      check(!plain.overlap && !full.overlap, `labels overlap: ${JSON.stringify([plain.boxes, full.boxes])}`);
      return `${plain.nodes.length}, ${full.nodes.length} and ${lure.nodes.length} parts`;
    },
  },

  {
    name: "rig picture: a part's tray shows its options and lines; an owned one fits and the picture follows; Murk's are priced, bought only at Murk's",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    editSave: (save) => {
      withParts(["sounding_lead", "pike_wire"])(save);
      save.meta.loop.arrivals = { ...(save.meta.loop.arrivals || {}), shelved: ["pike_wire", "chafe_gut"] };
    },
    async run(session) {
      await session.toHome();
      // Depth: both options with their two lines; the float fitted. Pressing the lead fits it and closes the tray.
      const depth = await rigTray(session, "depth");
      const allLines = await session.eval(() =>
        [...document.querySelectorAll(".gw-rig-tray .gw-rig-opt")].map(
          (o) => o.querySelectorAll(".gw-rig-line").length,
        ),
      );
      check(
        JSON.stringify(depth?.chips) ===
          '[{"key":"cork_float","on":true},{"key":"sounding_lead","on":false}]' &&
          JSON.stringify(allLines) === "[2,2]" &&
          depth.lines[0] === "Every fish bites, and you see each nibble on the float.",
        `the Depth tray: ${JSON.stringify({ depth, allLines })}`,
      );
      await session.eval(() =>
        document.querySelector('.gw-rig-tray .gw-rig-opt[data-key="sounding_lead"]').click(),
      );
      await session.pause(800);
      const after = await rigScreen(session);
      const fitted = await session.eval(() => window.__gw.progression.loop.state().fitted.depth);
      check(
        fitted === "lead" &&
          !after.trayOpen &&
          after.depth === "lead" &&
          after.nodes.find((n) => n.part === "depth")?.key === "sounding_lead",
        `after pressing the lead: ${fitted} ${JSON.stringify(after)}`,
      );
      // Leader: Chafe Gut is on Murk's shelf, not owned. It is priced under "More at Murk's" and cannot be fitted.
      const leader = await rigTray(session, "leader");
      const shop = await session.eval(() => {
        const el = document.querySelector('.gw-rig-tray .gw-rig-shop[data-buy="part:chafe_gut"]');
        return {
          head: [...document.querySelectorAll(".gw-rig-tray .gw-rig-more")].map((h) => h.textContent.trim()),
          tag: el?.tagName ?? null,
          price: el?.querySelector(".gw-rig-price")?.textContent.trim() ?? null,
          lines: el ? [...el.querySelectorAll(".gw-rig-line")].map((n) => n.textContent.trim()) : [],
          pressed: el?.hasAttribute("aria-pressed") ?? null,
        };
      });
      check(
        JSON.stringify(leader?.chips.map((c) => c.key).sort()) === '["pike_wire","plain_knot"]' &&
          JSON.stringify(leader.more) === '["part:chafe_gut"]' &&
          shop.head[0] === "More at Murk's" &&
          shop.price === "60" &&
          shop.lines[0] === "Fish with rough mouths, such as carp, bass and sturgeon, land more often." &&
          shop.pressed === false,
        `the Leader tray: ${JSON.stringify({ leader, shop })}`,
      );
      // At Murk's (home) it is a button that buys: refused with too few clams, then bought and fitted.
      const buys = await session.eval(async () => {
        const loop = window.__gw.progression.loop,
          s = loop.state(),
          press = async () => {
            document.querySelector('.gw-rig-tray .gw-rig-shop[data-buy="part:chafe_gut"]')?.click();
            await new Promise((r) => setTimeout(r, 600));
          };
        s.clams = 10;
        await press();
        const poor = { owned: s.parts.includes("chafe_gut"), fitted: s.fitted.leader, clams: s.clams };
        window.__gw.debug.loop.giveClams(500);
        await press();
        return {
          poor,
          owned: s.parts.includes("chafe_gut"),
          fitted: s.fitted.leader,
          trayOpen: !!document.querySelector('.gw-rig-tray[data-part="leader"]'),
          pressed: document
            .querySelector('.gw-rig-tray .gw-rig-opt[data-key="chafe_gut"]')
            ?.getAttribute("aria-pressed"),
        };
      });
      await closeTackle(session);
      check(
        !buys.poor.owned && buys.poor.fitted !== "chafe_gut" && buys.poor.clams === 10,
        `bought without the clams: ${JSON.stringify(buys)}`,
      );
      check(
        buys.owned && buys.fitted === "chafe_gut" && buys.trayOpen && buys.pressed === "true",
        `buying in the tray: ${JSON.stringify(buys)}`,
      );
      // The keyboard: the arrows move between the parts, Enter opens a tray, B closes it again.
      await session.eval(() => window.__gw.ui.loop.tackle.openScreen({ from: "rack" }));
      await session.pause(800);
      await session.page.keyboard.press("ArrowDown");
      await session.page.keyboard.press("ArrowDown");
      const focused = await session.eval(() => document.activeElement?.dataset?.part ?? null);
      await session.page.keyboard.press("Enter");
      await session.pause(800);
      const keyTray = await session.eval(() => document.querySelector(".gw-rig-tray")?.dataset.part ?? null);
      await session.page.keyboard.press("KeyB");
      await session.pause(800);
      const keyBack = await session.eval(() => ({
        tray: !!document.querySelector(".gw-rig-tray"),
        screen: !!document.querySelector(".gw-rig"),
        focus: document.activeElement?.dataset?.part ?? null,
      }));
      check(
        focused === "reel" &&
          keyTray === "reel" &&
          !keyBack.tray &&
          keyBack.screen &&
          keyBack.focus === "reel",
        `the keys: ${JSON.stringify({ focused, keyTray, keyBack })}`,
      );
      await closeTackle(session);
      // Out on the water Murk's lures are shown and priced in the bait's tray, but cannot be bought there.
      await session.sail();
      const raft = await rigTray(session, "bait");
      const raftShop = await session.eval(async () => {
        const loop = window.__gw.progression.loop,
          el = document.querySelector('.gw-rig-tray .gw-rig-shop[data-buy="lure:glimmer_spoon"]'),
          clams = loop.state().clams;
        el?.click();
        await new Promise((r) => setTimeout(r, 400));
        return {
          tag: el?.tagName ?? null,
          price: !!el?.querySelector(".gw-rig-price"),
          owned: loop.state().lures.includes("glimmer_spoon"),
          clamsKept: loop.state().clams === clams,
        };
      });
      await closeTackle(session);
      check(
        raft?.more.includes("lure:glimmer_spoon") &&
          raftShop.tag === "DIV" &&
          raftShop.price &&
          !raftShop.owned &&
          raftShop.clamsKept,
        `on the water: ${JSON.stringify({ raft, raftShop })}`,
      );
      return "lead fitted from its tray; Chafe Gut priced, refused, then bought at Murk's; shown but not sold on the water";
    },
  },

  {
    name: "rig picture: the limit line names the class and the part that sets it",
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.toHome();
      const limitWith = async (fit) => {
        await session.eval((f) => {
          const loop = window.__gw.progression.loop;
          loop.state().bait.mossmere.cut_strip = 3;
          loop.changeHook(f);
        }, fit);
        const r = await rigScreen(session);
        await closeTackle(session);
        return r.limit;
      };
      const worms = await limitWith({ bait: "mireworm" });
      const bare = await limitWith({ bait: null, lure: null });
      const spoon = await limitWith({ lure: "bent_spoon" });
      await buyAtHome(session, ["line:1"]);
      const wormsGut = await limitWith({ bait: "mireworm" });
      const strip = await limitWith({ bait: "cut_strip" });
      const got = { worms, bare, spoon, wormsGut, strip };
      const want = {
        worms: "Lands up to Prize: the line is the limit.",
        bare: "Lands up to Keeper: the bare hook is the limit.",
        spoon: "Lands up to Keeper: the lure is the limit.",
        wormsGut: "Lands up to Trophy: the line is the limit.",
        strip: "Lands up to Prize: the bait is the limit.",
      };
      for (const [k, text] of Object.entries(want))
        check(got[k]?.text === text, `${k}: "${got[k]?.text}", expected "${text}"`);
      return Object.values(want).length + " rigs";
    },
  },

  {
    name: "rig picture: Here, now lists at most five caught fish that bite this rig here, as the Odds engine says, with the lead and the leader; never her",
    fixture: "legend-sold",
    debug: true,
    editSave: withParts(["sounding_lead", "chafe_gut"]),
    async run(session) {
      await session.toHome();
      const r = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          s = loop.state(),
          journal = window.__gw.state.meta?.journal ?? {},
          caught = (id) => Number(journal[id]?.caught) > 0,
          here = (rig, live = null) => loop.rigHereNow(live, null, rig),
          shares = (h) => Object.fromEntries(h.fish.map((f) => [f.id, f.share])),
          // The Odds page's rows for the same rig, place and light: caught kinds only, likeliest first.
          odds = (view = {}) =>
            (loop.sheet(view)?.odds?.rows || [])
              .filter((row) => !row.legend && caught(row.id) && row.share > 0)
              .map((row) => row.id),
          out = {};
        loop.changeHook({ bait: "mireworm" });
        const worms = here({ bait: "mireworm" });
        out.worms = worms.fish.map((f) => f.id);
        out.wormsOdds = odds().slice(0, 5);
        out.wormsAll = odds().length;
        out.unmet = worms.unmet;
        out.allCaught = worms.fish.every((f) => caught(f.id));
        s.bait.mossmere.live_minnow = 2;
        loop.changeHook({ bait: "live_minnow" });
        out.live = here({ bait: "live_minnow" }).fish.map((f) => f.id);
        loop.changeHook({ bait: "mireworm" });
        // The lead: a bottom feeder comes more often. Chafe Gut: a Dusk Minnow comes less often.
        out.floatShares = shares(here({ bait: "mireworm" }));
        loop.fitDepth("lead");
        out.leadShares = shares(here({ bait: "mireworm" }));
        loop.fitDepth("float");
        loop.fitPart("leader", "chafe_gut");
        out.gutShares = shares(here({ bait: "mireworm" }));
        loop.fitPart("leader", "plain_knot");
        // Her water at night on her rig: the Odds page has her, the strip never does.
        loop.markLifted("bell_pool");
        loop.fitDepth("lead");
        loop.changeHook({ bait: "live_minnow" });
        const pool = here({ bait: "live_minnow" }, { place: "bell_pool", light: "night" });
        out.pool = pool.fish.map((f) => f.id);
        out.poolPlace = pool.place;
        out.herOdds = (loop.sheet({ place: "bell_pool", light: "night" })?.odds?.rows || []).some(
          (row) => row.id === "belled_matriarch" && row.share > 0,
        );
        loop.fitDepth("float");
        loop.changeHook({ bait: "mireworm" });
        return out;
      });
      check(r.allCaught && r.worms.length <= 5, `named: ${JSON.stringify(r.worms)}`);
      check(
        JSON.stringify(r.worms) === JSON.stringify(r.wormsOdds) && r.worms.length === Math.min(5, r.wormsAll),
        `not the Odds page's fish: ${JSON.stringify(r)}`,
      );
      check(
        r.worms.some((id) => GRAZERS.includes(id)) && !r.live.some((id) => GRAZERS.includes(id)),
        `the bait does not change the strip: worms ${r.worms}, live ${r.live}`,
      );
      check(
        r.leadShares.rustfin_sucker > r.floatShares.rustfin_sucker,
        `the lead does not bring the sucker more often: ${JSON.stringify([r.floatShares, r.leadShares])}`,
      );
      check(
        r.gutShares.dusk_minnow < r.floatShares.dusk_minnow,
        `Chafe Gut does not put the minnow off: ${JSON.stringify([r.floatShares, r.gutShares])}`,
      );
      check(
        r.poolPlace === "bell_pool" && r.herOdds && !r.pool.includes("belled_matriarch"),
        `her water: ${JSON.stringify(r)}`,
      );
      // On the screen: the same names, and the count of kinds not caught.
      const screen = await rigScreen(session);
      await closeTackle(session);
      check(
        JSON.stringify(screen.here) === JSON.stringify(r.worms) &&
          (r.unmet > 0 ? screen.unmetText != null : screen.unmetText == null),
        `the strip on screen: ${JSON.stringify(screen)} vs ${JSON.stringify(r)}`,
      );
      return `worms: ${r.worms.join(", ")}; live: ${r.live.join(", ")}; ${screen.unmetText ?? "none uncaught"}`;
    },
  },

  {
    name: "rig picture: Sporewood's tackle screen still works, with no Depth, and Mossmere's Leader and Hook parts never on it",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: (save) => {
      withLead(true)(save);
      withParts(["pike_wire", "turnback_hook"], { leader: "pike_wire", hook: "turnback_hook" })(save);
    },
    async run(session) {
      await session.toHome();
      const r = await rigScreen(session);
      const bait = await rigTray(session, "bait");
      await closeTackle(session);
      check(
        JSON.stringify(r.nodes.map((n) => n.part)) === '["rod","reel","line","bait"]' &&
          r.nodes[3].key === "spore_cake" &&
          r.drawn.cork &&
          !r.drawn.lead &&
          r.limit?.by === "line",
        `Sporewood's picture: ${JSON.stringify(r)}`,
      );
      check(
        bait?.chips.some((c) => c.key === "spore_cake" && c.on),
        `Sporewood's bait tray: ${JSON.stringify(bait)}`,
      );
      return `${r.limit.text}`;
    },
  },

  {
    name: "sheet in Sporewood: the Odds page lists only Sporewood's places, never Mossmere's (the maps of both lakes are in one list)",
    fixture: "sporewood-crossed",
    debug: true,
    async run(session) {
      await session.toHome();
      const r = await session.eval(() => {
        const g = window.__gw,
          loop = g.progression.loop;
        return {
          owned: loop.state().maps.places,
          choices: loop.sheet({}).picks.choices.map((c) => c.id),
        };
      });
      check(r.owned.includes("lily_maze"), `the fixture owns no Mossmere map: ${JSON.stringify(r)}`);
      check(
        sameJson(r.choices, [null, "lullaby", "gill_harp"]),
        `the Odds page's places in Sporewood: ${JSON.stringify(r.choices)}`,
      );
      await session.eval(() => window.__gw.ui.openJournal({ tab: "sheet" }));
      await session.waitFor("the Sheet", 10_000, () => !!document.querySelector(".gw-kit-row"));
      await session.eval(() => document.querySelector('[data-sheet-page="odds"]')?.click());
      await session.pause(800);
      const odds = await visibleText(session, ".gw-kit-page");
      check(
        odds.includes("The Lullaby") && !/Lily Maze|Under the Span|Buoy Lights|Bell Pool/.test(odds),
        `the Odds page on screen: ${odds.slice(0, 400)}`,
      );
      return r.choices.map((id) => id ?? "open water").join(", ");
    },
  },
  {
    name: "sheet in Sporewood: no Rivals page, as Old Rivals come only from Mossmere's water; the Journal's hints for Sporewood's fish say where, when and on what they bite",
    fixture: "sporewood-crossed",
    debug: true,
    async run(session) {
      await session.toHome();
      await session.eval(() => window.__gw.ui.openJournal({ tab: "sheet" }));
      await session.waitFor("the Sheet", 10_000, () => !!document.querySelector(".gw-kit-row"));
      const tabs = await session.eval(() =>
        [...document.querySelectorAll("[data-sheet-page]")].map((b) => b.dataset.sheetPage),
      );
      check(sameJson(tabs, ["buffs", "tackle", "raft", "home", "odds"]), `the Sheet's tabs: ${tabs}`);
      // innerText leaves out the pages that are not shown.
      const page = await session.eval(() => document.querySelector(".gw-kit-page")?.innerText ?? "");
      check(!/Old Rivals|big ones that get away/.test(page), `a Rivals page shows: ${page.slice(0, 300)}`);
      await backToJetty(session);
      // The hints of fish not yet caught (the measured bites are in the Sporewood audit's table).
      const WANT = {
        sleepspore_jelly: "It bites only in the Lullaby, by day and at dusk, and only on Amber Larvae.",
        nightbloom_carp: "It bites only at night, and only in the Veilwater.",
        mildew_angler:
          "It bites only at night, and Amber Larvae suits it best. It feeds most in the Lullaby, the Gill Harp and the Mother's Cup.",
        velvet_ray: "It bites at any hour and feeds most in the Lullaby. The Root Jig suits it best.",
        capshell_crayfish:
          "It bites at any hour, all over the pools. Spore Cake, Amber Larvae and the Root Jig all suit it.",
        harpstring_eel: "It never leaves the gill-strings, so it bites only at the Gill Harp.",
      };
      for (const [id, want] of Object.entries(WANT)) {
        await session.eval((id) => window.__gw.ui.openJournal({ zone: "sporewood", sel: id }), id);
        await session.waitFor(`${id}'s page`, 10_000, () => !!document.querySelector(".gw-jr-where"));
        const where = await visibleText(session, ".gw-jr-where");
        check(where === want, `${id}: the Journal says "${where}", expected "${want}"`);
        await backToJetty(session);
      }
      // Nightbloom Carp keeps its Mossmere line, where it is a guest on the lily pads at night.
      const mossmere = await session.eval(() => window.__gw.data.SPECIES_BY_ID.nightbloom_carp.hint);
      check(
        mossmere === "It bites only at night, and it likes the lily pads best.",
        `the carp's own hint: ${mossmere}`,
      );
      const gloom = await session.eval(() =>
        window.__gw.data.SPECIES.filter((sp) => /Gloomtide/.test(sp.hint || "")).map((sp) => sp.id),
      );
      check(gloom.length === 0, `hints that still say Gloomtide: ${gloom}`);
      return `tabs ${tabs.join(", ")}; ${Object.keys(WANT).length} hints`;
    },
  },
  {
    name: "Sporewood's list of 12: the Sporebelly Puffer, Plumgill Perch and Hushcap Koi each bite in a niche of their own by the game's own roll, are landed there, show on the lake's page and in its count, and their hints are true",
    fixture: "sporewood-crossed",
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      // Each one's niche: its hour, its place and its bait or lure, and an hour when it never bites.
      const THREE = {
        sporebelly_puffer: {
          name: "Sporebelly Puffer",
          light: "calm",
          off: "gloomtide",
          place: "lullaby",
          rig: { lure: "seedpod_twirl" },
          hint: "It bites only by day and at dusk, and feeds most in the Lullaby. The Seedpod Twirl suits it best.",
          line: "It bites only by day and at dusk. It feeds at any depth.",
        },
        plumgill_perch: {
          name: "Plumgill Perch",
          light: "dusk",
          off: "calm",
          place: "gill_harp",
          rig: { lure: "spore_moth" },
          hint: "It bites only at dusk and at night, and feeds most at the Gill Harp. The Spore Moth suits it best.",
          line: "It bites only at dusk and at night. It feeds at any depth.",
        },
        hushcap_koi: {
          name: "Hushcap Koi",
          light: "gloomtide",
          off: "calm",
          place: "veilwater",
          rig: { lure: null, bait: "spore_cake" },
          hint: "It bites only at night, and feeds most in the Veilwater. Spore Cake suits it best.",
          line: "It bites only at night. It feeds at any depth.",
        },
      };
      await session.toHome();
      const before = await session.eval(() => window.__gw.progression.loop.listCount("sporewood"));
      check(before.need === 12 && before.have === 2, `Sporewood's list before: ${JSON.stringify(before)}`);
      // Not yet caught, each one's Journal page shows its hint.
      for (const [id, f] of Object.entries(THREE)) {
        await session.eval((id) => window.__gw.ui.openJournal({ zone: "sporewood", sel: id }), id);
        await session.waitFor(`${id}'s page`, 10_000, () => !!document.querySelector(".gw-jr-where"));
        const where = await visibleText(session, ".gw-jr-where");
        check(where === f.hint, `${id}: the Journal says "${where}", expected "${f.hint}"`);
        await backToJetty(session);
      }
      await session.sail();
      await session.eval(() => {
        const g = window.__gw,
          loop = g.progression.loop;
        g.debug.loop.giveClams(5000);
        for (const item of ["place:veilwater", "lure:spore_moth"]) loop.buy(item);
        loop.markLifted("veilwater");
      });
      const seen = [];
      for (const [id, f] of Object.entries(THREE)) {
        // The game's own odds for this rig: at its place in its hour, in open water then, and at its place in
        // an hour it never bites. Then the game's own roll, cast after cast at its place, until it bites.
        const r = await session.eval(
          ([id, f]) => {
            const d = window.__gw.debug,
              loop = window.__gw.progression.loop;
            loop.changeHook(f.rig);
            const share = (light, place) => {
              d.setPhase(light);
              const roll = d.fishPoolRoll(1, { place, bait: f.rig.bait ?? null });
              return {
                place: roll.place,
                p: roll.shares?.[id] ?? 0,
                top: Math.max(...Object.values(roll.shares)),
              };
            };
            const out = {
              home: share(f.light, f.place),
              open: share(f.light, null),
              off: share(f.off, f.place),
            };
            d.setPhase(f.light);
            d.fishSeed(7);
            for (out.casts = 1; out.casts <= 400; out.casts++) {
              const roll = d.fishPoolRoll(1, { place: f.place, bait: f.rig.bait ?? null });
              if (roll.counts[id]) break;
            }
            return out;
          },
          [id, f],
        );
        check(r.home.place === f.place, `${id}: rolled at ${r.home.place}, not ${f.place}`);
        check(
          r.home.p >= 0.15 && r.home.p >= 2 * r.open.p,
          `${id}: share ${r.home.p} at ${f.place}, ${r.open.p} in open water`,
        );
        check(r.off.p === 0, `${id} bites at ${f.place} in the wrong hour: ${r.off.p}`);
        check(r.casts <= 400, `${id} never bit in 400 casts at ${f.place}`);
        await session.catchFish(id);
        seen.push(
          `${id} ${(100 * r.home.p).toFixed(0)}% at ${f.place} (open ${(100 * r.open.p).toFixed(0)}%), cast ${r.casts}`,
        );
      }
      // The lake's page: the three by name, the count of 12, and each one's line now that it is caught.
      const after = await session.eval(() => window.__gw.progression.loop.listCount("sporewood"));
      check(after.need === 12 && after.have === 5, `Sporewood's list after: ${JSON.stringify(after)}`);
      await session.eval(() => window.__gw.ui.openJournal({ zone: "sporewood" }));
      await session.waitFor("the Journal", 10_000, () => !!document.querySelector(".gw-m-catalogue .gw-tab"));
      const tabs = await visibleText(session, ".gw-m-catalogue .gw-tab");
      check(/Sporewood[^|]*5\/12/.test(tabs), `the Journal's tabs: ${tabs}`);
      // The lake's page: its head counts the list, and each fish on the list carries a notch.
      await session.waitFor(
        "the lake's page",
        15_000,
        () => !!document.querySelector(".gw-cat-list .gw-cat-card"),
      );
      const page = await session.eval(() => ({
        count: document.querySelector(".gw-cat-head .gw-cat-count")?.textContent ?? "",
        listed: [...document.querySelectorAll(".gw-cat-list .gw-cat-card")]
          .filter((card) => card.querySelector(".gw-jr-notch"))
          .map((card) => card.querySelector(".gw-cat-name > span")?.textContent ?? ""),
      }));
      check(
        page.listed.length === 12 && /5\D+12/.test(page.count),
        `the lake's page: ${JSON.stringify(page)}`,
      );
      for (const f of Object.values(THREE))
        check(page.listed.includes(f.name), `${f.name} is not on the lake's list: ${page.listed}`);
      await session.eval(() => window.__gw.ui.closeAll());
      for (const [id, f] of Object.entries(THREE)) {
        await session.eval((id) => window.__gw.ui.openJournal({ zone: "sporewood", sel: id }), id);
        await session.waitFor(`${id}'s page`, 10_000, () => !!document.querySelector(".gw-jr-where"));
        const where = await visibleText(session, ".gw-jr-where");
        check(where === f.line, `${id} caught: the Journal says "${where}", expected "${f.line}"`);
        await session.eval(() => window.__gw.ui.closeAll());
      }
      return `${seen.join("; ")}; list ${after.have}/${after.need}`;
    },
  },
  {
    name: "guide in Sporewood: the first-play card about worms and the spoon does not come up after a cast and a catch there, on a save whose guide is not finished",
    fixture: "sporewood-crossed",
    debug: true,
    // Every other card of the opening guide seen, so only the tackle card could come up.
    editSave(save) {
      Object.assign(save.meta.guide.seen, { bite: true, fight: true, card: true, away: true });
      save.meta.guide.on = true;
      delete save.meta.guide.seen.tackle;
    },
    async run(session) {
      await session.toHome();
      await session.sail({ water: "sporewood", timeoutMs: 200_000 });
      await session.eval(() => {
        const g = window.__gw;
        window.__guidesSeen = [];
        setInterval(() => {
          for (const el of document.querySelectorAll('.gw-modal[data-modal="guide"] .gw-guide'))
            window.__guidesSeen.includes(el.className) || window.__guidesSeen.push(el.className);
        }, 200);
        const p = g.player.position,
          yaw = g.render.getYaw();
        g.debug.castAt(p.x - Math.sin(yaw) * 9, p.z - Math.cos(yaw) * 9, 0.6);
      });
      await session.waitFor("the float out", 15_000, () => window.__gw.fishing.state === "waiting");
      await session.eval(() => window.__gw.fishing.reelInQuiet?.());
      await session.catchFish("netcloud_fry");
      await session.pause(6000);
      const r = await session.eval(() => ({
        seen: window.__guidesSeen,
        tackle: window.__gw.state.meta.guide?.seen?.tackle ?? null,
        on: window.__gw.state.meta.guide?.on,
        fish: window.__gw.fishing.state,
        tin: !!document.querySelector("[data-loop=tin]"),
      }));
      check(r.on === true && r.tin, `the guide is off or there is no tin: ${JSON.stringify(r)}`);
      check(
        !r.seen.some((c) => c.includes("gw-guide--tackle")) && r.tackle !== true,
        `the tackle card came up in Sporewood: ${JSON.stringify(r)}`,
      );
      return `cards seen: ${r.seen.join(", ") || "none"}`;
    },
  },

  {
    name: "home in Sporewood: the barge's menu always comes back, after Escape on the chart and with every screen closed (Escape, P or a tap), and Sail still sets out",
    fixture: "sporewood-crossed",
    debug: true,
    async run(session) {
      await session.toHome();
      return homeMenuComesBack(session, "sporewood");
    },
  },
  {
    name: "home in Mossmere: the barge's menu always comes back, after Escape on the chart and with every screen closed (Escape, P or a tap), and Sail still sets out; the Sheet keeps its Rivals page",
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.toHome();
      await session.eval(() => window.__gw.ui.openJournal({ tab: "sheet" }));
      await session.waitFor("the Sheet", 10_000, () => !!document.querySelector(".gw-kit-row"));
      const tabs = await session.eval(() =>
        [...document.querySelectorAll("[data-sheet-page]")].map((b) => b.dataset.sheetPage),
      );
      check(tabs.includes("rivals"), `Mossmere's Sheet has no Rivals page: ${tabs}`);
      await backToJetty(session);
      return homeMenuComesBack(session, "mossmere");
    },
  },

  {
    name: "rig picture: a red notch and a brass tick show on the piece they were made on, on the tackle screen, the Sheet and Murk's Tackle tab, and not once that part is changed",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 360_000,
    editSave: (save) => {
      RIG_PARTS_SAVE(save);
      withParts(["sounding_lead", "pike_wire", "turnback_hook"], {
        depth: "lead",
        leader: "plain_knot",
        hook: "turnback_hook",
      })(save);
      save.meta.loop.rigMarks = {
        notch: ["leader:plain_knot", "depth:cork_float"],
        tick: ["hook:turnback_hook"],
      };
    },
    async run(session) {
      await session.toHome();
      const want = '["hook:turnback_hook:tick","leader:plain_knot:notch"]';
      const screen = await rigScreenMarks(session);
      check(
        JSON.stringify(screen?.labels) === want &&
          JSON.stringify(screen.notch) === '["leader"]' &&
          JSON.stringify(screen.tick) === '["hook"]',
        `the tackle screen: ${JSON.stringify(screen)}`,
      );
      for (const where of ["sheet", "shop"]) {
        await openRigHost(session, where);
        const shown = await rigMarksShown(session, RIG_HOST[where]);
        await backToJetty(session);
        check(JSON.stringify(shown?.labels) === want, `${where}: ${JSON.stringify(shown)}`);
      }
      // A changed part loses its mark: Pike Wire on, then the float back on (the cork carries its own notch).
      await session.eval(() => {
        const loop = window.__gw.progression.loop;
        loop.fitPart("leader", "pike_wire");
        loop.fitDepth("float");
      });
      const changed = await rigScreenMarks(session);
      check(
        JSON.stringify(changed?.labels) === '["depth:cork_float:notch","hook:turnback_hook:tick"]',
        `after the changes: ${JSON.stringify(changed)}`,
      );
      return `${JSON.parse(want).join(", ")} on all three; then ${changed.labels.join(", ")}`;
    },
  },

  {
    name: "rig picture: her losses notch the part that broke and tick the parts that held before it; landing her ticks all three and clears every notch",
    fixture: "legend-sold",
    // Her hunt is not over: she has never been landed in this copy of the save.
    editSave: unsold(),
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1"]);
      await fitHerParts(session, { hook: "mere_hook", leader: "plain_knot", depth: "lead" });
      await session.sail();
      const line = await session.eval(() => window.__gw.progression.loop.state().tackle.line);
      check(line === 1, `the line is tier ${line}, expected Braided Gut (1)`);
      const steps = [
        { rig: { hook: "mere_hook", leader: "plain_knot" }, part: "hook", marks: ["hook:mere_hook:notch"] },
        {
          rig: { hook: "turnback_hook", leader: "plain_knot" },
          part: "leader",
          marks: ["hook:turnback_hook:tick", "leader:plain_knot:notch"],
        },
        {
          rig: { hook: "turnback_hook", leader: "chafe_gut" },
          part: "line",
          marks: ["hook:turnback_hook:tick", "leader:chafe_gut:tick", "line:"],
        },
      ];
      for (const step of steps) {
        await herRig(session, step.rig);
        const hooked = await hookAndPlayOut(session, LEGEND_ID, "land");
        check(
          hooked.escape?.legendLossReason === step.part,
          `${step.part}: ${JSON.stringify({ p: hooked.p, escape: hooked.escape })}`,
        );
        await session.closeGuides(3000);
        const shown = await rigScreenMarks(session);
        const ok =
          shown?.labels.length === step.marks.length &&
          step.marks.every((m, k) =>
            m.endsWith(":")
              ? shown.labels[k].startsWith(m) && shown.labels[k].endsWith(":notch")
              : shown.labels[k] === m,
          );
        check(ok, `after the ${step.part} loss: ${JSON.stringify(shown)}`);
        check(
          shown.notch.includes(step.part),
          `no notch drawn on the ${step.part}: ${JSON.stringify(shown)}`,
        );
      }
      // Waxed Silk on, and she is landed: all three held, so all three are ticked and no notch is left.
      await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        s.tackle.line = 2;
        s.fit && delete s.fit.line;
      });
      const landed = await hookAndPlayOut(session, LEGEND_ID, "land");
      check(landed.landed === LEGEND_ID, `she was not landed: ${JSON.stringify(landed)}`);
      await session.clickButton(/^\d?(Keep|Let go)\b/);
      await session.pause(800);
      await session.closeGuides(5000);
      const end = await rigScreenMarks(session);
      check(
        end?.labels.length === 3 &&
          end.labels.every((l) => l.endsWith(":tick")) &&
          JSON.stringify(end.tick) === '["hook","leader","line"]' &&
          !end.notch.length,
        `after the landing: ${JSON.stringify(end)}`,
      );
      const saved = JSON.parse(await session.saved()).meta.loop.rigMarks;
      check(
        saved?.tick?.length >= 3 && saved.notch.length === 0,
        `the written save: ${JSON.stringify(saved)}`,
      );
      return `notched hook, leader, line in turn; landed: ${end.labels.join(", ")}`;
    },
  },

  // ---- the words pass: the Journal and the Sheet in the house voice (voice.md) ----------------------------------
  {
    name: "words: each caught fish's Journal line says when it bites and where it feeds, in whole sentences that match the game",
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.toHome();
      // The game's own rules for each caught Mossmere fish: its hours on the loop and its row in the depth table.
      const fish = await session.eval(() => {
        const g = window.__gw,
          journal = g.state.meta.journal || {};
        return g.data.SPECIES.filter((s) => s.zone === "mossmere" && journal[s.id]?.caught > 0).map((s) => ({
          id: s.id,
          hours: g.data.loopHours(s),
          giant: !!s.giant,
        }));
      });
      check(fish.length >= 8, `only ${fish.length} caught fish in the fixture`);
      // Where each one feeds, as the depth table (mossmere-gear.md B2) puts it.
      const FEEDS = {
        rustfin_sucker: "bottom",
        weeping_carp: "bottom",
        milkeye_perch: "bottom",
        dusk_minnow: "high",
        reedjaw_pike: "high",
      };
      const HOURS = { day: "by day", dusk: "at dusk", night: "at night" };
      const FEED_WORDS = {
        bottom: "It feeds on the bottom.",
        high: "It feeds high in the water.",
        any: "It feeds at any depth.",
      };
      const lines = [];
      for (const f of fish) {
        await session.eval((id) => window.__gw.ui.openJournal({ sel: id }), f.id);
        await session.waitFor(
          `${f.id}'s Journal page`,
          10_000,
          () => !!document.querySelector(".gw-jr-where"),
        );
        const where = await visibleText(session, ".gw-jr-where");
        const named = f.hours.map((h) => HOURS[h]);
        const when =
          f.hours.length >= 3
            ? "at any hour"
            : `${f.giant ? "most" : "only"} ${named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}` : named[0]}`;
        const want = `It bites ${when}. ${FEED_WORDS[FEEDS[f.id] || "any"]}`;
        check(where === want, `${f.id}: the Journal says "${where}", the game's rules say "${want}"`);
        lines.push(where);
      }
      // The fish that bite only by day and at dusk say so (they once read "at any hour").
      check(
        lines.includes("It bites only by day and at dusk. It feeds at any depth."),
        `no day and dusk fish among ${JSON.stringify(lines)}`,
      );
      // The Sheet's Overview and Odds pages: whole sentences, with no "+", "×", "→" or "·" in a line.
      await session.eval(() => window.__gw.ui.openJournal({ tab: "sheet" }));
      await session.waitFor("the Sheet", 10_000, () => !!document.querySelector(".gw-kit-row"));
      const overview = await session.eval(() =>
        [...document.querySelectorAll(".gw-kit-context, .gw-kit-row > span")].map((el) =>
          el.textContent.trim(),
        ),
      );
      for (const line of overview)
        check(
          /^[A-Z].*\.$/.test(line) && !/[+×→·]/.test(line),
          `an Overview line is not a plain sentence: "${line}"`,
        );
      check(
        /^At home, this shows what helps you .+\.$/.test(overview[0]),
        `the Overview's first line: "${overview[0]}"`,
      );
      await session.eval(() => document.querySelector('[data-sheet-page="odds"]')?.click());
      await session.pause(800);
      const odds = await visibleText(session, ".gw-kit-page, .gw-sh-sec");
      check(
        odds.includes("A clean strike helps a little. Too early or too late costs a little.") &&
          !odds.includes("an early or late one"),
        `the Odds page's strike line: ${odds.slice(0, 400)}`,
      );
      check(
        /You have yet to meet \d+ more here\./.test(odds),
        `the Odds page's line for fish not met: ${odds.slice(0, 400)}`,
      );
      return `${fish.length} fish; ${overview.length} Overview lines`;
    },
  },

  // ---- saved rigs (mossmere-gear.md "Saved rigs", B4, B6; mossmere-gear-deeper.md "The rig picture and saved rigs")

  {
    name: "saved rigs: a fresh game has three plain rigs, Rig 1 in use and named from what is on it; an old save loads with Rig 1 as its fitted rig",
    fixture: "mid-mossmere",
    debug: true,
    // An old save (no rigs yet) with its own rig fitted: Lumen Moss, not the plain worms.
    editSave: (save) => {
      delete save.meta.loop.rigs, delete save.meta.loop.activeRig;
      save.meta.loop.fitted = { ...save.meta.loop.fitted, lure: null, bait: "lumen_moss" };
    },
    async run(session) {
      await session.toHome();
      const r = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          meta = window.__gw.state.meta,
          read = () => {
            const s = loop.state();
            return {
              rigs: JSON.parse(JSON.stringify(s.rigs)),
              active: s.activeRig,
              fitted: { ...s.fitted },
              names: loop.savedRigs().rigs.map((rg) => rg.name),
            };
          };
        const old = read();
        // A fresh game: the loader builds a new loop when the save has none.
        const kept = meta.loop;
        delete meta.loop;
        const fresh = read();
        meta.loop = kept;
        return { old, fresh, back: read() };
      });
      const plain = { lure: null, bait: "mireworm", depth: "float", leader: "plain_knot", hook: "mere_hook" };
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      check(
        r.fresh.rigs.length === 3 &&
          r.fresh.rigs.every((rg) => same(rg, plain)) &&
          r.fresh.active === 0 &&
          same(r.fresh.fitted, plain) &&
          same(r.fresh.names, ["Cork · Worms", "Cork · Worms", "Cork · Worms"]),
        `a fresh game's rigs: ${JSON.stringify(r.fresh)}`,
      );
      check(
        r.old.rigs.length === 3 &&
          r.old.active === 0 &&
          same(r.old.rigs[0], { ...plain, bait: "lumen_moss" }) &&
          same(r.old.rigs[1], plain) &&
          same(r.old.rigs[2], plain) &&
          r.old.names[0] === "Cork · Lumen Moss" &&
          same(r.back.rigs, r.old.rigs),
        `the old save's rigs: ${JSON.stringify(r.old)}`,
      );
      // The tackle screen shows them as three tabs, Rig 1 pressed.
      const tabs = await rigTabsShown(session);
      await closeTackle(session);
      check(
        same(
          tabs.map((t) => `${t.label}|${t.name}|${t.on}`),
          ["Rig 1|Cork · Lumen Moss|true", "Rig 2|Cork · Worms|false", "Rig 3|Cork · Worms|false"],
        ),
        `the tabs: ${JSON.stringify(tabs)}`,
      );
      return r.old.names.join(", ");
    },
  },

  {
    name: "saved rigs: a part changed on the picture changes only the rig in use; a tab fits its rig, and the first comes back as it was",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withParts(["sounding_lead", "pike_wire", "turnback_hook"]),
    async run(session) {
      await session.toHome();
      // Rig 1: the lead, Pike Wire and the Turnback Hook with Lumen Moss, fitted part by part.
      const one = await session.eval(() => {
        const loop = window.__gw.progression.loop;
        loop.fitDepth("lead"), loop.fitPart("leader", "pike_wire"), loop.fitPart("hook", "turnback_hook");
        loop.changeHook({ bait: "lumen_moss" });
        const s = loop.state();
        return { rigs: JSON.parse(JSON.stringify(s.rigs.slice(1))), names: loop.savedRigs().rigs };
      });
      check(
        one.rigs.every(
          (rg) => rg.bait === "mireworm" && rg.depth === "float" && rg.leader === "plain_knot",
        ) &&
          one.names[0].name === "Bottom · Lumen Moss" &&
          one.names[0].leader === "pike_wire" &&
          one.names[0].hook === "turnback_hook" &&
          one.names[1].name === "Cork · Worms" &&
          !one.names[1].leader,
        `the other rigs changed: ${JSON.stringify(one)}`,
      );
      // Rig 2's tab: its plain parts are fitted and the picture follows.
      const pressTab = async (n) => {
        await session.eval(() => window.__gw.ui.loop.tackle.openScreen({ from: "rack" }));
        await session.pause(800);
        await session.eval((k) => document.querySelector(`.gw-rig-tab[data-rig="${k}"]`)?.click(), n);
        await session.pause(800);
        const shown = await rigScreen(session);
        const tabs = await session.eval(() =>
          [...document.querySelectorAll(".gw-rig-tab")].map((b) => b.getAttribute("aria-pressed")),
        );
        const fitted = await session.eval(() => ({ ...window.__gw.progression.loop.state().fitted }));
        await closeTackle(session);
        return { shown, tabs, fitted };
      };
      const two = await pressTab(2);
      check(
        JSON.stringify(two.fitted) ===
          '{"lure":null,"bait":"mireworm","depth":"float","leader":"plain_knot","hook":"mere_hook"}' &&
          two.shown.depth === "float" &&
          two.shown.drawn.cork &&
          two.shown.drawn.worm &&
          two.shown.nodes.find((nd) => nd.part === "leader")?.key === "plain_knot" &&
          JSON.stringify(two.tabs) === '["false","true","false"]',
        `Rig 2: ${JSON.stringify(two)}`,
      );
      // A change now goes on Rig 2 only.
      const changed = await session.eval(() => {
        const loop = window.__gw.progression.loop;
        loop.changeHook({ lure: "bent_spoon" });
        return loop.savedRigs().rigs.map((rg) => rg.name);
      });
      check(
        JSON.stringify(changed) === '["Bottom · Lumen Moss","Bent Spoon","Cork · Worms"]',
        `after changing Rig 2: ${JSON.stringify(changed)}`,
      );
      const back = await pressTab(1);
      check(
        JSON.stringify(back.fitted) ===
          '{"lure":null,"bait":"lumen_moss","depth":"lead","leader":"pike_wire","hook":"turnback_hook"}' &&
          back.shown.depth === "lead" &&
          back.shown.drawn.wire &&
          JSON.stringify(back.tabs) === '["true","false","false"]',
        `back on Rig 1: ${JSON.stringify(back)}`,
      );
      const kept = await session.eval(() => window.__gw.progression.loop.state().rigs[1]);
      check(kept.lure === "bent_spoon", `Rig 2 lost its lure: ${JSON.stringify(kept)}`);
      return changed.join(", ");
    },
  },

  {
    name: "saved rigs: the chip on the water shows the rig's name, a tap fits the next rig and the next cast fishes it; it does nothing while a cast is out or a fish is on",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 360_000,
    editSave: (save) => {
      withParts(["sounding_lead"])(save);
      const plain = { lure: null, bait: "mireworm", depth: "float", leader: "plain_knot", hook: "mere_hook" };
      save.meta.loop.rigs = [plain, { ...plain, bait: "lumen_moss", depth: "lead" }, plain];
      save.meta.loop.activeRig = 0;
    },
    async run(session) {
      await session.sail();
      const chip = () =>
        session.eval(() => {
          const el = document.querySelector(".gw-rig-chip");
          return el && !el.hidden && el.getBoundingClientRect().width > 0
            ? { text: el.textContent.trim(), busy: el.classList.contains("gw-busy") }
            : null;
        });
      const tap = () => session.eval(() => document.querySelector(".gw-rig-chip")?.click());
      const rigNow = () =>
        session.eval(() => {
          const g = window.__gw,
            loop = g.progression.loop;
          return {
            active: loop.state().activeRig,
            bait: g.state.run?.equippedBait ?? null,
            lead: loop.leadFishes(),
          };
        });
      const first = await chip();
      check(first?.text === "Cork · Worms" && !first.busy, `the chip: ${JSON.stringify(first)}`);
      await tap();
      await session.pause(500);
      const second = { chip: await chip(), rig: await rigNow() };
      check(
        second.chip?.text === "Bottom · Lumen Moss" &&
          second.rig.active === 1 &&
          second.rig.bait === "lumen_moss" &&
          second.rig.lead === true,
        `after one tap: ${JSON.stringify(second)}`,
      );
      // A cast: it fishes the new rig. While it is out, a tap does nothing.
      const cast = await session.eval(async () => {
        const g = window.__gw,
          p = g.player.position,
          yaw = g.render.getYaw();
        g.debug.castAt(p.x - Math.sin(yaw) * 9, p.z - Math.cos(yaw) * 9, 0.6);
        for (let i = 0; i < 40 && g.fishing.state !== "waiting"; i++)
          await new Promise((r) => setTimeout(r, 250));
        return { state: g.fishing.state, line: g.fishing.hookLine?.() ?? null };
      });
      check(
        cast.state === "waiting" && cast.line?.castBait === "lumen_moss",
        `the cast: ${JSON.stringify(cast)}`,
      );
      const outChip = await chip();
      await tap();
      await session.pause(500);
      const whileOut = await rigNow();
      check(
        outChip?.busy && whileOut.active === 1 && whileOut.bait === "lumen_moss",
        `a tap while the cast is out: ${JSON.stringify({ outChip, whileOut })}`,
      );
      // A fish on (its catch card up): a tap does nothing.
      await session.eval(() => {
        window.__gw.fishing.reelInQuiet?.();
        return window.__gw.debug.instantCatch("dusk_minnow");
      });
      await session.pause(1500);
      const onState = await session.eval(() => window.__gw.progression.loop.canChangeHook());
      await tap();
      await session.pause(500);
      const whileOn = await rigNow();
      check(
        onState === false && whileOn.active === 1,
        `a tap with a fish on: ${JSON.stringify({ onState, whileOn })}`,
      );
      return `${first.text} > ${second.chip.text}; refused with a cast out and with a fish on`;
    },
  },

  {
    name: "saved rigs: the lead's gift goes in the kit, changes no rig and the tally says how to fit it; a bought leader or hook goes on the rig in use and says so",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 480_000,
    async run(session) {
      await session.sail();
      await session.catchFish("dusk_minnow");
      const gift = await tallyAndGift(session);
      const r = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          s = loop.state();
        return {
          rigs: JSON.parse(JSON.stringify(s.rigs)),
          active: s.activeRig,
          names: loop.savedRigs().rigs.map((rg) => rg.name),
          giftRig: s.lastTrip?.giftRig ?? null,
        };
      });
      // The rigs are the player's own: the gift fills none of them, and the tally says where to fit it.
      check(
        gift?.text.includes(GIFT_LINE) &&
          gift.text.includes("To fit it, press the float on the Tackle screen.") &&
          !gift.text.includes("It is on Rig"),
        `the gift block: ${JSON.stringify(gift)}`,
      );
      check(
        r.active === 0 &&
          r.giftRig === null &&
          r.rigs.every((rig) => rig.depth === "float" && rig.bait === "mireworm") &&
          JSON.stringify(r.names) === '["Cork · Worms","Cork · Worms","Cork · Worms"]',
        `the rigs after the gift: ${JSON.stringify(r)}`,
      );
      // Rig 2 in use, Chafe Gut bought in the Leader tray at Murk's: it goes on Rig 2 and the tray says so.
      const bought = await session.eval(async () => {
        const loop = window.__gw.progression.loop,
          s = loop.state();
        s.parts.includes("pike_wire") || s.parts.push("pike_wire");
        s.arrivals.shelved = [...new Set([...s.arrivals.shelved, "chafe_gut", "turnback_hook"])];
        window.__gw.debug.loop.giveClams(500);
        loop.useRig(1);
        window.__gw.ui.loop.tackle.openScreen({ from: "rack" });
        await new Promise((res) => setTimeout(res, 800));
        document.querySelector('.gw-rig-node[data-part="leader"]')?.click();
        await new Promise((res) => setTimeout(res, 800));
        document.querySelector('.gw-rig-tray .gw-rig-shop[data-buy="part:chafe_gut"]')?.click();
        await new Promise((res) => setTimeout(res, 800));
        const notes = [...document.querySelectorAll(".gw-rig-tray .gw-rig-note")].map((n) => n.textContent);
        window.__gw.ui.loop.tackle.closeScreen();
        // The Turnback Hook through the shop's own buy: its answer names the rig.
        const hook = loop.buy("part:turnback_hook");
        return {
          notes,
          hook,
          rigs: JSON.parse(JSON.stringify(loop.state().rigs)),
          fitted: { ...loop.state().fitted },
        };
      });
      check(
        bought.notes.includes("It is on Rig 2 now.") &&
          bought.hook?.ok === true &&
          bought.hook.rig === 2 &&
          bought.fitted.leader === "chafe_gut" &&
          bought.fitted.hook === "turnback_hook" &&
          bought.rigs[1].leader === "chafe_gut" &&
          bought.rigs[0].leader === "plain_knot" &&
          bought.rigs[2].hook === "mere_hook",
        `buying: ${JSON.stringify(bought)}`,
      );
      return `"${gift.text.slice(-40)}"; ${bought.notes.join(" ")}`;
    },
  },

  {
    name: "saved rigs: a rig never stores rod, reel or line; a rig whose bait has run out greys its bait and fishes on a bare hook",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 360_000,
    editSave: (save) => {
      const plain = { lure: null, bait: "mireworm", depth: "float", leader: "plain_knot", hook: "mere_hook" };
      // Rig 2 holds Cut Strip, of which there is none.
      save.meta.loop.rigs = [plain, { ...plain, bait: "cut_strip" }, plain];
      save.meta.loop.activeRig = 0;
      delete save.meta.loop.bait.mossmere.cut_strip;
    },
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["rod:1", "line:1"]);
      const tabs = await rigTabsShown(session);
      await closeTackle(session);
      check(
        tabs[1].name === "Cork · Cut Strip" &&
          tabs[1].out &&
          tabs[1].greyed &&
          !tabs[0].out &&
          !tabs[0].greyed,
        `the tabs: ${JSON.stringify(tabs)}`,
      );
      const r = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          tackle = () => JSON.stringify(loop.state().tackle),
          before = tackle();
        loop.useRig(1);
        const after = tackle();
        loop.useRig(0);
        return {
          before,
          after,
          back: tackle(),
          keys: loop.state().rigs.map((rg) => Object.keys(rg).sort().join(",")),
        };
      });
      check(
        r.before === r.after &&
          r.after === r.back &&
          r.keys.every((k) => k === "bait,depth,hook,leader,lure"),
        `the rigs touched rod, reel or line: ${JSON.stringify(r)}`,
      );
      // On the water, Rig 2 fishes bare: no bait goes on the hook, and the picture shows the bare hook.
      await session.sail();
      const bare = await session.eval(() => {
        const g = window.__gw,
          loop = g.progression.loop,
          used = loop.useRig(1);
        return { used: used.ok, bait: g.state.run?.equippedBait ?? null, fitted: loop.state().fitted.bait };
      });
      const shown = await rigScreen(session);
      await closeTackle(session);
      check(
        bare.used &&
          bare.bait === null &&
          bare.fitted === "cut_strip" &&
          shown.nodes.find((nd) => nd.part === "bait")?.key === "bare",
        `Rig 2 on the water: ${JSON.stringify({ bare, nodes: shown.nodes })}`,
      );
      return "tackle kept through two switches; Cut Strip greyed and fished bare";
    },
  },

  {
    name: "saved rigs: rigs and the rig in use survive a save and reload, and in Sporewood a rig is named by its bait or lure alone",
    fixture: "sporewood-crossed",
    debug: true,
    timeoutMs: 360_000,
    editSave: withParts(["sounding_lead", "pike_wire"], { depth: "lead", leader: "pike_wire" }),
    async run(session, { page, browser }) {
      await session.toHome();
      const r = await session.eval(() => {
        const loop = window.__gw.progression.loop;
        const first = loop.savedRigs().rigs.map((rg) => ({ name: rg.name, leader: rg.leader }));
        loop.useRig(2);
        loop.changeHook({ lure: "seedpod_twirl" });
        return {
          first,
          names: loop.savedRigs().rigs.map((rg) => rg.name),
          rigs: JSON.parse(JSON.stringify(loop.state().rigs)),
          fitted: { ...loop.state().fitted },
        };
      });
      // Sporewood: no depth word and no leader icon; Rig 1 keeps its lead and Pike Wire for Mossmere.
      check(
        r.first[0].name === "Spore Cake" &&
          !r.first[0].leader &&
          r.rigs[0].depth === "lead" &&
          r.rigs[0].leader === "pike_wire" &&
          r.rigs[0].bait === "spore_cake" &&
          r.fitted.lure === "seedpod_twirl" &&
          r.names[2] === "Seedpod Twirl",
        `Sporewood's rigs: ${JSON.stringify(r)}`,
      );
      const tabs = await rigTabsShown(session);
      await closeTackle(session);
      check(
        JSON.stringify(tabs.map((t) => t.on)) === "[false,false,true]" && tabs[2].name === "Seedpod Twirl",
        `Sporewood's tabs: ${JSON.stringify(tabs)}`,
      );
      const saved = await session.saved();
      const again = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await again.boot();
        await again.toHome();
        const back = await again.eval(() => {
          const s = window.__gw.progression.loop.state();
          return { rigs: JSON.parse(JSON.stringify(s.rigs)), active: s.activeRig, fitted: { ...s.fitted } };
        });
        check(
          back.active === 2 &&
            JSON.stringify(back.rigs) === JSON.stringify(r.rigs) &&
            back.fitted.lure === "seedpod_twirl",
          `after the reload: ${JSON.stringify(back)} vs ${JSON.stringify(r.rigs)}`,
        );
        // Sporewood fishes the rig in use: back to Rig 1 and out on the water, the Spore Cake goes on.
        await again.eval(() => window.__gw.progression.loop.useRig(0));
        await again.sail({ water: "sporewood" });
        const run = await again.eval(() => ({
          zone: window.__gw.state.run?.zone,
          bait: window.__gw.state.run?.equippedBait ?? null,
          lure: window.__gw.state.run?.lure ?? null,
        }));
        check(
          run.zone === "sporewood" && run.bait === "spore_cake" && !run.lure,
          `Sporewood's trip: ${JSON.stringify(run)}`,
        );
        await again.collectGameErrors();
        check(!again.errors.length, `errors after reloading: ${again.errors.join("; ")}`);
      } finally {
        await again.close();
      }
      return r.names.join(", ");
    },
  },
  // ---- practice orders on Murk's Order Board (mossmere-review-addendum.md section 3) -----------------------

  {
    name: "practice orders: never without a board; with a board and no part ready, the seeded refills are exactly as before",
    fixture: "mid-mossmere",
    async run(session) {
      await session.boot();
      await practiceKit(session);
      const r = await session.eval((ALL) => {
        const P = window.__practice,
          rng = P.rng(7);
        let posted = 0,
          picked = 0;
        // No board: nothing is posted, though every part is owned and ready; the picker names no practice order.
        for (let k = 0; k < 200; k++) {
          posted += P.refill(P.loop({ board: 0, parts: ALL }), rng).length;
          const one = P.D.pickOrder(P.D, P.loop({ board: 0, parts: ALL }), {
            rng,
            listFor: P.D.orderList,
            water: "mossmere",
          });
          one?.kind === "rig" && picked++;
        }
        // The 40 seeded refills of a two-order board that the build before practice orders drew.
        const board = (parts, ready) => {
          const seeded = P.rng(12345),
            seq = [];
          for (let k = 0; k < 40; k++) {
            const l = P.loop({ board: 2, parts, ready });
            P.refill(l, seeded);
            seq.push(
              l.orders
                .map((o) => [o.speciesId, o.kind, o.n, o.cls ?? null, o.oz ?? null].join(":"))
                .join("|"),
            );
          }
          return P.hash(seq.join("\n"));
        };
        return { posted, picked, none: board([], []), notReady: board(ALL, []) };
      }, PRACTICE_PARTS);
      check(r.posted === 0 && r.picked === 0, `with no board: ${JSON.stringify(r)}`);
      check(
        r.none === BOARD_BEFORE && r.notReady === BOARD_BEFORE,
        `the seeded refills changed: ${r.none} and ${r.notReady}, expected ${BOARD_BEFORE}`,
      );
      return "no board, no order; the refills match the build before, with no part and with parts not yet ready";
    },
  },

  {
    name: "practice orders: a part Murk gives at a tally is not offered at that tally, and is from the next",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 600_000,
    editSave(save) {
      const loop = save.meta.loop;
      loop.parts = ["cork_float", "plain_knot", "mere_hook", "sounding_lead"];
      loop.home.orders = 2;
      loop.orders = [{ id: "ord_kept", speciesId: "likely_chub", kind: "count", n: 3, have: 0, said: true }];
    },
    async run(session) {
      await session.boot();
      await session.sail(SLOW_SAIL);
      await session.catchFish("dusk_minnow");
      await session.goHomeAndTally();
      await practiceKit(session);
      const r = await session.eval(() => {
        const P = window.__practice,
          D = P.D,
          live = window.__gw.progression.loop.state(),
          rng = P.rng(21),
          count = (l, n) => {
            const parts = {};
            for (let k = 0; k < n; k++) {
              const copy = JSON.parse(JSON.stringify(l));
              copy.orders = copy.orders.filter((o) => o.kind !== "rig" && o.id === "ord_kept");
              P.refill(copy, rng);
              for (const o of copy.orders) o.kind === "rig" && (parts[o.part] = (parts[o.part] || 0) + 1);
            }
            return parts;
          };
        const after = {
          parts: [...live.parts],
          ready: [...live.practice.ready],
          board: live.orders.map((o) => o.part ?? o.kind),
        };
        const thisTally = count(live, 400);
        // The next tally: the tin, given at the last one, is ready now.
        const next = JSON.parse(JSON.stringify(live));
        D.notePracticeTally(next, null);
        return { after, thisTally, nextTally: count(next, 400), nextReady: next.practice.ready };
      });
      check(r.after.parts.includes("minnow_tin"), `Murk did not give the tin: ${JSON.stringify(r.after)}`);
      check(
        JSON.stringify(r.after.ready) === '["sounding_lead"]' && !r.after.board.includes("minnow_tin"),
        `after the tally that gave the tin: ${JSON.stringify(r.after)}`,
      );
      check(
        !r.thisTally.minnow_tin && r.thisTally.sounding_lead > 0,
        `refills until the next tally: ${JSON.stringify(r.thisTally)}`,
      );
      check(
        r.nextTally.minnow_tin > 0 && r.nextReady.includes("minnow_tin"),
        `refills from the next tally: ${JSON.stringify(r)}`,
      );
      return `the tin waits a tally (${JSON.stringify(r.thisTally)}), then posts (${JSON.stringify(r.nextTally)})`;
    },
  },

  {
    name: "practice orders: a slot refills with one about 1 time in 2 before its part's order is filled and 1 in 6 after, unfilled parts first",
    fixture: "mid-mossmere",
    async run(session) {
      await session.boot();
      await practiceKit(session);
      const r = await session.eval((ALL) => {
        const P = window.__practice,
          rng = P.rng(99),
          N = 3000,
          rate = (filled) => {
            let rig = 0;
            const parts = {};
            for (let k = 0; k < N; k++) {
              const l = P.loop({ board: 1, parts: ALL, filled });
              P.refill(l, rng);
              const o = l.orders.find((x) => x.kind === "rig");
              o && (rig++, (parts[o.part] = (parts[o.part] || 0) + 1));
            }
            return { rate: rig / N, parts };
          };
        return { before: rate([]), after: rate(ALL), tinFilled: rate(["minnow_tin"]) };
      }, PRACTICE_PARTS);
      const all = (parts) => PRACTICE_PARTS.every((p) => parts[p] > 0);
      check(
        Math.abs(r.before.rate - 0.5) < 0.04 && all(r.before.parts),
        `never filled: ${JSON.stringify(r.before)}`,
      );
      check(
        Math.abs(r.after.rate - 1 / 6) < 0.03 && all(r.after.parts),
        `all filled: ${JSON.stringify(r.after)}`,
      );
      check(
        Math.abs(r.tinFilled.rate - 0.5) < 0.04 && !r.tinFilled.parts.minnow_tin,
        `the tin's filled, the rest not: ${JSON.stringify(r.tinFilled)}`,
      );
      return `before ${r.before.rate.toFixed(3)}, after ${r.after.rate.toFixed(3)}, a filled part waits while others are unfilled`;
    },
  },

  {
    name: "practice orders: never two on the board at once",
    fixture: "mid-mossmere",
    async run(session) {
      await session.boot();
      await practiceKit(session);
      const r = await session.eval((ALL) => {
        const P = window.__practice,
          rng = P.rng(5);
        let most = 0,
          withOne = 0;
        // A three-order board refilled from empty, and one board kept a long while, an order taken off each time.
        for (let k = 0; k < 600; k++) {
          const l = P.loop({ board: 3, parts: ALL });
          P.refill(l, rng);
          const n = l.orders.filter((o) => o.kind === "rig").length;
          (most = Math.max(most, n)), n === 1 && withOne++;
        }
        const l = P.loop({ board: 3, parts: ALL });
        for (let k = 0; k < 600; k++) {
          l.orders.splice(Math.floor(rng() * l.orders.length), 1);
          P.refill(l, rng);
          most = Math.max(most, l.orders.filter((o) => o.kind === "rig").length);
        }
        return { most, withOne, size: l.orders.length };
      }, PRACTICE_PARTS);
      check(
        r.most === 1 && r.withOne > 0 && r.size === 3,
        `practice orders on the board: ${JSON.stringify(r)}`,
      );
      return `at most one (${r.withOne} of 600 fresh boards had one)`;
    },
  },

  {
    name: "practice orders: the right fish taken on the part fills it and pays double; taken the wrong way it pays the ordinary price and the order stays",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 600_000,
    editSave(save) {
      const loop = save.meta.loop;
      loop.parts = ["cork_float", "plain_knot", "mere_hook", "turnback_hook"];
      loop.fitted.hook = "turnback_hook";
      loop.home.orders = 1;
      loop.orders = [PRACTICE_CARP];
      loop.practice = { filled: [], ready: ["turnback_hook"] };
    },
    async run(session) {
      await session.boot();
      // The matcher: any size, only the stated way, and only that fish.
      const matched = await session.eval((order) => {
        const D = window.__gw.data,
          rig = (r) => ({ bait: "mireworm", lead: !1, hook: null, leader: null, ...r }),
          fish = (speciesId, castRig, more = {}) => ({ speciesId, sizeClass: "small", castRig, ...more });
        const pairs = {
          rightSmall: fish("weeping_carp", rig({ hook: "turnback_hook" })),
          wrongHook: fish("weeping_carp", rig()),
          noRecord: fish("weeping_carp", undefined),
          otherFish: fish("overbold_bass", rig({ hook: "turnback_hook" })),
          giant: fish("weeping_carp", rig({ hook: "turnback_hook" }), { giant: true }),
        };
        const out = Object.fromEntries(
          Object.entries(pairs).map(([k, f]) => [k, D.orderMatches(D, order, f)]),
        );
        const way = (r, castRig) =>
          D.orderMatches(D, { ...order, speciesId: "x", rig: r }, fish("x", castRig));
        out.minnow = way({ bait: "live_minnow" }, rig({ bait: "live_minnow", lead: true }));
        out.minnowWrong = way({ bait: "live_minnow" }, rig());
        out.bottom = way({ depth: "bottom" }, rig({ lead: true }));
        out.bottomWrong = way({ depth: "bottom" }, rig());
        out.gut = way({ leader: "chafe_gut" }, rig({ leader: "chafe_gut" }));
        out.gutWrong = way({ leader: "chafe_gut" }, rig({ leader: "pike_wire" }));
        return out;
      }, PRACTICE_CARP);
      const want = {
        rightSmall: true,
        wrongHook: false,
        noRecord: false,
        otherFish: false,
        giant: false,
        minnow: true,
        minnowWrong: false,
        bottom: true,
        bottomWrong: false,
        gut: true,
        gutWrong: false,
      };
      for (const [k, v] of Object.entries(want))
        check(matched[k] === v, `${k}: ${matched[k]}, expected ${v}`);
      // On the water: a carp on the Turnback Hook, then a carp on the Mere Hook, both kept and sold.
      await session.sail(SLOW_SAIL);
      const land = async () => {
        const landed = await hookAndPlayOut(session, "weeping_carp", "land", { z: 0 });
        check(landed.landed === "weeping_carp", `the carp was not landed: ${JSON.stringify(landed)}`);
        check(await session.clickButton(/^\d?Keep\b/), "no Keep on the carp's card");
        await session.pause(800);
        await session.closeGuides(8000);
      };
      await land();
      await session.eval(() => (window.__gw.progression.loop.state().fitted.hook = "mere_hook"));
      await land();
      const creel = await session.eval(() =>
        window.__gw.state.run.creel
          .filter((f) => f.speciesId === "weeping_carp")
          .map((f) => ({ uid: f.uid, castRig: f.castRig ?? null })),
      );
      check(
        creel.length === 2 && creel[0].castRig?.hook === "turnback_hook" && creel[1].castRig?.hook === null,
        `the carps' records: ${JSON.stringify(creel)}`,
      );
      await session.goHomeAndTally();
      const after = await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        return {
          lines: s.lastTrip.lines.map((l) => ({
            uid: l.uid,
            base: l.base,
            clams: l.clams,
            order: !!l.order,
          })),
          filled: [...s.practice.filled],
          board: s.orders.map((o) => o.id),
        };
      });
      const right = after.lines.find((l) => l.uid === creel[0].uid),
        wrong = after.lines.find((l) => l.uid === creel[1].uid);
      check(
        right?.order && right.clams === right.base * 2,
        `the carp on the Turnback: ${JSON.stringify(right)}`,
      );
      check(
        wrong && !wrong.order && wrong.clams === wrong.base,
        `the carp on the Mere Hook: ${JSON.stringify(wrong)}`,
      );
      check(
        JSON.stringify(after.filled) === '["turnback_hook"]' && !after.board.includes(PRACTICE_CARP.id),
        `after the tally: ${JSON.stringify(after)}`,
      );
      // Had only the wrong carp come in, the order would stay: the tally's own matcher.
      const kept = await session.eval(
        ([order, uid]) => {
          const D = window.__gw.data;
          return D.orderMatches(D, order, { speciesId: "weeping_carp", castRig: { hook: null }, uid });
        },
        [PRACTICE_CARP, creel[1].uid],
      );
      check(kept === false, "the wrong carp matched the order");
      return `paid ${right.clams} for ${right.base} on the Turnback, ${wrong.clams} on the Mere Hook; the part is filled`;
    },
  },

  {
    name: "practice orders: the sturgeon is named only with Under the Span owned, and a part with two fish names either",
    fixture: "mid-mossmere",
    async run(session) {
      await session.boot();
      await practiceKit(session);
      const r = await session.eval(() => {
        const P = window.__practice,
          rng = P.rng(13),
          fishFor = (parts, places) => {
            const seen = {};
            for (let k = 0; k < 1500; k++) {
              const l = P.loop({ board: 1, parts, places });
              P.refill(l, rng);
              for (const o of l.orders)
                o.kind === "rig" && (seen[o.speciesId] = (seen[o.speciesId] || 0) + 1);
            }
            return seen;
          };
        return {
          lead: fishFor(["sounding_lead"], ["lily_maze"]),
          leadSpan: fishFor(["sounding_lead"], ["lily_maze", "under_the_span"]),
          tin: fishFor(["minnow_tin"], ["lily_maze"]),
        };
      });
      check(
        JSON.stringify(Object.keys(r.lead)) === '["rustfin_sucker"]',
        `the lead without Under the Span: ${JSON.stringify(r.lead)}`,
      );
      check(
        r.leadSpan.rustfin_sucker > 0 &&
          r.leadSpan.bridgechain_sturgeon > 0 &&
          Object.keys(r.leadSpan).length === 2,
        `the lead with Under the Span: ${JSON.stringify(r.leadSpan)}`,
      );
      check(
        r.tin.mossback_perch > 0 && r.tin.milkeye_perch > 0 && Object.keys(r.tin).length === 2,
        `the tin: ${JSON.stringify(r.tin)}`,
      );
      return `lead ${JSON.stringify(r.lead)}, with the chart ${JSON.stringify(r.leadSpan)}, tin ${JSON.stringify(r.tin)}`;
    },
  },

  {
    name: "practice orders: a posted one survives a save and reload with its part, and an old save loads with none filled",
    fixture: "mid-mossmere",
    debug: true,
    async run(session, { page, browser }) {
      await session.boot();
      await session.toHome();
      await practiceKit(session);
      const posted = await session.eval((ALL) => {
        const P = window.__practice,
          live = window.__gw.progression.loop,
          s = live.state(),
          rng = P.rng(3),
          loaded = JSON.parse(JSON.stringify(s.practice ?? null));
        s.home.orders = 1;
        for (const id of ALL) s.parts.includes(id) || s.parts.push(id);
        s.practice.ready = [...ALL];
        for (let k = 0; k < 50 && !s.orders.some((o) => o.kind === "rig"); k++) {
          s.orders = [];
          P.refill(s, rng);
        }
        const order = s.orders.find((o) => o.kind === "rig") ?? null;
        return {
          loaded,
          order: JSON.parse(JSON.stringify(order)),
          text: live.orders().find((o) => o.id === order?.id)?.text,
        };
      }, PRACTICE_PARTS);
      check(
        JSON.stringify(posted.loaded) === '{"filled":[],"ready":[]}',
        `the old save's practice record: ${JSON.stringify(posted.loaded)}`,
      );
      check(
        posted.order?.part && posted.order.rig,
        `no practice order was posted: ${JSON.stringify(posted)}`,
      );
      const saved = await session.saved();
      const again = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await again.boot();
        await again.toHome();
        const back = await again.eval((id) => {
          const loop = window.__gw.progression.loop,
            s = loop.state();
          return {
            order: JSON.parse(JSON.stringify(s.orders.find((o) => o.id === id) ?? null)),
            text: loop.orders().find((o) => o.id === id)?.text,
            practice: JSON.parse(JSON.stringify(s.practice)),
          };
        }, posted.order.id);
        const same = ["speciesId", "kind", "n", "part"].every((k) => back.order?.[k] === posted.order[k]);
        check(
          same &&
            JSON.stringify(back.order.rig) === JSON.stringify(posted.order.rig) &&
            back.text === posted.text,
          `after the reload: ${JSON.stringify(back)} vs ${JSON.stringify(posted)}`,
        );
        check(
          back.practice.ready.length === PRACTICE_PARTS.length,
          `the ready parts: ${JSON.stringify(back.practice)}`,
        );
        await again.collectGameErrors();
        check(!again.errors.length, `errors after reloading: ${again.errors.join("; ")}`);
      } finally {
        await again.close();
      }
      return `"${posted.text}" kept`;
    },
  },

  {
    name: "practice orders: Sporewood's board is unchanged by Mossmere's parts, every one owned and ready (its own parts' orders are checked with its tackle)",
    fixture: "sporewood-crossed",
    async run(session) {
      await session.boot();
      await practiceKit(session);
      const r = await session.eval((ALL) => {
        const P = window.__practice,
          board = (parts) => {
            const seeded = P.rng(4242),
              seq = [];
            for (let k = 0; k < 200; k++) {
              const l = P.loop({ board: 2, parts });
              P.refill(l, seeded, "sporewood");
              seq.push(l.orders.map((o) => `${o.speciesId}:${o.kind}:${o.water ?? ""}`).join("|"));
            }
            return seq;
          },
          none = board([]),
          all = board(ALL);
        return {
          same: JSON.stringify(none) === JSON.stringify(all),
          rig: all.join("|").includes(":rig:"),
          filled: all.filter(Boolean).length,
        };
      }, PRACTICE_PARTS);
      check(r.same && !r.rig && r.filled === 200, `Sporewood's board: ${JSON.stringify(r)}`);
      return "the same seeded orders with and without the parts, none a practice order";
    },
  },

  {
    name: 'practice orders: Murk says each of the six table lines, the board shows it without "Bring me", and it is said apart from the other orders',
    fixture: "mid-mossmere",
    async run(session) {
      await session.boot();
      await practiceKit(session);
      const r = await session.eval(
        (table) => {
          const D = window.__practice.D,
            order = ([part, speciesId], k) => ({
              id: `o${k}`,
              speciesId,
              kind: "rig",
              n: 1,
              have: 0,
              part,
              rig: { ...D.LOOP.orders.practice.mossmere.parts[part].rig },
            }),
            orders = table.map(order),
            others = [
              { id: "a", speciesId: "likely_chub", kind: "count", n: 2, have: 0 },
              { id: "b", speciesId: "dusk_minnow", kind: "count", n: 1, have: 0 },
            ];
          return {
            said: orders.map((o) => D.orderLine(D, [o]).line),
            board: orders.map((o) => D.orderBoardText(D, o)),
            plain: D.orderLine(D, others).line,
            mixed: D.orderLine(D, [...others, orders[0]]).line,
          };
        },
        PRACTICE_TABLE.map(([part, fish]) => [part, fish]),
      );
      PRACTICE_TABLE.forEach(([, , line], k) => {
        check(r.said[k] === line, `Murk says "${r.said[k]}", expected "${line}"`);
        const shown = `${line.replace(/^Bring me a/, "A")}`;
        check(r.board[k] === shown, `the board shows "${r.board[k]}", expected "${shown}"`);
        // The voice's measures: at most 25 words, plain punctuation.
        check(line.split(/\s+/).length <= 25 && !/[;–—×+]/.test(line), `"${line}" breaks the voice`);
      });
      // With other orders, theirs is said first as it always was, then the practice order's line on its own.
      const mixed = `${r.plain} ${PRACTICE_TABLE[0][2]}`;
      check(
        /^Bring me 2 .* and a Dusk Minnow\.$/.test(r.plain) && r.mixed === mixed,
        `with other orders: "${r.mixed}", expected "${mixed}"`,
      );
      return r.board.join(" / ");
    },
  },

  {
    name: "lake kits: the first tow sets Mossmere's kit and purse aside whole, and Sporewood starts from a new game's kit and clams",
    fixture: "legend-sold",
    debug: true,
    editSave: withParts(["sounding_lead", "pike_wire"], { depth: "lead", leader: "pike_wire" }),
    async run(session) {
      await session.toHome();
      await fillMossmereKit(session);
      const before = await kitNow(session);
      check(before.water === "mossmere" && sameJson(before.kits, {}), `before: ${JSON.stringify(before)}`);
      await towKit(session, "sporewood");
      const after = await kitNow(session);
      const grip = await shelfAndGrip(session);
      check(
        sameJson(after.kits.mossmere, before.kit),
        `Mossmere's kit was not set aside whole: ${JSON.stringify(after.kits.mossmere)} vs ${JSON.stringify(before.kit)}`,
      );
      const k = after.kit;
      check(
        k.clams === 0 &&
          sameJson(k.tackle, { rod: 0, line: 0, reel: 0 }) &&
          k.holdSlots === 3 &&
          sameJson(k.raft, { oars: 0, keel: 0, lantern: 0 }) &&
          Object.values(k.carry).every((v) => typeof v === "object" || v === 0) &&
          Object.values(k.carry.raft).every((v) => v === 0) &&
          sameJson(k.parts, NEW_GAME_PARTS) &&
          k.activeRig === 0 &&
          k.rigs.every((r) => r.bait === "spore_cake" && !r.lure && r.depth === "float") &&
          k.fitted.bait === "spore_cake" &&
          k.fitted.leader === "plain_knot" &&
          k.fitted.hook === "mere_hook",
        `Sporewood's kit is not a new game's: ${JSON.stringify(k)}`,
      );
      check(
        after.gearWater === "sporewood" &&
          after.bait.sporewood?.spore_cake === 10 &&
          sameJson(after.bait.mossmere, before.bait.mossmere) &&
          !after.kits.sporewood,
        `bait or the gear pointer: ${JSON.stringify(after)}`,
      );
      // Nothing of Mossmere's tackle is carried: no Grip but the Wick's own, and Sporewood's own shelf.
      check(
        grip.grip.rod === 0 && grip.grip.line === 0 && grip.grip.reel === 0,
        `carried Grip in Sporewood: ${JSON.stringify(grip.grip)}`,
      );
      check(
        ["rod:1", "line:1", "reel:1"].every((id) =>
          grip.items.some((i) => i.startsWith(id + ":") && /:(stalkwood|rootthread|capwheel):sale$/.test(i)),
        ),
        `Sporewood's shelf: ${grip.items}`,
      );
      return `set aside ${before.kit.clams} clams and rod ${before.kit.tackle.rod}; Sporewood starts plain`;
    },
  },

  {
    name: "lake kits: tow back and Mossmere's tiers, parts, rigs, fitted, bait, raft, creel and clams are exactly as left; tow again and Sporewood's are",
    fixture: "legend-sold",
    debug: true,
    editSave: withParts(["sounding_lead", "pike_wire"], { depth: "lead", leader: "pike_wire" }),
    async run(session) {
      await session.toHome();
      await fillMossmereKit(session);
      const moss = await kitNow(session);
      await towKit(session, "sporewood");
      // Sporewood's own kit gets something in it too: clams, a rod and a creel, and the lure on Rig 3.
      await buyAtHome(session, ["rod:1", "hold:4"]);
      await session.eval(() => {
        const loop = window.__gw.progression.loop;
        loop.useRig(2);
        loop.changeHook({ lure: "seedpod_twirl" });
      });
      const spore = await kitNow(session);
      check(
        spore.kit.tackle.rod === 1 && spore.kit.holdSlots === 4,
        `Sporewood's buys: ${JSON.stringify(spore.kit)}`,
      );
      await towKit(session, "mossmere");
      const back = await kitNow(session);
      check(
        sameJson(back.kit, moss.kit) &&
          sameJson(back.bait.mossmere, moss.bait.mossmere) &&
          back.gearWater === "mossmere",
        `Mossmere after the trip: ${JSON.stringify(back.kit)} vs ${JSON.stringify(moss.kit)}`,
      );
      check(
        sameJson(back.kits.sporewood, spore.kit),
        `Sporewood set aside: ${JSON.stringify(back.kits.sporewood)}`,
      );
      await towKit(session, "sporewood");
      const again = await kitNow(session);
      check(
        sameJson(again.kit, spore.kit) && sameJson(again.bait.sporewood, spore.bait.sporewood),
        `Sporewood again: ${JSON.stringify(again.kit)} vs ${JSON.stringify(spore.kit)}`,
      );
      check(
        sameJson(again.kits.mossmere, moss.kit),
        `Mossmere set aside again: ${JSON.stringify(again.kits)}`,
      );
      return `Mossmere ${moss.kit.clams} clams, Sporewood ${spore.kit.clams}, both kept`;
    },
  },

  {
    name: "lake kits: Hob's Lamp, the journal, the hunt record, looks, charts, finds and the home are the same before and after tows",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      const record = () =>
        session.eval(() => {
          const g = window.__gw,
            s = g.progression.loop.state();
          return JSON.stringify({
            relics: s.relics,
            journal: g.state.meta.journal,
            hunt: s.hunt,
            looks: s.looks,
            lakes: s.maps.lakes,
            places: s.maps.places,
            prints: s.prints,
            finds: s.finds,
            found: s.found,
            home: s.home,
            lures: s.lures.filter((id) => id !== "seedpod_twirl"),
          });
        });
      const before = await record();
      check(before.includes("hobs_lamp"), "the save has no Hob's Lamp");
      await towKit(session, "sporewood");
      const there = await record();
      await towKit(session, "mossmere");
      const back = await record();
      check(there === before, `changed by the tow: ${there} vs ${before}`);
      check(back === before, `changed by the tow back: ${back} vs ${before}`);
      return "relics, journal, hunt, looks, charts, finds and home unchanged";
    },
  },

  {
    name: "lake kits: after a Sporewood visit, Murk's Tackle and Raft shelf in Mossmere lists the same items at the same prices, and the fitted tackle's Grip is the same",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["rod:1", "line:1", "line:2", "hold:4"]);
      // The shelf as Murk lays it out on a later visit, not marking what was just bought (a trip's start
      // empties that list; the trip itself is not started).
      await session.eval(() => void window.__gw.progression.loop.createTrip({ startZone: "mossmere" }));
      const before = await shelfAndGrip(session);
      await towKit(session, "sporewood");
      const there = await shelfAndGrip(session);
      // Buying in Sporewood moves Sporewood's tiers only.
      await buyAtHome(session, ["rod:1", "rod:2", "reel:1", "oars:1"]);
      await towKit(session, "mossmere");
      const after = await shelfAndGrip(session);
      check(!sameJson(there.items, before.items), `Sporewood showed Mossmere's shelf: ${there.items}`);
      check(sameJson(after.items, before.items), `Mossmere's shelf: ${after.items} vs ${before.items}`);
      check(
        sameJson(after.grip, before.grip),
        `Mossmere's Grip: ${JSON.stringify(after.grip)} vs ${JSON.stringify(before.grip)}`,
      );
      return `${after.items.length} shelf rows the same; line Grip ${after.grip.line}`;
    },
  },

  {
    name: "lake kits, old save never towed: it loads unchanged with no stored kits",
    fixture: "mid-mossmere",
    debug: true,
    async run(session, { fixture }) {
      await session.toHome();
      const now = await kitNow(session);
      const was = fixture.meta.loop;
      check(sameJson(now.kits, {}) && now.gearWater === "mossmere", `kits: ${JSON.stringify(now)}`);
      for (const k of ["clams", "tackle", "holdSlots", "raft"])
        check(
          sameJson(now.kit[k], was[k]),
          `${k}: ${JSON.stringify(now.kit[k])} vs ${JSON.stringify(was[k])}`,
        );
      return `clams ${now.kit.clams}, kept`;
    },
  },

  {
    name: "lake kits, old save towed and in Sporewood: it keeps all it holds there, and Mossmere's kit is read back from the tow's record",
    fixture: "sporewood-crossed",
    debug: true,
    async run(session, { fixture }) {
      await session.toHome();
      const now = await kitNow(session);
      const was = fixture.meta.loop;
      check(now.water === "sporewood" && now.gearWater === "sporewood", `where: ${JSON.stringify(now)}`);
      for (const k of ["clams", "tackle", "holdSlots", "raft", "carry"])
        check(
          sameJson(now.kit[k], was[k]),
          `${k}: ${JSON.stringify(now.kit[k])} vs ${JSON.stringify(was[k])}`,
        );
      // The fixture bought the Ashwood rod before its tow, so its record carries a third of the Ashwood's Grip.
      const moss = now.kits.mossmere;
      check(
        moss && moss.tackle.rod === 1 && moss.tackle.line === 0 && moss.clams === 0 && moss.carry.rod === 0,
        `Mossmere's kit: ${JSON.stringify(moss)}`,
      );
      await towKit(session, "mossmere");
      const home = await shelfAndGrip(session);
      check(
        home.items.some((i) => /^rod:2:\d+:-:sale$/.test(i)) &&
          !home.items.some((i) => /stalkwood|amberheart/.test(i)),
        `Mossmere's shelf: ${home.items}`,
      );
      return `Sporewood kept ${now.kit.clams} clams; Mossmere's rod ${moss.tackle.rod}`;
    },
  },

  {
    name: "lake kits, old save towed and back in Mossmere: Sporewood's pieces wait in Sporewood, Mossmere's own come back, clams stay",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: (save) => {
      const loop = save.meta.loop;
      loop.barge.water = "mossmere";
      loop.tackle = { rod: 1, line: 1, reel: 0 };
    },
    async run(session, { fixture }) {
      await session.toHome();
      const now = await kitNow(session);
      const was = fixture.meta.loop;
      check(now.water === "mossmere" && now.gearWater === "mossmere", `where: ${JSON.stringify(now)}`);
      check(now.kit.clams === was.clams, `clams: ${now.kit.clams} vs ${was.clams}`);
      check(
        sameJson(now.kit.tackle, { rod: 1, line: 0, reel: 0 }) && now.kit.carry.rod === 0,
        `Mossmere's tackle: ${JSON.stringify(now.kit)}`,
      );
      const away = now.kits.sporewood;
      check(
        away &&
          sameJson(away.tackle, { rod: 1, line: 1, reel: 0 }) &&
          sameJson(away.carry, was.carry) &&
          away.holdSlots === was.holdSlots &&
          away.clams === 0,
        `Sporewood's kit: ${JSON.stringify(away)}`,
      );
      const home = await shelfAndGrip(session);
      check(
        !home.items.some((i) => /stalkwood|rootthread|capwheel/.test(i)),
        `Mossmere's shelf: ${home.items}`,
      );
      await towKit(session, "sporewood");
      const there = await kitNow(session);
      check(
        sameJson(there.kit.tackle, { rod: 1, line: 1, reel: 0 }),
        `Sporewood again: ${JSON.stringify(there.kit)}`,
      );
      return `Mossmere rod ${now.kit.tackle.rod}, Sporewood rod and line waiting`;
    },
  },

  {
    name: "lake kits: a save and reload in Sporewood keeps both kits",
    fixture: "legend-sold",
    debug: true,
    async run(session, { page, browser }) {
      await session.toHome();
      await fillMossmereKit(session);
      await towKit(session, "sporewood");
      await buyAtHome(session, ["rod:1"]);
      const before = await kitNow(session);
      const saved = await session.saved();
      const again = await GameSession.open(browser, { page, save: saved, debug: true, viewport: VIEWPORT });
      try {
        await again.boot();
        await again.toHome();
        const after = await kitNow(again);
        check(
          after.water === "sporewood" && sameJson(after.kit, before.kit) && sameJson(after.kits, before.kits),
          `after the reload: ${JSON.stringify(after)} vs ${JSON.stringify(before)}`,
        );
        await again.collectGameErrors();
        check(!again.errors.length, `errors after reloading: ${again.errors.join("; ")}`);
      } finally {
        await again.close();
      }
      return `Sporewood ${before.kit.clams} clams, Mossmere ${before.kits.mossmere.clams} waiting`;
    },
  },

  {
    name: "lake kits: the 900 bounty is paid at Mossmere's tally into Mossmere's purse, and waits there through a tow",
    fixture: "legend-sold",
    debug: true,
    editSave: unsold(),
    async run(session) {
      await session.toHome();
      const r = await session.eval(() => {
        const g = window.__gw,
          loop = g.progression.loop,
          s = loop.state(),
          h = s.hunt.mossmere,
          start = s.clams;
        // She was landed this evening: the tally pays the bounty.
        h.landed = s.evenings + 1;
        h.bountyPaid = false;
        // Her landing lays down Sporewood's chart (layMonsterChart); here it is laid by hand.
        s.maps.lakes.includes("sporewood") || s.maps.lakes.push("sporewood");
        const run = loop.createTrip({ startZone: "mossmere" });
        g.state.run = run;
        loop.endTrip();
        g.state.run = null;
        return { start, paid: s.clams, zone: run?.zone };
      });
      check(r.zone === "mossmere" && r.paid === r.start + 900, `the tally: ${JSON.stringify(r)}`);
      await session.closeGuides(5000);
      await towKit(session, "sporewood");
      const there = await kitNow(session);
      check(
        there.kits.mossmere.clams === r.paid && there.kit.clams === 0,
        `after the tow: ${JSON.stringify({ moss: there.kits.mossmere.clams, here: there.kit.clams })}`,
      );
      return `${r.start} + 900 = ${r.paid}, waiting in Mossmere`;
    },
  },

  // ---- Mossmere's local kinds (the review addendum, section 6) ----------------------------------------------
  {
    name: "local kinds: a seeded run of bites is as before away from their four homes and in her water, and in a home only its base fish's bites change, to its local kind",
    fixture: "legend-sold",
    debug: true,
    timeoutMs: 480_000,
    async run(session) {
      // Hob's Lamp is taken away, as in the build the sequences were recorded on.
      await dropLamp(session);
      await session.sail();
      const want = JSON.parse(readFileSync(join(FIXTURES_DIR, "bite-sequence-homes.json"), "utf8"));
      const seen = {};
      let same = 0;
      for (const [key, letters] of Object.entries(want.sequences)) {
        const [spot, light, bait] = key.split("|");
        const at = want.spots[spot];
        const got = await session.eval(
          ([at, light, bait, n, seed]) => {
            const g = window.__gw,
              d = g.debug;
            if (at && at.x != null) g.player.teleport({ x: at.x, z: at.z }, 0);
            d.setPhase(light);
            d.fishSeed(seed);
            const seq = [];
            for (let k = 0; k < n; k++) {
              const r = d.fishPoolRoll(1, { place: at?.place ?? null, bait });
              seq.push(r?.mist ? `mist:${r.mist}` : Object.keys(r?.counts ?? {})[0]);
            }
            return seq;
          },
          [at, light, bait, letters.length, want.seed],
        );
        // The Buoy Lights are a place only at night: by day they are open water, no home.
        const home = spot === "buoy_lights" && light !== "gloomtide" ? null : LOCAL_HOMES[spot] || null;
        [...letters].forEach((letter, i) => {
          const before = want.kinds[SEQUENCE_LETTERS.indexOf(letter)];
          if (got[i] === before) return void same++;
          check(
            home && got[i] === home && before === LOCAL_BASES[home],
            `${key}: bite ${i} drew ${got[i]}, the build before drew ${before}`,
          );
          seen[home] = (seen[home] || 0) + 1;
        });
      }
      check(
        Object.keys(LOCAL_BASES).every((id) => seen[id] > 0),
        `a local kind never bit in its home: ${JSON.stringify(seen)}`,
      );
      // The exact share: a quarter of the base fish's bites in its home, none anywhere else.
      const shares = await session.eval((spots) => {
        const g = window.__gw,
          d = g.debug,
          out = {};
        for (const [name, at, light, bait] of spots) {
          if (at.x != null) g.player.teleport({ x: at.x, z: at.z }, 0);
          d.setPhase(light);
          out[name] = d.fishPoolRoll(0, { place: at.place ?? null, bait })?.shares ?? null;
        }
        return out;
      }, LOCAL_SHARE_SPOTS);
      for (const [name, s] of Object.entries(shares)) {
        const kinds = Object.keys(LOCAL_BASES).filter((id) => s?.[id] > 0);
        const home = LOCAL_SHARE_SPOTS.find((x) => x[0] === name)[4];
        check(
          JSON.stringify(kinds) === JSON.stringify(home ? [home] : []),
          `${name}: local kinds ${JSON.stringify(kinds)}, expected ${home || "none"}`,
        );
        if (!home) continue;
        const share = s[home] / (s[home] + s[LOCAL_BASES[home]]);
        check(near(share, 0.25, 1e-9), `${name}: ${home} takes ${share} of the ${LOCAL_BASES[home]}'s bites`);
      }
      // Her water: no local kind there, even where a home would reach it (the rule itself).
      const rule = await session.eval(() => {
        const at = window.__gw.data.localKindAt;
        return {
          stones: at("dusk_minnow", { area: "stones", x: 30, z: 30, light: "calm" }),
          stonesInHerWater: at("dusk_minnow", { area: "stones", x: -4, z: -9, light: "calm" }),
          herPlace: at("dusk_minnow", { area: "stones", castPlace: "bell_pool", light: "calm" }),
          span: at("dusk_minnow", { place: "under_the_span", light: "gloomtide" }),
          spanInHerWater: at("dusk_minnow", { place: "under_the_span", x: -6, z: -12, light: "calm" }),
          buoyNight: at("lampsipper", { place: "buoy_lights", light: "gloomtide" }),
          buoyDay: at("lampsipper", { place: "buoy_lights", light: "calm" }),
          sporewood: at("dusk_minnow", { water: "sporewood", area: "stones", light: "calm" }),
        };
      });
      check(
        JSON.stringify(rule) ===
          JSON.stringify({
            stones: "stone_minnow",
            stonesInHerWater: null,
            herPlace: null,
            span: "archshade_minnow",
            spanInHerWater: null,
            buoyNight: "buoy_rudd",
            buoyDay: null,
            sporewood: null,
          }),
        `the rule: ${JSON.stringify(rule)}`,
      );
      return `${same} bites as before; changed in their homes: ${JSON.stringify(seen)}`;
    },
  },

  {
    name: "local kinds: with Hob's Lamp a local kind never caught takes 3 in 8 of its base fish's bites, and 1 in 4 once caught, and the total does not change",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.sail();
      const roll = () =>
        session.eval(() => {
          const d = window.__gw.debug;
          d.setPhase("calm");
          return d.fishPoolRoll(0, { place: "under_the_span", bait: "mireworm" }).shares;
        });
      const lamp = await session.eval(() =>
        window.__gw.progression.loop.state().relics.includes("hobs_lamp"),
      );
      check(lamp, "the save has no Hob's Lamp");
      const unmet = await roll();
      await session.eval(() => (window.__gw.state.meta.journal.archshade_minnow = { caught: 1 }));
      const met = await roll();
      const share = (s) => s.archshade_minnow / (s.archshade_minnow + s.dusk_minnow);
      check(near(share(unmet), 3 / 8, 1e-9), `never caught: ${share(unmet)}`);
      check(near(share(met), 1 / 4, 1e-9), `caught: ${share(met)}`);
      check(
        near(unmet.archshade_minnow + unmet.dusk_minnow, met.archshade_minnow + met.dusk_minnow, 1e-12) &&
          near(unmet.mossback_perch, met.mossback_perch, 1e-12),
        `the minnows' total or another fish's share moved: ${JSON.stringify({ unmet, met })}`,
      );
      return `${share(unmet).toFixed(3)} never caught, ${share(met).toFixed(3)} caught`;
    },
  },

  {
    name: "local kinds: a small Stone or Archshade Minnow shows Into the tin and goes in as a Live Minnow",
    fixture: "mid-mossmere",
    debug: true,
    editSave: withTin,
    timeoutMs: 360_000,
    async run(session) {
      await session.sail();
      const seen = [];
      for (const [k, id] of ["stone_minnow", "archshade_minnow"].entries()) {
        const card = await catchCard(session, id, -1.5);
        check(card.tin === `Into the tin (${3 - k} left)`, `${id}: the button reads ${card.tin}`);
        await session.clickButton(/^Into the tin/);
        await session.pause(1200);
        await session.closeGuides(4000);
        const live = await liveInRun(session);
        check(live === k + 1, `after the ${id}: ${live} Live Minnows`);
        seen.push(card.tin);
      }
      // The other two never offer it.
      const rule = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          fish = (speciesId) => ({ uid: `t-${speciesId}`, speciesId, sizeClass: "small" });
        return { carp: loop.tinRoom(fish("mirror_carp")), rudd: loop.tinRoom(fish("buoy_rudd")) };
      });
      check(rule.carp === null && rule.rudd === null, `tinRoom: ${JSON.stringify(rule)}`);
      return seen.join(", ");
    },
  },

  {
    name: "local kinds: catching one changes no lake list count, catch seal or order, and leaves no bite mark",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 480_000,
    async run(session) {
      await session.sail();
      const counts = () =>
        session.eval(() => {
          const loop = window.__gw.progression.loop;
          return {
            list: loop.listCount("mossmere"),
            seals: JSON.stringify(loop.seals()),
            page: loop.catalogue("mossmere").head,
          };
        });
      const before = await counts();
      // An order for a Dusk Minnow on the board: a Stone or Archshade Minnow never fills it.
      const orders = await session.eval(() => {
        const loop = window.__gw.progression.loop,
          fish = (speciesId) => ({ uid: `o-${speciesId}`, speciesId, sizeClass: "keeper", length: 20 });
        loop.state().orders.push({ id: "ord-local", speciesId: "dusk_minnow", kind: "count", n: 1, have: 0 });
        const out = {};
        for (const id of ["dusk_minnow", "stone_minnow", "archshade_minnow"])
          out[id] = loop.orderFor(fish(id));
        return out;
      });
      check(
        orders.dusk_minnow === "ord-local" &&
          orders.stone_minnow === null &&
          orders.archshade_minnow === null,
        `orders: ${JSON.stringify(orders)}`,
      );
      for (const id of Object.keys(LOCAL_BASES)) await session.catchFish(id, { keep: false });
      const after = await counts();
      const got = await session.eval(
        (ids) => ids.map((id) => window.__gw.state.meta.journal[id]?.caught ?? 0),
        Object.keys(LOCAL_BASES),
      );
      check(
        got.every((n) => n === 1),
        `the local kinds are not in the Journal: ${JSON.stringify(got)}`,
      );
      check(
        JSON.stringify(after) === JSON.stringify(before),
        `the counts moved: ${JSON.stringify({ before, after })}`,
      );
      // No bite mark: the mark rule gives a Dusk Minnow in the reeds its cuts, never a local kind.
      const marks = await session.eval((ids) => {
        const g = window.__gw.data,
          loop = { hunt: { mossmere: { sketches: { map: 1 } } } },
          run = { zone: "mossmere" },
          mark = (speciesId) =>
            g.catchMarkFor(loop, run, { speciesId, area: "reeds", phase: "dusk" }, () => 0);
        return { dusk: mark("dusk_minnow"), locals: ids.map(mark) };
      }, Object.keys(LOCAL_BASES));
      check(
        marks.dusk === "cuts" && marks.locals.every((m) => m === null),
        `marks: ${JSON.stringify(marks)}`,
      );
      return `list ${after.list.have}/${after.list.need} before and after four local kinds`;
    },
  },

  {
    name: "local kinds: the Journal's Local kinds strip shows under a caught base fish only, a ? until caught, then the picture and name, which opens its entry",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 420_000,
    async run(session) {
      const strips = () =>
        session.eval(() =>
          Object.fromEntries(
            [...document.querySelectorAll("[data-loop=locals]")].map((s) => [
              s.dataset.of,
              {
                head: s.querySelector(".gw-cat-locals-head")?.textContent ?? null,
                items: [...s.querySelectorAll(".gw-cat-local")].map((b) =>
                  b.matches("button")
                    ? `${b.dataset.species}:${b.textContent.trim()}:${!!b.querySelector("canvas")}`
                    : `${b.dataset.species}:${b.textContent.trim()}`,
                ),
              },
            ]),
          ),
        );
      await session.toHome();
      await session.eval(() => window.__gw.ui.openJournal({ zone: "mossmere" }));
      await session.pause(800);
      const before = await strips();
      // Caught in this save: the Dusk Minnow and the Weeping Carp. Not caught: the Lampsipper.
      check(
        JSON.stringify(before) ===
          JSON.stringify({
            dusk_minnow: { head: "Local kinds", items: ["stone_minnow:?", "archshade_minnow:?"] },
            weeping_carp: { head: "Local kinds", items: ["mirror_carp:?"] },
          }),
        `before: ${JSON.stringify(before)}`,
      );
      const names = await session.eval(() => document.querySelector(".gw-cat-scroll")?.textContent ?? "");
      check(
        !/Stone Minnow|Archshade|Mirror Carp|Buoy Rudd/.test(names),
        "a local kind is named before it is caught",
      );
      await backToJetty(session);
      await session.sail();
      await session.catchFish("stone_minnow");
      await session.eval(() => window.__gw.ui.openJournal({ zone: "mossmere" }));
      await session.pause(800);
      const after = await strips();
      check(
        JSON.stringify(after.dusk_minnow?.items) ===
          JSON.stringify(["stone_minnow:Stone Minnow:true", "archshade_minnow:?"]),
        `after: ${JSON.stringify(after)}`,
      );
      await session.eval(() =>
        document.querySelector("button.gw-cat-local[data-species=stone_minnow]").click(),
      );
      await session.pause(800);
      const entry = await session.eval(() => ({
        name: document.querySelector(".gw-cat-species h3")?.textContent ?? null,
        lore: document.querySelector(".gw-cat-species .gw-lore")?.textContent ?? null,
        where: document.querySelector(".gw-cat-species .gw-jr-where")?.textContent ?? null,
      }));
      check(
        entry.name === "Stone Minnow" &&
          entry.lore === LOCAL_LORE.stone_minnow &&
          entry.where?.startsWith("Only in the stony shallows."),
        `the entry: ${JSON.stringify(entry)}`,
      );
      return `${JSON.stringify(after.dusk_minnow.items)}; entry "${entry.where}"`;
    },
  },
  {
    name: "rig picture on the Sheet: its Tackle page is the rig picture with three rig tabs, a tray fits a piece and keeps the old plates' lines, the keys reach it, and the other five pages are as before",
    fixture: "mid-mossmere",
    debug: true,
    async run(session) {
      await session.toHome();
      const shown = await openRigHost(session, "sheet");
      check(
        shown &&
          shown.tabs === 3 &&
          JSON.stringify(shown.nodes.map((n) => n.split(":")[0])) === '["rod","reel","line","bait"]' &&
          shown.nodes[3] === "bait:mireworm" &&
          shown.plates === 0 &&
          !shown.hookRow,
        `the Tackle page: ${JSON.stringify(shown)}`,
      );
      // The other five pages: each still drawn, none with the picture in it.
      const pages = await session.eval(() =>
        ["buffs", "raft", "home", "odds", "rivals"].map((id) => {
          const sec = document.querySelector(`.gw-sh-sec--${id}`);
          return {
            id,
            there: !!sec,
            text: (sec?.textContent || "").trim().length,
            rig: !!sec?.querySelector(".gw-rig-host"),
          };
        }),
      );
      check(
        pages.every((pg) => pg.there && pg.text > 0 && !pg.rig),
        `the other pages: ${JSON.stringify(pages)}`,
      );
      // The bait's tray fits Lumen Moss, as on the tackle screen; the tray closes and the picture shows it.
      const baitTray = await rigHostTray(session, "sheet", "bait");
      check(
        baitTray?.owned.some((o) => o.key === "lumen_moss"),
        `the bait's tray: ${JSON.stringify(baitTray)}`,
      );
      check(
        await rigHostPress(session, "sheet", '.gw-rig-opt[data-key="lumen_moss"]'),
        "no Lumen Moss option",
      );
      await session.pause(900);
      const fitted = await session.eval(() => window.__gw.progression.loop.state().fitted.bait);
      const after = await rigHostShown(session, "sheet");
      check(
        fitted === "lumen_moss" && after?.tray === null && after.nodes.includes("bait:lumen_moss"),
        `after pressing Lumen Moss: ${fitted} ${JSON.stringify(after)}`,
      );
      // The rod's tray keeps what the old plate said: its strike time on the fitted rod, and how much the next one
      // Murk sells helps.
      const rodTray = await rigHostTray(session, "sheet", "rod");
      const fittedRod = rodTray?.owned.find((o) => o.on);
      const nextRod = rodTray?.shop.find((o) => o.id === "rod:1");
      check(
        /longer to strike/.test(fittedRod?.text || "") && /With this, /.test(nextRod?.text || ""),
        `the rod's tray: ${JSON.stringify(rodTray)}`,
      );
      // Escape closes the tray, not the Sheet; Enter on a part opens its tray with the fitted option focused.
      await session.page.keyboard.press("Escape");
      await session.pause(800);
      const escaped = await rigHostShown(session, "sheet");
      check(escaped && escaped.tray === null, `after Escape: ${JSON.stringify(escaped)}`);
      await session.eval(() =>
        document.querySelector('.gw-sh-sec--tackle .gw-rig-node[data-part="reel"]').focus(),
      );
      await session.page.keyboard.press("Enter");
      await session.pause(900);
      const keyed = await session.eval(() => {
        const tray = document.querySelector(".gw-sh-sec--tackle .gw-rig-tray");
        return {
          tray: tray?.dataset.part ?? null,
          fitted: tray?.querySelector(".gw-rig-opt[aria-pressed=true]")?.dataset.key ?? null,
          focus: document.activeElement?.closest?.(".gw-rig-tray")
            ? document.activeElement.dataset.key
            : null,
        };
      });
      check(
        keyed.tray === "reel" && keyed.focus != null && keyed.focus === keyed.fitted,
        `Enter on the Reel: ${JSON.stringify(keyed)}`,
      );
      return `${shown.nodes.join(", ")}; Lumen Moss fitted from the tray; the rod's tray keeps the plate's lines; keys open and close a tray`;
    },
  },

  {
    name: "rig picture at Murk's: his Tackle tab is the rig picture, every piece it sells is offered from a tray at its price and nothing else, the next rod and a leader are bought there as on his shelf",
    fixture: "mid-mossmere",
    debug: true,
    editSave: (save) => {
      RIG_PARTS_SAVE(save);
      // A bait tin with none left: the tackle screen's tray offers it, Murk's Tackle tab must not (it is on his Bait tab).
      save.meta.loop.bait.mossmere.lumen_moss = 0;
    },
    async run(session) {
      await session.toHome();
      await session.eval(() => window.__gw.debug.loop.giveClams(1000));
      const shelf = await session.eval(() =>
        (window.__gw.progression.loop.shelf().tabs.find((t) => t.id === "tackle")?.items || [])
          .filter((c) => c.bought !== true && c.sealed !== true && c.price != null)
          .map((c) => `${c.id}:${c.price}`)
          .sort(),
      );
      const shown = await openRigHost(session, "shop");
      check(shown && shown.tabs === 3, `Murk's Tackle tab: ${JSON.stringify(shown)}`);
      const offered = [];
      for (const node of shown.nodes) {
        const tray = await rigHostTray(session, "shop", node.split(":")[0]);
        check(tray && tray.shop.every((o) => o.button), `the ${node} tray: ${JSON.stringify(tray)}`);
        offered.push(...tray.shop.map((o) => `${o.id}:${o.price}`));
        await rigHostBack(session, "shop");
        await session.pause(600);
      }
      check(
        JSON.stringify([...offered].sort()) === JSON.stringify(shelf),
        `the trays offer ${JSON.stringify(offered.sort())}; the Tackle tab sells ${JSON.stringify(shelf)}`,
      );
      // The next rod step from the Rod's tray, at the shelf's price: owned and fitted after, marked as his shelf does.
      const before = await session.eval(() => window.__gw.progression.loop.state().clams);
      const rodPrice = Number(shelf.find((c) => c.startsWith("rod:1:")).split(":")[2]);
      await rigHostTray(session, "shop", "rod");
      check(await rigHostPress(session, "shop", '[data-buy="rod:1"]'), "no rod:1 in the Rod's tray");
      await session.pause(1000);
      const rod = await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        return { tier: s.tackle.rod, clams: s.clams, fit: s.fit?.rod ?? null };
      });
      const rodTray = await session.eval(() => {
        const tray = document.querySelector(".gw-mb-page--rig .gw-rig-tray");
        const on = tray?.querySelector(".gw-rig-opt[aria-pressed=true]");
        return {
          part: tray?.dataset.part ?? null,
          on: on?.dataset.key ?? null,
          tag: on?.querySelector(".gw-rig-owned")?.textContent ?? null,
          stamped: !!on?.querySelector(".gw-rig-stamp.gw-press"),
          more: [...tray.querySelectorAll(".gw-rig-shop")].map((o) => o.dataset.buy),
        };
      });
      check(
        rod.tier === 1 && rod.clams === before - rodPrice && rod.fit === null,
        `after buying the rod: ${JSON.stringify(rod)} (had ${before}, price ${rodPrice})`,
      );
      check(
        rodTray.part === "rod" && rodTray.on !== "rod_0" && rodTray.tag === "Yours." && rodTray.stamped,
        `the Rod's tray after buying: ${JSON.stringify(rodTray)}`,
      );
      // A leader from the Leader's tray: owned, on the rig in use, and Murk says which rig, as on his shelf.
      await rigHostBack(session, "shop");
      await session.pause(600);
      const leaderTray = await rigHostTray(session, "shop", "leader");
      check(
        leaderTray?.owned.length === 1 && leaderTray.owned[0].key === "plain_knot" && leaderTray.owned[0].on,
        `the Leader's tray: ${JSON.stringify(leaderTray)}`,
      );
      check(
        await rigHostPress(session, "shop", '[data-buy="part:pike_wire"]'),
        "no Pike Wire in the Leader's tray",
      );
      await session.pause(1000);
      const leader = await session.eval(() => {
        const s = window.__gw.progression.loop.state();
        return {
          parts: [...s.parts],
          fitted: s.fitted.leader,
          line: document.querySelector(".gw-book .gw-murk-line")?.textContent ?? "",
        };
      });
      check(
        leader.parts.includes("pike_wire") &&
          leader.fitted === "pike_wire" &&
          leader.line === "It is on Rig 1 now.",
        `after buying Pike Wire: ${JSON.stringify(leader)}`,
      );
      // Escape closes the tray first, then the shop.
      await session.page.keyboard.press("Escape");
      await session.pause(800);
      const escaped = await session.eval(() => ({
        shop: !!document.querySelector(".gw-book"),
        tray: !!document.querySelector(".gw-mb-page--rig .gw-rig-tray"),
      }));
      check(escaped.shop && !escaped.tray, `after Escape: ${JSON.stringify(escaped)}`);
      return `${offered.length} pieces offered from ${shown.nodes.length} trays; rod:1 for ${rodPrice}; Pike Wire on Rig 1`;
    },
  },

  {
    name: "rig picture on the Sheet on the water: with no line out a tray fits a piece, as on the tackle screen; with a cast out the Sheet stays shut (Reel in first) and nothing changes",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 480_000,
    async run(session, { fixture }) {
      await continueToPlay(session, fixture);
      const idle = await openRigHost(session, "sheet");
      check(idle && !idle.busy, `the picture with no line out: ${JSON.stringify(idle)}`);
      await rigHostTray(session, "sheet", "bait");
      check(
        await rigHostPress(session, "sheet", '.gw-rig-opt[data-key="lumen_moss"]'),
        "no Lumen Moss option",
      );
      await session.pause(900);
      const fitted = await session.eval(() => window.__gw.state.run?.equippedBait ?? null);
      check(fitted === "lumen_moss", `with no line out: ${fitted}`);
      for (let i = 0; i < 4 && (await session.eval(() => !!document.querySelector(".gw-m-catalogue"))); i++) {
        await session.page.keyboard.press("Escape");
        await session.pause(600);
      }
      const cast = await session.eval(async () => {
        const g = window.__gw,
          p = g.player.position,
          yaw = g.render.getYaw();
        g.debug.castAt(p.x - Math.sin(yaw) * 9, p.z - Math.cos(yaw) * 9, 0.6);
        for (let i = 0; i < 40 && g.fishing.state !== "waiting"; i++)
          await new Promise((r) => setTimeout(r, 250));
        return g.fishing.state;
      });
      check(cast === "waiting", `the cast: ${cast}`);
      await session.closeGuides(4000); // a first-cast tip
      const rigBefore = await session.eval(() => JSON.stringify(window.__gw.progression.loop.state().fitted));
      const opened = await session.eval(() => window.__gw.ui.openSheet({ from: "rack", section: "tackle" }));
      await session.pause(1500);
      const after = await session.eval(() => ({
        host: !!document.querySelector(".gw-rig-host"),
        bait: window.__gw.state.run?.equippedBait ?? null,
        fitted: JSON.stringify(window.__gw.progression.loop.state().fitted),
        out: window.__gw.fishing.hookLine?.()?.out === true,
      }));
      check(
        opened === false &&
          !after.host &&
          after.bait === "lumen_moss" &&
          after.fitted === rigBefore &&
          after.out,
        `with a cast out: ${JSON.stringify({ opened, ...after })}`,
      );
      return "Lumen Moss fitted from the Sheet's tray with no line out; with a cast out the Sheet is refused and the rig is as it was";
    },
  },

  {
    name: "rig picture in Sporewood: the Sheet and Murk's Tackle tab show the tackle screen's picture, with Sporewood's own Leader and Hook and no Depth; at Murk's a Leader or Hook with goods carries its chip and its tray reaches its last option",
    fixture: "sporewood-crossed",
    debug: true,
    editSave: (save) => {
      RIG_PARTS_SAVE(save);
      withParts(["sounding_lead", "pike_wire", "chafe_gut", "turnback_hook"])(save);
      withSporeParts(["brass_trace", "burl_hook"], { leader: "brass_trace", hook: "burl_hook" })(save);
      save.meta.loop.arrivals.shelved.push("mossthread_snood");
    },
    async run(session) {
      await session.toHome();
      const screen = await rigScreen(session);
      await closeTackle(session);
      await session.pause(500);
      const sheet = await openRigHost(session, "sheet");
      await backToJetty(session);
      const shop = await openRigHost(session, "shop");
      const want = screen.nodes.map((n) => `${n.part}:${n.key}`);
      check(
        sameJson(want, [
          "rod:willow_switch",
          "reel:wooden_winch",
          "line:twine",
          "leader:brass_trace",
          "hook:burl_hook",
          "bait:spore_cake",
        ]) &&
          sameJson(sheet?.nodes, want) &&
          sameJson(shop?.nodes, want),
        `the tackle screen ${JSON.stringify(want)}, the Sheet ${JSON.stringify(sheet?.nodes)}, Murk's ${JSON.stringify(shop?.nodes)}`,
      );
      // At Murk's: the Leader sells the snood ("Leader · 1 for sale"); the Hook has nothing for sale here.
      const chips = await session.eval(
        (sel) =>
          Object.fromEntries(
            [...document.querySelectorAll(`${sel} .gw-rig-node`)].map((b) => [
              b.dataset.part,
              b.querySelector(".gw-rig-sale")?.textContent ?? null,
            ]),
          ),
        RIG_HOST.shop,
      );
      check(
        chips.leader === "Leader · 1 for sale" && chips.hook === null,
        `the chips at Murk's: ${JSON.stringify(chips)}`,
      );
      const tray = await rigHostTray(session, "shop", "leader");
      check(
        // (the owned ones in the save's order: the loader adds the Plain Knot after the bought parts)
        sameJson(tray?.owned.map((o) => `${o.key}:${o.on}`).sort(), [
          "brass_trace:true",
          "plain_knot:false",
        ]) &&
          tray.shop.length === 1 &&
          tray.shop[0].id === "part:mossthread_snood" &&
          tray.shop[0].price === 230,
        `the Leader's tray at Murk's: ${JSON.stringify(tray)}`,
      );
      // The tray's list scrolled to its end shows its last option whole, under the tray's name.
      const last = await session.eval((sel) => {
        const host = document.querySelector(sel),
          list = host?.querySelector(".gw-rig-tray .gw-rig-opts"),
          opts = [...(list?.querySelectorAll(".gw-rig-opt") || [])],
          end = opts[opts.length - 1];
        if (!end) return null;
        list.scrollTop = list.scrollHeight;
        const lr = end.getBoundingClientRect(),
          vr = list.getBoundingClientRect(),
          pr = host.closest(".gw-mb-page").getBoundingClientRect();
        return {
          id: end.dataset.buy ?? null,
          inView: lr.top >= Math.max(vr.top, pr.top) - 1 && lr.bottom <= Math.min(vr.bottom, pr.bottom) + 1,
        };
      }, RIG_HOST.shop);
      check(
        last?.id === "part:mossthread_snood" && last.inView,
        `the tray's last option: ${JSON.stringify(last)}`,
      );
      await rigHostBack(session, "shop");
      return `${want.join(", ")}; ${chips.leader}`;
    },
  },

  {
    name: "Murk's Tackle tab: each part with goods carries a chip with their count, the line over the picture shows until a tray is opened once and stays gone after a reload, and at 844 x 390 the last item of the bait and lure trays scrolls into view by wheel and keys and is bought",
    fixture: "sporewood-crossed",
    debug: true,
    timeoutMs: 600_000,
    async run(session) {
      // A phone held sideways.
      await session.page.setViewportSize({ width: 844, height: 390 });
      await session.toHome();
      const HOST = RIG_HOST.shop;
      const shownNow = () =>
        session.eval((sel) => {
          const host = document.querySelector(sel);
          if (!host) return null;
          return {
            chips: [...host.querySelectorAll(".gw-rig-node")].map(
              (b) =>
                `${b.dataset.part}:${b.dataset.sale ?? "-"}:${b.querySelector(".gw-rig-sale")?.textContent ?? ""}`,
            ),
            hint: host.querySelector(".gw-rig-hint")?.textContent ?? null,
            glow: host.classList.contains("gw-rig-learn"),
            tray: host.querySelector(".gw-rig-tray")?.dataset.part ?? null,
            seen: window.__gw.state.meta.seenTips?.rig_tray === true,
          };
        }, HOST);
      // What his Tackle tab sells for each part: rod, reel and line steps, and lures for the bait.
      const forSale = await session.eval(() => {
        const n = {};
        for (const c of window.__gw.progression.loop.shelf().tabs.find((t) => t.id === "tackle").items)
          if (c.bought !== true && c.sealed !== true && c.price != null) {
            const part = c.slot === "lure" ? "bait" : c.slot;
            n[part] = (n[part] || 0) + 1;
          }
        return n;
      });
      const what = {
        rod: ["Rod", "Rods"],
        reel: ["Reel", "Reels"],
        line: ["Line", "Lines"],
        bait: ["Lure", "Lures"],
      };
      // The chips expected, the bait's part named `last` ("lure" once a lure is on).
      const want = (counts, last = "bait") =>
        ["rod", "reel", "line", "bait"].map((p) =>
          counts[p]
            ? `${p === "bait" ? last : p}:${counts[p]}:${what[p][counts[p] === 1 ? 0 : 1]} · ${counts[p]} for sale`
            : `${p === "bait" ? last : p}:-:`,
        );
      const HINT =
        "Press a part of your rig to see what Murk sells for it. Pick one with the arrow keys or the left stick.";
      // Nothing is affordable yet (137 clams), so no tray opens by itself: the picture, its chips and the line.
      await openRigHost(session, "shop");
      const first = await shownNow();
      check(
        sameJson(first?.chips, want(forSale)) &&
          first.hint === HINT &&
          first.glow &&
          !first.tray &&
          !first.seen,
        `on first open: ${JSON.stringify(first)}; the shelf sells ${JSON.stringify(forSale)}`,
      );
      // A tray opened by the player: the line and the glow go, and stay gone after Back.
      await rigHostTray(session, "shop", "bait");
      await rigHostBack(session, "shop");
      await session.pause(700);
      const after = await shownNow();
      check(
        after && after.hint === null && !after.glow && after.seen && sameJson(after.chips, first.chips),
        `after a tray was opened: ${JSON.stringify(after)}`,
      );
      await backToJetty(session);
      // Saved and loaded again: still gone. Clams for everything, so the first part he can be paid for (the rod)
      // opens by itself.
      await reloadToHome(session);
      await session.closeGuides(4000);
      await session.eval(() => window.__gw.debug.loop.giveClams(5000));
      await openRigHost(session, "shop");
      const reloaded = await shownNow();
      check(
        reloaded && reloaded.hint === null && !reloaded.glow && reloaded.seen && reloaded.tray === "rod",
        `after a reload, with clams: ${JSON.stringify(reloaded)}`,
      );
      await rigHostBack(session, "shop");
      await session.pause(700);
      // The tray's list, its last option and what the page shows of it.
      const lastShown = () =>
        session.eval((sel) => {
          const host = document.querySelector(sel),
            tray = host?.querySelector(".gw-rig-tray"),
            list = tray?.querySelector(".gw-rig-opts"),
            opts = [...(list?.querySelectorAll(".gw-rig-opt") || [])],
            last = opts[opts.length - 1];
          if (!last) return null;
          const lr = last.getBoundingClientRect(),
            vr = list.getBoundingClientRect(),
            pr = host.closest(".gw-mb-page").getBoundingClientRect(),
            x = lr.left + lr.width / 2,
            y = lr.top + Math.min(lr.height / 2, 20);
          return {
            part: tray.dataset.part,
            id: last.dataset.buy ?? null,
            price: Number((last.querySelector(".gw-rig-price")?.textContent || "").replace(/\D/g, "")),
            more: tray.dataset.more ?? "",
            inView: lr.top >= Math.max(vr.top, pr.top) - 1 && lr.bottom <= Math.min(vr.bottom, pr.bottom) + 1,
            hit: document.elementFromPoint(x, y)?.closest(".gw-rig-opt") === last,
            x,
            y,
            list: { top: Math.round(list.scrollTop), height: list.scrollHeight, shown: list.clientHeight },
          };
        }, HOST);
      const lures = () => session.eval(() => [...window.__gw.progression.loop.state().lures]);
      const clams = () => session.eval(() => window.__gw.progression.loop.state().clams);
      // The bait's tray (Spore Cake on): the wheel over its list brings the last lure into view, pressed there.
      await rigHostTray(session, "shop", "bait");
      const before = await lastShown();
      check(
        before && before.id?.startsWith("lure:") && !before.inView && /below/.test(before.more),
        `the bait's tray before scrolling: ${JSON.stringify(before)}`,
      );
      const box = await session.eval(
        (sel) => document.querySelector(`${sel} .gw-rig-opts`).getBoundingClientRect().toJSON(),
        HOST,
      );
      await session.page.mouse.move(box.x + box.width / 2, box.y + Math.min(60, box.height / 2));
      for (let i = 0; i < 16; i++) {
        await session.page.mouse.wheel(0, 240);
        await session.pause(150);
      }
      await session.pause(800);
      const wheeled = await lastShown();
      check(
        wheeled?.inView && wheeled.hit && !/below/.test(wheeled.more),
        `the bait's tray after the wheel: ${JSON.stringify(wheeled)}`,
      );
      const had = await clams();
      await session.page.mouse.click(wheeled.x, wheeled.y);
      await session.pause(1200);
      const bought1 = { lures: await lures(), clams: await clams() };
      const lure1 = wheeled.id.slice(5);
      check(
        bought1.lures.includes(lure1) && bought1.clams === had - wheeled.price,
        `after pressing ${wheeled.id} (${wheeled.price}): ${JSON.stringify(bought1)} (had ${had})`,
      );
      // The lure bought, fitted from the same tray: the part is now the Lure, and its tray is the same list.
      await session.eval(
        ([sel, id]) => document.querySelector(`${sel} .gw-rig-tray .gw-rig-opt[data-key="${id}"]`)?.click(),
        [HOST, lure1],
      );
      await session.pause(1000);
      const fitted = await session.eval(() => window.__gw.progression.loop.state().fitted.lure);
      check(fitted === lure1, `the lure fitted from the tray: ${fitted}`);
      // The Lure's tray by keys: down to its last option, which comes into view, and Enter buys it.
      await rigHostTray(session, "shop", "lure");
      await session.eval((sel) => document.querySelector(`${sel} .gw-rig-tray .gw-rig-back`)?.focus(), HOST);
      let keyed = null;
      for (let i = 0; i < 30; i++) {
        await session.page.keyboard.press("ArrowDown");
        await session.pause(120);
        keyed = await session.eval((sel) => {
          const opts = [...document.querySelectorAll(`${sel} .gw-rig-tray button.gw-rig-opt`)];
          return { at: opts.indexOf(document.activeElement), of: opts.length };
        }, HOST);
        if (keyed.at === keyed.of - 1) break;
      }
      await session.pause(800);
      const keyLast = await lastShown();
      check(
        keyed?.at === keyed.of - 1 &&
          keyLast?.part === "lure" &&
          keyLast.id?.startsWith("lure:") &&
          keyLast.inView,
        `the Lure's tray by keys: ${JSON.stringify({ keyed, keyLast })}`,
      );
      const had2 = await clams();
      await session.page.keyboard.press("Enter");
      await session.pause(1200);
      const bought2 = { lures: await lures(), clams: await clams() };
      check(
        bought2.lures.includes(keyLast.id.slice(5)) && bought2.clams === had2 - keyLast.price,
        `after Enter on ${keyLast.id} (${keyLast.price}): ${JSON.stringify(bought2)} (had ${had2})`,
      );
      // Escape closes the tray; the Lure's chip counts the two fewer.
      await session.page.keyboard.press("Escape");
      await session.pause(900);
      const left = await shownNow();
      check(
        left && !left.tray && sameJson(left.chips, want({ ...forSale, bait: forSale.bait - 2 }, "lure")),
        `after the two lures were bought: ${JSON.stringify(left)}`,
      );
      return `chips ${first.chips.join(", ")}; ${lure1} bought by wheel and press, ${keyLast.id.slice(5)} by keys and Enter; then ${left.chips[3]}`;
    },
  },

  {
    name: "camera after reeling: once a landed fish's card closes, the camera pulls back once to the resting distance and is still three seconds later",
    fixture: "mid-mossmere",
    debug: true,
    timeoutMs: 480_000,
    async run(session) {
      await session.sail();
      // Every frame: the game's own time (the clamped step the camera gets), the camera and the raft.
      await session.eval(() => {
        const g = window.__gw,
          r = g.render,
          update = r.update.bind(r),
          rec = (window.__camAfterReel = { t: 0, on: false, frames: [] });
        r.update = (dt, ...rest) => {
          const out = update(dt, ...rest);
          rec.t += Math.min(Math.max(Number(dt) || 0, 0), 0.1);
          if (rec.on) {
            const p = r.camera.position,
              raft = g.player.position,
              e = r.camera.matrixWorld.elements;
            rec.frames.push({
              t: rec.t,
              x: p.x,
              y: p.y,
              z: p.z,
              look: [-e[8], -e[9], -e[10]],
              dist: Math.hypot(p.x - raft.x, p.y - raft.y, p.z - raft.z),
            });
          }
          return out;
        };
      });
      const record = (on) =>
        session.eval((v) => {
          const rec = window.__camAfterReel;
          v && (rec.frames = []);
          rec.on = v;
          return rec.t;
        }, on);
      const gameTime = () => session.eval(() => window.__camAfterReel.t);
      const waitGame = async (secs) => {
        const until = (await gameTime()) + secs;
        for (const end = Date.now() + 240_000 * SLOW; Date.now() < end; await session.pause(400))
          if ((await gameTime()) >= until) return;
        throw new Error(`${secs}s of game time did not pass`);
      };
      // The camera at rest on the raft before the cast: the usual fishing distance.
      await waitGame(3);
      await record(true);
      await waitGame(3);
      const restFrames = await session.eval(() => window.__camAfterReel.frames.slice(-20));
      const restDist = restFrames.reduce((s, f) => s + f.dist, 0) / restFrames.length;
      await hookAndPlayOut(session, "dusk_minnow", "land", { z: -1 });
      await session.pause(1500);
      const closedAt = await record(true);
      check(await session.clickButton(/^\d?Keep\b/), "no Keep on the catch card");
      // A guide box that follows the card holds the screen, and the camera waits behind it: the three
      // seconds count from when nothing holds the screen.
      await session.pause(600);
      await session.closeGuides(8000);
      const freeAt = await gameTime();
      await waitGame(3.6);
      const frames = await session.eval(() => window.__camAfterReel.frames);
      await record(false);
      const after = frames.filter((f) => f.t >= closedAt);
      check(after.length > 10, `only ${after.length} frames were drawn after the card closed`);
      // One move away from the raft: the distance never comes back in by more than 2 cm from its furthest.
      let far = after[0].dist,
        back = 0;
      for (const f of after) (far = Math.max(far, f.dist)), (back = Math.max(back, far - f.dist));
      check(
        back <= 0.02,
        `the camera pulled out to ${far.toFixed(2)} m and came back in by ${back.toFixed(2)} m`,
      );
      // Still from three seconds on: no step, bob or turn of the view between frames.
      const late = after.filter((f) => f.t - freeAt >= 3);
      check(late.length >= 2, `only ${late.length} frames from three seconds after the card`);
      let moved = 0,
        turned = 0;
      for (let i = 1; i < late.length; i++) {
        const a = late[i - 1],
          b = late[i];
        moved = Math.max(moved, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
        turned = Math.max(turned, Math.hypot(...b.look.map((v, k) => v - a.look[k])));
      }
      check(
        moved < 0.002 && turned < 0.0005,
        `the camera still moves three seconds after the card: ${moved.toFixed(4)} m, view ${turned.toFixed(5)} a frame`,
      );
      // The usual distance: before the cast the live rig sways and rides the swell a few tenths of a metre
      // about it; the return holds the pose without them.
      const final = after.at(-1).dist;
      check(
        Math.abs(final - restDist) < 0.5,
        `the camera settled at ${final.toFixed(2)} m from the raft, not its resting ${restDist.toFixed(2)} m`,
      );
      return `out from ${after[0].dist.toFixed(2)} m to ${final.toFixed(2)} m (resting ${restDist.toFixed(2)} m) in one move, still after 3 s`;
    },
  },
  {
    name: "lure strike: a take on the Bent Spoon gives about 40% more time to strike than a bite on worms, and a press after a worm bite's time is up, but inside the spoon's, sets the hook",
    fixture: "fresh-first-evening",
    debug: true,
    timeoutMs: 480_000,
    async run(session) {
      await session.sail(SLOW_SAIL);
      // In this page only: every second of the spoon's swim back rolls a take, and no take is a hard take
      // (which sets itself), so a take that needs a press comes at once. Fights end at once as escapes.
      const table = await session.eval(() => {
        const g = window.__gw,
          s = g.data.AUTOFISH.strike;
        g.data.LOOP.lureCast.strike = 1;
        g.data.LOOP.hardTake.chance = 0;
        return { window: { ...s.window }, clamp: [...s.clamp], late: s.lateGrace, comp: s.latencyComp.mouse };
      });
      // One cast (worms, or the spoon), watched frame by frame: the gauge as the bite shows it, then a mouse
      // press `after` s past the time a worm bite of the take's size would end on this rod (`old`: the rod's
      // factor and the table; no press for null), and the strike's grade or the miss.
      const castAndPress = (lure, old) =>
        session.eval(
          ([lure, old]) =>
            new Promise((resolve) => {
              const g = window.__gw,
                rec = { gauge: null, pressedAt: null, grade: null, miss: null, hard: false };
              const oldEnd = (cls) =>
                Math.min(old.table.clamp[1], Math.max(old.table.clamp[0], old.table.window[cls] * old.rodK)) +
                old.table.late;
              let pressAt = null;
              // Fitted as from the tin: the spoon takes the worms off, and worms take the spoon off.
              const loop = g.progression.loop;
              rec.fitted = lure
                ? loop.changeHook({ lure })?.ok === true
                : loop.changeHook({ lure: null, bait: "mireworm" })?.ok === true;
              g.debug.fishOutcome("lose");
              const offs = [
                g.bus.on("fishing:strike", (e) => (rec.grade = e.grade)),
                g.bus.on("fishing:miss", (e) => (rec.miss = e.reason || "miss")),
                g.bus.on("fishing:bite", (e) => ((rec.hard = !!e.hardTake), (rec.cls = e.sizeClass))),
              ];
              const p = g.player.position,
                yaw = g.render.getYaw(),
                t0 = performance.now();
              rec.cast = g.debug.castAt(p.x - Math.sin(yaw) * 11, p.z - Math.cos(yaw) * 11, 0.7);
              let forced = false;
              const tick = () => {
                const st = g.fishing.state,
                  v = g.fishing.view;
                // A guide card (the tin's, at the first lure) holds the game: closed as a player would.
                if (g.ui.isBlocking?.() === true)
                  [...document.querySelectorAll("button")]
                    .find((b) => b.getBoundingClientRect().width > 0 && b.textContent.trim() === "Got it")
                    ?.click();
                // Worms: the bite is brought on 1.2 s after the float settles, nibbles and all.
                if (!lure && st === "waiting" && !forced) forced = g.debug.forceBite({ wait: 1.2 }) !== false;
                if (st === "bite" && v.strikeGauge) {
                  rec.gauge ||= { ...v.strikeGauge };
                  if (old && pressAt == null && rec.cls) pressAt = oldEnd(rec.cls) + old.after;
                  if (pressAt != null && rec.pressedAt == null && v.strikeGauge.t >= pressAt) {
                    rec.pressedAt = v.strikeGauge.t;
                    g.fishing.onPointerDown({ input: "mouse" });
                  }
                }
                // Back in with nothing (the spoon swam home untaken): done as well.
                rec.waited ||= st === "waiting";
                const done = rec.grade || rec.miss || rec.hard || !rec.cast || (rec.waited && st === "idle");
                if (done || performance.now() - t0 > 150_000) {
                  g.fishing.state === "reeling" && g.debug.fishPlayTo(0.995);
                  offs.forEach((off) => off());
                  resolve({ ...rec, state: g.fishing.state });
                  return;
                }
                requestAnimationFrame(tick);
              };
              requestAnimationFrame(tick);
            }),
          [lure, old],
        );
      const settle = async () => {
        for (const end = Date.now() + 60_000 * SLOW; Date.now() < end; ) {
          const st = await session.eval(() => window.__gw.fishing.state);
          if (st === "idle") return;
          st === "reeling" && (await session.eval(() => window.__gw.debug.fishPlayTo(0.995)));
          await session.clickButton(/^Got it$/);
          await session.pause(400);
        }
        throw new Error(`the line did not come back in; ${JSON.stringify(await session.state())}`);
      };
      const clamp = (x) => Math.min(table.clamp[1], Math.max(table.clamp[0], x));
      // A bite on worms keeps the old time: its window is the size's window times the rod's, and after it
      // the late grace. The rod's factor read from it gives the old time for any size.
      let worm = null;
      for (let tries = 0; tries < 3 && !(worm?.gauge && table.window[worm.cls]); tries++) {
        await settle();
        await session.closeGuides(2000);
        worm = await castAndPress(null, null);
      }
      check(
        worm.fitted && worm.gauge && table.window[worm.cls] && worm.miss === "passed",
        `a worm bite left alone did not pass: ${JSON.stringify(worm)}`,
      );
      const rodK = worm.gauge.win / table.window[worm.cls];
      check(
        Math.abs(worm.gauge.end - worm.gauge.win - table.late) < 1e-6 && Math.abs(rodK - 1) < 0.02,
        `a worm bite's time is not the size's window on the Willow Switch plus ${table.late} s: ${JSON.stringify(worm.gauge)} (${worm.cls})`,
      );
      // The spoon: a take shows the gauge, about 40% longer in every part; a press after a worm bite of the
      // same size would have been let go, but before the spoon's late grace ends, sets the hook.
      let spoon = null;
      for (let tries = 0; tries < 4 && !spoon?.gauge; tries++) {
        await settle();
        await session.closeGuides(2000);
        spoon = await castAndPress("bent_spoon", { table, rodK, after: table.comp + 0.08 });
      }
      check(
        spoon?.fitted && spoon.gauge && spoon.cls,
        `no take on the spoon in four casts: ${JSON.stringify(spoon)}`,
      );
      const g = spoon.gauge,
        oldWin = clamp(table.window[spoon.cls] * rodK),
        oldEnd = oldWin + table.late;
      // First what a player meets: the late press sets the hook (on the old time the fish had gone by then).
      check(
        (spoon.grade === "late" || spoon.grade === "struck") && !spoon.miss,
        `the late press did not set the hook: ${JSON.stringify(spoon)}`,
      );
      check(
        spoon.pressedAt - table.comp > oldEnd && spoon.pressedAt < g.end,
        `the press at ${spoon.pressedAt} s was not after the worm bite's end (${oldEnd.toFixed(3)} s) and inside the spoon's (${g.end.toFixed(3)} s)`,
      );
      check(
        g.win / oldWin > 1.35 && g.win / oldWin < 1.45 && g.end / oldEnd > 1.35 && g.end / oldEnd < 1.45,
        `the spoon's ${spoon.cls} take is not about 40% longer than a worm bite's (${oldWin.toFixed(3)} s, ending ${oldEnd.toFixed(3)} s): ${JSON.stringify(g)}`,
      );
      check(
        Math.abs(g.from / g.win - worm.gauge.from / worm.gauge.win) < 1e-6 &&
          Math.abs(g.to / g.win - worm.gauge.to / worm.gauge.win) < 1e-6,
        `the bright notch moved on the gauge: ${JSON.stringify({ spoon: g, worm: worm.gauge })}`,
      );
      return `worms (${worm.cls}): window ${worm.gauge.win.toFixed(2)} s, ends ${worm.gauge.end.toFixed(2)} s; spoon (${spoon.cls}): window ${g.win.toFixed(2)} s, ends ${g.end.toFixed(2)} s; a press at ${spoon.pressedAt.toFixed(2)} s, after ${oldEnd.toFixed(2)} s, is ${spoon.grade}`;
    },
  },
  {
    name: "controller alone at 1280 x 800, ratio 2 (a Legion Go): the sound card on the first press, a Wick, the film, the tow, a cast, a strike, the fight, the card, B for home, the tally, Murk's tabs, the chart, the Journal, Settings and Sail again, every screen with its focus shown and A and B letters",
    fixture: null,
    open: { viewport: { width: 1280, height: 800 }, scale: 2, init: [GAMEPAD_INIT], gesture: false },
    timeoutMs: 900_000,
    async run(session) {
      // The CPU-drawn 3D picture is skipped (seconds a frame at this size here); the game, its screens and the
      // controller all run as they do for a player.
      await session.eval(() => (window.__gw.render.render = () => {}));
      await session.eval(() => window.__padConnect());
      const seen = [];
      let v;
      const look = async () => {
        v = await padView(session);
        const where = `${v.flow}/${v.top ?? "-"}`;
        seen[seen.length - 1] !== where && seen.push(where);
        return v;
      };
      // The focus is drawn within a few frames of a screen opening.
      const shown = async (what) => {
        for (let i = 0; i < 15 && !(await look()).focusShown; i++) await session.pause(200);
        check(v.focusShown, `${what}: no focus shown (${JSON.stringify(v)}); screens ${seen.join(" > ")}`);
      };
      // Presses A (or another button) while a screen is up until `ok` holds: through the tow, the guide's boxes
      // and Murk's tally. With no screen up it only waits: A on the water would cast.
      const pressTo = async (ok, what, button = "A", limit = 40) => {
        for (let i = 0, waits = 0; i < limit && waits < 200; ) {
          if (ok(await look())) return;
          if (v.top) await padPress(session, button), i++;
          else waits++;
          await session.pause(300);
        }
        throw new Error(`did not reach ${what}: ${JSON.stringify(v)}; screens ${seen.join(" > ")}`);
      };
      // A screen and then any guide's box that comes up over it a moment later, closed with A.
      const settle = async (top, what) => {
        await pressTo((x) => x.top === top, what);
        await session.pause(1500);
        await pressTo((x) => x.top === top, what);
      };
      const moveTo = async (label, button, limit = 8) => {
        const path = [];
        for (let i = 0; i < limit && !new RegExp(label).test((await look()).focus ?? ""); i++)
          path.push(v.focus), await padPress(session, button);
        check(
          new RegExp(label).test(v.focus ?? ""),
          `the d-pad did not reach ${label}: ${path.join(" > ")}; ${JSON.stringify(v)}`,
        );
      };

      // The first press: no tap or key yet, so the browser keeps the sound off and the card says so.
      await padPress(session, "DOWN");
      await look();
      check(v.hush && v.sound !== "running", `no sound card on a controller start: ${JSON.stringify(v)}`);
      const card = await visibleText(session, ".gw-hush");
      check(
        /Tap the screen to begin\..*Sound starts when you tap or press a key\..*Press A to play without it\./.test(
          card,
        ),
        `the sound card reads "${card}"`,
      );
      await padPress(session, "A");
      check(
        !(await look()).hush && v.top === "title",
        `A did not play on from the sound card: ${JSON.stringify(v)}`,
      );

      // The title and a Wick: down from the chosen card reaches the buttons under the cards.
      await padPress(session, "A");
      check((await look()).top === "newdescent", `A on the title opened ${v.top}`);
      await padPress(session, "UP");
      await padPress(session, "A");
      await padPress(session, "DOWN");
      check(
        /^(Start|Back)$/.test((await look()).focus ?? ""),
        `down from the chosen Wick went to ${v.focus}`,
      );
      v.focus === "Back" && (await padPress(session, "RIGHT"));
      await look();
      await shown("the Wicks");
      check(
        v.focus === "Start" && v.glyphs.includes("A") && v.glyphs.includes("B"),
        `on the Wicks: focus ${v.focus}, letters ${v.glyphs}`,
      );
      await padPress(session, "A");
      await session.waitFor("the film", 30_000, () => window.__gw.flow !== "title");
      (await look()).flow === "intro" && (await padPress(session, "B"));

      // The tow and the welcome, then the chart's box and Sail.
      // A closes the guide's box over the chart, then waits: A on the chart itself would sail.
      await pressTo((x) => x.top === "chart", "the chart");
      await moveTo("^Sail$", "DOWN", 3);
      await shown("the chart");
      await padPress(session, "A");
      await pressTo((x) => x.flow === "playing" && x.top === "guide", "the cast box on the water");
      const castBox = await visibleText(session, ".gw-m-guide");
      check(
        /Sail with the left stick/.test(castBox) && /press A and let go/.test(castBox),
        `the cast box reads "${castBox}"`,
      );
      await padPress(session, "A");
      await session.waitFor("the cast tip", 30_000, () =>
        document.body.innerText.includes("Press A. Let go to cast."),
      );
      const hints = await session.eval(() =>
        [...document.querySelectorAll("kbd")]
          .filter((k) => k.getBoundingClientRect().width > 0 && getComputedStyle(k).display !== "none")
          .map((k) => getComputedStyle(k, "::after").content.replace(/"/g, "") || k.textContent),
      );
      check(
        hints.includes("X") && hints.includes("B") && hints.length === 2,
        `key hints on the water: ${hints}`,
      );

      // Cast with A, wait for the bite (A closes the guide's boxes), strike with A, and the fight plays.
      let landed = false;
      for (let cast = 0; cast < 6 && !landed; cast++) {
        await pressTo(
          (x) => x.top === null && x.fishing === "idle" && x.mode === "water",
          "the water, free to cast",
        );
        await session.eval(() => window.__padSet(0, true));
        await waitFrames(session, 40);
        await session.eval(() => window.__padSet(0, false));
        for (const end = Date.now() + 240_000 * SLOW; Date.now() < end; await session.pause(25)) {
          await look();
          if (v.top === "guide") await padPress(session, "A");
          else if (v.fishing === "bite") await padPress(session, "A", 1);
          else if (v.top === "catch") break;
          else if (v.fishing === "idle" && v.top === null) break;
        }
        landed = v.top === "catch";
      }
      check(landed, `no fish landed in six casts; screens ${seen.join(" > ")}`);
      await session.pause(1500);
      await pressTo((x) => x.top === "catch", "the catch card, its guide box closed");
      await shown("the catch card");
      check(
        v.glyphs.includes("A") && v.glyphs.includes("B"),
        `the catch card shows ${v.glyphs}, not A and B`,
      );
      const digits = await session.eval(
        () =>
          [...document.querySelectorAll(".gw-modal:not(.gw-out) kbd")].filter(
            (k) => getComputedStyle(k).display !== "none",
          ).length,
      );
      check(digits === 0, `${digits} keyboard keys show on the catch card while the controller is in use`);
      await pressTo((x) => x.top !== "catch", "Keep", "A");
      await pressTo(
        (x) => x.top === null && x.mode === "water" && x.fishing === "idle",
        "the water after the card",
      );

      // Home with B held, then the tally and Murk's boxes with A.
      // A guide box can come up a moment after the card (B then closes it): hold B again once it has gone.
      for (let tries = 0; tries < 8 && (await look()).flow !== "home"; tries++) {
        await session.pause(2000);
        await pressTo(
          (x) => x.top === null && x.mode === "water" && x.fishing === "idle",
          "the water, to go home",
        );
        await session.eval(() => window.__padSet(1, true));
        await session.waitFor("home", 8_000, () => window.__gw.flow === "home").catch(() => null);
        await session.eval(() => window.__padSet(1, false));
        await waitFrames(session, 3);
      }
      check(
        v.flow === "home" || (await look()).flow === "home",
        `B held did not sail home: ${JSON.stringify(v)}`,
      );
      await pressTo((x) => x.top === "tally", "the tally");
      await pressTo((x) => x.top === "jetty", "the barge's menu");
      await session.pause(2000); // Murk's box or the guide's comes a moment after the menu
      await pressTo((x) => x.top === "jetty", "the barge's menu");
      await shown("the barge's menu");

      // Murk: the bumpers turn his book a spread at a time, both ways, and B closes it.
      await moveTo("^Murk$", "RIGHT");
      await padPress(session, "A");
      await pressTo((x) => x.top === "shelf", "Murk's book", "A", 4);
      await session.pause(1500); // the book opens
      const firstTab = (await look()).tab;
      await shown("Murk's book");
      const tabs = [firstTab];
      for (const b of ["RB", "RB", "LB", "LB"]) {
        await padPress(session, b);
        await session.pause(1500); // the page turns
        tabs.push((await look()).tab);
      }
      check(
        tabs[1] !== tabs[0] && tabs[2] !== tabs[1] && tabs[3] === tabs[1] && tabs[4] === tabs[0],
        `Murk's tabs by the bumpers: ${tabs.join(" > ")}`,
      );
      await pressTo((x) => x.top === "jetty", "the barge's menu, Murk's book closed by B", "B", 4);

      // The chart, then the Journal and its tabs.
      await moveTo("^Chart$", "LEFT");
      await padPress(session, "A");
      await settle("chart", "the chart");
      await padPress(session, "UP");
      check((await look()).top === "chart", `the chart did not stay open: ${v.top}`);
      await shown("a place on the chart");
      await pressTo((x) => x.top === "jetty", "the barge's menu, the chart closed by B", "B", 4);
      await moveTo("^Journal$", "RIGHT");
      await padPress(session, "A");
      await settle("journal", "the Journal");
      const page = (await look()).tab;
      await padPress(session, "RB");
      await session.pause(600);
      check((await look()).tab !== page, `RB did not turn the Journal's page from ${page}`);
      await padPress(session, "LB");
      await session.pause(600);
      check((await look()).tab === page, `LB did not turn back to ${page}: ${v.tab}`);
      await shown("the Journal");
      await pressTo((x) => x.top === "jetty", "the barge's menu, the Journal closed by B", "B", 4);

      // Settings from the barge's menu: Full screen, pressed from the controller, asks for a tap.
      await padPress(session, "B");
      check((await look()).top === "homepause", `B on the barge's menu opened ${v.top}`);
      await moveTo("^Settings$", "DOWN");
      await padPress(session, "A");
      await settle("settings", "Settings");
      if (await session.eval(() => !!document.fullscreenEnabled)) {
        // Up from Done reaches the Quality row (the centred button sits under it), then right to High, above the
        // column of switches, and down to Full screen.
        await moveTo("^(Auto|Low|Medium|High)$", "UP", 4);
        await moveTo("^High$", "RIGHT", 4);
        await moveTo("^Full screen$", "DOWN", 3);
        await padPress(session, "A");
        await session.waitFor("the full-screen line", 10_000, () =>
          document.body.innerText.includes("Tap the switch to fill the screen."),
        );
      }
      await padPress(session, "B");
      await padPress(session, "B");

      // And back out on the water.
      await moveTo("^Chart$", "LEFT");
      await padPress(session, "A");
      await pressTo((x) => x.top === "chart" && x.focus === "Sail", "Sail", "DOWN");
      await padPress(session, "A");
      await session.waitFor("the water", 120_000, () => window.__gw.flow === "playing");
      check((await look()).sound !== "running", "the sound started with no tap or key");
      return `screens ${seen.join(" > ")}`;
    },
  },
  {
    name: "controller alone in Murk's Tackle tab, at 1280 x 800 ratio 2 and at 844 x 390: A opens a part's tray, the d-pad keeps to it and stops on its last option with the A ring beside it, B closes it back to its part and the page does not turn, left from Rig 1 stays on the picture, A buys in a tray, and a part's kind is at least 13 px",
    fixture: "mid-mossmere",
    debug: true,
    open: { viewport: { width: 1280, height: 800 }, scale: 2, init: [GAMEPAD_INIT] },
    timeoutMs: 600_000,
    async run(session) {
      // The CPU-drawn 3D picture is skipped, as in "controller alone"; the book and the controller run as they do.
      await session.eval(() => (window.__gw.render.render = () => {}));
      await session.toHome();
      await session.closeGuides(4000);
      await session.eval(() => window.__padConnect());
      const HOST = RIG_HOST.shop;
      // What a controller player sees of the book: its top screen, the pages showing and the chapter lit, the open
      // tray, the focus (a part, a rig tab, or which of the tray's options) and the A ring's box beside it.
      const look = () =>
        session.eval((sel) => {
          const open = [...document.querySelectorAll(".gw-modal-layer > .gw-modal")].filter(
            (m) => !m.classList.contains("gw-out") && !m.dataset.held,
          );
          const host = document.querySelector(sel),
            f = document.querySelector(".gw-padfocus"),
            ring = [...document.querySelectorAll(".gw-padg.gw-on")].find((c) => c.textContent === "A"),
            opts = [...(host?.querySelectorAll(".gw-rig-tray button.gw-rig-opt") ?? [])],
            box = (el) => {
              const r = el?.getBoundingClientRect();
              return r ? { l: r.left, t: r.top, r: r.right, b: r.bottom } : null;
            };
          return {
            top: open.at(-1)?.dataset.modal ?? null,
            pages: [...document.querySelectorAll(".gw-mb-page")]
              .filter((p) => p.getBoundingClientRect().width > 0)
              .map((p) => p.dataset.page)
              .join(","),
            chapter: document.querySelector(".gw-book-tab[aria-selected=true]")?.textContent.trim() ?? null,
            tray: host?.querySelector(".gw-rig-tray")?.dataset.part ?? null,
            focus: f
              ? (f.getAttribute("aria-label") || f.textContent).trim().replace(/\s+/g, " ").slice(0, 40)
              : null,
            node: f?.classList.contains("gw-rig-node") ? f.dataset.part : null,
            inTray: !!f?.closest(".gw-rig-tray"),
            opt: f ? opts.indexOf(f) : -1,
            opts: opts.length,
            fbox: box(f),
            ring: box(ring),
          };
        }, HOST);
      let v;
      const press = async (button) => {
        await padPress(session, button);
        await session.pause(350);
        return (v = await look());
      };
      // Presses `button` until `ok` holds, at most `limit` times.
      const pressTo = async (ok, button, what, limit = 10) => {
        const path = [(v = await look()).focus];
        for (let i = 0; i < limit && !ok(v); i++) path.push((await press(button)).focus);
        check(
          ok(v),
          `the d-pad (${button}) did not reach ${what}: ${path.join(" > ")}; ${JSON.stringify(v)}`,
        );
      };
      const ringBeside = (x) =>
        !!x.ring &&
        !!x.fbox &&
        x.ring.r <= x.fbox.l + 1 &&
        x.ring.l >= 0 &&
        (x.ring.t + x.ring.b) / 2 > x.fbox.t &&
        (x.ring.t + x.ring.b) / 2 < x.fbox.b;
      const results = [];
      for (const size of [
        { width: 1280, height: 800 },
        { width: 844, height: 390 },
      ]) {
        const at = `${size.width} x ${size.height}`;
        await session.page.setViewportSize(size);
        await session.pause(800);
        await session.eval(() => window.__gw.ui.loop.openShelf({ tab: "tackle" }));
        await session.waitFor("Murk's Tackle tab", 15_000, (sel) => !!document.querySelector(sel), HOST);
        await session.pause(1500);
        // Nothing he sells for the tackle is in the purse's reach, so no tray opens by itself: the d-pad goes to
        // the bait's part (the longest tray, its lures) and A opens it at his goods.
        await pressTo((x) => x.node === "bait", "DOWN", `the bait's part (${at})`);
        const spread = { pages: v.pages, chapter: v.chapter };
        check(
          v.top === "shelf" && !v.tray && /^\d/.test(v.pages),
          `Murk's book at ${at}: ${JSON.stringify(v)}`,
        );
        await press("A");
        await session.pause(600);
        check(
          ((v = await look()), v.tray === "bait" && v.inTray && v.opts >= 4),
          `A on the bait's part at ${at}: ${JSON.stringify(v)}`,
        );
        // Down to the last option, and down once more stays there, with the A ring beside it.
        await pressTo((x) => x.opt === x.opts - 1, "DOWN", `the tray's last option (${at})`, 20);
        await press("DOWN");
        await session.pause(400);
        v = await look();
        check(
          v.tray === "bait" && v.opt === v.opts - 1 && ringBeside(v),
          `the tray's last option at ${at}: ${JSON.stringify(v)}`,
        );
        const last = { n: v.opts, gap: Math.round(v.fbox.l - v.ring.r) };
        // Left and right keep to the tray and do not turn the page.
        for (const b of ["LEFT", "RIGHT"]) {
          await press(b);
          check(
            v.tray === "bait" && v.opt === v.opts - 1 && v.pages === spread.pages,
            `${b} in the bait's tray at ${at}: ${JSON.stringify(v)}`,
          );
        }
        // B closes the tray back to its part; the book stays open on the same pages.
        await press("B");
        await session.pause(500);
        v = await look();
        check(
          v.top === "shelf" &&
            !v.tray &&
            v.node === "bait" &&
            v.pages === spread.pages &&
            v.chapter === spread.chapter,
          `B in the bait's tray at ${at}: ${JSON.stringify(v)} (the book showed ${JSON.stringify(spread)})`,
        );
        // Left from Rig 1 stays on it; right steps to Rig 2.
        await pressTo((x) => /^Rig 1\b/.test(x.focus ?? ""), "UP", `Rig 1 (${at})`);
        await press("LEFT");
        check(
          /^Rig 1\b/.test(v.focus ?? "") && v.pages === spread.pages,
          `left from Rig 1 at ${at}: ${JSON.stringify(v)}`,
        );
        await press("RIGHT");
        check(/^Rig 2\b/.test(v.focus ?? ""), `right from Rig 1 at ${at}: ${JSON.stringify(v)}`);
        results.push(`${at}: the bait's tray ends on option ${last.n}, the A ring ${last.gap} px left of it`);
        if (size.width === 844) {
          // A chooses in a tray: the rod's tray, its next rod bought with A. With nothing more for the rod on his
          // shelf, the part shows its kind, at least 13 px and clear of the drawing.
          await pressTo((x) => x.node === "rod", "DOWN", `the rod's part (${at})`);
          await press("A");
          await session.pause(600);
          await pressTo(
            (x) => x.inTray && x.opt === x.opts - 1,
            "DOWN",
            `the rod's tray's last option (${at})`,
          );
          const rod = await session.eval(
            (sel) => document.querySelector(`${sel} .gw-padfocus`)?.dataset.buy ?? null,
            HOST,
          );
          check(rod?.startsWith("rod:"), `the rod's tray ends on ${rod}`);
          await session.eval(() => window.__gw.debug.loop.giveClams(500));
          const had = await session.eval(() => window.__gw.progression.loop.state().clams);
          await press("A");
          await session.pause(1200);
          const bought = await session.eval(
            (id) =>
              window.__gw.progression.loop
                .shelf()
                .tabs.find((t) => t.id === "tackle")
                .items.some((c) => c.id === id && c.bought === true),
            rod,
          );
          const paid = had - (await session.eval(() => window.__gw.progression.loop.state().clams));
          check(bought && paid > 0, `A on ${rod}: bought ${bought}, paid ${paid}`);
          await press("B");
          await session.pause(500);
          const kind = await session.eval((sel) => {
            const b = document.querySelector(`${sel} .gw-rig-node[data-part="rod"]`),
              k = b?.querySelector(".gw-rig-kind"),
              r = k?.getBoundingClientRect();
            if (!r) return null;
            const drawn = new Set();
            for (let x = r.left + 0.5; x < r.right; x += 2)
              for (let y = r.top + 0.5; y < r.bottom; y += 2)
                for (const el of document.elementsFromPoint(x, y))
                  if (el instanceof SVGElement && el.closest(".gw-rig") && el.tagName !== "svg") {
                    const c = el.getAttribute("class") || el.tagName;
                    /gw-rig-(band|bed|hit)/.test(c) || drawn.add(c);
                  }
            return { text: k.textContent, px: parseFloat(getComputedStyle(k).fontSize), drawn: [...drawn] };
          }, HOST);
          check(
            kind && kind.text === "Rod" && kind.px >= 13 && !kind.drawn.length,
            `the rod's kind at ${at}: ${JSON.stringify(kind)}`,
          );
          results.push(`the rod bought by A for ${paid}; its kind ${kind.px} px`);
        }
        await press("B");
        await session.pause(800);
        check((v = await look()).top === "jetty", `B on the picture at ${at} left ${v.top} open`);
      }
      return results.join("; ");
    },
  },
  {
    name: "real time at 144 Hz: on a 144 Hz screen the dusk, a strike window, a fight, its landing and the raft's sailing speed take the same real time as at 60 Hz",
    fixture: "mid-mossmere",
    debug: true,
    open: { init: [[VIRTUAL_CLOCK, 144], GAMEPAD_INIT] },
    timeoutMs: 900_000,
    async run(session, { browser }) {
      const fast = await timeRealPlay(session);
      const other = await GameSession.open(browser, {
        page: PAGE,
        save: readFileSync(join(FIXTURES_DIR, "mid-mossmere.json"), "utf8"),
        debug: true,
        viewport: VIEWPORT,
        init: [[VIRTUAL_CLOCK, 60], GAMEPAD_INIT],
      });
      let slow;
      try {
        await other.boot();
        slow = await timeRealPlay(other);
        await other.collectGameErrors();
        check(!other.errors.length, `the 60 Hz game: ${other.errors.join("; ")}`);
      } finally {
        await other.close();
      }
      check(
        Math.abs(fast.hz - 144) < 1 && Math.abs(slow.hz - 60) < 1,
        `frame rates ${fast.hz} and ${slow.hz}`,
      );
      // Within two frames of the slower screen (a state is seen at the first frame after it changes).
      const frames2 = 2000 / 60;
      for (const k of ["dusk", "window", "fight", "landing"])
        check(
          Math.abs(fast[k] - slow[k]) <= frames2,
          `${k}: ${fast[k].toFixed(1)} ms at 144 Hz against ${slow[k].toFixed(1)} ms at 60 Hz`,
        );
      check(
        Math.abs(fast.sail / slow.sail - 1) < 0.01,
        `sailing ${fast.sail.toFixed(3)} against ${slow.sail.toFixed(3)} m/s`,
      );
      const ms = (x) => `${Math.round(x)}`;
      return `144 against 60 Hz: dusk ${ms(fast.dusk)}/${ms(slow.dusk)} ms, strike window ${ms(fast.window)}/${ms(slow.window)}, fight ${ms(fast.fight)}/${ms(slow.fight)}, landing ${ms(fast.landing)}/${ms(slow.landing)}, sailing ${fast.sail.toFixed(2)}/${slow.sail.toFixed(2)} m/s`;
    },
  },
];

// The local kinds, their base fish and homes, as in wo.localKinds.
const LOCAL_BASES = {
  stone_minnow: "dusk_minnow",
  archshade_minnow: "dusk_minnow",
  mirror_carp: "weeping_carp",
  buoy_rudd: "lampsipper",
};
const LOCAL_HOMES = {
  stones: "stone_minnow",
  under_the_span: "archshade_minnow",
  lily_maze: "mirror_carp",
  buoy_lights: "buoy_rudd",
};
const LOCAL_LORE = {
  stone_minnow:
    "It is a small olive minnow with dark blotches along its side and a copper belly. It lives over the stones in the shallows.",
};
// tools/fixtures/bite-sequence-homes.json writes each bite as one letter: its place in the fixture's `kinds`.
const SEQUENCE_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
// Where the shares are read: [name, spot, light, bait, the local kind expected there or null].
const LOCAL_SHARE_SPOTS = [
  ["stones by day", { x: -48, z: 18 }, "calm", "mireworm", "stone_minnow"],
  ["Under the Span at night", { place: "under_the_span" }, "gloomtide", "mireworm", "archshade_minnow"],
  ["the Lily Maze at dusk", { place: "lily_maze" }, "dusk", "lumen_moss", "mirror_carp"],
  // On the Buoy Lights themselves: by day they are open water (a drop-off), no home.
  [
    "the Buoy Lights at night",
    { place: "buoy_lights", x: -48, z: -2 },
    "gloomtide",
    "feather_fly",
    "buoy_rudd",
  ],
  ["the Buoy Lights by day", { place: "buoy_lights", x: -48, z: -2 }, "calm", "feather_fly", null],
  ["her water at night", { place: "bell_pool" }, "gloomtide", "feather_fly", null],
  ["deep water at night", { x: -24, z: -10 }, "gloomtide", "lumen_moss", null],
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
    const context = { fixture: fixture ? JSON.parse(fixture) : null, page: PAGE, browser };
    const work = async () => {
      if (scenario.browser === false) return scenario.run(null, context);
      session = await GameSession.open(browser, {
        page: PAGE,
        save: fixture,
        debug: !!scenario.debug,
        viewport: VIEWPORT,
        ...scenario.open,
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
      const limit = (scenario.timeoutMs ?? SCENARIO_TIMEOUT_MS) * SLOW;
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
