#!/usr/bin/env node
// A timed play-through of the whole Mossmere hunt, by script: New Game (fresh profile, Wick "Tallow"), then
// evening after evening until the thief is landed and the ending tally is done, or the evening limit passes.
// It changes nothing in the game. It prints one line per evening and a summary, and writes both as JSON.
//
// How it plays (the shortcuts are listed in the summary too):
// - Screens are worked as a player works them: the driver's sail, the tally's Sold button, Murk's and Hob's
//   speech boxes, the notepad's close button, the catch card's Keep, Let go and Into the tin.
// - Fish are landed with the debug hook instantCatch, at an ordinary size (z 0; in Sporewood at the game's own size
//   roll), and only kinds the game's own
//   bite roll (fishPoolRoll) gives for the place, light, bait and depth fitted. Each evening keeps fish up to an
//   earnings budget (decisions.md: a keen player earns about 45 clams an evening, about 80 once on Braided Gut).
// - The raft is moved by teleport (to Hob's rock, to Hob's part, to a boil, to the marked spot).
// - The wait to midnight is skipped with the debug clock (the night phase and its clock), as the scenarios do.
// - Her answer to each cast in her time is the game's own (fishHerCast) with a random roll; a take is hooked with
//   fishHook and fought to its end with the game's own landing roll.
// - Shelf buys use the shelf's own call (loop.buy) and fitting uses the tackle screen's calls (fitDepth, fit).
//
// Usage: node tools/playthrough.mjs [--out run.json] [--evenings 40] [--page Gloomwater-Mossmere.html]
//   [--lake sporewood --from save.txt]
//
// With --lake sporewood it plays Sporewood's hunt (sporewood-plan.md) from a save whose barge is in Sporewood (by
// default tools/fixtures/sporewood-crossed.json made into a first arrival: no Sporewood evening played yet), evening
// after evening until the wandering island is landed and her ending tally is done. Its player: fishes by day in
// the Lullaby (Sporewood's free place, where the earnings study's starter kit fished) to an earnings budget, landing
// fish at the game's own size roll, fits Murk's Drift Float, sails to Burr's lamp at dusk until his almanac
// is drawn, gathers three Capseeds in the seedfall (the raft put on floating pods), waits where the drift ends in
// her time and follows the moss rafts in, casts there in her time (two ordinary casts, which may bring up a
// cracked pod, then her own answer, fishHerCast, on Spore Cake until the refusal is drawn, then on a Capseed
// under the Drift Float), and buys the Burl Hook, the Brass Trace, the Rootthread and the Mothsilk as the hunt
// shows them. Its evenings in the summary are Sporewood's own.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PAGE, GameSession, MURK_BOX_BUTTON, launchBrowser } from "./game-driver.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const OUT = option("--out", null);
const MAX_EVENINGS = Number(option("--evenings", 40)) || 40;
const PAGE = option("--page", DEFAULT_PAGE);
const SAVES = option("--saves", null); // a folder: the save string after each evening, as e<N>.save
const FROM = option("--from", null); // a save file to start from instead of New Game (for testing the tool)
const LAKE = option("--lake", "mossmere");

const LEGEND = "belled_matriarch";
const MIDNIGHT_AT = 60;
const HER_CENTRE = { x: -4, z: -14 };
const HOB_ROCK = { x: -30, z: 4 };
// Inside Hob's shaded part, about 11 m from her centre: where a player told "be in Hob's part" would wait.
const HOBS_PART = { x: -14, z: -18 };
const BUDGET = { plain: 45, braided: 80 }; // clams an evening, a keen player (decisions.md, 22 November 2026)
const MAX_LANDED = 12; // fish landed in one evening at most, kept or let go
const MIDNIGHT_LINE = "Far off, the old bell on the toll-tower strikes midnight.";

const t0 = Date.now();
const clock = () => `${((Date.now() - t0) / 60000).toFixed(1)}m`;
const say = (...a) => console.log(clock(), ...a);
const short = (text, n = 8) =>
  String(text || "")
    .split(/\s+/)
    .slice(0, n)
    .join(" ");

// ---- small steps on the page --------------------------------------------------------------------------------

const loopState = (s) =>
  s.eval(() => {
    const g = window.__gw,
      st = g.progression.loop.state();
    return JSON.parse(
      JSON.stringify({
        clams: st.clams,
        evenings: st.evenings,
        tackle: st.tackle,
        parts: st.parts,
        fitted: st.fitted,
        shelved: st.arrivals?.shelved ?? [],
        hunt: st.hunt?.mossmere ?? null,
        orders: st.orders ?? [],
        home: st.home,
        relics: st.relics ?? [],
        bait: st.bait?.mossmere ?? {},
        holdSlots: st.holdSlots,
        next: g.progression.loop.notepad?.()?.next ?? null,
      }),
    );
  });

const shelfNow = (s) =>
  s.eval(() =>
    window.__gw.progression.loop
      .shelf()
      .tabs.flatMap((t) =>
        t.items.map((i) => ({ tab: t.id, id: i.id, name: i.name, price: i.price, bought: !!i.bought })),
      ),
  );

// Records toasts, boils, escapes and landings on the page from now on.
const listen = (s) =>
  s.eval(() => {
    const g = window.__gw;
    // The bus can be a new one on each trip, so the listeners go on each bus once.
    if (g.bus.__ptListening) return;
    g.bus.__ptListening = true;
    window.__pt ||= { toasts: [], boils: [], escaped: [], landed: [], scene: [] };
    g.bus.on("toast", (e) => window.__pt.toasts.push(String(e?.text ?? "")));
    g.bus.on("hunt:boil", (b) => window.__pt.boils.push(JSON.parse(JSON.stringify(b))));
    g.bus.on("fish:escaped", (e) => window.__pt.escaped.push(JSON.parse(JSON.stringify(e))));
    g.bus.on("fish:landed", (e) => window.__pt.landed.push(e?.species?.id ?? null));
    g.bus.on("hunt:birdScene", (e) => window.__pt.scene.push(e.phase));
  });
const takeToasts = (s) =>
  s.eval(() => {
    const t = window.__pt.toasts.slice();
    window.__pt.toasts.length = 0;
    return t;
  });

const teleport = (s, at) => s.eval((a) => window.__gw.player.teleport(a, 0), at);

// The night clock put at t seconds after dark (the scenarios' atNight), with two frames run.
const atNight = (s, t) =>
  s.eval(async (t) => {
    const g = window.__gw,
      run = g.state.run;
    const was = `${run.phase}@${Number(run.phaseTime).toFixed(1)}`;
    if (run.phase !== "gloomtide") g.debug.setPhase("gloomtide");
    run.phaseTime = t;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    (window.__ptTrace ||= []).push(
      `${was}>${t}>${run.phase}@${Number(run.phaseTime).toFixed(1)}:${run.midnight?.struck}`,
    );
    return run.midnight ? JSON.parse(JSON.stringify(run.midnight)) : null;
  }, t);

// One cast's fish, drawn from the game's own bite roll for this place, light, bait and depth.
const rollFish = (s, bait) =>
  s.eval((bait) => {
    const r = window.__gw.debug.fishPoolRoll(300, { bait });
    const entries = Object.entries(r?.counts || {}).filter(
      ([id]) => id !== "none" && id !== "belled_matriarch",
    );
    const total = entries.reduce((n, [, c]) => n + c, 0);
    if (!total) return null;
    let u = Math.random() * total;
    for (const [id, c] of entries) if ((u -= c) <= 0) return id;
    return entries.at(-1)[0];
  }, bait);

// Presses the visible card button matching re; returns its text or null.
const press = (s, re) => s.clickButton(re);

// Hob's boxes: reads each and presses its button until he is done.
async function hearHob(s, waitMs = 15000) {
  const lines = [];
  for (const end = Date.now() + waitMs; Date.now() < end; ) {
    const said = await s.eval(
      () => document.querySelector('.gw-modal[data-modal="hob"].gw-in .gw-hob-text')?.textContent ?? null,
    );
    if (said) {
      lines.push(said);
      await s.eval(() => document.querySelector('.gw-modal[data-modal="hob"].gw-in .gw-hob-ok')?.click());
      await s.pause(600);
    } else if (lines.length) break;
    else await s.pause(500);
  }
  return lines;
}

// Lands a fish with instantCatch and works its catch card: Into the tin when wanted and offered, else Keep while
// the hold has room, else Let go. Returns what was done.
async function landFish(s, id, { tin = false, rolled = false } = {}) {
  // An ordinary size (z 0), or with `rolled` the game's own size roll for the cast.
  const ok = await s.eval(
    ([id, rolled]) => window.__gw.debug.instantCatch(id, rolled ? undefined : { z: 0 }),
    [id, rolled],
  );
  if (!ok) return { id, did: "refused" };
  for (const end = Date.now() + 30000; Date.now() < end; ) {
    await s.pause(400);
    const card = await s.eval(() => {
      const vis = (el) => el && el.getBoundingClientRect().width > 0;
      const keep = document.querySelector(".gw-cc-keep");
      if (!vis(keep)) return null;
      const tinB = document.querySelector(".gw-cc-tin");
      return {
        tin: vis(tinB) && !tinB.disabled,
        full: window.__gw.progression.loop.holdFull?.() === true,
        mark: document.querySelector(".gw-cc-markline")?.textContent ?? null,
      };
    });
    if (!card) {
      await press(s, /^Got it$/);
      continue;
    }
    let did;
    if (tin && card.tin) {
      await s.eval(() => document.querySelector(".gw-cc-tin").click());
      did = "tin";
      await s.pause(500);
      // The card stays up after the tin button on some builds: let it go if so.
      if (await s.eval(() => document.querySelector(".gw-cc-keep")?.getBoundingClientRect().width > 0))
        await press(s, /^\d?Let go\b/);
    } else if (!card.full) {
      await press(s, /^\d?Keep\b/);
      did = "keep";
    } else {
      await press(s, /^\d?Let go\b/);
      did = "let go";
    }
    await s.pause(500);
    await s.closeGuides(3000);
    return { id, did, mark: card.mark };
  }
  return { id, did: "no card" };
}

// Hooks a fish (fishHook) with the game's own landing roll and plays the fight to its end, as the scenarios'
// hookOnce does. Returns { p, escape } or { p, landed } or { find: true }.
async function hookAndPlay(s, id) {
  const hooked = await s.eval((id) => {
    const g = window.__gw;
    g.debug.fishOutcome(null);
    const ok = g.debug.fishHook(id);
    return {
      ok,
      state: g.fishing.state,
      p: g.debug.fishChance(),
      loss: g.debug.fishPlay()?.loss ?? null,
      escaped: window.__pt.escaped.length,
      landed: window.__pt.landed.length,
      bob: g.debug.fishing()?.bob ?? null,
      raft: { x: g.player.position.x, z: g.player.position.z },
    };
  }, id);
  if (!hooked.ok || hooked.state !== "reeling") return { failed: true, hooked };
  await s.eval(() => window.__gw.debug.fishPlayTo(0.995));
  for (const end = Date.now() + 150000; Date.now() < end; ) {
    const now = await s.eval(() => ({
      escaped: window.__pt.escaped.length,
      last: window.__pt.escaped.at(-1) ?? null,
      landed: window.__pt.landed.length,
      lastLanded: window.__pt.landed.at(-1) ?? null,
      card: [...document.querySelectorAll("button")].some(
        (b) => /Keep|Let go/.test(b.textContent) && b.getBoundingClientRect().width > 0,
      ),
      line: [...document.querySelectorAll(".gw-strike-gear")].map((e) => e.textContent.trim()).join(" "),
    }));
    if (now.escaped > hooked.escaped) {
      await s.pause(1200);
      const line = await s.eval(() =>
        [...document.querySelectorAll(".gw-strike-gear")].map((e) => e.textContent.trim()).join(" "),
      );
      return { p: hooked.p, loss: hooked.loss, escape: now.last, line, bob: hooked.bob, raft: hooked.raft };
    }
    if (hooked.p === 1 && now.card) return { find: true };
    if (now.landed > hooked.landed && now.card) return { p: hooked.p, landed: now.lastLanded };
    await press(s, /^Got it$/);
    await s.pause(400);
  }
  return { stuck: true };
}

// Waits for the fishing line to be idle and nothing to hold the screen, letting go of any card.
async function settle(s) {
  for (const end = Date.now() + 90000; Date.now() < end; ) {
    if (await press(s, /^\d?Let go\b/)) await s.pause(800);
    const idle = await s.eval(() => window.__gw.fishing.state === "idle" && !window.__gw.ui.isBlocking?.());
    if (idle) return;
    // The bird at midnight is skipped with one press, as a player would.
    if (await s.eval(() => !!window.__gw.game.birdScene?.())) await s.page.keyboard.press("Enter");
    await s.closeGuides(1000);
    await s.pause(500);
  }
}

// Goes home and works the tally: Sold, Murk's box page by page, Sold again, then the notepad and any guide or
// Murk box at the jetty. Returns what was said and shown.
async function tally(s) {
  for (const homeBy = Date.now() + 90000; !(await s.eval(() => window.__gw.game.goHome())); ) {
    if (Date.now() > homeBy) throw new Error(`the game will not go home; ${JSON.stringify(await s.state())}`);
    if (await s.eval(() => !!window.__gw.game.birdScene?.())) await s.page.keyboard.press("Enter");
    await s.closeGuides(3000);
    await s.pause(1000);
  }
  const soldVisible = () =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.trim() === "Sold" && b.getBoundingClientRect().width > 0,
    );
  await s.waitFor("Murk's tally", 120000, soldVisible);
  const out = { murk: [], hob: [], hunt: "", gift: "", rows: [], pad: null, guides: 0 };
  await press(s, /^Sold$/);
  await s.pause(2500);
  const card = await s.eval(() => {
    const text = (sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() ?? "";
    return {
      hunt: text(".gw-tally-hunt"),
      gift: text(".gw-tally-gift"),
      rows: [...document.querySelectorAll(".gw-trow")].map((r) => r.textContent.replace(/\s+/g, " ").trim()),
    };
  });
  Object.assign(out, card);
  // Murk's box, then Sold, then whatever opens at the jetty, until the barge is free.
  let calm = 0;
  for (const end = Date.now() + 120000; Date.now() < end && calm < 6; ) {
    const step = await s.eval((murkSel) => {
      const vis = (el) => el && el.getBoundingClientRect().width > 0;
      const murk = document.querySelector(murkSel);
      if (murk) {
        const text =
          document.querySelector('.gw-modal.gw-in[data-modal="murktalk"] .gw-murk-text')?.textContent ?? "";
        murk.click();
        return { murk: text };
      }
      const pad = document.querySelector('.gw-modal[data-modal="notepad"].gw-in .gw-pad');
      if (pad) {
        const view = {
          page: pad.querySelector(".gw-pad-page.gw-on")?.dataset.page ?? null,
          drawn: [...pad.querySelectorAll(".gw-pad-fig[data-drawn]")].map((f) => f.dataset.sketch),
          next: pad.querySelector(".gw-pad-next em")?.textContent ?? null,
          words: [...pad.querySelectorAll(".gw-pad-cap")].map((c) => c.textContent),
        };
        document.querySelector(".gw-pad-close")?.click();
        return { pad: view };
      }
      const sold = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "Sold" && vis(b),
      );
      if (sold) return sold.click(), { sold: true };
      const guide = [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim() === "Got it" && vis(b),
      );
      if (guide) return guide.click(), { guide: true };
      return { idle: window.__gw.flow === "home" && !window.__gw.ui.isBlocking?.() };
    }, MURK_BOX_BUTTON);
    if (step.murk != null) out.murk.push(step.murk);
    if (step.pad) out.pad = step.pad;
    if (step.guide) out.guides++;
    calm = step.idle ? calm + 1 : 0;
    await s.pause(700);
  }
  const trip = await s.eval(() => {
    const t = window.__gw.progression.loop.lastTrip?.();
    return t ? JSON.parse(JSON.stringify({ total: t.total, bounty: t.bounty, gift: t.gift })) : null;
  });
  out.trip = trip;
  return out;
}

// ---- the player's choices ----------------------------------------------------------------------------------

// What the hunt asks for next, cheapest first, as a player who reads Murk's lines and the notepad would buy it.
function wantList(st, shelf) {
  const want = [];
  const has = (id) => st.parts.includes(id);
  const onShelf = (id) => shelf.find((i) => i.id === id && !i.bought);
  if (onShelf("part:turnback_hook") && !has("turnback_hook")) want.push("part:turnback_hook");
  if (onShelf("part:chafe_gut") && !has("chafe_gut")) want.push("part:chafe_gut");
  // The line: Braided Gut first (Murk shelves the Silk only after it), then the Waxed Silk.
  if (st.tackle.line < 1 && onShelf("line:1")) want.push("line:1");
  if (st.tackle.line >= 1 && st.tackle.line < 2 && onShelf("line:2")) want.push("line:2");
  return want;
}

// ---- one evening ------------------------------------------------------------------------------------------

async function playEvening(s, n, ctx) {
  const rec = {
    evening: n,
    notes: [],
    landed: [],
    murk: [],
    hob: [],
    toasts: [],
    bought: [],
    wanted: [],
    gifts: [],
    debugClock: false,
    her: [],
  };
  const before = await loopState(s);
  rec.clamsAtStart = before.clams;
  const sailed = await s.sail({ wick: "Tallow", timeoutMs: 300000 });
  rec.sail = sailed;
  await listen(s);
  await s.eval(() => {
    for (const k of ["toasts", "boils", "escaped", "landed", "scene"]) window.__pt[k].length = 0;
  });
  let st = await loopState(s);
  const h = () => st.hunt || {};
  const lampLit = await s.eval(() => window.__gw.progression.loop.hobLampLit?.() === true);

  // 1. Hob: a player told his lamp is lit sails close to it (until his map is drawn; after that once a night,
  // to hear his new line).
  if (lampLit && (!h().sketches?.map || ctx.visitHob)) {
    await teleport(s, HOB_ROCK);
    const lines = await hearHob(s, h().sketches?.map ? 8000 : 20000);
    rec.hob.push(...lines);
    await teleport(s, { x: 0, z: 30 });
    await s.pause(800);
    st = await loopState(s);
  }

  // 2. Live bait: once her water is found and the tin is owned, fill the tin from Dusk Minnows first.
  const huntingHer = h().found && st.parts.includes("minnow_tin");
  // 3. Earnings fishing at the start spot (or in Hob's part when the evening needs it).
  const budget = st.tackle.line >= 1 ? BUDGET.braided : BUDGET.plain;
  rec.budget = budget;
  const keepN = Math.max(1, Math.min(st.holdSlots || 3, Math.round(budget / Math.max(5, ctx.avgFish))));
  let kept = 0,
    casts = 0,
    tin = 0;
  const bait = st.fitted.bait || "mireworm";
  // Minnows feed high: while the tin needs filling, the player fishes worms under the float, and puts the lead
  // back on for her at midnight.
  if (huntingHer) await s.eval(() => window.__gw.progression.loop.fitDepth("float"));
  while (casts < MAX_LANDED && (kept < keepN || (huntingHer && tin < 3))) {
    casts++;
    const id = await rollFish(s, bait);
    if (!id) {
      rec.notes.push(`no bite roll for ${bait}`);
      break;
    }
    const wantTin = huntingHer && tin < 3 && id === "dusk_minnow";
    if (!wantTin && kept >= keepN) continue; // a cast whose fish the player would not keep: not landed
    const got = await landFish(s, id, { tin: wantTin });
    rec.landed.push(`${id}:${got.did}${got.mark ? "*" : ""}`);
    if (got.did === "keep") kept++;
    if (got.did === "tin") tin++;
  }
  rec.tin = tin;
  if (huntingHer && ctx.leadFitted) await s.eval(() => window.__gw.progression.loop.fitDepth("lead"));

  // 4. Midnight, when the hunt needs it: from Hob's map on.
  st = await loopState(s);
  const evNo = await s.eval(() => window.__gw.state.run.evening ?? null);
  if (h().sketches?.map && !h().landed && evNo >= 2) {
    rec.debugClock = true;
    await s.closeGuides(3000);
    rec.beforeMidnight = await s.state();
    rec.paused = await s.eval(() => ({
      blocking: window.__gw.ui.isBlocking?.() === true,
      fishing: window.__gw.fishing.state,
      phase: window.__gw.state.run.phase,
      t: window.__gw.state.run.phaseTime,
      modals: [...document.querySelectorAll(".gw-modal.gw-in")].map((m) => m.dataset.modal),
    }));
    const spot = h().found ? h().foundAt || HER_CENTRE : HOBS_PART;
    await teleport(s, spot);
    await s.pause(1200);
    // Dark falls (the debug clock): a guide card that comes with the night is closed before the clock runs on,
    // since the game's clock stands still while a card is up.
    await atNight(s, MIDNIGHT_AT - 10);
    await s.pause(1500);
    await s.closeGuides(4000);
    rec.nightCards = await s.eval(() => window.__gw.ui.isBlocking?.() === true);
    await atNight(s, MIDNIGHT_AT - 1);
    await s.closeGuides(2000);
    await atNight(s, MIDNIGHT_AT + 0.05);
    await atNight(s, MIDNIGHT_AT + 3);
    await s.pause(2000);
    rec.diag = await s.eval(() => {
      const r = window.__gw.state.run;
      return { ev: r.evening, phase: r.phase, t: r.phaseTime, m: r.midnight, trace: window.__ptTrace };
    });
    await settle(s);
    if (!h().found) await findHerWater(s, rec);
    else await fishHer(s, rec, ctx);
    // Her time ends.
    rec.midnight = await atNight(s, MIDNIGHT_AT + 181);
    rec.raftAt = await s.eval(() => ({ x: window.__gw.player.position.x, z: window.__gw.player.position.z }));
    rec.partAt = (await loopState(s)).hunt?.partAt ?? null;
    await s.pause(1500);
    await settle(s);
  }
  rec.toasts.push(...(await takeToasts(s)));
  rec.bellHeard = rec.toasts.includes(MIDNIGHT_LINE);

  // 5. Home, and the tally.
  const clamsBeforeTally = (await loopState(s)).clams;
  const t = await tally(s);
  rec.clamsBeforeTally = clamsBeforeTally;
  rec.murk.push(...t.murk);
  rec.tallyHunt = t.hunt;
  rec.tallyGift = t.gift;
  rec.trip = t.trip;
  rec.pad = t.pad;
  st = await loopState(s);
  rec.clamsAfterTally = st.clams;
  if (t.trip?.gift) rec.gifts.push(t.trip.gift);
  if (t.trip?.total && rec.landed.some((l) => l.endsWith(":keep"))) {
    const keptN = rec.landed.filter((l) => /:keep\*?$/.test(l)).length;
    const sale = t.trip.total - (t.trip.bounty || 0);
    if (keptN) ctx.avgFish = 0.5 * ctx.avgFish + 0.5 * (sale / keptN);
  }

  // 6. At home: fit what Murk's lines say to fit, and buy what the hunt needs next.
  await shop(s, rec, ctx);
  st = await loopState(s);
  rec.after = st;
  rec.notepad = await s.eval(() => {
    const v = window.__gw.progression.loop.notepad?.();
    return v ? JSON.parse(JSON.stringify(v)) : null;
  });
  await s.collectGameErrors();
  rec.errors = s.errors.splice(0);
  return rec;
}

// Her water, before it is found: wait in Hob's part after the bell, sail to the boils, and fish under them.
async function findHerWater(s, rec) {
  for (let i = 0; i < 6; i++) {
    const due = await s.eval(() => window.__gw.state.run.midnight?.boilAt ?? null);
    if (due == null || due > MIDNIGHT_AT + 178) break;
    const seen = await s.eval(() => window.__pt.boils.length);
    await atNight(s, due + 0.05);
    await s.pause(600);
    const boil = await s.eval((k) => window.__pt.boils[k] ?? null, seen);
    if (!boil) continue;
    rec.notes.push(`boil ${boil.word ?? "unseen"}`);
    if (!boil.word) continue; // too far to be seen: wait for the next
    // Sail to it and cast under it: one calibration of where the float lands from the raft, then the cast.
    await teleport(s, { x: boil.x, z: boil.z });
    await s.pause(1000);
    const id = (await rollFish(s, (await loopState(s)).fitted.bait || "mireworm")) || "mossback_perch";
    const off = await s.eval(() => {
      const f = window.__gw.debug.fishing?.();
      return f?.aim ?? null;
    });
    void off;
    const r = await hookAndPlay(s, id);
    await settle(s);
    if (r.escape?.reason === "thief") {
      rec.notes.push(`theft of a ${id}`);
      rec.theft = true;
      return;
    }
    rec.notes.push(
      `${id} under the boil: ${r.landed ? "landed" : r.escape ? `lost (${r.escape.reason})` : "?"}`,
    );
    if (r.bob && r.raft) {
      // Next time, stand off so the float lands on the boil.
      const dx = r.bob.x - r.raft.x,
        dz = r.bob.z - r.raft.z;
      await teleport(s, { x: boil.x - dx, z: boil.z - dz });
    }
    const found = await s.eval(() => window.__gw.progression.loop.state().hunt.mossmere.found === true);
    if (found) return;
  }
}

// Her water found: cast at the marked spot in her time, up to three tries, as the rig the player has worked out.
async function fishHer(s, rec, ctx) {
  const st = await loopState(s);
  const h = st.hunt;
  // What the player puts on: after the swirl (sketch 4) a live minnow on the lead, if the tin has one; before it,
  // the rig as it is (worms on whatever depth is fitted).
  const live = await s.eval(() => window.__gw.state.run?.bait?.live_minnow ?? 0);
  let bait = st.fitted.bait || "mireworm";
  if (h.sketches?.swirl && live > 0) {
    await s.eval(() => {
      const loop = window.__gw.progression.loop;
      loop.fitDepth("lead");
      loop.fit("bait", "live_minnow");
    });
    bait = "live_minnow";
  } else if (h.sketches?.swirl && !live) rec.notes.push("no live minnow in the tin at midnight");
  for (let k = 0; k < 6; k++) {
    const a = await s.eval((b) => window.__gw.debug.fishHerCast({ bait: b, u: Math.random() }), bait);
    if (!a) {
      rec.her.push("closed");
      break;
    }
    rec.her.push(`${a.part || (a.take ? "take" : "none")}${a.said ? `: ${short(a.said, 7)}` : ""}`);
    await settle(s);
    if (a.take) {
      const r = await hookAndPlay(s, LEGEND);
      rec.hook = {
        p: r.p,
        reason: r.escape?.legendLossReason ?? null,
        line: r.line ?? null,
        landed: r.landed === LEGEND,
      };
      ctx.hookups++;
      if (r.landed === LEGEND) {
        await press(s, /^\d?Let go\b/);
        await s.pause(1500);
      }
      await settle(s);
      break;
    }
    if (!a.open) break;
    if (!a.tried && a.part) {
      // A refusal uses no try; the player changes nothing on the water (they learn at the notepad), so stop.
      if (k >= 2) break;
    }
  }
  await s.eval(() => window.__gw.progression.loop.fit("bait", "mireworm"));
}

async function shop(s, rec, ctx) {
  let st = await loopState(s);
  // Murk's lead gift: the tally says how to fit it, so the player fits it.
  if (st.parts.includes("sounding_lead") && !ctx.leadFitted) {
    await s.eval(() => window.__gw.progression.loop.fitDepth("lead"));
    ctx.leadFitted = true;
    rec.notes.push("fitted the Sounding Lead");
  }
  // Worms: a tin when fewer than five are left.
  const worms = st.bait?.mireworm ?? 0;
  if (worms < 5 && st.clams >= 20) {
    const r = await s.eval(() => window.__gw.progression.loop.buy("tin:mireworm"));
    if (r?.ok) rec.bought.push("Mire Worms (20)");
  }
  const shelf = await shelfNow(s);
  st = await loopState(s);
  for (const id of wantList(st, shelf)) {
    const item = shelf.find((i) => i.id === id);
    st = await loopState(s);
    if (st.clams >= item.price) {
      const r = await s.eval((id) => window.__gw.progression.loop.buy(id), id);
      if (r?.ok) rec.bought.push(`${item.name} (${item.price})`);
      else rec.notes.push(`buy ${id} refused: ${r?.msg ?? ""}`);
    } else {
      rec.wanted.push(`${item.name} (${item.price}, had ${st.clams})`);
      break; // saving for this one
    }
  }
  // A bought hook or leader goes on the rig in use; make sure the best owned parts are on.
  await s.eval(() => {
    const loop = window.__gw.progression.loop,
      p = loop.state().parts;
    p.includes("turnback_hook") && loop.fitPart("hook", "turnback_hook");
    p.includes("chafe_gut") && loop.fitPart("leader", "chafe_gut");
  });
  await s.closeGuides(3000);
}

// ---- milestones -------------------------------------------------------------------------------------------

const MILESTONES = [
  ["Sounding Lead given", (r) => r.after.parts.includes("sounding_lead")],
  ["tale told, notepad opens", (r) => r.after.hunt?.taleAt > 0],
  ["minnow tin given", (r) => r.after.parts.includes("minnow_tin")],
  ["Hob's first talk and map (sketch 1)", (r) => r.after.hunt?.sketches?.map > 0],
  ["Turnback Hook on the shelf", (r) => r.after.shelved.includes("turnback_hook")],
  ["leaders on the shelf", (r) => r.after.shelved.includes("chafe_gut")],
  ["line-up (sketch 3)", (r) => r.after.hunt?.sketches?.lineup > 0],
  ["midnight bell heard", (r) => r.bellHeard],
  ["theft seen, her water found (sketch 2)", (r) => r.after.hunt?.found === true],
  ["swirl (sketch 4)", (r) => r.after.hunt?.sketches?.swirl > 0],
  ["Turnback Hook bought", (r) => r.after.parts.includes("turnback_hook")],
  ["Chafe Gut bought", (r) => r.after.parts.includes("chafe_gut")],
  ["Braided Gut bought", (r) => r.after.tackle.line >= 1],
  ["Waxed Silk on the shelf", (r) => r.shelfSilk],
  ["Waxed Silk bought", (r) => r.after.tackle.line >= 2],
  [
    "live minnow ready at midnight",
    (r) => r.her.some((x) => !/^gate|^bait|^depth|^closed/.test(x)) && r.tin > 0,
  ],
  ["first hook-up", (r) => !!r.hook],
  ["what came back (sketch 5)", (r) => r.after.hunt?.sketches?.back > 0],
  ["landed", (r) => r.hook?.landed === true || r.after.hunt?.landed > 0],
  ["ending tally (bounty, Hob's Lamp)", (r) => r.after.relics.includes("hobs_lamp")],
];

// ---- main ---------------------------------------------------------------------------------------------------

async function main() {
  if (LAKE === "sporewood") return mainSporewood();
  const browser = await launchBrowser();
  const save = FROM ? readFileSync(FROM, "utf8") : null;
  const s = await GameSession.open(browser, {
    page: PAGE,
    save,
    debug: true,
    viewport: { width: 480, height: 270 },
  });
  const first = FROM ? (JSON.parse(save).meta?.loop?.evenings | 0) + 1 : 1;
  const evenings = [];
  const ctx = { avgFish: 15, hookups: 0, leadFitted: !!FROM, visitHob: true };
  const milestones = {};
  const quiet = [];
  let lastPointer = 0;
  let stopped = null;
  try {
    await s.boot();
    say("booted");
    for (let n = first; n <= MAX_EVENINGS; n++) {
      let rec;
      try {
        rec = await playEvening(s, n, ctx);
      } catch (err) {
        stopped = `evening ${n}: ${err.message}`;
        say("STOPPED", stopped);
        await s.collectGameErrors();
        evenings.push({ evening: n, crashed: err.message, errors: s.errors.splice(0) });
        break;
      }
      const shelf = await shelfNow(s);
      rec.shelfSilk = shelf.some((i) => i.id === "line:2");
      for (const [name, test] of MILESTONES) if (!(name in milestones) && test(rec)) milestones[name] = n;
      if (rec.hook) {
        rec.loss = rec.hook.landed ? null : rec.hook.reason;
      }
      // Something pointing forward: a new line from Murk or Hob, a new sketch, a new notepad foot, a shelf item.
      const pointer =
        rec.murk.length ||
        rec.hob.length ||
        rec.pad ||
        rec.tallyHunt ||
        rec.tallyGift ||
        (evenings.length && rec.notepad?.next !== evenings.at(-1).notepad?.next);
      if (pointer) lastPointer = n;
      else if (n - lastPointer >= 2) quiet.push(n);
      evenings.push(rec);
      const sk = rec.after.hunt?.sketches || {};
      const pad = Object.entries(sk)
        .filter(([, v]) => v > 0)
        .map(([k]) => k)
        .join(",");
      say(
        `E${n}`,
        `clams ${rec.clamsBeforeTally}->${rec.clamsAfterTally}`,
        `fish ${rec.landed.join(" ")}`,
        rec.murk.length ? `Murk: ${rec.murk.map((m) => `"${short(m, 6)}"`).join(" ")}` : "",
        rec.hob.length ? `Hob: ${rec.hob.map((m) => `"${short(m, 6)}"`).join(" ")}` : "",
        rec.gifts.length ? `gift ${rec.gifts}` : "",
        rec.bought.length ? `bought ${rec.bought.join(", ")}` : "",
        rec.wanted.length ? `wanted ${rec.wanted.join(", ")}` : "",
        `pad [${pad}]`,
        rec.her.length ? `her: ${rec.her.join(" / ")}` : "",
        rec.hook ? `HOOK p=${rec.hook.p} ${rec.hook.landed ? "LANDED" : `lost: ${rec.hook.reason}`}` : "",
        rec.notes.length ? `(${rec.notes.join("; ")})` : "",
        rec.debugClock ? "[debug clock to midnight]" : "",
        rec.errors.length ? `ERRORS ${rec.errors.length}` : "",
      );
      if (OUT) writeFileSync(OUT, JSON.stringify({ evenings, milestones, quiet, stopped }, null, 1));
      if (SAVES) writeFileSync(join(SAVES, `e${n}.save`), await s.saved());
      if (rec.after.relics.includes("hobs_lamp")) break;
    }
  } finally {
    await browser.close();
  }
  const summary = {
    evenings: evenings.length,
    landedOn: milestones.landed ?? null,
    milestones,
    quietEvenings: quiet,
    stopped,
    minutes: (Date.now() - t0) / 60000,
    errors: evenings.flatMap((e) => (e.errors || []).map((x) => `E${e.evening}: ${x}`)),
  };
  say("SUMMARY", JSON.stringify(summary, null, 1));
  if (OUT) writeFileSync(OUT, JSON.stringify({ summary, evenings }, null, 1));
}

// ---- Sporewood's hunt (--lake sporewood) --------------------------------------------------------------------

const SW_LEGEND = "drifting_grove";
const SW_BUDGET = { plain: 178, root: 260 }; // clams an evening: the starter kit's measured earnings, more on Rootthread
const BURR_NEAR = { x: 52, z: -25.5 };
const SW_START = { x: 40, z: 22 };
// Where the player fishes by day: the Lullaby, Sporewood's free place, as the earnings study's starter kit did.
const SW_FISHING = { x: -51.5, z: -29 };

const swState = (s) =>
  s.eval(() => {
    const g = window.__gw,
      st = g.progression.loop.state();
    return JSON.parse(
      JSON.stringify({
        clams: st.clams,
        evenings: st.evenings,
        lake: st.eveningsAt?.sporewood ?? 0,
        tackle: st.tackle,
        parts: st.parts,
        fitted: st.fitted,
        shelved: st.arrivals?.shelved ?? [],
        hunt: st.hunt?.sporewood ?? null,
        relics: st.relics ?? [],
        bait: st.bait?.sporewood ?? {},
        holdSlots: st.holdSlots,
        next: g.progression.loop.notepad?.("sporewood")?.next ?? null,
      }),
    );
  });

// Records the hunt's own events too: moss rafts (hunt:boil), the find, its scenes and cracked pods.
const listenSw = (s) =>
  s.eval(() => {
    const g = window.__gw;
    if (g.bus.__ptSwListening) return;
    g.bus.__ptSwListening = true;
    window.__ptSw ||= { found: [], scene: [], pods: [] };
    g.bus.on("hunt:found", (e) => window.__ptSw.found.push(JSON.parse(JSON.stringify(e))));
    g.bus.on("hunt:scene", (e) => window.__ptSw.scene.push(`${e.kind}:${e.phase}`));
    g.bus.on("hunt:pod", (e) => window.__ptSw.pods.push(JSON.parse(JSON.stringify(e))));
  });

// The clock put `tau` seconds after the seedfall's first sigh (1 s into dusk), with two frames run.
const atSeedfall = (s, tau) =>
  s.eval(async (tau) => {
    const g = window.__gw,
      run = g.state.run,
      t = 1 + tau,
      phase = t < 20 ? "dusk" : "gloomtide";
    run.phase !== phase && g.debug.setPhase(phase);
    run.phaseTime = t < 20 ? t : t - 20;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return run.midnight ? JSON.parse(JSON.stringify(run.midnight)) : null;
  }, tau);

const swEddy = (s) => s.eval(() => window.__gw.data.herWaterAt("sporewood", window.__gw.state.run.evening));

const rollSwFish = (s, bait) =>
  s.eval((bait) => {
    const r = window.__gw.debug.fishPoolRoll(300, { bait });
    const entries = Object.entries(r?.counts || {}).filter(
      ([id]) => id !== "none" && id !== "drifting_grove",
    );
    const total = entries.reduce((n, [, c]) => n + c, 0);
    if (!total) return null;
    let u = Math.random() * total;
    for (const [id, c] of entries) if ((u -= c) <= 0) return id;
    return entries.at(-1)[0];
  }, bait);

// Sails the raft through the seedfall's floating pods until the pouch holds three Capseeds (the raft gathers a pod
// within 3 m of it).
async function gatherCapseeds(s, rec) {
  for (let k = 0; k < 14; k++) {
    const got = await s.eval(async (k) => {
      const g = window.__gw,
        D = g.data,
        run = g.state.run,
        set = D.seedfallPods("sporewood", run.evening),
        tau = run.phase === "dusk" ? run.phaseTime - 1 : 19 + run.phaseTime,
        at = set ? D.seedfallPodAt(set, k, tau) : null;
      if (at && (at.state === "float" || at.state === "eddy")) g.player.teleport({ x: at.x, z: at.z }, 0);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return run.bait?.capseed ?? 0;
    }, k);
    await s.pause(250);
    if (got >= 3) break;
  }
  rec.capseeds = await s.eval(() => window.__gw.state.run.bait?.capseed ?? 0);
}

// Two ordinary casts by her eddy, which may bring up a cracked pod; the line is brought in after each.
async function castsByEddy(s, at, rec) {
  for (let k = 0; k < 2; k++) {
    const cast = await s.eval((a) => {
      const g = window.__gw;
      g.player.teleport({ x: a.x + 14, z: a.z + 1 }, Math.PI / 2);
      return g.debug.castAt(a.x + 8, a.z, 0.6);
    }, at);
    if (!cast) rec.notes.push("a cast by the eddy was refused");
    // A pod comes 1.2 s of the game's clock after the float lands (podDue): wait for it, or for none to be due.
    await s
      .waitFor(
        "the cast by the eddy",
        20000,
        (n) => {
          const f = window.__gw.debug.fishing();
          return (
            window.__ptSw.pods.length > n ||
            (f?.state === "waiting" && !f.podDue) ||
            (!!f && f.state !== "waiting" && f.state !== "casting")
          );
        },
        await s.eval(() => window.__ptSw.pods.length),
      )
      .catch(() => {});
    await s.eval(() => {
      const g = window.__gw;
      g.debug.fishPlayTo?.(0.995);
      g.fishing.reelInQuiet?.();
    });
    await settle(s);
  }
  rec.pods = await s.eval(() => window.__ptSw.pods.length);
}

// Her answer at her eddy in her time: Spore Cake on the Drift Float until the refusal is drawn, then a Capseed, up
// to three tries; a take is hooked and fought out.
async function fishSwHer(s, at, rec, ctx) {
  const st = await swState(s);
  for (let k = 0; k < 6; k++) {
    const capseeds = await s.eval(() => window.__gw.state.run.bait?.capseed ?? 0);
    const bait = st.hunt?.sketches?.swirl && capseeds > 0 ? "capseed" : "spore_cake";
    await s.eval((bait) => {
      const loop = window.__gw.progression.loop;
      loop.state().parts.includes("drift_float") && loop.fitDepth("drift");
    }, bait);
    const a = await s.eval(
      ([b, at]) => window.__gw.debug.fishHerCast({ bait: b, u: Math.random(), at: { x: at.x + 2, z: at.z } }),
      [bait, at],
    );
    if (!a) {
      rec.her.push("closed");
      break;
    }
    rec.her.push(`${bait}:${a.part || (a.take ? "take" : "none")}${a.said ? `: ${short(a.said, 7)}` : ""}`);
    await settle(s);
    if (a.take) {
      const r = await hookAndPlay(s, SW_LEGEND);
      rec.hook = {
        p: r.p,
        reason: r.escape?.legendLossReason ?? null,
        line: r.line ?? null,
        landed: r.landed === SW_LEGEND,
      };
      ctx.hookups++;
      if (r.landed === SW_LEGEND) {
        await press(s, /^\d?Let go\b/);
        await s.pause(1500);
      }
      await settle(s);
      break;
    }
    if (!a.open) break;
    if (!a.tried && a.part && k >= 2) break;
  }
}

async function playSporeEvening(s, n, ctx) {
  const rec = {
    evening: n,
    notes: [],
    landed: [],
    murk: [],
    hob: [],
    toasts: [],
    bought: [],
    wanted: [],
    gifts: [],
    her: [],
  };
  const before = await swState(s);
  rec.clamsAtStart = before.clams;
  rec.sail = await s.sail({ wick: "Tallow", water: "sporewood", timeoutMs: 300000 });
  await listen(s);
  await listenSw(s);
  await s.eval(() => {
    for (const k of ["toasts", "boils", "escaped", "landed", "scene"]) window.__pt[k].length = 0;
    for (const k of ["found", "scene", "pods"]) window.__ptSw[k].length = 0;
  });
  let st = await swState(s);
  const h = () => st.hunt || {};
  const lake = await s.eval(() => window.__gw.state.run.lakeEvening ?? null);
  rec.lake = lake;
  // 1. By day: fish the Lullaby to the budget, on Spore Cake (the Drift Float is a plain float there).
  await teleport(s, SW_FISHING);
  await s.pause(1500);
  await s.closeGuides(3000);
  const budget = st.tackle.line >= 1 ? SW_BUDGET.root : SW_BUDGET.plain;
  rec.budget = budget;
  const keepN = Math.max(1, Math.min(st.holdSlots || 3, Math.round(budget / Math.max(10, ctx.avgFish))));
  await s.eval(() => window.__gw.progression.loop.fit?.("bait", "spore_cake"));
  let kept = 0;
  for (let casts = 0; casts < MAX_LANDED && kept < keepN; casts++) {
    const id = await rollSwFish(s, "spore_cake");
    if (!id) {
      rec.notes.push("no bite roll for spore_cake");
      break;
    }
    const got = await landFish(s, id, { rolled: true });
    rec.landed.push(`${id}:${got.did}${got.mark ? "*" : ""}`);
    if (got.did === "keep") kept++;
  }
  // 2. Dusk, from Sporewood's evening 2: Burr's lamp is lit; sail to him until his almanac is drawn.
  if (lake >= 2 && !h().landed) {
    await atSeedfall(s, -0.6);
    await s.closeGuides(3000);
    if (!h().sketches?.map) {
      await teleport(s, BURR_NEAR);
      const lines = await hearHob(s, 25000);
      rec.hob.push(...lines);
      await teleport(s, SW_START);
      await s.pause(800);
      st = await swState(s);
    }
    // 3. The seedfall: gather three Capseeds once the pouch is owned (after a cutscene that is due has played).
    await atSeedfall(s, 0.2);
    await atSeedfall(s, 2);
    await s.closeGuides(3000);
    await atSeedfall(s, 8);
    await s.pause(1500);
    await settle(s);
    if (st.parts.includes("seed_pouch")) {
      await atSeedfall(s, 40);
      await gatherCapseeds(s, rec);
    }
    // 4. Her time, once the almanac is drawn: where the drift ends.
    if (h().sketches?.map) {
      rec.debugClock = true;
      const at = await swEddy(s);
      if (!h().found) {
        // Where the spores gather: wait 20 m short of the eddy, then follow a moss raft in.
        await teleport(s, { x: at.x + 20, z: at.z });
        for (let tau = 44; tau < 170 && !(await s.eval(() => window.__ptSw.found.length)); tau += 4) {
          await atSeedfall(s, tau);
          const raft = await s.eval(() => window.__pt.boils.at(-1) ?? null);
          if (raft?.word) {
            rec.notes.push(`moss raft ${raft.word}`);
            await teleport(s, { x: at.x + 6, z: at.z });
            await s.pause(1500);
          }
        }
        await settle(s);
        st = await swState(s);
        if (h().found) rec.notes.push("the island rose");
      } else {
        await atSeedfall(s, 60);
        await castsByEddy(s, at, rec);
        await settle(s);
        await fishSwHer(s, at, rec, ctx);
      }
      rec.midnight = await atSeedfall(s, 181);
      await s.pause(1200);
      await settle(s);
    }
  }
  rec.toasts.push(...(await takeToasts(s)));
  rec.scenes = await s.eval(() => window.__ptSw.scene.slice());
  // 5. Home, and the tally.
  rec.clamsBeforeTally = (await swState(s)).clams;
  const t = await tally(s);
  rec.murk.push(...t.murk);
  rec.tallyHunt = t.hunt;
  rec.tallyGift = t.gift;
  rec.trip = t.trip;
  rec.pad = t.pad;
  st = await swState(s);
  rec.clamsAfterTally = st.clams;
  if (t.trip?.gift) rec.gifts.push(t.trip.gift);
  if (t.trip?.total && rec.landed.some((l) => /:keep\*?$/.test(l))) {
    const keptN = rec.landed.filter((l) => /:keep\*?$/.test(l)).length;
    const sale = t.trip.total - (t.trip.bounty || 0);
    if (keptN && sale > 0) ctx.avgFish = 0.5 * ctx.avgFish + 0.5 * (sale / keptN);
  }
  // 6. At home: fit the Drift Float, buy what the hunt needs next, and fit the hunt's parts.
  await shopSw(s, rec);
  rec.after = await swState(s);
  rec.notepad = await s.eval(() => {
    const v = window.__gw.progression.loop.notepad?.("sporewood");
    return v ? JSON.parse(JSON.stringify(v)) : null;
  });
  await s.collectGameErrors();
  rec.errors = s.errors.splice(0);
  return rec;
}

async function shopSw(s, rec) {
  let st = await swState(s);
  if (st.parts.includes("drift_float") && st.fitted.depth !== "drift") {
    await s.eval(() => window.__gw.progression.loop.fitDepth("drift"));
    rec.notes.push("fitted the Drift Float");
  }
  const cake = st.bait?.spore_cake ?? 0;
  if (cake < 6) {
    const r = await s.eval(() => window.__gw.progression.loop.buy("tin:spore_cake"));
    if (r?.ok) rec.bought.push("Spore Cake");
  }
  const shelf = await shelfNow(s);
  st = await swState(s);
  const want = [];
  const onShelf = (id) => shelf.find((i) => i.id === id && !i.bought);
  for (const id of ["burl_hook", "brass_trace"])
    if (onShelf(`part:${id}`) && !st.parts.includes(id)) want.push(`part:${id}`);
  if (st.tackle.line < 1 && onShelf("line:1")) want.push("line:1");
  if (st.tackle.line >= 1 && st.tackle.line < 2 && onShelf("line:2")) want.push("line:2");
  for (const id of want) {
    const item = shelf.find((i) => i.id === id);
    st = await swState(s);
    if (st.clams >= item.price) {
      const r = await s.eval((id) => window.__gw.progression.loop.buy(id), id);
      if (r?.ok) rec.bought.push(`${item.name} (${item.price})`);
      else rec.notes.push(`buy ${id} refused: ${r?.msg ?? ""}`);
    } else {
      rec.wanted.push(`${item.name} (${item.price}, had ${st.clams})`);
      break;
    }
  }
  await s.eval(() => {
    const loop = window.__gw.progression.loop,
      p = loop.state().parts;
    p.includes("burl_hook") && loop.fitPart("hook", "burl_hook");
    p.includes("brass_trace") && loop.fitPart("leader", "brass_trace");
  });
  await s.closeGuides(3000);
}

const SW_MILESTONES = [
  ["Drift Float given", (r) => r.after.parts.includes("drift_float")],
  ["Seed Pouch given", (r) => r.after.parts.includes("seed_pouch")],
  ["tale told, notepad opens", (r) => r.after.hunt?.taleAt > 0],
  ["Burr's first talk and almanac (sketch 1)", (r) => r.after.hunt?.sketches?.map > 0],
  ["leaders on the shelf", (r) => r.after.shelved.includes("mossthread_snood")],
  ["line-up (sketch 3)", (r) => r.after.hunt?.sketches?.lineup > 0],
  ["first cracked pod", (r) => r.after.hunt?.marks?.person > 0],
  ["Burl Hook on the shelf", (r) => r.after.shelved.includes("burl_hook")],
  ["the island rises (sketch 2)", (r) => r.after.hunt?.found === true],
  ["the crunch", (r) => r.after.hunt?.scenesSeen?.crunch > 0],
  ["refusal (sketch 4)", (r) => r.after.hunt?.sketches?.swirl > 0],
  ["Burl Hook bought", (r) => r.after.parts.includes("burl_hook")],
  ["Brass Trace bought", (r) => r.after.parts.includes("brass_trace")],
  ["Rootthread bought", (r) => r.after.tackle.line >= 1],
  ["Mothsilk bought", (r) => r.after.tackle.line >= 2],
  ["first hook-up", (r) => !!r.hook],
  ["what came back (sketch 5)", (r) => r.after.hunt?.sketches?.back > 0],
  ["landed", (r) => r.hook?.landed === true || r.after.hunt?.landed > 0],
  ["ending tally (bounty, Burr's Seed)", (r) => r.after.relics.includes("burrs_seed")],
];

async function mainSporewood() {
  const browser = await launchBrowser();
  let save = FROM ? readFileSync(FROM, "utf8") : null;
  if (!save) {
    // sporewood-crossed made into a first arrival: the barge in Sporewood, no evening played there yet.
    const fixture = JSON.parse(
      readFileSync(
        join(new URL("..", import.meta.url).pathname, "tools/fixtures/sporewood-crossed.json"),
        "utf8",
      ),
    );
    const loop = fixture.meta.loop;
    loop.eveningsAt = { ...loop.eveningsAt, sporewood: 0 };
    loop.evenings = loop.eveningsAt.mossmere || 0;
    save = JSON.stringify(fixture);
  }
  const s = await GameSession.open(browser, {
    page: PAGE,
    save,
    debug: true,
    viewport: { width: 480, height: 270 },
  });
  const evenings = [];
  const ctx = { avgFish: 40, hookups: 0 };
  const milestones = {};
  let stopped = null;
  try {
    await s.boot();
    say("booted");
    for (let n = 1; n <= MAX_EVENINGS; n++) {
      let rec;
      try {
        rec = await playSporeEvening(s, n, ctx);
      } catch (err) {
        stopped = `evening ${n}: ${err.message}`;
        say("STOPPED", stopped);
        await s.collectGameErrors();
        evenings.push({ evening: n, crashed: err.message, errors: s.errors.splice(0) });
        break;
      }
      for (const [name, test] of SW_MILESTONES)
        if (!(name in milestones) && test(rec)) milestones[name] = rec.lake ?? n;
      evenings.push(rec);
      const sk = rec.after.hunt?.sketches || {};
      const pad = Object.entries(sk)
        .filter(([, v]) => v > 0)
        .map(([k]) => k)
        .join(",");
      say(
        `E${rec.lake ?? n}`,
        `clams ${rec.clamsBeforeTally}->${rec.clamsAfterTally}`,
        `fish ${rec.landed.join(" ")}`,
        rec.murk.length ? `Murk: ${rec.murk.map((m) => `"${short(m, 6)}"`).join(" ")}` : "",
        rec.hob.length ? `Burr: ${rec.hob.map((m) => `"${short(m, 6)}"`).join(" ")}` : "",
        rec.gifts.length ? `gift ${rec.gifts}` : "",
        rec.bought.length ? `bought ${rec.bought.join(", ")}` : "",
        rec.wanted.length ? `wanted ${rec.wanted.join(", ")}` : "",
        `pad [${pad}]`,
        rec.capseeds != null ? `capseeds ${rec.capseeds}` : "",
        rec.pods ? `pods ${rec.pods}` : "",
        rec.scenes?.length ? `scenes ${rec.scenes.join(",")}` : "",
        rec.her.length ? `her: ${rec.her.join(" / ")}` : "",
        rec.hook ? `HOOK p=${rec.hook.p} ${rec.hook.landed ? "LANDED" : `lost: ${rec.hook.reason}`}` : "",
        rec.notes.length ? `(${rec.notes.join("; ")})` : "",
        rec.errors.length ? `ERRORS ${rec.errors.length}` : "",
      );
      if (OUT) writeFileSync(OUT, JSON.stringify({ evenings, milestones, stopped }, null, 1));
      if (SAVES) writeFileSync(join(SAVES, `e${n}.save`), await s.saved());
      if (rec.after.relics.includes("burrs_seed")) break;
    }
  } finally {
    await browser.close();
  }
  const summary = {
    evenings: evenings.length,
    landedOn: milestones.landed ?? null,
    milestones,
    stopped,
    minutes: (Date.now() - t0) / 60000,
    errors: evenings.flatMap((e) => (e.errors || []).map((x) => `E${e.evening}: ${x}`)),
  };
  say("SUMMARY", JSON.stringify(summary, null, 1));
  if (OUT) writeFileSync(OUT, JSON.stringify({ summary, evenings }, null, 1));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
