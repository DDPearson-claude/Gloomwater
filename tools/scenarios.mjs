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
//   run      async (session, { fixture, page, browser }) => { ... }: throw an Error to fail. `session` is a
//            GameSession (tools/game-driver.mjs) that has booted to the title; `fixture` is the parsed save;
//            `browser` opens a second session (a reload of a saved string).

import { readFileSync } from "node:fs";
import * as acorn from "acorn";
import { join } from "node:path";
import { DEFAULT_PAGE, GameSession, ROOT, launchBrowser } from "./game-driver.mjs";

const BUDGET_MS = 3_600_000; // every scenario, launch to exit
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
        loss: g.debug.fishPlay()?.loss ?? null,
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
    await session.eval(() => document.querySelector(".gw-m-guide .gw-guide-ok")?.click());
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
      const box = await session.page.locator("canvas").first().boundingBox();
      await session.page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.6);
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
    name: "gear: with the Cork Float fitted, a seeded run of bait casts bites exactly as before the Sounding Lead",
    fixture: "legend-sold",
    debug: true,
    timeoutMs: 360_000,
    async run(session, { fixture }) {
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
        const at = got.findIndex((id, i) => id !== sequence[i]);
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
      check(
        gift === null && !after.parts.includes(TIN),
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
    name: "hunt rules: on Waxed Silk she can be landed",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      await session.toHome();
      await buyAtHome(session, ["line:1", "line:2"]);
      await fitHerParts(session);
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
    name: "midnight: she can take only in her time (from the first stroke for three minutes, until she is hooked); the still-water line shows once; her Journal page says she feeds after the bell",
    fixture: "legend-sold",
    debug: true,
    async run(session) {
      // Her Journal page (she is landed in this save): the feeding line agrees with her lore.
      await session.toHome();
      await session.eval((id) => window.__gw.ui.openJournal({ sel: id }), LEGEND_ID);
      await session.waitFor("her journal page", 10_000, () => !!document.querySelector(".gw-jr-where"));
      const where = await visibleText(session, ".gw-jr-where");
      await session.eval(() => window.__gw.ui.closeAll());
      check(
        where.includes("Feeds just after the old bell strikes midnight") && !/calm/i.test(where),
        `her Journal page's feeding line: "${where}"`,
      );
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
      // After the three minutes: closed, and the still-water line shows once.
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
      await session.eval(() => window.__gw.ui.closeAll());
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
        // Sporewood: nothing.
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
      check(r.sporewood === null, `Sporewood: ${key(r.sporewood)}`);
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
  // ---- the thief's tries, refusals and losses (mossmere-hunt-2.md section 2, B3) -------------------------

  {
    name: "her tries: three a night, counted only on a rig that could bring her; her time then closes for the night",
    fixture: "legend-sold",
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
        d.findHerWater(l, null, { x: -4, z: -14 });
        const shelvedFirst = loop();
        shelvedFirst.arrivals.shelved.push("turnback_hook");
        d.findHerWater(shelvedFirst, null, { x: -4, z: -14 });
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
            const beat = g.mossmereTallyBeat(loop, { zone: "mossmere", evening }, undefined, { journal: {} });
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
          sporewood: g.mossmereTallyBeat(
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
          roll = (id, area, phase) => share(() => g.catchMarkRoll(id, area, phase, rng));
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
      await session.eval(() => (window.__gw.data.LOOP.hunt.marks.ring.oftenChance = 1));
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
    name: "rig picture: Sporewood's tackle screen still works, with no Depth, Leader or Hook",
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
