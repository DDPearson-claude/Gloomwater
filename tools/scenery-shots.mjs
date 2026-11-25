#!/usr/bin/env node
// Renders a fixed set of named views of a lake (Mossmere, or Sporewood Pools with --lake sporewood) to PNG files, the
// same way every time, so "before" and "after" pictures of the lake's scenery can be laid side by side. It changes
// nothing in the game.
//
// Usage: node tools/scenery-shots.mjs --out <dir> [--only name,name] [--quality high|low] [--size 1280x720]
//          [--rod <rod id>] [--raft top|none|keel:N|lantern:N|oars:N[+...][,...]] [--lake mossmere|sporewood]
//        node tools/scenery-shots.mjs --speed [--lake mossmere|sporewood]
//        either may add --page <path/to/built.html> to use another build than the repo's own
//
// --lake sporewood: Sporewood Pools' own views (SPOREWOOD_VIEWS) from tools/fixtures/sporewood-crossed.json, a save
// with the barge at Sporewood, the Lullaby and the Gill Harp free and the Veilwater and the Mother's Cup still locked
// under their mist. Among them: the spore drift by the hour, the seedfall from far and near, its pods in the evening's
// eddy and the Drift Float riding the drift (its trip is evening 7, so the drift and the seedfall are that evening's),
// and the Drowned Greenhouse: hidden under its mist, its lamp seen far off, its find, and found by the hour.
// --rod is for Mossmere's rods only.
//
// --rod: the "found" save owns and fits that Mossmere rod (willow_switch, ashwood_rod, whalebone_rod, or the found
// lamp_pole), and each picture's name gains "-<rod id>". --raft top: the save has every raft part at its top level
// (oars, keel, lantern), and each picture's name gains "-raft-top". --raft none: no raft part. --raft keel:2: that
// level of that part and none of the others (parts joined by "+", e.g. keel:2+lantern:1); the name gains
// "-raft-keel2". A comma list shoots each view once for each setting in one session: the first is in the save,
// the others are put in the game's state before their picture (the raft redraws its parts from it at once).
//
// Default: the game's best quality setting ("high") at 1280x720, device scale 1.
// --speed: at 480x270 on low quality (or --quality), prints the average time of 60 frames at the set-out spot and in the
// Lily Maze (with --lake sporewood: in the Lullaby and in the Drowned Greenhouse's aisle, found) (wall-clock time between
// animation frames; builders use it to check the low setting is no slower).
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
const ROD = option("--rod", null);
const RAFT = option("--raft", null);
const LAKE = option("--lake", "mossmere");
const MOSSMERE_RODS = ["willow_switch", "ashwood_rod", "whalebone_rod"];
const RAFTS = RAFT ? RAFT.split(",").map((r) => r.trim()) : [null];
const RAFT_OK = /^(top|none|(oars|keel|lantern):\d(\+(oars|keel|lantern):\d)*)$/;
// the raft's part levels a --raft setting names (null: the save's own)
const raftLevels = (setting) => {
  if (!setting) return null;
  if (setting === "top") return { oars: 2, keel: 3, lantern: 2 };
  const levels = { oars: 0, keel: 0, lantern: 0 };
  if (setting !== "none")
    for (const part of setting.split("+")) levels[part.split(":")[0]] = Number(part.split(":")[1]);
  return levels;
};
const suffix = (setting) =>
  (ROD ? `-${ROD}` : "") + (setting ? `-raft-${setting.replace(/:/g, "").replace(/\+/g, "-")}` : "");
const [SHOT_W, SHOT_H] = option("--size", "1280x720").split("x").map(Number);
if (!SPEED && !OUT) {
  console.error(
    "usage: node tools/scenery-shots.mjs --out <dir> [--only a,b] [--quality high|low] [--size WxH]",
  );
  console.error("       node tools/scenery-shots.mjs --speed");
  process.exit(2);
}
if (
  (ROD && ![...MOSSMERE_RODS, "lamp_pole"].includes(ROD)) ||
  (RAFT && !RAFTS.every((r) => RAFT_OK.test(r)))
) {
  console.error(
    `--rod must be one of ${MOSSMERE_RODS.join(", ")}, lamp_pole; --raft must be top, none or part:level[+part:level]`,
  );
  process.exit(2);
}
if (!["mossmere", "sporewood"].includes(LAKE) || (LAKE === "sporewood" && ROD)) {
  console.error("--lake must be mossmere or sporewood; --rod is for Mossmere only");
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
  // Sporewood's seedfall (its time clue strikes 1 s into dusk, ten sighs 2.2 s apart): mid-seedfall, with pods in the
  // air and the Mother Cap glowing; and about 100 s after its first sigh, the pods gathered in the evening's eddy.
  seedfall: { phase: "dusk", t: 12 },
  podsFalling: { phase: "dusk", t: 16 },
  gathered: { phase: "gloomtide", t: 81 },
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
  // the reed areas: Elder Sister's ring of reeds seen from the north with a line cast into them; Mossbell Isle's
  // northern reeds from open water; the north-west shore's reed bed (its arc 120-135 degrees), the raft off it
  sister: { at: { x: -30, z: -9.5 }, look: { x: -30, z: -24 } },
  isleNorth: { at: { x: -31, z: 26 }, look: { x: -30, z: 14 } },
  nwShore: { at: { x: -27, z: 38 }, look: { x: -34, z: 45 } },
};

// Sporewood Pools' places: each raft spot faces the place across open water (the Veilwater from outside its curtain of
// moss, the Mother's Cup from the neck's side of the East Pool), close enough that the fishing camera frames it.
const SPOREWOOD_PLACES = {
  lullaby: { at: { x: -50, z: -24.5 }, look: { x: -52.5, z: -37 } }, // the sleeping cove's lily rafts, from the north
  harp: { at: { x: -9, z: 6.5 }, look: { x: 2, z: 6.5 } }, // the raft under the Gill Harp's west strings, facing the neck
  veil: { at: { x: -66, z: 29.5 }, look: { x: -84, z: 36.5 } }, // the moss curtain over the Veilwater's mouth
  cup: { at: { x: 35, z: 11 }, look: { x: 48, z: 6 } }, // the Mother's Cup under the Mother Cap
  open: { at: { x: 30, z: -6 }, look: { x: 44, z: -14 } }, // the open East Pool
  // The spore drift on the save's evening (evening 7: it runs from the Cup west to the eddy south of Murk's barge). The
  // fishing camera sits south of the raft (+z) whatever way it faces, so the drift crosses its frame: the raft in the
  // drift, facing down it; north of it (the Drift Float's cast puts the raft a cast's length off the drift, on this side,
  // clear of Murk's barge to the south, and the camera drawn back with the line out takes in the float and the raft);
  // and in the drift's last metres, with the eddy to its left.
  drift: { at: { x: 37, z: 9.4 }, look: { x: 26, z: 10 } },
  driftSide: { at: { x: 34, z: 2 }, look: { x: 35, z: 9 } },
  eddy: { at: { x: 30, z: 11.5 }, look: { x: 26, z: 10 } },
  // The seedfall from far off (by the Lullaby, facing the Mother Cap) and from near the Mother's Cup (south of it, so the
  // Cup is in the fishing camera's frame).
  lullabyCap: { at: { x: -44, z: -21 }, look: { x: 51, z: 8 } },
  cupNear: { at: { x: 44, z: 16 }, look: { x: 48, z: 6 } },
  // The Drowned Greenhouse in the south-east bay's shallows (its door at 52, -31.3, the aisle running north): the raft in
  // its flooded aisle facing the door and the lamp, and the raft out in the bay north of it, where it is first seen.
  greenhouse: { at: { x: 52, z: -25.4 }, look: { x: 52, z: -31 } },
  ghOutside: { at: { x: 51, z: -11 }, look: { x: 52, z: -31 } },
};

// The views, in the order they are taken. `session` names the save they need; `at` a place above or "setout" (the
// spot the set-out sail ends at); `hour` a key of HOURS; `act` an extra step before the scene settles.
const MOSSMERE_VIEWS = [
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
  // a low camera close along the north-west shore's reed bed (`cam`: the landmark camera's framing, held on it)
  {
    name: "reed-bed-low-dusk",
    session: "found",
    at: "nwShore",
    hour: "dusk",
    cam: { x: -34.5, y: 0.7, z: 44, side: [0.55, -0.85], elev: 5, dist: 7.5 },
  },
  // the normal fishing camera with the line cast 9 m ahead into Elder Sister's reeds
  { name: "reed-line-out-day", session: "found", at: "sister", hour: "day", act: "cast" },
  { name: "reed-isle-night", session: "found", at: "isleNorth", hour: "night" },
  { name: "raft-line-out-dusk", session: "found", at: "setout", hour: "dusk", act: "cast" },
  // close on the angler and the rod from the right side, a little behind, with the line cast 9 m ahead
  {
    name: "rod-close-dusk",
    session: "found",
    at: "setout",
    hour: "dusk",
    act: "cast",
    close: { side: 0.85, back: 0.5, elev: 12, dist: 3.4, ahead: 0.55, y: 1.05 },
  },
  { name: "hooked-fight-dusk", session: "found", at: "setout", hour: "dusk", act: "hook" },
  { name: "mist-locked-dusk", session: "locked", at: "mistview", hour: "dusk" },
  // close on a dock that keeps its mooring posts and buoy (the lake's second dock), seen from the open water at dusk
  { name: "dock-posts-dusk", session: "found", at: "dock", dock: 1, hour: "dusk", dockCam: true },
  { name: "mist-lifting-dusk", session: "locked", at: "mistview", hour: "dusk", act: "liftMist" },
];

// Sporewood's views (--lake sporewood), all from the one save: the arrival as the set-out sail leaves the raft, each
// free place at dusk from the raft, the two locked places under their mist, the open water by the hour, the raft with the
// line out.
const SPOREWOOD_VIEWS = [
  { name: "arrival-setout", session: "crossed", at: "setout", hour: "setout" },
  { name: "lullaby-dusk", session: "crossed", at: "lullaby", hour: "dusk" },
  { name: "gill-harp-dusk", session: "crossed", at: "harp", hour: "dusk" },
  // the two locked places through their own landmark camera (the one the mist lift uses), so the picture faces the place
  { name: "veilwater-locked-dusk", session: "crossed", at: "veil", hour: "dusk", frame: "veilwater" },
  { name: "mothers-cup-locked-dusk", session: "crossed", at: "cup", hour: "dusk", frame: "mothers_cup" },
  ...["day", "dusk", "night"].map((hour) => ({
    name: `open-water-${hour}`,
    session: "crossed",
    at: "open",
    hour,
  })),
  { name: "raft-line-out-dusk", session: "crossed", at: "setout", hour: "dusk", act: "cast" },
  // The spore drift by the hour from the fishing camera, the seedfall from far and near, the pods gathered in the
  // evening's eddy, and the Drift Float riding the drift (from the fishing camera and close).
  ...["day", "dusk", "night"].map((hour) => ({
    name: `drift-${hour}`,
    session: "crossed",
    at: "drift",
    hour,
  })),
  { name: "seedfall-lullaby", session: "crossed", at: "lullabyCap", hour: "seedfall" },
  { name: "seedfall-cup", session: "crossed", at: "cupNear", hour: "podsFalling" },
  // the Mother's Cup bought and lifted, a camera held west of it that takes in the Mother Cap over the Cup: pods in the
  // air and the first on the water
  {
    name: "seedfall-cap",
    session: "cup",
    at: "cupNear",
    hour: "podsFalling",
    cam: { x: 50, y: 8.5, z: 7, side: [-0.86, -0.5], elev: 9, dist: 34 },
  },
  { name: "pods-eddy-night", session: "crossed", at: "eddy", hour: "gathered" },
  { name: "drift-float-dusk", session: "crossed", at: "driftSide", hour: "dusk", act: "driftCast" },
  {
    name: "drift-float-close-dusk",
    session: "crossed",
    at: "driftSide",
    hour: "dusk",
    act: "driftCast",
    floatClose: { elev: 16, dist: 3.2, side: 0.6 },
  },
  // The Drowned Greenhouse: found and its mist lifted, from the fishing camera in its aisle by the hour (the save's
  // evening is 7, so Burr's lamp is lit at dusk and at night); hidden under its mist from the bay with the lamp lit; the
  // lamp seen far off from the set-out spot at dusk; the find, as the raft sails into it (the title shown with the
  // game's own page, so `hud`); and close on the door, the lamp and the clear spot beside it for Burr.
  ...["day", "dusk", "night"].map((hour) => ({
    name: `greenhouse-${hour}`,
    session: "ghfound",
    at: "greenhouse",
    hour,
  })),
  { name: "greenhouse-hidden-dusk", session: "crossed", at: "ghOutside", hour: "dusk" },
  { name: "greenhouse-lamp-far-dusk", session: "crossed", at: "setout", hour: "dusk" },
  {
    name: "greenhouse-find-dusk",
    session: "crossed",
    at: "ghOutside",
    hour: "dusk",
    act: "findGreenhouse",
    hud: true,
  },
  {
    name: "greenhouse-door-night",
    session: "ghfound",
    at: "greenhouse",
    hour: "night",
    cam: { x: 52.6, y: 1.1, z: -30.9, side: [0.25, 0.97], elev: 22, dist: 6 },
  },
];
const VIEWS = LAKE === "sporewood" ? SPOREWOOD_VIEWS : MOSSMERE_VIEWS;
const PLACES_HERE = LAKE === "sporewood" ? SPOREWOOD_PLACES : PLACES;

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
  // --rod: that rod owned (every shop rod below it too) and fitted; the found pole as a find, fitted.
  if (ROD === "lamp_pole") {
    loop.finds.got.lamp_pole = 1;
    loop.found = { ...loop.found, rod: "lamp_pole" };
  } else if (ROD) {
    loop.tackle.rod = Math.max(loop.tackle.rod || 0, MOSSMERE_RODS.indexOf(ROD));
    loop.fit = { ...loop.fit, rod: ROD };
  }
  if (RAFTS[0]) loop.raft = raftLevels(RAFTS[0]);
  return JSON.stringify(save);
}

function lockedSave(quality) {
  const save = readSave("mid-mossmere");
  save.meta.settings.quality = quality;
  return JSON.stringify(save);
}

// Sporewood as the save left it (the barge there); --raft sets its raft parts as for Mossmere.
function crossedSave(quality) {
  const save = readSave("sporewood-crossed");
  save.meta.settings.quality = quality;
  if (RAFTS[0]) save.meta.loop.raft = raftLevels(RAFTS[0]);
  return JSON.stringify(save);
}

// Sporewood with the Mother's Cup bought and its mist lifted, so the seedfall's pods are seen falling into it.
function cupSave(quality) {
  const save = JSON.parse(crossedSave(quality)),
    loop = save.meta.loop;
  loop.places = loop.places || { revealed: [] };
  for (const list of [loop.maps.places, loop.places.revealed, (loop.lifted = loop.lifted || [])])
    list.includes("mothers_cup") || list.push("mothers_cup");
  return JSON.stringify(save);
}

// Sporewood with the Drowned Greenhouse found and its mist lifted (as a sail into it leaves the save).
function ghFoundSave(quality) {
  const save = JSON.parse(crossedSave(quality)),
    loop = save.meta.loop;
  loop.places = loop.places || { revealed: [] };
  loop.places.revealed = loop.places.revealed || [];
  for (const list of [loop.maps.places, loop.places.revealed, (loop.lifted = loop.lifted || [])])
    list.includes("drowned_greenhouse") || list.push("drowned_greenhouse");
  return JSON.stringify(save);
}

const SAVES = {
  found: foundSave,
  locked: lockedSave,
  crossed: crossedSave,
  cup: cupSave,
  ghfound: ghFoundSave,
};

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
    const dock = await s.eval((i) => {
      const d = window.__gw.world.getDocks?.()?.[i];
      return d ? { x: d.position.x, z: d.position.z } : null;
    }, view.dock ?? 0);
    if (!dock) throw new Error("the world lists no dock");
    const at = { x: dock.x, z: dock.z + 10 };
    place = { ...at, yaw: facing(at, dock) };
    if (view.dockCam) {
      // the landmark camera on the dock, from the lake's middle side: the raft is moved out of the way
      const k = Math.hypot(dock.x, dock.z) || 1;
      view = {
        ...view,
        cam: { x: dock.x, y: 0.8, z: dock.z, side: [-dock.x / k, -dock.z / k], elev: 12, dist: 7.5 },
      };
      place = { x: dock.x * 0.7, z: dock.z * 0.7, yaw: facing({ x: dock.x * 0.7, z: dock.z * 0.7 }, dock) };
    }
  } else
    place = { ...PLACES_HERE[view.at].at, yaw: facing(PLACES_HERE[view.at].at, PLACES_HERE[view.at].look) };
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
  if (view.cam) {
    await s.eval((cam) => window.__gw.render.frameLandmark(cam, { dur: 600 }), view.cam);
  } else if (view.frame) {
    // The place's landmark camera (the one the mist lift and the reveal use), held on it.
    await s.eval((id) => {
      const g = window.__gw,
        a = g.world.placeAnchor(id);
      if (!a) throw new Error(`no anchor for ${id}`);
      g.render.frameLandmark(a, { dur: 600 });
    }, view.frame);
  } else if (view.act === "cast") {
    await s.eval(
      ([p, close]) => {
        const g = window.__gw,
          d = 9;
        g.debug.castAt(p.x - Math.sin(p.yaw) * d, p.z - Math.cos(p.yaw) * d, 0.6);
        if (!close) return;
        // The landmark camera held on the angler: aimed a little ahead of the raft's middle, from its right side
        // and behind (forward is (-sin yaw, -cos yaw), right is (cos yaw, -sin yaw)).
        const [fx, fz] = [-Math.sin(p.yaw), -Math.cos(p.yaw)],
          [rx, rz] = [Math.cos(p.yaw), -Math.sin(p.yaw)],
          at = g.player.position;
        g.render.frameLandmark(
          {
            x: at.x + fx * close.ahead,
            y: close.y,
            z: at.z + fz * close.ahead,
            r: 1,
            side: [rx * close.side - fx * close.back, rz * close.side - fz * close.back],
            elev: close.elev,
            dist: close.dist,
          },
          { dur: 600 },
        );
      },
      [place, view.close || null],
    );
  } else if (view.act === "driftCast") {
    // Sporewood's Drift Float owned and fitted (as Murk's gift leaves it), cast into the spore drift past halfway
    // down it, the raft 9 m to its side facing it; with floatClose the landmark camera is held on the float.
    await s.eval(
      ([p0, close]) => {
        const g = window.__gw,
          loop = g.state.meta.loop,
          D = g.data,
          drift = D.sporeDriftOf(g.state.run.evening, "sporewood"),
          q = D.driftAt(drift, drift.len * 0.55),
          x = q.x,
          z = q.z,
          side = (p0.x - x) * -q.dz + (p0.z - z) * q.dx >= 0 ? 1 : -1,
          rx = x - q.dz * 9 * side,
          rz = z + q.dx * 9 * side,
          p = { x: rx, z: rz, yaw: Math.atan2(-(x - rx), -(z - rz)) };
        g.player.teleport({ x: p.x, z: p.z }, p.yaw);
        for (const id of ["drift_float", "seed_pouch"]) loop.parts.includes(id) || loop.parts.push(id);
        g.progression.loop.fitDepth("drift");
        g.debug.castAt(x, z, 0.6);
        if (!close) return;
        const [ux, uz] = [Math.cos(p.yaw), -Math.sin(p.yaw)];
        g.render.frameLandmark(
          {
            x,
            y: 0.1,
            z,
            r: 0.5,
            side: [ux * close.side + Math.sin(p.yaw), uz * close.side + Math.cos(p.yaw)],
            elev: close.elev,
            dist: close.dist,
          },
          { dur: 600 },
        );
      },
      [place, view.floatClose || null],
    );
  } else if (view.act === "findGreenhouse") {
    // Sail into the Greenhouse's aisle: the game finds it (its update, four times a second) and lifts its mist.
    await s.eval(() => {
      const g = window.__gw,
        a = g.data.loopPlace("drowned_greenhouse")?.area;
      if (!a) throw new Error("no Drowned Greenhouse");
      g.player.teleport({ x: a.x, z: a.z + 1 }, 0);
    });
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

async function shoot(s, view, dir, setting = RAFTS[0]) {
  await setStep(s, 50);
  // A hooked fish's fight and the mist lift are moments: they settle for less time.
  const settle =
    view.act === "hook"
      ? 30
      : view.act === "liftMist"
        ? 70
        : view.act === "findGreenhouse"
          ? 72
          : SETTLE_FRAMES;
  await frames(s, settle);
  await setStep(s, 1000 / 30);
  await s.page.setViewportSize({ width: SHOT_W, height: SHOT_H });
  await setQuality(s, QUALITY);
  await frames(s, SHOT_FRAMES);
  view.hud ||
    (await s.page.addStyleTag({
      content:
        "*{visibility:hidden!important} canvas[data-scenery-shot]{visibility:visible!important}" +
        " html,body{background:#000!important}",
    }));
  await frames(s, 1);
  const file = join(dir, `${view.name}${suffix(setting)}.png`);
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
    for (const kind of Object.keys(SAVES)) {
      const mine = views.filter((v) => v.session === kind);
      if (!mine.length) continue;
      say(`session ${kind}: ${mine.length} views`);
      const { s, setout } = await openSession(browser, SAVES[kind](QUALITY));
      say(`  set-out spot ${setout.x.toFixed(1)}, ${setout.z.toFixed(1)}`);
      for (const view of mine)
        for (const [i, setting] of RAFTS.entries()) {
          const name = view.name + suffix(setting);
          try {
            // The first setting is the save's and the view is staged for it; the others are put in the game's
            // state, which the raft reads, with the view left as it is (staging again would move the camera).
            if (i === 0) await stage(s, view, setout);
            else if (kind !== "locked")
              await s.eval((levels) => {
                window.__gw.state.meta.loop.raft = levels;
              }, raftLevels(setting));
            const file = await shoot(s, view, OUT, setting);
            say(`  ${name}: ${file}`);
          } catch (e) {
            failed.push(name);
            say(`  ${name}: FAILED ${String(e.message || e).split("\n")[0]}`);
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
    // The scenery is built for the quality the save names when the lake loads (low or not, and medium or high for
    // some pieces), so the save carries the measured quality: a change of setting alone does not rebuild it.
    // (Sporewood: the Drowned Greenhouse found, so its glass and lamp are there with no mist over them; an older build
    // simply has no such place)
    const { s, setout } = await openSession(browser, LAKE === "sporewood" ? ghFoundSave(q) : foundSave(q));
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
      LAKE === "sporewood"
        ? ["the Lullaby", { at: "lullaby", hour: "dusk" }]
        : ["Lily Maze", { at: "lily", hour: "dusk" }],
      ...(LAKE === "sporewood" ? [["the Greenhouse", { at: "greenhouse", hour: "dusk" }]] : []),
    ]) {
      await stage(s, view, setout);
      await frames(s, 20);
      out[name] = await measure();
      // the last frame's totals (the game resets the renderer's counts at the start of each frame)
      const info = await s.eval(() => {
        const r = window.__gw.render.renderer.info.render;
        return { calls: r.calls, triangles: r.triangles };
      });
      console.log(
        `${name}: ${out[name].toFixed(1)} ms a frame (60 frames, 480x270, ${q});` +
          ` ${info.calls} draw calls, ${info.triangles} triangles`,
      );
    }
    await s.close();
  } finally {
    await browser.close();
  }
}

await (SPEED ? speed() : shots());
