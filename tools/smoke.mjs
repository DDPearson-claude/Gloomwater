#!/usr/bin/env node
// Smoke test of the built Gloomwater-Mossmere.html in headless Chromium (Playwright, software WebGL).
//
// It plays the opening of a fresh game the way a player would and fails on the first problem:
//   1. boot from file:// to the title, with no console error and no uncaught page error;
//   2. the game canvas is a live WebGL2 context and the title scene renders real pixels;
//   3. "New Game" opens the Wick picker with the five Wicks; pick one; "Start";
//   4. skip the intro, tap through the opening tow, close the guide cards, open the chart and "Sail";
//   5. on the water: flow "playing", a trip is running, the save records the chosen Wick, the lake renders;
//   6. one cast with the mouse (press on the water, hold, let go) until the float is in the water.
// Console errors and page errors are checked after every step and once more at the end.
//
// Needs Playwright with Chromium installed (not a dependency of this repo; it is resolved like
// require("playwright") from this directory, so a global install on NODE_PATH works).
//
// Usage: node tools/smoke.mjs [path/to/page.html]   (default: the repo's Gloomwater-Mossmere.html)

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = resolve(process.argv[2] || join(ROOT, "Gloomwater-Mossmere.html"));

// Console errors that are expected and not a failure. Keep this explicit and tiny, one justified entry at a
// time, each a RegExp matched against the message text. Today no console error is expected, so it is empty.
const ALLOWED_CONSOLE_ERRORS = [];

const CHARACTER = { label: "Tallow", id: "tallow" };
const WICKS = ["The Wick", "Taper", "Stub", "Tallow", "Ashwick"];
// Small viewport: Chromium renders WebGL on the CPU here (SwiftShader), and every frame costs.
const VIEWPORT = { width: 480, height: 270 };
// On a busy machine, GW_SLOW=2 (or more) stretches every time limit by that factor; it changes no check.
const SLOW = Math.max(1, Number(process.env.GW_SLOW) || 1);
const BUDGET_MS = 110_000 * SLOW; // the whole run, launch to exit

const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s";
const log = (msg) => console.log(`[smoke ${secs()}] ${msg}`);

class SmokeFailure extends Error {}
let currentStep = "setup";
const fail = (msg) => {
  throw new SmokeFailure(msg);
};

let browser = null;
const budget = setTimeout(() => {
  console.error(`\nsmoke FAILED: over the ${BUDGET_MS / 1000}s budget during step "${currentStep}"`);
  if (errors.length) console.error(errorReport());
  browser?.close().catch(() => {});
  process.exit(1);
}, BUDGET_MS);

// ---- error capture -----------------------------------------------------------------------------------

const errors = [];
const externalRequests = [];
// A wait (waitFor) ends as soon as an error is recorded, so the error is reported at once, not at the timeout.
const errorWaiters = new Set();
function addError(msg) {
  errors.push(msg);
  for (const wake of errorWaiters) wake();
}
function watchErrors(page) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    if (ALLOWED_CONSOLE_ERRORS.some((re) => re.test(text))) return;
    const at = m.location();
    addError(
      `console.error during "${currentStep}": ${text}${at?.lineNumber ? ` (line ${at.lineNumber + 1})` : ""}`,
    );
  });
  page.on("pageerror", (e) =>
    addError(`uncaught page error during "${currentStep}": ${e.stack || e.message || e}`),
  );
  page.on("crash", () => addError(`the page crashed during "${currentStep}"`));
}
const errorReport = () => `${errors.length} error(s):\n  ${errors.map((e) => e.slice(0, 1500)).join("\n  ")}`;
function assertNoErrors() {
  if (errors.length) fail(errorReport());
}

// The game also keeps its own log of errors it caught and reported (window.__gw.errors, filled by the same
// report function that writes "[gloomwater] ..." to console.error). Read it too, in case a report bypasses
// the console.
let page = null;
let gameErrorsSeen = 0;
async function collectGameErrors() {
  const list = await page?.evaluate(() => window.__gw?.errors?.slice() ?? []).catch(() => []);
  for (const e of (list ?? []).slice(gameErrorsSeen))
    addError(`game error log during "${currentStep}": ${e}`);
  gameErrorsSeen = Math.max(gameErrorsSeen, list?.length ?? 0);
}

async function step(name, fn) {
  currentStep = name;
  const s = Date.now();
  let detail;
  try {
    detail = await fn();
  } catch (e) {
    await collectGameErrors();
    if (e instanceof SmokeFailure && errors.length && !e.message.includes(" error(s):\n"))
      fail(`${e.message}\n${errorReport()}`);
    throw e;
  }
  await collectGameErrors();
  assertNoErrors();
  log(`ok  ${name}${detail ? ` (${detail})` : ""} [${((Date.now() - s) / 1000).toFixed(1)}s]`);
}

// ---- page helpers (run inside the page) --------------------------------------------------------------

const IN_PAGE_HELPERS = () => {
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return (
      r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity > 0.05
    );
  };
  window.__smoke = {
    events: [],
    button(text) {
      const want = text.toLowerCase();
      return [...document.querySelectorAll("button")].find(
        (b) => b.textContent.trim().replace(/\s+/g, " ").toLowerCase() === want && visible(b),
      );
    },
    press(el) {
      el?.click();
      return !!el;
    },
    wickCard(label) {
      return [...document.querySelectorAll(".gw-char")].find((c) => c.textContent.trim().startsWith(label));
    },
    state() {
      const g = window.__gw;
      return {
        flow: g.flow,
        tow: g.game?.towing?.() ?? null,
        fishing: g.fishing?.state ?? null,
        blocking: g.ui?.isBlocking?.() === true,
        tutorial: g.state?.meta?.loop?.tutorial?.step ?? null,
      };
    },
    // Reads the WebGL drawing buffer right after the game has drawn a frame (this rAF callback is queued
    // behind the game's own), and summarises it.
    pixels() {
      const canvas = window.__gw?.render?.renderer?.domElement;
      const gl = window.__gw?.render?.renderer?.getContext?.();
      if (!canvas || !gl) return Promise.resolve({ error: "no renderer canvas or context" });
      return new Promise((done) =>
        requestAnimationFrame(() => {
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const px = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
          const colours = new Set();
          let lo = 255;
          let hi = 0;
          for (let i = 0; i < px.length; i += 4) {
            colours.add(((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3));
            const y = (px[i] * 3 + px[i + 1] * 6 + px[i + 2]) / 10;
            if (y < lo) lo = y;
            if (y > hi) hi = y;
          }
          done({
            webgl2: typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext,
            lost: gl.isContextLost(),
            inPage: document.getElementById("game")?.contains(canvas) === true,
            size: `${w}x${h}`,
            colours: colours.size,
            lumaRange: Math.round(hi - lo),
          });
        }),
      );
    },
  };
};

async function expectRendering(page, where) {
  const p = await page.evaluate(() => window.__smoke.pixels());
  if (p.error) fail(`${where}: ${p.error}`);
  if (!p.webgl2) fail(`${where}: the game canvas is not a WebGL2 context`);
  if (p.lost) fail(`${where}: the WebGL context is lost`);
  if (!p.inPage) fail(`${where}: the renderer canvas is not inside #game`);
  // A blank, cleared or single-colour frame has a handful of colours and no contrast; a 3D scene has many.
  if (p.colours < 24 || p.lumaRange < 24)
    fail(`${where}: the canvas looks blank (${p.colours} distinct colours, luma range ${p.lumaRange})`);
  return `WebGL2 ${p.size}, ${p.colours} colours, luma range ${p.lumaRange}`;
}

async function waitFor(page, what, timeoutMs, fn, arg) {
  timeoutMs *= SLOW;
  assertNoErrors();
  let wake;
  const errored = new Promise((resolve) => errorWaiters.add((wake = resolve)));
  const waiting = page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 250 });
  waiting.catch(() => {}); // if an error wins the race, this wait may still reject later
  try {
    await Promise.race([waiting, errored]);
  } catch (e) {
    assertNoErrors();
    const st = await page.evaluate(() => window.__smoke?.state?.()).catch(() => null);
    fail(`timed out after ${timeoutMs / 1000}s waiting for ${what}; game state ${JSON.stringify(st)}`);
  } finally {
    errorWaiters.delete(wake);
  }
  assertNoErrors();
}

// ---- the run -----------------------------------------------------------------------------------------

async function main() {
  if (!existsSync(PAGE)) fail(`no such file: ${PAGE} (run: npm run build)`);
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)("playwright"));
  } catch {
    fail('Playwright is not available: require("playwright") failed. Install Playwright with Chromium.');
  }
  log(`page ${PAGE}`);
  browser = await chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  // Hermetic: the page's only outside requests are Google Fonts stylesheets. Answer every non-file request
  // with an empty 200 so the result never depends on the network (the page falls back to local fonts).
  await context.route(
    (url) => url.protocol !== "file:",
    (route) => {
      externalRequests.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/css", body: "" });
    },
  );
  page = await context.newPage();
  watchErrors(page);

  await step("boot to the title", async () => {
    await page.goto(pathToFileURL(PAGE).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitFor(
      page,
      'the title screen with "New Game"',
      60_000,
      () =>
        !!window.__gw &&
        window.__gw.flow === "title" &&
        [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "New Game"),
    );
    await page.evaluate(IN_PAGE_HELPERS);
    const fresh = await page.evaluate(() => localStorage.getItem("gloomwater.save.v1"));
    return `fresh profile, save ${fresh ? "present" : "absent"}`;
  });

  await step("title scene renders through WebGL2", () => expectRendering(page, "title"));

  // Speed only: SwiftShader manages about 1.5 frames per second at the default quality and the game's
  // clock advances at most 0.05 s per frame. The title (boot) has already run at the default quality.
  // This is the call the Settings menu makes.
  await page.evaluate(() => window.__gw.render.setQuality("low"));
  await page.evaluate(() => {
    for (const name of ["fishing:cast", "fishing:state", "loop:tow", "run:start", "home:enter"])
      window.__gw.bus.on(name, (p) =>
        window.__smoke.events.push({ name, state: p?.state ?? p?.phase ?? null }),
      );
  });

  await step('"New Game" opens the Wick picker', async () => {
    if (!(await page.evaluate(() => window.__smoke.press(window.__smoke.button("New Game")))))
      fail('no "New Game" button');
    await waitFor(
      page,
      "the five Wick cards",
      15_000,
      () => document.querySelectorAll(".gw-char").length >= 5,
    );
    const names = await page.evaluate(() =>
      [...document.querySelectorAll(".gw-char")].map((c) => c.textContent.trim()),
    );
    for (const w of WICKS)
      if (!names.some((n) => n.startsWith(w)))
        fail(`Wick "${w}" missing from the picker: ${JSON.stringify(names)}`);
    return `${names.length} Wicks`;
  });

  await step(`pick ${CHARACTER.label} and Start`, async () => {
    const found = await page.evaluate(
      (label) => window.__smoke.press(window.__smoke.wickCard(label)),
      CHARACTER.label,
    );
    if (!found) fail(`no ${CHARACTER.label} card`);
    await waitFor(
      page,
      `${CHARACTER.label} to show as selected`,
      10_000,
      (label) => window.__smoke.wickCard(label)?.classList.contains("gw-on") === true,
      CHARACTER.label,
    );
    if (!(await page.evaluate(() => window.__smoke.press(window.__smoke.button("Start")))))
      fail('no "Start" button');
    await waitFor(page, "the intro or home to begin", 20_000, () => window.__gw.flow !== "title");
  });

  await step("intro, opening tow and chart, then Sail", async () => {
    // The game decides what comes next; each turn does the one thing a player would do on that screen.
    const seen = [];
    const deadline = Date.now() + 60_000 * SLOW;
    while (Date.now() < deadline) {
      assertNoErrors();
      const { act, state } = await page.evaluate(() => {
        const S = window.__smoke;
        const state = S.state();
        let act = "wait";
        if (state.flow === "playing") act = "playing";
        else if (state.flow === "intro") {
          const skip = document.querySelector(".gw-intro-skip");
          if (skip) skip.click(), (act = "skip intro");
        } else if (S.button("Got it")) S.button("Got it").click(), (act = "close guide");
        else if (document.querySelector(".gw-tow"))
          document.querySelector(".gw-tow").click(), (act = "tap tow");
        else if (state.tow === "glide")
          act = "key:Enter"; // the glide in is skipped from the keyboard
        else if (S.button("Sail")) S.button("Sail").click(), (act = "sail");
        else if (state.flow === "home" && !state.tow && !state.blocking && S.button("Chart"))
          S.button("Chart").click(), (act = "open chart");
        return { act, state };
      });
      if (act === "key:Enter") await page.keyboard.press("Enter");
      if (act !== "wait" && seen[seen.length - 1] !== act) seen.push(act);
      if (act === "playing") return seen.join(" > ");
      await page.waitForTimeout(400);
    }
    const st = await page.evaluate(() => window.__smoke.state());
    fail(`did not reach the water within 60s; actions ${seen.join(" > ")}; state ${JSON.stringify(st)}`);
  });

  await step("on the water", async () => {
    const s = await page.evaluate(() => {
      const g = window.__gw;
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem("gloomwater.save.v1"));
      } catch {}
      return {
        flow: g.flow,
        run: g.state.run
          ? { active: g.state.run.active, outing: g.state.run.outing, zone: g.state.run.zone }
          : null,
        savedWick: saved?.meta?.loop?.wick ?? null,
        started: window.__smoke.events.some((e) => e.name === "run:start"),
      };
    });
    if (s.flow !== "playing") fail(`flow is ${s.flow}, expected playing`);
    if (!s.run?.active || s.run.outing !== "trip") fail(`no active trip: ${JSON.stringify(s.run)}`);
    if (!s.started) fail('no "run:start" event was seen');
    if (s.savedWick !== CHARACTER.id) fail(`the save records Wick ${s.savedWick}, expected ${CHARACTER.id}`);
    return `trip on ${s.run.zone}, save has Wick ${s.savedWick}; ${await expectRendering(page, "on the water")}`;
  });

  await step("close the guide cards on the water", async () => {
    await waitFor(page, "the guide cards to close", 20_000, () => {
      window.__smoke.button("Got it")?.click();
      return !window.__smoke.state().blocking;
    });
  });

  await step("cast once with the mouse", async () => {
    const x = Math.round(VIEWPORT.width / 2);
    const y = Math.round(VIEWPORT.height * 0.7);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await waitFor(page, "the rod to start charging", 10_000, () => window.__gw.fishing.state === "charging");
    await page.waitForTimeout(1000);
    await page.mouse.up();
    await waitFor(
      page,
      "the float to land in the water",
      30_000,
      () =>
        window.__gw.fishing.state === "waiting" &&
        window.__smoke.events.some((e) => e.name === "fishing:cast"),
    );
    const states = await page.evaluate(() =>
      window.__smoke.events.filter((e) => e.name === "fishing:state").map((e) => e.state),
    );
    return `fishing states ${states.join(" > ")}`;
  });

  await step("one more second of play without errors", () => page.waitForTimeout(1000));

  await browser.close();
  const ext = [...new Set(externalRequests.map((u) => new URL(u).host))];
  log(`external requests stubbed: ${externalRequests.length}${ext.length ? ` (${ext.join(", ")})` : ""}`);
  console.log(`\nsmoke passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main()
  .then(() => {
    clearTimeout(budget);
    process.exit(0);
  })
  .catch(async (e) => {
    clearTimeout(budget);
    console.error(
      `\nsmoke FAILED at step "${currentStep}":\n${e instanceof SmokeFailure ? e.message : e.stack || e}`,
    );
    await browser?.close().catch(() => {});
    process.exit(1);
  });
