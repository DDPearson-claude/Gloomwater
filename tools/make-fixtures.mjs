#!/usr/bin/env node
// Makes the save fixtures in tools/fixtures/ by playing the built game in headless Chromium and taking
// the save the game itself writes (localStorage gloomwater.save.v1). Nothing in a fixture is written by
// hand: every change comes from the game's own hooks (window.__gw, with ?debug=1 for instantCatch and
// giveClams), the same calls the game's debug panel makes.
//
// Each fixture after the first starts from an earlier one, so they read as one player's story:
//   fresh-first-evening -> mid-mossmere -> legend-sold
//                                       -> sporewood-crossed
//
// The committed fixtures were made from the build before the legend was renamed (commit 3bacf14), so they
// stand for existing players' saves. Re-making them overwrites them; normally there is no need to.
//
// Usage: node tools/make-fixtures.mjs [--page path/to/page.html] [--only name] [--out dir]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PAGE, GameSession, ROOT, launchBrowser } from "./game-driver.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const PAGE = option("--page", DEFAULT_PAGE);
const ONLY = option("--only", null);
const OUT = option("--out", join(ROOT, "tools", "fixtures"));

const t0 = Date.now();
const log = (msg) => console.log(`[fixtures ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${msg}`);

const loop = (session, fn, arg) => session.eval(fn, arg);
const buy = (session, id) =>
  loop(
    session,
    (shelfId) => {
      const result = window.__gw.progression.loop.buy(shelfId);
      return JSON.stringify(result);
    },
    id,
  );
const giveClams = (session, n) => loop(session, (amount) => window.__gw.debug.loop.giveClams(amount), n);

// One evening on the water: sail, land these fish (keeping the first `keep` of them), go home, tally.
async function evening(session, catches, { keep = 4, before = null, water = null } = {}) {
  log(`  sail: ${await session.sail({ water })}`);
  if (before) await before();
  for (const [i, id] of catches.entries()) log(`  ${id}: ${await session.catchFish(id, { keep: i < keep })}`);
  const summary = await session.goHomeAndTally();
  log(`  home: ${JSON.stringify(summary)}`);
  return summary;
}

const FIXTURES = [
  {
    name: "fresh-first-evening",
    from: null,
    async play(session) {
      // New Descent as Tallow, the opening tow, then the first evening: two fish kept and sold.
      await evening(session, ["dusk_minnow", "mossback_perch"]);
    },
  },
  {
    name: "mid-mossmere",
    from: "fresh-first-evening",
    async play(session) {
      await evening(session, ["likely_chub", "weeping_carp", "reedjaw_pike", "overbold_bass"]);
      await evening(session, ["milkeye_perch", "kissmark_trout", "rustfin_sucker", "reedjaw_pike"]);
      const { clams } = await session.loopSummary();
      if (clams < 160) await giveClams(session, 160 - clams);
      for (const id of ["place:lily_maze", "bait:heartmoss", "tin:lumen_moss"])
        log(`  buy ${id}: ${await buy(session, id)}`);
      // The Lily Maze lifts out of the mist at this set-out.
      await evening(session, ["candlefin_koi", "dusk_minnow"], {
        before: () => session.eval(() => window.__gw.debug.loop.at("lily_maze")),
      });
    },
  },
  {
    name: "legend-sold",
    from: "mid-mossmere",
    async play(session) {
      await giveClams(session, 2000);
      for (const id of ["place:under_the_span", "place:buoy_lights", "place:bell_pool"])
        log(`  buy ${id}: ${await buy(session, id)}`);
      // At the Bell Pool with the Heartmoss Ball on, the legend is landed, kept and sold at the tally.
      await evening(session, ["belled_matriarch"], {
        before: async () => {
          await session.eval(() => window.__gw.debug.loop.at("bell_pool"));
          await session.eval(() => window.__gw.progression.loop.fit("bait", "heartmoss"));
        },
      });
    },
  },
  {
    name: "sporewood-crossed",
    from: "mid-mossmere",
    async play(session) {
      // The rest of Mossmere's list (let go), then the rod and the chart, then the crossing.
      await evening(session, ["gutter_crayfish", "lampsipper", "likely_chub", "dusk_minnow"], { keep: 2 });
      await giveClams(session, 3000);
      for (const id of ["rod:1", "lake:sporewood"]) log(`  buy ${id}: ${await buy(session, id)}`);
      await evening(session, ["netcloud_fry", "falsesmile_barb"], {
        water: "sporewood",
        before: async () => {
          const zone = await session.eval(() => window.__gw.state.run?.zone);
          if (zone !== "sporewood") throw new Error(`the trip is on ${zone}, not sporewood`);
        },
      });
    },
  },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  try {
    for (const fixture of FIXTURES) {
      if (ONLY && fixture.name !== ONLY) continue;
      log(`${fixture.name}${fixture.from ? ` (from ${fixture.from})` : ""}`);
      const save = fixture.from ? readFileSync(join(OUT, `${fixture.from}.json`), "utf8") : null;
      const session = await GameSession.open(browser, { page: PAGE, save, debug: true });
      try {
        await session.boot();
        await fixture.play(session);
        await session.collectGameErrors();
        if (session.errors.length) throw new Error(`errors while playing:\n  ${session.errors.join("\n  ")}`);
        writeFileSync(join(OUT, `${fixture.name}.json`), await session.saved());
        log(`  wrote ${fixture.name}.json`);
      } finally {
        await session.close();
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(`\nfixtures FAILED: ${e.stack || e}`);
  process.exit(1);
});
