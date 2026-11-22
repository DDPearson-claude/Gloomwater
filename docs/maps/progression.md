# Gloomwater map: progression (lakes, travel, the save)

Scope: the registry of waters, the gate and steps of the first tow, returning, per-lake versus global state, the save shape and migration, the outer frame (title, Wicks, evenings, trip, tally, shop, end state), legacy roguelite reachability, and debug/test hooks.

How to read the anchors. Every claim is anchored by a search string that exists in both `Gloomwater-Mossmere.html` and `reading/game.pretty.js`. `(L12345)` is the reading-copy line, for convenience only. Tags:

- **[read]**: read in the code.
- **[ran]**: confirmed in the running game with `smoke/main-fixed.html`, Playwright and Chromium (swiftshader), driving `window.__gw.progression.loop` directly. The scripts are `scratchpad/tmp-progression/probe.js` and `probe2.js`, with output in `probe.out` and `probe2.out`.
- **[inferred]**: my reading of intent or consequence. It was not executed.

Layers. **LOOP** is the current relaxed-fishing layer: the `wo` object (exported as `LOOP: () => wo`), the text table `Ca` (`TEXT_LOOP`), the loop API `CF(e)` and `meta.loop`. **Roguelite** is the older survival layer: `ZONES` (`Wr`), `meta` fields from `z5()`, run fields hp, oil and satiety, Gloomtide swarms, the Shrine and Trials.

---

## 1. How the current layer is switched on

| Fact | Anchor | Tag |
|---|---|---|
| The HTML has an inline script before the module: `globalThis.GW_V3=true;globalThis.GW_V3_PHASE=1;globalThis.GW_LOOP=true;globalThis.GW_LOOP_COST=2;` | search the HTML for `globalThis.GW_LOOP=true` | read |
| `Er = Su && globalThis.GW_LOOP === !0` is `LOOP_ENABLED`. At the bottom of the module `ms = Er === !0` is the loop-mode flag and `gs = cl && !ms && …` is the legacy hub mode. | `Er = Su && globalThis.GW_LOOP`, `ms = Er === !0` (L40589, L172992) | read |
| The `?loop=` URL parameter cannot turn the loop off in this build. `wQ` returns early when the preset `GW_LOOP` is a boolean (`if (e && typeof e.loop == "boolean") return { on: e.loop, source: "preset", apply: !1 }`). | `function wQ(` (L30101) | read |
| The price multiplier is `wo.cost.factor = SP()`. `SP` reads `globalThis.GW_LOOP_COST` first (2 here). The `?cost=` parameter and the default `VS = 2` are used only when `GW_LOOP_COST` is not set, so **every LOOP shop price is twice its data value**. `i8(e,t)` applies the factor. | `function SP(`, `var VS = 2`, `var i8 =` (L47188, L105130) | read, ran (`costFactor: 2`) |
| `h1` is exported as `PARKED`. When `Er` is on, it sets these roguelite features to `!0` (parked, meaning switched off): swarm, combat, levels, embers, hunger, oilAsLife, nightModes, death, days, farWater, liveWell, meta, tolls, longDescent, challenges, quality, mercy, passFavour, baitAttract, murkInLake, runShop, residents, weather, walking, giantSpots, watchLamps, arrivalHush, eatRender, bounties, firstCatchShells, proofs. | `h1 = Object.freeze(`, `PARKED: () => h1` (L40590) | read |

---

## 2. The registry of waters

There are **two registries**, one per layer.

### 2a. LOOP waters: `wo.waters` (current, live)

| id | Defined at | Record |
|---|---|---|
| `mossmere` | `waters: { mossmere: { order: 1, tier: 7, prices: { day: 60, old: 150, night: 260, crown: 500 } } }` inside `wo = {` (L46755) | `order`, `tier` (the value scale used by `$ee`), `prices` per place kind. It has **no** `lake` price, **no** `places` array and **no** `plainBait`. |
| `sporewood` | `wo.waters.sporewood = {` (L47876) | `order: 2, tier: 12, prices: { night: 1200, crown: 2200 }, lake: 1400, plainBait: "spore_cake", places: [{ id: "lullaby", kind: "day" }, { id: "gill_harp", kind: "old" }]` |

- `wo.shipped = "sporewood"` (L46756) caps what is playable. `iw(e,t)` admits a water only if its `order` is ≤ the shipped water's order. `MF(e,t)` is the same test, used for "shipped" (L104832, L105316). [read]
- `il(e)` (also `Pr(e)`) is "the home water": the `LOOP.waters` key with the lowest `order`, which is `"mossmere"` (L104840, L102802). Many rules special-case it. [read]
- **Playable now: Mossmere and Sporewood only.** `Object.keys(D.LOOP.waters)` returns `["mossmere","sporewood"]`. [ran]

A water is spread across many parallel tables keyed by water id. A third lake needs an entry in each. The first five rows are rules data; the last six are presentation.

| Table | Anchor | mossmere | sporewood |
|---|---|---|---|
| `wo.places` (place records, each with `water`, `kind` (day, old, night or crown), `price`, `card`, `giant`/`legend`/`own`, `draws` and `out` path; `lake: !0` means it is granted free with the chart) | `places: {` inside `wo`, `Object.assign(wo.places, {` | lily_maze 60 day, under_the_span 150 old (giant thousandcast_pike), buoy_lights 260 night (giant hullkiss_lamprey), bell_pool 500 crown (legend belled_matriarch), and `wo.places.veilback_brook` | lullaby 0 day `lake:!0`, gill_harp 0 old `lake:!0` (giant harpstring_eel), veilwater 1200 night (giant festival_puffer), mothers_cup 2200 crown (legend drifting_grove) |
| `wo.species[water]` | `species: {` and `wo.species.sporewood =` | 12 ids | 9 ids |
| `wo.gear[water]` (per-water rod, line and reel ladders, hold ladder and raft prices) | `wo.gear = {` (L48035) | tiers 0–2 from `Gc` at `wo.tackle.price`, which is `[0, 50, 300, …]` | stalkwood, rootthread, capwheel at 300; amberheart, mothsilk, burlwheel at 1400; bark_creel 300 and up |
| `wo.legendBait[water]` | `legendBait: { mossmere: { id: "heartmoss", price: 10 } }`, `wo.legendBait.sporewood = { id: "glowcap_bulb", price: 250 }` | heartmoss 10 | glowcap_bulb 250 |
| `wo.tins[water]` (plain bait sold in tins) | `wo.tins = {`, `wo.tins.sporewood =` | mireworm, lumen_moss | spore_cake, amber_larvae |
| `wo.start` / `wo.start[water]` (starter kit) | `wo.start = { lures: ["bent_spoon"], bait: { mireworm: 10 }, fit: "mireworm" }`, `wo.start.sporewood = {` | bent_spoon and 10 mireworm (top level, because Mossmere is the home water) | seedpod_twirl and 10 spore_cake |
| `wo.tow.legs[water]` and `wo.tow.glideIn[water]` | `legs: {` in `X2`, `wo.tow.legs.sporewood =` | `from: "landing"`, piece `sluiceRun`, crossings locks 0.3 and fall 0.78 | `from: "mossmere"`, piece `lockwaterA`, fall 0.24 and locks 0.51, `glideIn` astern |
| `wo.mooring[water]` | `mooring: {` (L46973), `wo.mooring.sporewood =` | yes | `hull: { x: 32, z: 25, yaw: 0.55 }`, and so on |
| `wo.tutorial.outPath`, `wo.camera`, `wo.wildlife`, `wo.ambient` | `wo.tutorial.outPath.sporewood`, `wo.camera = { sporewood:`, `wo.wildlife.sporewood`, `wo.ambient.sporewood` | yes | yes |
| Murk's lines for the water | `Ca.murk.at = { sporewood: { map, home, away } }`, `Ca.shelfAt` | none (the generic lines apply) | yes |
| Place geometry (name, x and z, water disc, landmark) | `_P = Object.freeze({ places:` (L47959) for Sporewood; `Mu.places` for Mossmere (read through `Q5`) | `Mu` | `_P` |

### 2b. Roguelite zones: `ZONES` (`Wr`) (legacy, partly reused)

`Wr = [` (L33369): `mossmere` index 0 "The Mossmere"; `sporewood` index 1 "Sporewood Pools"; `glasswater` index 2 "Glasswater Vault"; `paleabyss` index 3 "The Pallid Deep". These carry arena, layout and species data. [read, ran: `zones: mossmere:0, sporewood:1, glasswater:2, paleabyss:3`]

The LOOP layer still uses `ZONES` for two things:

1. **The ordering of "next lake".** `kF(e)` sorts `ZONES` by `index`. `s8()` and `Ghe()` take "the next water after the frontier" from that list (L105301, L105307, L161368).
2. **Display names.** `ZONE_BY_ID[...].name` supplies them.

### 2c. Is there a scaffold for a third lake?

**Partly. There is UI scaffold, but no LOOP data.**

- After Sporewood the "next" water is `glasswater` (from `ZONES` order). The Maps tab and chart then show a **sealed** chart, `lake:glasswater:null:sealed`, labelled `"Coming soon"` (`label: ie != null ? String(ie) : p.shipped === !0 ? p.waterId : "Coming soon"`, L153353; `comingSoon: "Coming soon"` in `Ca`). [read, ran]
- There is no `wo.waters.glasswater` and no entry for glasswater in places, gear, tow legs, mooring, start or legendBait. Glasswater and paleabyss have 33 and 26 roguelite `zone: "…"` references, but **0** `water: "glasswater"` or `water: "paleabyss"` references. [read: grep counts]
- The `O5` roster lists `{ name: "Glasswater Vault", existingLake: "glasswater" }` among its waters (`var O5 = {`, L30772). That is a data roster, not a playable registry. [read]
- **Inferred:** to ship a third lake you would add `wo.waters.<id>` with `order: 3`, raise `wo.shipped` to that id, and fill every table in §2a. Reusing the `glasswater` zone gets the `ZONES` ordering and the existing arena for free. A brand-new id would also need a `ZONES` entry, because `kF` and `Ghe` look up ordering only in `ZONES`.

---

## 3. The first tow to a new lake: gate, price and steps

### 3a. Obtaining the chart (map)

- The Maps tab of Murk's shelf lists at most two unowned, non-secret places of the **current barge water**, cheapest first (`.slice(0, 2)`). It then lists **one** lake chart, `{ id: "lake:<next>", waterId, sealed, price, seals }` (`function X3(`, L105367). [read]
- The chart's price is `waters[next].lake × cost.factor`, which is **1400 × 2 = 2800 clams** for Sporewood (`price: s && Number.isFinite(Number(r?.lake)) ? i8(t, Number(r.lake)) : null` in `function sw(`, L105335). [read, ran: `lake:sporewood:2800`]
- **Buying the chart has no gate other than clams.** The chart is `sealed` only when it is not shipped or is already held (`u = f.map.shipped && !f.map.held`, `sealed: !u`). `buy()` rejects only `sealed`, a null price or too few clams (`function xe(ze)`, L106169). [read, ran: buying with 5000 clams succeeded and left 2200]
- On purchase (`je.slot === "lake"`) the water id is pushed onto `maps.lakes`, and **every place with `water === id && lake === !0` is pushed onto `maps.places`** (Sporewood: `lullaby`, `gill_harp`). The `loop:buy` event fires. [read, ran: `places: ["lullaby","gill_harp"]`]
- After purchase the chart shows again as `lake:sporewood:null:sealed` until the water is open, because the frontier has not moved. [ran]

### 3b. What gates sailing there: the three "seals"

`isOpen(water)` is `Te(ze)` in the loop API (L105977). It requires `!!LOOP.waters[w] && iw(D,w) && maps.lakes.includes(w) && Zy(meta, D, w)`.

`function Zy(` (L105358):
- The home water is always open.
- Otherwise the water must be in `maps.lakes`.
- Then it is open if `barge.towed.includes(w)` (already towed once).
- **Otherwise both** `sw(...).gear.held` **and** `sw(...).catch.held` must be true.

`function sw(e, t, n = "sporewood")` (L105335) returns the three seals the chart draws (`["map", "gear", "catch"]` at L153301):

| Seal | Rule | Sporewood value |
|---|---|---|
| `map` | `held: maps.lakes.includes(n)`, `price` as above | 2800 |
| `gear` | `LOOP.access.gear[n]`, which is `"rod:1"` (`access: { gear: { sporewood: "rod:1" } }`, L46751). Held when `loop.tackle.rod >= 1`. | buy the first rod tier (100 clams in Mossmere) |
| `catch` | `Yy(meta, D, prevWater)`, meaning every species in `op(D, prev)` has `meta.journal[id].caught > 0` | **12 of 12** Mossmere species |

`op(e, t)` (L105273) builds the species list. It keeps species with `zone === t`, rarity not legendary or epic, not `giant`, not `cove`, in an "open/day/old" place, and with no special bait (`plainBaitOnly`). For Mossmere it returns: dusk_minnow, mossback_perch, gutter_crayfish, likely_chub, overbold_bass, rustfin_sucker, lampsipper, weeping_carp, candlefin_koi, milkeye_perch, kissmark_trout, reedjaw_pike. [ran: `listCount('mossmere') = {have:0, need:12}`; the 12 ids were recomputed in the page and match `wo.species.mossmere`]

[ran] On a fresh save, buying the chart left `isOpen('sporewood') === false`. After buying `rod:1` and marking those 12 species caught in `meta.journal`, `isOpen` became `true`.

**Where the gate is enforced.** The player's route is `sail` → `Ne(Ze)` in the home controller, which returns early when `N?.isOpen?.(xe) === !1` (`function Ne(Ze = {})`, L50981). `towTo` (`Ct`) checks **only** `maps.lakes`, so calling it directly through the API skips the gear and catch seals. [read] (Checked: `Ne` is the only isOpen check on the **tow** path, since `J` → `playTow`/`towBarge` is reached only after it. It is not the only place `isOpen` is consulted, though. The trip start `Ye` (`K = Te(ze) ? ze : Ee.maps.lakes.find((st) => Te(st)) || …`, L105986) also re-checks it and falls back to another open lake, and `s8`/`X3` (chart frontier) use `Zy`. `towBarge` (`Ft`, L106716) sets `barge.water` directly, with no check at all, for the home water, for already-towed waters and for any string that has no `LOOP.waters` entry. It also treats the `{ok:false}` object from `Ct` as truthy.)

**Handoff discrepancy.** The handoff's Sporewood section talks about the tow resetting gear and about clams. It never mentions that the crossing also needs rod tier 1 and a complete 12-species Mossmere list. The code enforces both.

### 3c. The steps of a first tow

1. **Set out.** At home the player picks a water on the chart (`chartPick {water, place}`) and sails. `Ne` → `J(Ze, xe, N)` (L50929). If the barge is elsewhere and the target is **not** in `barge.towed`, the leaving card is shown first.
2. **Leaving card.** `t.ui.loop.tow.leave({ water, terms: leaveTerms(water), onTow })`. `leaveTerms` is `UH(D, loop, water)` (L102940). It returns `{ to, from, first, add: WH(), carry, line: "Carried +r · +l · +c" }`. The card text is `Ca.leave`: `"To {water}"`, `"Bought tackle, raft parts and creels stay here."`, `"Your hands keep a third of it."`, `"Lures and bait wait here."`, `"Found things come with you."`, with the buttons `"Tow"` and `"Not yet"` (`Ca.leave = {`, L48174). If the card cannot show, the code falls back to `globalThis.confirm`. [read, ran: leaveTerms returned `add.rod: 1, cast: 1, line: "Carried +1 · +0 · +0"` after one rod tier]
3. **Tow animation.** `rt.playTow(water, { onDone })` runs the tow controller `uI(e)` (L56072). Phases: `leg` → `dip` → `dipHold` → `dipClear` → `glide` → `done`. Each phase change emits `loop:tow` with `{ phase, water, opening }` (`function w(C)`, L56153). The leg lasts `AP()` = `min(6, 4 + 0.5 × crossings)` seconds, or 1.5 when reduced motion is on. Then the dip is 0.6 and the glide is 3. At the start of `leg`, `T()` calls `towBarge(water)`.
4. **State change.** `towBarge` is `Ft` (L106716). For a not-yet-towed water it calls `towTo` (`Ct`, L106733). `Ct` returns `{ ok:false, reason:"map" }` when the water is not in `maps.lakes`. Otherwise it calls **`GH(D, loop, water)`**, sets `barge.water`, pushes onto `barge.towed`, saves, and emits `loop:tow { water, first: true, add }`.
5. **`GH`** (L102912) is the one-time crossing:
   - `carry += WH(loop)`.
   - `tackle = { rod: 0, line: 0, reel: 0 }`.
   - `fit` (found gear) is cleared except `lostTackle` ids.
   - `holdSlots = 3 + round(carry.slots)`.
   - `raft = { oars: 0, keel: 0, lantern: 0 }`.
   - **`gearWater = water`**.
   - Starter kit `ale(D, water)`: the `wo.start.sporewood` lures are added to the global `lures`, and its bait is added to `bait[water]`.
   - `fitted` is reset to the new kit unless the fitted lure is a `found` lure.
   - `eveningsAt[water] = 0`.
6. **`WH`** (L102878) computes the carryover. The share is `wo.carry.share = 1/3`, rounded **up** (`nle = ceil`):
   - Per slot, ceil(hold bonus of the bought tier × 1/3).
   - `cast` = ceil(rod cast bonus × 1/3).
   - `slots` = ceil(extra hold slots bought × 1/3).
   - Raft parts × 1/3, unrounded.
7. **Arrival grants** (`wo.start.sporewood = { lures: ["seedpod_twirl"], bait: { spore_cake: 10 }, fit: "spore_cake" }`). [ran: after the tow `lures: ["bent_spoon","glimmer_spoon","seedpod_twirl"]`, `bait.sporewood: {spore_cake:10}`, `fitted: {lure:null, bait:"spore_cake"}`]
8. **Early evenings handicap.** `wo.arrival = { evenings: 3, cap: "cap", fight: [-10, -6, -3] }`. For the first 3 evenings in a towed non-home water, `jH()` attaches `run.arrival = { k, cap, fight }` (L102963, used in `createTrip`). [read]

### 3d. The opening tow (first launch only)

- `towOpeningDue(loop, "mossmere")` is `rte` (L56163 region, defined at `function rte(`). It is true when the loop is on, `X2.opening === !0`, the tutorial is not done and `barge.towed` does not include `mossmere`. [read]
- The opening plays `L("mossmere", { opening: true })`. Phases: `dipIn` → `arrive` → `wake` (Murk says `Ca.murk.wake`: "Awake, little Wick? Good. Fish sell. Clams buy. That's the whole of it.") → `leg` → `dip` → `glide` → `done`. `T()` sets `chartPick = { water, place: null }` and calls `towBarge("mossmere")`, which pushes `mossmere` onto `towed` **without** running `GH`, because Mossmere is the home water. [read]
- The fresh state is `barge: { water: "mossmere", towed: [] }`. [ran]

---

## 4. Returning, and per-lake versus global state

- **Going back is allowed and cheap.** When the target is already in `barge.towed`, `J()` uses `rt.wayBack(water)` (a short `backDip`, `backHold`, `backClear` fade). `towBarge` then just sets `barge.water`, and `towTo` returns `first: false, add: null`. `GH` never runs again. [read, ran: `towTo('mossmere')` returned `{ok:true, first:false, add:null}`; towing to Sporewood again did not change `carry`]
- **Quirk found in the code and confirmed in the game: `gearWater` never returns to Mossmere.** During play only `GH` changes `gearWater` (L102924). It is also written by the fresh-state default `gearWater: il(e)` in `yF` (L104896) and by the load normaliser `c.gearWater = al(t, c)` in `a8` (L105001), but those only initialise it or re-validate it. Back in Mossmere, `al(D, loop)` still returns `"sporewood"`, so Murk's Tackle and Raft tabs sell **Sporewood** rods, lines and reels at 600 and Sporewood raft parts. The lures, tins, legend bait and places correctly follow the barge water. [ran: `shelfMossAgain` tackle = `rod:1:600, line:1:600, reel:1:600, lure:feather_fly:100 …`] The handoff does not mention this.
- A side effect of the stuck `gearWater` (inferred): `rivalGate` (Old Rivals) runs only when `al(...) === "mossmere"` (`const rivalKeys = al(n(), H) === "mossmere" ? rivalGate(o(), n()) : null`, L106182). After the first tow the rival purchase gate stops working, even in Mossmere.

| State | Scope | Anchor |
|---|---|---|
| `clams` (the purse) | **global**; it travels with the player | `clams: 0` in `yF`; `GH` does not touch it [ran: 2100 before and after the tow] |
| `tackle {rod, line, reel}` tiers | one global object, **reset to 0 on the first tow** into each new water | `GH` |
| `carry` (inherited passive bonus) | global; it accumulates once per first tow | `Dy()`, `lc()`, `WH` |
| `gearWater` (which gear catalogue the tiers refer to) | one global pointer; during play changed only by `GH` (also defaulted in `yF`, re-validated by `a8` via `al`) | `function al(` |
| `holdSlots`, `raft` | global; reset on the first tow | `GH` |
| `fit` / `found` (found gear) | global; `fit` is cleared on the first tow | `GH` |
| `lures` (owned lures) | global list, but a lure can be used only in its own water or when `found` (`$c(e,t,n)`, which checks `o.water === n`) | `function $c(` |
| `fitted {lure, bait}` | global | |
| `bait` | **per water**: `bait[waterId][baitId]` | `xF` writes `e.bait[n.zone]`; `createTrip` copies `bait[K]` |
| `eveningsAt` | **per water** | `eveningsAt[n.zone] + 1` in `xF` |
| `evenings` | global count of tallies | `xF` |
| `maps.lakes`, `maps.places`, `lifted`, `places.revealed` | global id lists. Place ids are unique per water. | `yF` |
| `legends`, `giants`, `prints`, `best`, `firsts` | global, keyed by species id | `yF`, `xF` |
| `home {orders, baitBed, wall, lights}`, `looks`, `orders`, `ledgerPaid` | global (the barge travels) | `yF` |
| `meta.journal` (caught counts) | global, keyed by species id, **outside** `meta.loop` (roguelite meta) | `journal: {}` in `z5()`; read by `Yy` |
| `meta.oldRivals` | Mossmere-only rival book, outside `meta.loop` | `meta.oldRivals || (meta.oldRivals = { landed: [] })` |

---

## 5. The save

### 5a. Storage and top-level shape

- The localStorage key is `mS = "gloomwater.save.v1"` (L29951). Writes go through `yS(e)`: `{ version: uQ /*1*/, savedAt: Date.now(), meta, run: run && run.active ? run : null }` (L30344). Reads use `R5()`. Defaults are filled by `wS(e)`: `meta = Object.assign(z5(), meta)`, and `run` is kept only if active. Erasing uses `u7()`. [read]
- `version` is written as 1 and **never compared**. Real versioning lives in `meta.loop.v`. [read]
- Saving: `Ba.save()` every 30 s of play (`PC > 30 && ((PC = 0), Ba.save())`), plus the loop API's `i()` (requestSave) and `c()` (game.save) on every mutation. [read]
- The fresh `meta`, after boot in loop mode, has these keys: memories, memoriesEarnedTotal, relics, journal, bestDay, deepestZone, runs, deaths, victory, victories, totalFish, totalSlain, bestLevel, tutorialDone, seenTips, challenges, challengeProgress, unlocks, lastCharacter, settings, v3ids, firstEvening, loop, guide. The first 20 come from `z5()`, the roguelite meta. [ran]

### 5b. `meta.loop` as created fresh: `function yF(e)` (L104861)

[ran: identical to a fresh `loop.state()`]

```
{ v: 4, clams: 0, evenings: 0, holdSlots: 3,
  tackle: {rod:0,line:0,reel:0}, lures: ["bent_spoon"], fitted: {lure:null, bait:"mireworm"},
  bait: {mossmere: {mireworm:10}}, maps: {lakes:["mossmere"], places:[]},
  raft: {oars:0,keel:0,lantern:0}, home: {orders:0,baitBed:0,wall:0,lights:0},
  looks: [], orders: [], legends: {}, giants: {}, prints: {}, ledgerPaid: [], said: {},
  lastTrip: null, wick: null, tutorial: null, firsts: {seen:[],seals:[],best:{}},
  finds: {got:{},worn:{},share:{},tackleMiss:{}}, found: {rod:null,line:null,reel:null},
  places: {revealed:[]}, lifted: [], best: {}, chartPick: null,
  barge: {water:"mossmere", towed:[]}, sheetSeen: ["lure:bent_spoon"], startKit: true,
  carry: {rod:0,line:0,reel:0,cast:0,slots:0,raft:{oars:0,keel:0,lantern:0}},
  gearWater: "mossmere", fit: {rod:null,line:null,reel:null}, eveningsAt: {mossmere:0} }
```

Later keys appear at run time, including `parkedRun`, `legendWounds`, `marked` and `chartPick`.

### 5c. Migration

The pipeline at boot:
1. `Db = R5()`.
2. `migrateSave` is `c8(e, t)` (L107115). It runs the V3 renames once (`Dle(meta)`, then `meta.v3ids = true`), then `Wle(run)` and `u8(meta)` (firstEvening), then **`a8(meta, D, { hasTrip })`**.
3. `a8` runs again lazily on every loop API access, through `p()` (`function p()` in `CF`, L105672).

The stranded-trip seller `sellStrandedTrip` (`vF`) is skipped in loop mode (`let e = ms ? null : uj(Ky, "sellStrandedTrip")`). [read]

`function a8(` (L104901). The loop version is `Z3 = 4` (L104744). When `loop.v < 4`:
- Flat `bait` becomes per-water under the home water.
- `hold` becomes `holdSlots`.
- `raft.hull` is refunded from `pF = [100, 600, 8e3]` and deleted.
- An array `maps` becomes `{ lakes, places }`, and day/old places of owned lakes are granted.
- If v < 4 and there is no `barge`: `barge = { water: home, towed: [home] }`.
- Then `v = 4`.

On every load:
- **Each top-level key missing from `yF()` is filled with its default.** A key whose type is wrong (an object or array expected) is replaced.
- The nested keys of `tackle`, `fitted`, `maps`, `raft`, `home`, `firsts` and `barge` are default-filled.
- The start kit is granted if `startKit !== true`.
- `barge.water` and `towed` are validated against `LOOP.waters`. Unknown waters are dropped.
- Clamps are applied, `carry = lc()` is normalised and `gearWater = al()` is set.
- `eveningsAt` is created if missing.
- Lost-tackle lures are restored.
- The tutorial is marked done when `evenings > 0`.

**Consequence for a new `hunt` record [inferred, from the generic fill loop]:** adding `hunt: {}` (for example `hunt: { mossmere: {...} }`) to `yF()` makes old saves pick it up automatically. Nested defaults are filled only for the listed seven keys, so per-lake sub-records need their own normaliser inside `a8`, or a bump to `Z3 = 5`. Any lake id stored in the record should be validated the way `barge.towed` is. A hunt record has to coexist with:
- `legends{}` (landed-legend counts, incremented in `xF` on sale);
- `giants{speciesId: {landed, marked}}`;
- `meta.legendWounds`;
- `maps.places` and `lifted` (owned and revealed places);
- `firsts.seals`;
- `meta.journal`;
- `meta.oldRivals`.

---

## 6. The outer frame the player sees

### 6a. The title

The loop branch is `if (B())` in the title builder (`B = () => d().LOOP_ENABLED === !0`, L165773). It removes the tagline, premise and meta lines.
- **Fresh save** (`loopFresh()` = `JP(meta, hasSavedRun)`: no `loop.wick`, no `tutorial` and `evenings == 0`): buttons **"New Game"** and **"Settings"** (`function OV(`, L161468).
- **Otherwise:** **"Continue"** (continues the saved trip, or goes `toHome`) and "Settings", plus "Prologue" when an intro replay is offered.
- In loop mode **there is no New Game on a used save**. The only restart is Settings → Erase everything (`Ca.forget.row: "This erases your clams, gear and Journal for good."`) → `Ba.wipeAll()` (L168882, L173328).
- The legacy branch below it (Continue, New Descent, Journal, Shrine, Trials) does not run in loop mode. [read, ran: flow `title`, `fresh: true`]

### 6b. Character select

"New Descent" calls `Ae()`, and `if (B()) return Me()` (L165887). `Me()` (L166105) opens the `newdescent` modal with five Wick cards from `MC(D)` (`LOOP.wicks.order = ["wick","taper","stub","tallow","ashwick"]`) plus "Back" and "Start". Start calls `game.beginIntro({ character })`, which leads to `setWick` and then the intro or the opening tow. The Wick is fixed per save: the only other `setWick` callers are intro cancel (`setWick(null)`) and debug.

| Wick | Passive name | Rule | Data |
|---|---|---|---|
| wick | Curious | "New kinds and new bests sell higher." | firstMult 1.4 |
| taper | Long Reach | "Evenings start with a rarer fish." | firstBites 1 |
| stub | Moth-Bright | "Fish bite sooner and keep biting." | waitMul 0.78 |
| tallow | Broad Back | "One more slot in the hold." | slots 1 |
| ashwick | Burns Back | "A fish that gets away comes back." | hold 4 |

Anchors: `wicks: {` in `wo`, `Ca.passives`, `Ca.wicks`. [read]

### 6c. Evenings and the trip

- A trip ("evening") is a run with `outing: "trip"`, created by `createTrip` (`function Ye({ startZone`, L105986). It still carries roguelite fields (`hp: 5, oil: 100, satiety: 100, phase: "calm"`, bounties, xp, `flags.nightLog` and more), which are inert because those systems are parked. It also has `evening: loop.evenings + 1`, `bait: {...loop.bait[zone]}`, `lure`/`equippedBait`, and `arrival` when `jH` applies. [read]
- **Light phases** reuse the roguelite phase names. `calm` (day) lasts `wo.evening.day = 40`, `dusk` lasts `20`, and `gloomtide` (night) has `night: null`, so it lasts **∞** (`if (Ie === "gloomtide") return ze.night == null ? 1 / 0 : …`, L112398 region). The evening ends only when the player goes Home. The unit is presumably game seconds [inferred]. `nightMode: "still"` means no swarm.
- **Flow:** title → home (the barge at the mooring: Murk, Chart / Map Table "Plan", Journal, The Long Wall, Raft "Board"; `Ca.jetty`) → set out (`Ne`; a tow first if the water differs) → `flow "playing"` on the lake → **Home** (`goHome` → `endTrip`). The creel is limited by `holdSlots` ("Hold's full.").
- `endTrip` (`function ee()`, L106096) sells the creel through `xF` (clams, `evenings + 1`, `legends` and `giants` counts, bait written back per water, `eveningsAt + 1`), writes `lastTrip { id, evening, zone, total, lines, seen:false }` and emits **`loop:tally`**. The tally card is labelled `"Sold"` (`Ca.sold`). Murk's line after a tally is chosen by `Xhe()` (L161628) from `listComplete` ("Every fish in this water. I'll write that down."), `legendFirst` ("Her. You brought me her…"), `firstGiant`, `at:<water>:home` and others. Each line is said once (`said{}`).
- **The shop** is Murk's shelf `shelf()` = `ow(...)`, with tabs `tackle, raft, bait, maps, home`. `buy(id)` emits **`loop:buy`**. The cheapest next thing is shown as `"Next: {name} · {price}"` (`goal()` = `Rle`, which prefers `line:1`). [ran: fresh shelf = tackle `rod:1:100, line:1:100, reel:1:100, lure:feather_fly:100, glimmer_spoon:180, bone_jig:220, bell_spinner:360`; raft `hold:4:400, oars:1:120, keel:1:200, lantern:1:200`; bait `heartmoss:20, tin:mireworm:20, tin:lumen_moss:20`; maps `place:lily_maze:120, place:under_the_span:300, lake:sporewood:2800`; home `baitBed:1:240, wall:1:500, lights:1:400, looks 600/800/1200, orders:1:140`]

### 6d. End of game or win state

**Not found in the LOOP layer.**
- `Ba.victory()` begins `if (ms) return;` (L173280).
- The legacy win fired `bus.emit("victory")` on landing a species with `final: !0`. The only such species is `pale_leviathan` "The Pale Leviathan", zone `paleabyss` (L34663, L110158). That zone is not a LOOP water.
- After Sporewood the frontier simply shows the sealed "Coming soon" chart.

I searched for `victory`, `final: !0`, `credits`, `"The End"`, `gameComplete` and `listComplete`. `listComplete` is only a Murk line.

---

## 7. What of the roguelite layer is still live

| Legacy item | Status in current play | Anchor |
|---|---|---|
| `glasswater`, `paleabyss` zones | **Dead data** for play. They show only as the sealed "Coming soon" chart (glasswater) and in the `ZONES` ordering. | `Wr = [`, `Ghe(` |
| `ZONES` mossmere and sporewood | **Live**: the LOOP reuses the arenas, names and index order | `kF`, `ZONE_BY_ID` |
| Gloomtide | The **name is live** as the night phase id (`hours.night: ["gloomtide"]`, `giantBack.phases: ["gloomtide"]`). The swarm and combat are parked. | `hours: {` in `wo`, `PARKED` |
| oil, food (satiety), hp, death, days, levels, bounties, tolls and gates (`gateOpen`), challenges and Trials, Shrine and Memories | Fields still exist on run and meta, but the systems are **parked** (`PARKED.tolls`, `PARKED.combat` and so on). Not reachable from the loop UI. | `h1`, L110591–L110706, L122772 |
| "New Descent" | **Live as a label only**: the loop title button and `Ca.newDescent`. It opens the loop Wick picker, not the legacy descent modal. | `function Me()` |
| Waystones (52 references) | Not reached by the loop flow. I did not trace every reference. [inferred from the parked flags] | grep `waystone` |
| Legacy hub (`gs` mode, the "cove", First Evening) | Off: `gs = cl && !ms && …` is false when `ms` is true. `meta.firstEvening` is still created at boot. | L172994 |
| Legacy victory | Dead (`if (ms) return`) | `victory() {` |

---

## 8. Debug and test hooks

| Hook | What it does | Anchor | Tag |
|---|---|---|---|
| `window.__gw` (= `$t`) | Always exposed. Keys include `bus`, `state` (`meta`, `run`), `data` (all tables, `LOOP`, `ZONES`, `SPECIES`), `flow`, `game` (`Ba`), `progression` (`.loop` is the full loop API), `world`, `fishing`, `ui`, `debug`, `errors`. | `window.__gw = $t` (L173122) | ran |
| `__gw.progression.loop` | `state, shelf, buy, goal, isOpen, listCount, seals, mapCards, leaveTerms, towTo, towBarge, barge, carried, createTrip, endTrip, lastTrip, fit, spendBait, keep, letGo, prints, catalogue, tutorial…, debugGive` and more. Usable **without** debug mode. | the returned object near `isOpen: Te,` (L106940) | ran |
| `__gw.game` (`Ba`) | `startNewRun, beginIntro, sail, canGoHome, goHome, toHome, atHome, loopFresh, playTow, towing, save, wipeAll, continueRun, endRun` and more | `$t.game = Ba`, `Object.assign(Ba, {` | ran |
| Debug mode | Turned on by `?debug=1`, `globalThis.GW_DEBUG === true` or `localStorage["gw.debug"] === "1"` (`function bu(`). Without it, the `r7` list of fish debug keys is deleted from `__gw.debug`. | `var r7 = Object.freeze([`, `if (cl && !kp) for (let e of r7) delete $t.debug[e]` | read |
| `__gw.debug.loop` (debug only) | `state, giveClams(n), bites, home(), sail(water), tutorial('done'/'reset'/step), wick(id), tow('tap'/'cut'/state), homeState, own(placeId/'all'), lift(...), giveBait(id, n, {fit}), at(placeId) (teleport), places, chart` | `$t.debug.loop = {` (L174285) | ran (keys listed) |
| `__gw.debug.freshSave()` | Calls `Ba.wipeAll()` | `freshSave()` | read |
| Other debug | `__gw.debug` has about 80 or more entries: `forceBite`, `instantCatch`, `landFish`, `giveFish`, `odds`, `migrate`, `unlockZone` and others (many from the roguelite layer) | | ran |
| `GW_REDRESS` | `wo.redress = Er && GW_REDRESS !== false` (Mossmere visual redress). `?redress=0/1` sets it. | `function bQ(`, `redress: Er && globalThis.GW_REDRESS` | read |
| `GW_WILD` | Wildlife and ambient boats on unless `GW_WILD === false` or `?wild=0` | `wildlife: { on: Er && globalThis.GW_WILD` | read |
| `GW_LOOP_COST`, `?cost=` | Price factor (fixed at 2 by the inline script) | `function SP(` | read |
| `GW_V3`, `GW_V3_PHASE`, `GW_LOOP` | Layer switches (set inline); `?v3=`, `?v3phase=`; `localStorage["gloomwater.loop"]` is ignored while a preset exists | `function pQ(`, `function yQ(` | read |
| `GW_INTRO`, `?intro=1` | Intro opt-in under debug | `debugOptIn: ["GW_INTRO", "?intro=1"` | read |
| Bus events | `loop:tow {phase, water, opening}` from the tow controller; `loop:tow {water, first, add}` from `towTo`; `loop:buy`; `loop:tally`; `run:start`; `run:end`; `zone:change`; `home:enter`; `fish:landed`; `fish:escaped` | `__gw.bus.on(...)` | read |

**Simulation entry points for automated tests** [ran]: the whole progression state machine can be driven headless through `__gw.progression.loop` without rendering trips: set `state().clams`, `buy(id)`, write `__gw.state.meta.journal[id].caught`, then `isOpen(water)`, `leaveTerms(water)`, `towTo(water)`, `shelf()` and `mapCards()`. `createTrip` and `endTrip` need a run in `__gw.state.run` with `outing: "trip"` (not exercised here). The known load error "[world] places failed ReferenceError: tt is not defined" did not appear with `main-fixed.html`, and both probes logged no page errors.

---

## Hook points for the hunt loop

1. **The lake gate: `Zy()` and `sw()`.** A water opens when the chart is held AND (it has been towed OR every seal holds). Add a seal such as `monster: { held: loop.hunt[prev]?.landed === true }` to `sw()`'s return value. Then require it in `Zy()`, replacing or joining `gear` and `catch`. The chart UI already draws one seal per key, iterating over `["map","gear","catch"]` (L153301); extend that list.
2. **The seal data: `wo.access.gear` (`{ sporewood: "rod:1" }`) and `op()`/`Yy()` (the species list).** These are the data-driven pattern for "what the previous lake demands". A `wo.access.monster = { sporewood: "belled_matriarch" }` table fits beside them.
3. **The frontier: `s8()`/`Ghe()`.** These compute the next lake from `ZONES` index order and Zy-open lakes. If landing the monster is what opens the next lake, the chart purchase could also be gated in `X3`/`sw` (today `sealed` depends only on shipped and held).
4. **Landing detection.** `xF()` already increments `loop.legends[speciesId]` on sale, and the `legendFirst` tally line exists. `fish:landed` on the bus fires at catch time (L110403). Either can set `hunt[lake].landed`.
5. **The save: `yF()` plus `a8()`.** Add `hunt: {}` to the factory and the generic default-fill migrates old saves. Bump `Z3` to 5 if old saves that already landed a legend need back-filling from `legends{}`.
6. **Places as investigation targets.** `wo.places[*]` already has `card` (its signature fish), `kind` (day, old, night or crown, with `hours` derived through `TF`), `legend`/`giant`, `draws` and the purchase and lift (mist reveal) pipeline (`maps.places`, `lifted`, `liftDue`, `markLifted`). Lake-granted places (`lake: !0`) show how to hand out a place for free.
7. **Arrival grants and handicap: `wo.start[water]` and `wo.arrival`.** These are the existing per-lake one-time kit and the early-evenings modifier.
8. **Murk's lines.** `Ca.murk.at[water] = { map, home, away }` with `said{}` once-only keys (`at:<water>:<key>`) is a ready channel for clue delivery. `Xhe()` picks the post-tally line.
9. **Tow events.** `loop:tow` with `first: true` and the `leaveTerms` card are where to announce the next target.
10. **Test harness.** `__gw.progression.loop` and `__gw.debug.loop` (with `?debug=1`) drive state without a renderer.

## Gaps

- **No monster record.** There is nothing per lake for "the target fish", "clues found", "known haunt, feeding time, bait or rig", or "hooked or landed the target". `legends{}` is only a sale counter keyed by species. I searched `yF` and `a8`, and grepped `hunt`, `target`, `clue` and `monster` in the loop data. Found only the giant `marked` flags, `firsts.seals` and journal entries.
- **No "landing X opens the next lake" rule.** Today the gate is chart (2800) + rod tier 1 + a complete 12-species list. Legends play no part in it.
- **No third playable lake.** Glasswater has `ZONES` data but no `wo.waters`, places, gear, mooring, tow leg, start kit or legend bait. `wo.shipped` must also be raised.
- **No end or win state** in the loop layer (`Ba.victory` returns early in loop mode).
- **`gearWater` is a single pointer that never returns home.** Murk sells the last-crossed lake's gear in every lake. Per-lake tackle state (the handoff's "local economy" proposal) does not exist. Tiers are one global object that is reset at each first crossing.
- **No restart other than a full erase.** The loop title offers no New Descent on a used save, and the Wick cannot be changed.
- **A lure in the global `lures` list is unusable outside its water** (`$c`), and nothing explains this beyond the leave card line "Lures and bait wait here."
- **`towTo` does not check `isOpen`.** On the tow path only `sail`/`Ne` enforces the seals (trip start `Ye` and the chart frontier also consult `isOpen`/`Zy`, but they do not stop a direct `towTo`). A new gate should live in `Zy` so that both routes respect it, or `Ct` should also check it.

## Checked

Sceptical re-check against `game.pretty.js` (verdict, then corrections where needed).

1. **Two LOOP waters; `shipped` caps via `iw`/`MF`; no glasswater/paleabyss `wo.waters` entry.** Confirmed. `waters: { mossmere: {...} }` (L46755), `wo.waters.sporewood = {` (L47876), `shipped: "sporewood"` (L46756), `function iw(` (L104832), `function MF(` (L105316). 0 hits for `water: "glasswater"` / `water: "paleabyss"`; a runtime probe gives `Object.keys(LOOP.waters) = [mossmere, sporewood]`.
2. **Chart 2800 = 1400 x factor 2; buy checks sealed/price/clams; pushes lake and grants lake:!0 places.** Confirmed. Note: `buy` (`function xe(ze)`, L106170 region) also requires the card to be offered by `ow()` and not already bought, and the `lake:` card is only offered for the `s8` frontier's next water (`X3`). `i8` applies the factor (L105130); the inline `GW_LOOP_COST=2` is in the HTML's first script.
3. **isOpen = waters && iw && lakes && Zy; Zy home/towed else gear+catch; 12 Mossmere ids.** Confirmed (`function Te(ze)`, L105977; `function Zy(`, L105358). Precision: `sw` takes the catch list from the previous water in `ZONES` index order (`kF`), which is Mossmere for Sporewood; `towed` short-circuits only after the `maps.lakes` check.
4. **towTo checks only maps.lakes; seals enforced only in Ne.** Refuted in part. `Ct` indeed checks only `maps.lakes` (L106739), and `Ne` (L50985) is the only isOpen check on the tow path. But `isOpen` is also enforced at trip start (`Ye`, L105986: falls back to another open lake), and `towBarge` (`Ft`, L106716) sets `barge.water` with no check for home, towed or unknown waters. Corrected in 3b and Gaps.
5. **GH details.** Confirmed with precision already in 3c: `fit` is cleared except `lostTackle` ids; raft carry is an unrounded third (only tackle/cast/slots are ceil'd, `nle`, L102801); `fitted` is reset to `{lure:null, bait:"spore_cake"}` only when the fitted lure is not a `found` lure. clams untouched. (`function GH(`, L102912; `wo.start.sporewood`, L48092.)
6. **gearWater written only by GH; Murk sells Sporewood tiers back home.** Refuted in wording, conclusion stands. Also written by `yF` default (L104896) and `a8` normaliser `c.gearWater = al(t, c)` (L105001); during play only `GH` changes it, and `GH` runs only on a first tow (`Ee` in `Ct`). Browser probe output (`shelfMossAgain`) confirms rod/line/reel:1 at 600 in Mossmere. Corrected in section 4.
7. **Save key and versioning.** Confirmed. `mS = "gloomwater.save.v1"` (L29951), `yS` writes `{version: uQ(=1), savedAt, meta, run-if-active}` (L30345); `R5` reads `version` but nothing tests it. `Z3 = 4` (L104744). `a8` fills missing top-level keys from `yF` and also replaces keys whose type mismatches (object/array); nested fill only for tackle, fitted, maps, raft, home, firsts, barge.
8. **No loop win/end state; title Continue vs New Descent; only reset is wipeAll.** Confirmed. `victory() { if (ms) return;` (L173280, `ms = Er === !0`, `Er = Su && GW_LOOP`); only `final: !0` is `pale_leviathan` (L34663, zone paleabyss). `OV` (L161468). `wipeAll` (L173328) is reached from Settings forget (L168882) and the debug `freshSave` (L174237).
