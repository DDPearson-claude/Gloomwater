#!/usr/bin/env node
// Renders a fixed set of named Mossmere views to PNG files, the same way every time, so "before" and "after"
// pictures of the lake's scenery can be laid side by side. It changes nothing in the game.
//
// Usage: node tools/scenery-shots.mjs --out <dir> [--only name,name] [--quality high|low] [--size 1280x720]
//        node tools/scenery-shots.mjs --speed
//        either may add --page <path/to/built.html> to use another build than the repo's own
//
// Default: the game's best quality setting ("high") at 1280x720, device scale 1.
// --speed: at 480x270 on low quality, prints the average time of 60 frames at the set-out spot and in the
// Lily Maze (wall-clock time between animation frames; builders use it to check the low setting is no slower).
//
// How each view is made the same every time:
// - The page's clock is replaced before the game loads: every animation frame moves the game on by a fixed step,
//   however long the frame took to draw, and performance.now() reads that clock. Math.random is a seeded generator.
//   So the water, the wind sway, the wildlife and every random roll follow the same course on every run.
// - The hour is set with the debug clock (the phase and its time) and held there while the scene settles.
// - The raft is put at a fixed spot and heading by teleport; the camera is the game's own.
// - The scene settles at a small size on low quality (fast), then the page is resized to the shot size, the quality
//   is set, a few frames are drawn and the picture is taken with the game's own HUD hidden by a style this tool
//   adds to the page for the shot only.
//
// Saves: tools/fixtures/legend-sold.json (every Mossmere place bought and lifted), edited in memory so her water is
// found (the Bell Pool's harbour frame and bell stand) and Veilback Brook is revealed; and mid-mossmere.json for a
// place still locked under its mist (Under the Span).

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GameSession, ROOT, launchBrowser } from "./game-driver.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const SPEED = args.includes("--speed");
const OUT = option("--out", null);
const ONLY = option("--only", null)
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const QUALITY = option("--quality", "high");
// --page: another built page to shoot (default: the repo's Gloomwater-Mossmere.html), e.g. a trial build
const PAGE = option("--page", undefined);
const [SHOT_W, SHOT_H] = option("--size", "1280x720").split("x").map(Number);
if (!SPEED && !OUT) {
  console.error(
    "usage: node tools/scenery-shots.mjs --out <dir> [--only a,b] [--quality high|low] [--size WxH]",
  );
  console.error("       node tools/scenery-shots.mjs --speed");
  process.exit(2);
}
if (!["high", "medium", "low"].includes(QUALITY) || !(SHOT_W > 0 && SHOT_H > 0)) {
  console.error("--quality must be high, medium or low; --size must be WxH");
  process.exit(2);
}

const FIXTURES = join(ROOT, "tools", "fixtures");
const SETTLE_SIZE = { width: 480, height: 270 };
const SETTLE_FRAMES = 45; // at the 50 ms step: 2.25 s of game time for the camera, the hour's light and the mist to settle
const SHOT_FRAMES = 3; // frames drawn at the shot size and quality before the picture
const SEED = 1307;

// The hours: the debug clock's phase and the seconds into it. Day is the brightest part of the "calm" phase
// (its first moments still carry the set-out's warm light and its end fades into dusk); dusk is mid-dusk; night is
// a third of the way into the gloomtide, well before midnight's events.
const HOURS = {
  setout: { phase: "calm", t: 1 },
  day: { phase: "calm", t: 36 },
  dusk: { phase: "dusk", t: 7 },
  night: { phase: "gloomtide", t: 30 },
};

// yaw that turns the raft at `from` to face `to` (the game's own convention, as its sail plans use)
const facing = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));

const PLACES = {
  lily: { at: { x: -40.5, z: 33 }, look: { x: -40.5, z: 24.5 } },
  bellpool: { at: { x: -4, z: -4 }, look: { x: -4, z: -14 } },
  span: { at: { x: -28, z: 10 }, look: { x: -29.5, z: 0.5 } },
  hob: { at: { x: -20, z: 13 }, look: { x: -30, z: 8 } }, // Hob on his rock, seen from the east
  shore: { at: { x: -24.5, z: 10 }, look: { x: -30, z: 14 } }, // close under Mossbell Isle's shore and reeds
  brook: { at: { x: 56, z: 3.8 }, look: { x: 68.5, z: 5 } }, // the last leg of the brook's glide in (its place data)
  mistview: { at: { x: -27, z: 14 }, look: { x: -29.5, z: 0.5 } },
};

// The views, in the order they are taken. `session` names the save they need; `at` a place above or "setout" (the
// spot the set-out sail ends at); `hour` a key of HOURS; `act` an extra step before the scene settles.
const VIEWS = [
  ...["day", "dusk", "night"].map((hour) => ({ name: `dock-${hour}`, session: "found", at: "dock", hour })),
  ...["day", "dusk", "night"].map((hour) => ({
    name: `lily-maze-${hour}`,
    session: "found",
    at: "lily",
    hour,
  })),
  ...["day", "dusk", "night"].map((hour) => ({
    name: `bell-pool-${hour}`,
    session: "found",
    at: "bellpool",
    hour,
  })),
  { name: "open-water-dusk", session: "found", at: "setout", hour: "dusk" },
  { name: "open-water-night", session: "found", at: "setout", hour: "night" },
  { name: "under-the-span-night", session: "found", at: "span", hour: "night" },
  { name: "mossbell-isle-hob-dusk", session: "found", at: "hob", hour: "dusk" },
  { name: "bell-close-dusk", session: "found", at: "bellpool", hour: "dusk", frame: "bell_pool" },
  { name: "bell-close-night", session: "found", at: "bellpool", hour: "night", frame: "bell_pool" },
  { name: "veilback-brook-arrival", session: "found", at: "brook", hour: "setout", frame: "veilback_brook" },
  { name: "shore-reeds-dusk", session: "found", at: "shore", hour: "dusk" },
  { name: "raft-line-out-dusk", session: "found", at: "setout", hour: "dusk", act: "cast" },
  { name: "hooked-fight-dusk", session: "found", at: "setout", hour: "dusk", act: "hook" },
  { name: "mist-locked-dusk", session: "locked", at: "mistview", hour: "dusk" },
  { name: "mist-lifting-dusk", session: "locked", at: "mistview", hour: "dusk", act: "liftMist" },
];

// ---- the page's fixed clock and seeded random, installed before the game's own scripts run -------------------

function installClock(seed) {
  const realRaf = window.requestAnimationFrame.bind(window);
  const realNow = performance.now.bind(performance);
  const clock = { now: 0, step: 1000 / 30, frames: 0, realNow, pin: null };
  window.__shot = clock;
  let queue = [];
  let scheduled = false;
  let nextId = 1;
  const cancelled = new Set();
  const tick = () => {
    scheduled = false;
    clock.now += clock.step;
    clock.frames++;
    const pin = clock.pin;
    const run = window.__gw?.state?.run;
    if (pin && run) run.phaseTime = pin.t; // hold the hour while the scene settles
    const list = queue;
    queue = [];
    for (const [id, cb] of list) {
      if (cancelled.delete(id)) continue;
      try {
        cb(clock.now);
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
  };
  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    queue.push([id, cb]);
    if (!scheduled) {
      scheduled = true;
      realRaf(tick);
    }
    return id;
  };
  window.cancelAnimationFrame = (id) => cancelled.add(id);
  performance.now = () => clock.now;
  // mulberry32
  let a = seed >>> 0;
  Math.random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- saves ---------------------------------------------------------------------------------------------------------

const readSave = (name) => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

function foundSave(quality) {
  const save = readSave("legend-sold");
  const loop = save.meta.loop;
  save.meta.settings.quality = quality;
  // Her water found (as the scenarios' withFound): the Bell Pool's harbour frame and bell are built.
  loop.hunt = {
    mossmere: {
      lineLesson: false,
      taleAt: 2,
      hobMet: 3,
      hobNight: 3,
      mapBy: "hob",
      sketches: { map: 3, taken: 3, lineup: 0, swirl: 0, back: 0 },
      found: true,
      foundEvening: 3,
      foundBy: "theft",
      foundAt: { x: -2, z: -12 },
      takenOn: "float",
      birdCutsceneSeen: true,
    },
  };
  for (const list of [loop.maps.places, loop.places.revealed, loop.lifted])
    list.includes("bell_pool") || list.push("bell_pool");
  // Veilback Brook revealed by the Veil Angler's Notebook.
  loop.finds.got.veil_notebook = 1;
  loop.places.revealed.includes("veilback_brook") || loop.places.revealed.push("veilback_brook");
  return JSON.stringify(save);
}

function lockedSave(quality) {
  const save = readSave("mid-mossmere");
  save.meta.settings.quality = quality;
  return JSON.stringify(save);
}

// ---- steps on the page ---------------------------------------------------------------------------------------------

const t0 = Date.now();
const say = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s`, ...a);

const frames = (s, n) =>
  s.eval(
    (n) =>
      new Promise((resolve) => {
        let left = n;
        const f = () => (--left <= 0 ? resolve() : requestAnimationFrame(f));
        requestAnimationFrame(f);
      }),
    n,
  );

const setStep = (s, ms) => s.eval((ms) => (window.__shot.step = ms), ms);

async function setQuality(s, q) {
  await s.eval((q) => {
    const g = window.__gw;
    if (g.state?.meta?.settings) g.state.meta.settings.quality = q;
    g.render.setQuality(q);
  }, q);
}

async function openSession(browser, save) {
  const s = await GameSession.open(browser, { page: PAGE, save, debug: true, viewport: SETTLE_SIZE });
  await s.context.addInitScript(installClock, SEED);
  await s.page.reload({ waitUntil: "domcontentloaded" });
  await s.boot();
  await setStep(s, 50); // the set-out's shows run on the game's clock: the longest step the game takes keeps them short
  let route;
  try {
    route = await s.sail({ timeoutMs: 600_000 });
  } catch (e) {
    if (!/stayed held/.test(String(e.message))) throw e;
    await s.waitUntilFree(600_000); // a set-out show on a slow machine can outlast the driver's own wait
    route = "sailed (a long set-out show waited out)";
  }
  await setStep(s, 1000 / 30);
  say(`  on the water: ${route}`);
  // The renderer's canvas, so the shot style can hide everything else.
  await s.eval(() => window.__gw.render.renderer.domElement.setAttribute("data-scenery-shot", "1"));
  const setout = await s.eval(() => {
    const p = window.__gw.player;
    return { x: p.position.x, z: p.position.z, yaw: Number(p.heading) || 0 };
  });
  return { s, setout };
}

// Puts the hour, the raft and any extra step in place, and holds the hour while the scene settles.
async function stage(s, view, setout) {
  const hour = HOURS[view.hour];
  let place;
  if (view.at === "setout") place = { x: setout.x, z: setout.z, yaw: setout.yaw };
  else if (view.at === "dock") {
    // The lake's first dock (the world's own list), with the raft 10 m south of it, facing it.
    const dock = await s.eval(() => {
      const d = window.__gw.world.getDocks?.()?.[0];
      return d ? { x: d.position.x, z: d.position.z } : null;
    });
    if (!dock) throw new Error("the world lists no dock");
    const at = { x: dock.x, z: dock.z + 10 };
    place = { ...at, yaw: facing(at, dock) };
  } else place = { ...PLACES[view.at].at, yaw: facing(PLACES[view.at].at, PLACES[view.at].look) };
  await s.eval(
    ([hour, place]) => {
      const g = window.__gw;
      g.render.frameLandmark?.(null);
      if (g.fishing?.state && g.fishing.state !== "idle") g.debug.fishPlayTo?.(0.995);
      if (g.state.run.phase !== hour.phase) g.debug.setPhase(hour.phase);
      window.__shot.pin = { t: hour.t };
      g.player.teleport({ x: place.x, z: place.z }, place.yaw);
    },
    [hour, place],
  );
  await frames(s, 10);
  await s.closeGuides(1500);
  if (view.frame) {
    // The place's landmark camera (the one the mist lift and the reveal use), held on it.
    await s.eval((id) => {
      const g = window.__gw,
        a = g.world.placeAnchor(id);
      if (!a) throw new Error(`no anchor for ${id}`);
      g.render.frameLandmark(a, { dur: 600 });
    }, view.frame);
  } else if (view.act === "cast") {
    await s.eval((p) => {
      const g = window.__gw,
        d = 9;
      g.debug.castAt(p.x - Math.sin(p.yaw) * d, p.z - Math.cos(p.yaw) * d, 0.6);
    }, place);
  } else if (view.act === "hook") {
    await s.eval(() => {
      const g = window.__gw;
      g.debug.fishOutcome("lose");
      if (!g.debug.fishHook("mossback_perch")) throw new Error("could not hook a fish");
    });
  } else if (view.act === "liftMist") {
    await s.eval(() => {
      const g = window.__gw,
        a = g.world.placeAnchor("under_the_span");
      g.world.liftMist("under_the_span", 3);
      if (a) g.render.frameLandmark(a, { dur: 600 });
    });
  }
}

async function shoot(s, view, dir) {
  await setStep(s, 50);
  // A hooked fish's fight and the mist lift are moments: they settle for less time.
  const settle = view.act === "hook" ? 30 : view.act === "liftMist" ? 70 : SETTLE_FRAMES;
  await frames(s, settle);
  await setStep(s, 1000 / 30);
  await s.page.setViewportSize({ width: SHOT_W, height: SHOT_H });
  await setQuality(s, QUALITY);
  await frames(s, SHOT_FRAMES);
  await s.page.addStyleTag({
    content:
      "*{visibility:hidden!important} canvas[data-scenery-shot]{visibility:visible!important}" +
      " html,body{background:#000!important}",
  });
  await frames(s, 1);
  const file = join(dir, `${view.name}.png`);
  await s.page.screenshot({ path: file, timeout: 300_000 });
  await s.eval(() =>
    document
      .querySelectorAll("style")
      .forEach((el) => /data-scenery-shot/.test(el.textContent) && el.remove()),
  );
  await s.page.setViewportSize(SETTLE_SIZE);
  await setQuality(s, "low");
  return file;
}

async function shots() {
  mkdirSync(OUT, { recursive: true });
  const views = ONLY ? VIEWS.filter((v) => ONLY.includes(v.name)) : VIEWS;
  if (ONLY) for (const n of ONLY) if (!VIEWS.some((v) => v.name === n)) console.error(`no view named ${n}`);
  const browser = await launchBrowser();
  const failed = [];
  try {
    for (const kind of ["found", "locked"]) {
      const mine = views.filter((v) => v.session === kind);
      if (!mine.length) continue;
      say(`session ${kind}: ${mine.length} views`);
      const { s, setout } = await openSession(
        browser,
        kind === "found" ? foundSave(QUALITY) : lockedSave(QUALITY),
      );
      say(`  set-out spot ${setout.x.toFixed(1)}, ${setout.z.toFixed(1)}`);
      for (const view of mine) {
        try {
          await stage(s, view, setout);
          const file = await shoot(s, view, OUT);
          say(`  ${view.name}: ${file}`);
        } catch (e) {
          failed.push(view.name);
          say(`  ${view.name}: FAILED ${String(e.message || e).split("\n")[0]}`);
          await s.page.setViewportSize(SETTLE_SIZE).catch(() => {});
          await setQuality(s, "low").catch(() => {});
        }
      }
      await s.collectGameErrors();
      if (s.errors.length) say(`  page errors: ${s.errors.slice(0, 5).join(" | ")}`);
      await s.close();
    }
  } finally {
    await browser.close();
  }
  say(failed.length ? `done; not taken: ${failed.join(", ")}` : "done");
  if (failed.length) process.exitCode = 1;
}

// ---- --speed ---------------------------------------------------------------------------------------------------------

async function speed() {
  const browser = await launchBrowser();
  try {
    // Low unless --quality is given, so the dearer settings can be compared too.
    const q = args.includes("--quality") ? QUALITY : "low";
    const { s, setout } = await openSession(browser, foundSave("low"));
    await setQuality(s, q);
    const measure = () =>
      s.eval(
        () =>
          new Promise((resolve) => {
            const clock = window.__shot;
            let n = 0,
              start = 0;
            const f = () => {
              if (n === 0) start = clock.realNow();
              if (++n > 60) return resolve((clock.realNow() - start) / 60);
              requestAnimationFrame(f);
            };
            requestAnimationFrame(f);
          }),
      );
    const out = {};
    for (const [name, view] of [
      ["set-out spot", { at: "setout", hour: "dusk" }],
      ["Lily Maze", { at: "lily", hour: "dusk" }],
    ]) {
      await stage(s, view, setout);
      await frames(s, 20);
      out[name] = await measure();
      console.log(`${name}: ${out[name].toFixed(1)} ms a frame (60 frames, 480x270, ${q})`);
    }
    await s.close();
  } finally {
    await browser.close();
  }
}

await (SPEED ? speed() : shots());
