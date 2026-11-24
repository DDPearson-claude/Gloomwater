// Drives the built Gloomwater-Mossmere.html in headless Chromium (Playwright, software WebGL), for the
// scenario tests (tools/scenarios.mjs) and the save-fixture maker (tools/make-fixtures.mjs).
//
// One browser is shared; each GameSession is its own browser context, so it has its own localStorage.
// A session can start from a save (the exact string the game keeps under gloomwater.save.v1) and records
// every console error, uncaught page error, crash and new entry in the game's own error log
// (window.__gw.errors) in `session.errors`.
//
// Needs Playwright with Chromium (not a dependency of this repo; resolved like require("playwright"), so a
// global install on NODE_PATH works), the same as tools/smoke.mjs.

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_PAGE = join(ROOT, "Gloomwater-Mossmere.html");
export const SAVE_KEY = "gloomwater.save.v1";
// On a busy machine the game runs slowly and the fixed time limits fail tests that are only slow. Set GW_SLOW=2
// (or more) to stretch every time limit by that factor; it changes no check.
export const SLOW = Math.max(1, Number(process.env.GW_SLOW) || 1);
// The button of Murk's speech box while it is up ("Next" on each page, "Got it" on the last).
export const MURK_BOX_BUTTON = '.gw-modal.gw-in[data-modal="murktalk"] .gw-speech-ok';

// Small viewport: Chromium renders WebGL on the CPU here (SwiftShader), and every frame costs.
const VIEWPORT = { width: 480, height: 270 };

// Console errors that are expected and not a failure: one justified RegExp at a time. None today.
const ALLOWED_CONSOLE_ERRORS = [];

export async function launchBrowser() {
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)("playwright"));
  } catch {
    throw new Error(
      'Playwright is not available: require("playwright") failed. Install Playwright with Chromium.',
    );
  }
  return chromium.launch({
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
}

export class GameSession {
  // options: page: path to the built HTML; save: a save string, or null for a fresh profile; debug: add ?debug=1.
  // viewport: { width, height } in CSS pixels; smaller renders faster on the CPU. scale: the device pixel ratio.
  // init: scripts run in the page before the game, each a function or [function, argument].
  // gesture: false to reach the page without a user gesture. Playwright's page.evaluate counts as one, which
  // unlocks sound and full screen; a session that must see the page as a controller-only player does (no tap or
  // key yet) sends its calls through the DevTools protocol instead, and must not use page.click or keyboard.
  static async open(
    browser,
    {
      page = DEFAULT_PAGE,
      save = null,
      debug = false,
      viewport = VIEWPORT,
      scale = 1,
      init = [],
      gesture = true,
    } = {},
  ) {
    const session = new GameSession();
    session.context = await browser.newContext({ viewport, deviceScaleFactor: scale });
    for (const script of init)
      await (Array.isArray(script)
        ? session.context.addInitScript(script[0], script[1])
        : session.context.addInitScript(script));
    // Hermetic: the page's only outside requests are Google Fonts stylesheets; answer them with nothing.
    await session.context.route(
      (url) => url.protocol !== "file:",
      (route) => route.fulfill({ status: 200, contentType: "text/css", body: "" }),
    );
    if (save != null)
      await session.context.addInitScript(
        ([key, value]) => {
          // Only before the first load in this tab, so the game's own later writes are kept on a reload.
          if (sessionStorage.getItem("gw-driver-preloaded")) return;
          localStorage.setItem(key, value);
          sessionStorage.setItem("gw-driver-preloaded", "1");
        },
        [SAVE_KEY, save],
      );
    session.page = await session.context.newPage();
    if (!gesture) session.cdp = await session.context.newCDPSession(session.page);
    session.page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (ALLOWED_CONSOLE_ERRORS.some((re) => re.test(text))) return;
      session.errors.push(`console.error: ${text}`);
    });
    session.page.on("pageerror", (e) =>
      session.errors.push(`uncaught page error: ${e.stack || e.message || e}`),
    );
    session.page.on("crash", () => session.errors.push("the page crashed"));
    const url = pathToFileURL(resolve(page)).href + (debug ? "?debug=1" : "");
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 * SLOW });
    return session;
  }

  constructor() {
    this.errors = [];
    this.gameErrorsSeen = 0;
  }

  // Copies new entries of the game's own error log into `errors`.
  async collectGameErrors() {
    const list = await this.eval(() => window.__gw?.errors?.slice() ?? []).catch(() => []);
    for (const e of list.slice(this.gameErrorsSeen)) this.errors.push(`game error log: ${e}`);
    this.gameErrorsSeen = Math.max(this.gameErrorsSeen, list.length);
    return this.errors;
  }

  async eval(fn, arg) {
    if (!this.cdp) return this.page.evaluate(fn, arg);
    const r = await this.cdp.send("Runtime.evaluate", {
      expression: `(${fn})(...${JSON.stringify(arg === undefined ? [] : [arg])})`,
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "page error");
    return r.result.value;
  }

  async waitFor(what, timeoutMs, fn, arg) {
    timeoutMs *= SLOW;
    try {
      if (!this.cdp) await this.page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 250 });
      else
        for (const end = Date.now() + timeoutMs; !(await this.eval(fn, arg).catch(() => false)); ) {
          if (Date.now() > end) throw new Error("timed out");
          await this.pause(250);
        }
    } catch {
      throw new Error(
        `timed out after ${timeoutMs / 1000}s waiting for ${what}; ${JSON.stringify(await this.state())}`,
      );
    }
  }

  pause(ms) {
    return this.page.waitForTimeout(ms);
  }

  // A short summary of where the game is, for failure messages.
  state() {
    return this.eval(() => {
      const g = window.__gw;
      return {
        flow: g?.flow ?? null,
        fishing: g?.fishing?.state ?? null,
        blocking: g?.ui?.isBlocking?.() === true,
        zone: g?.state?.run?.zone ?? null,
        buttons: [...document.querySelectorAll("button")]
          .filter((b) => b.getBoundingClientRect().width > 0)
          .map((b) => b.textContent.trim().replace(/\s+/g, " "))
          .filter(Boolean),
        chart:
          [...document.querySelectorAll(".gw-chart-hit")].map((h) => h.dataset.id).join(" ") || undefined,
      };
    }).catch((e) => ({ error: String(e) }));
  }

  // Clicks the first visible button whose text (whitespace collapsed) matches; returns its text or null.
  // While Murk's speech box is up (over his tally or the jetty), a press meant to get past a box ("Got it" or
  // "Sold") presses the box's own button instead: "Next" on each page, "Got it" on the last.
  clickButton(re) {
    return this.eval(
      ([source, flags, murkButton]) => {
        const want = new RegExp(source, flags);
        const murk = document.querySelector(murkButton);
        if (murk && (want.test("Got it") || want.test("Sold"))) {
          murk.click();
          return murk.textContent.trim();
        }
        const b = [...document.querySelectorAll("button")].find(
          (el) =>
            el.getBoundingClientRect().width > 0 && want.test(el.textContent.trim().replace(/\s+/g, " ")),
        );
        if (!b) return null;
        b.click();
        return b.textContent.trim().replace(/\s+/g, " ");
      },
      [re.source, re.flags, MURK_BOX_BUTTON],
    );
  }

  // Waits for the title screen (after boot), then switches to low quality so software rendering keeps up
  // (the call the Settings menu makes; it is not saved). The wait is long because several sessions may be
  // booting on the same CPU at once.
  async boot() {
    await this.waitFor(
      'the title screen with "New Game" or "Continue"',
      180_000,
      () =>
        window.__gw?.flow === "title" &&
        [...document.querySelectorAll("button")].some((b) =>
          /^(New Game|Continue)$/.test(b.textContent.trim()),
        ),
    );
    await this.eval(() => window.__gw.render.setQuality("low"));
  }

  // Closes guide cards ("Got it") until nothing blocks play for about two seconds.
  async closeGuides(timeoutMs = 20_000) {
    const end = Date.now() + timeoutMs;
    let calm = 0;
    while (Date.now() < end && calm < 5) {
      const clicked = await this.clickButton(/^Got it$/);
      const blocking = await this.eval(() => window.__gw.ui.isBlocking?.() === true);
      calm = clicked || blocking ? 0 : calm + 1;
      await this.pause(400);
    }
  }

  // From the title (fresh or saved profile) or home, does what a player would on each screen until the
  // raft is on the water: New Game and a Wick on a fresh profile, Continue on a saved one, the intro
  // skipped, the tow tapped through, the guide cards closed, the chart opened and Sail.
  // With `water`, that water's row is picked on the chart before Sail (a tow follows if the barge is elsewhere).
  async sail({ wick = "Tallow", water = null, timeoutMs = 90_000 } = {}) {
    const end = Date.now() + timeoutMs * SLOW;
    const seen = [];
    let picked = !water;
    let chartWaits = 0;
    while (Date.now() < end) {
      const act = await this.eval(
        ([wickLabel, waterId, murkButton]) => {
          const button = (text) =>
            [...document.querySelectorAll("button")].find(
              (b) =>
                b.getBoundingClientRect().width > 0 && b.textContent.trim().replace(/\s+/g, " ") === text,
            );
          const g = window.__gw;
          if (g.flow === "playing") return "playing";
          const card = [...document.querySelectorAll(".gw-char")].find((c) =>
            c.textContent.trim().startsWith(wickLabel),
          );
          if (card && !card.classList.contains("gw-on")) return card.click(), "pick wick";
          if (card && button("Start")) return button("Start").click(), "start";
          if (g.flow === "title") {
            if (button("Continue")) return button("Continue").click(), "continue";
            if (button("New Game")) return button("New Game").click(), "new game";
            return "wait";
          }
          if (g.flow === "intro") {
            const skip = document.querySelector(".gw-intro-skip");
            return skip ? (skip.click(), "skip intro") : "wait";
          }
          const murk = document.querySelector(murkButton);
          if (murk) return murk.click(), "hear Murk";
          if (button("Got it")) return button("Got it").click(), "close guide";
          if (button("Sold")) return button("Sold").click(), "close tally";
          if (button("Tow")) return button("Tow").click(), "agree to the tow"; // the barge to another water
          if (document.querySelector(".gw-tow")) return document.querySelector(".gw-tow").click(), "tap tow";
          if (g.game?.towing?.() === "glide") return "key:Enter"; // the glide in is skipped from the keyboard
          // On the drawn chart each water is a hit area: "water:<id>" to pick it, "sheet:<id>" to turn to it.
          const hit = (kind) =>
            waterId && document.querySelector(`.gw-chart-hit[data-id="${kind}:${waterId}"]`);
          if (hit("water")) return hit("water").click(), `pick ${waterId} on the chart`;
          if (hit("sheet")) return hit("sheet").click(), `turn to ${waterId} on the chart`;
          if (waterId && document.querySelector(".gw-m-chart")) return "wait for the chart"; // until it is drawn
          if (button("Sail")) return button("Sail").click(), "sail";
          if (g.flow === "home" && !g.game?.towing?.() && !g.ui?.isBlocking?.() && button("Chart"))
            return button("Chart").click(), "open chart";
          return "wait";
        },
        [wick, picked ? null : water, MURK_BOX_BUTTON],
      );
      if (act.startsWith("pick ")) picked = true;
      if (act === "key:Enter") await this.page.keyboard.press("Enter");
      // A chart opened in the first moment of the home screen is sometimes drawn without its tap areas and
      // stays that way (a known timing fault in the game). After three seconds, close it; it is opened again.
      chartWaits = act === "wait for the chart" ? chartWaits + 1 : 0;
      if (chartWaits >= 8) {
        await this.page.keyboard.press("Escape");
        chartWaits = 0;
        if (seen[seen.length - 1] !== "reopen chart") seen.push("reopen chart");
      }
      if (!act.startsWith("wait") && seen[seen.length - 1] !== act) seen.push(act);
      if (act === "playing") {
        await this.closeGuides();
        await this.waitUntilFree();
        return seen.join(" > ");
      }
      await this.pause(400);
    }
    throw new Error(
      `did not reach the water; actions ${seen.join(" > ")}; ${JSON.stringify(await this.state())}`,
    );
  }

  // Waits until nothing holds the screen on the water (the mist-lift camera at a set-out, a landing show,
  // a card): the moment the game would let the player go home.
  async waitUntilFree(timeoutMs = 120_000) {
    const end = Date.now() + timeoutMs * SLOW;
    for (;;) {
      const why = await this.eval(() => window.__gw.game.canGoHome());
      if (why?.ok) return;
      if (Date.now() > end)
        throw new Error(
          `the screen stayed held (${JSON.stringify(why)}); ${JSON.stringify(await this.state())}`,
        );
      await this.closeGuides(2000);
      await this.pause(1000);
    }
  }

  // From the title, Continue to the barge at home, with any tally and guide cards closed.
  async toHome() {
    await this.clickButton(/^Continue$/);
    await this.waitFor("home", 60_000, () => window.__gw.flow === "home");
    const end = Date.now() + 30_000 * SLOW;
    let calm = 0;
    while (Date.now() < end && calm < 5) {
      const pressed = (await this.clickButton(/^Sold$/)) || (await this.clickButton(/^Got it$/));
      const blocking = await this.eval(() => window.__gw.ui.isBlocking?.() === true);
      calm = pressed || blocking ? 0 : calm + 1;
      await this.pause(600);
    }
  }

  // Lands a fish of the given species at once through the game's debug hook (needs debug: true), then
  // keeps it or lets it go on the catch card. Returns the card's button text.
  async catchFish(speciesId, { keep = true } = {}) {
    const ok = await this.eval((id) => window.__gw.debug.instantCatch(id), speciesId);
    if (!ok) throw new Error(`instantCatch(${speciesId}) refused; ${JSON.stringify(await this.state())}`);
    const end = Date.now() + 30_000 * SLOW;
    while (Date.now() < end) {
      await this.pause(400);
      if (await this.clickButton(/^Got it$/)) continue;
      const pressed = await this.clickButton(keep ? /^\d?Keep\b/ : /^\d?Let go\b/);
      if (pressed) {
        await this.pause(600);
        await this.closeGuides(8000);
        return pressed;
      }
    }
    throw new Error(`no catch card for ${speciesId}; ${JSON.stringify(await this.state())}`);
  }

  // Goes home from the water and closes Murk's tally once it has counted; returns the loop state summary.
  async goHomeAndTally() {
    // Home is refused while something holds the screen (a catch card, a guide card, the mist-lift camera).
    const homeBy = Date.now() + 60_000 * SLOW;
    while (!(await this.eval(() => window.__gw.game.goHome()))) {
      if (Date.now() > homeBy) {
        const why = await this.eval(() => window.__gw.game.canGoHome());
        throw new Error(
          `the game will not go home: ${JSON.stringify(why)}; ${JSON.stringify(await this.state())}`,
        );
      }
      await this.closeGuides(3000);
      await this.pause(1000);
    }
    const soldVisible = () =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Sold" && b.getBoundingClientRect().width > 0,
      );
    await this.waitFor("Murk's tally", 90_000, soldVisible);
    const end = Date.now() + 60_000 * SLOW;
    // The first press finishes the count, the next one closes the tally.
    while (Date.now() < end && (await this.eval(soldVisible))) {
      await this.clickButton(/^Sold$/);
      await this.pause(1500);
    }
    await this.closeGuides();
    return this.loopSummary();
  }

  loopSummary() {
    return this.eval(() => {
      const s = window.__gw.progression.loop.state();
      return {
        flow: window.__gw.flow,
        clams: s.clams,
        evenings: s.evenings,
        barge: s.barge?.water,
        lastTrip: s.lastTrip ? { total: s.lastTrip.total, seen: s.lastTrip.seen } : null,
      };
    });
  }

  // The save string as the game itself writes it (Ba.save, the routine the game calls at every checkpoint).
  async saved() {
    return this.eval((key) => {
      window.__gw.game.save();
      return localStorage.getItem(key);
    }, SAVE_KEY);
  }

  close() {
    return this.context.close();
  }
}
