# Conditions map: what the engine can already detect about a cast

Area key: `conditions`. Scope: every signal the current build can test on a cast, from the moment the float or lure lands to the landing roll. Written for the River Monsters redesign, where each lake has one target monster that the player must locate, time, rig and present for.

## How to use this file

- **Anchors.** Every claim carries a search anchor that works in both `/home/user/Gloomwater/Gloomwater-Mossmere.html` and the reading copy `reading/game.pretty.js`. The anchor is a function name, a property name or a string literal. `L12345` is the reading-copy line, given as a convenience only.
- **Layers.** Each item is tagged **[loop]** (the current relaxed-fishing layer: `LOOP`, `wo.`, `meta.loop`, run `outing: "trip"`), **[legacy]** (the survival roguelite: zones glasswater/paleabyss, oil, Gloomtide threat, "New Descent" runs), or **[shared]** (code used by both). Each item also says whether it is **live** in current play.
- **Evidence.** "read" means read in code. "dumped" means read from `window.__gw.data` in a Chromium run of `smoke/main-fixed.html` (scripts in `tmp-conditions/`). "inferred" means a reasoned conclusion that was not executed. I never drove a full trip in the browser: the probe reached the title screen only (`state.run` stayed empty), so no claim here rests on observed play.
- **Gate.** In the fishing controller, `xe()` means "LOOP_ENABLED and run.outing === 'trip'" (`xe = () => X && h()?.outing === "trip"`, L127865). `ge()` adds "this lake has a hook table" (`ge = () => xe() && !!Re()`, L127966). `pe()` means the autofish/strike-gauge model is on. `Nr()` means signs/tells are on: `Nr = () => Lc() && xe() && !!bs?.[Yt()]?.tells` (L133345). Both Mossmere and Sporewood satisfy all four in a loop trip (read; `bs.sporewood.tells =` L32150).

---

## 1. The bite pipeline, in order

### 1.0 Cast and landing of the float or lure [shared, live]

| Step | Function / anchor | Takes | Produces |
|---|---|---|---|
| Aim meter | `function sq(` (L134289) | time since anchoring, raft speed | `i.charge` is a triangle wave with period `cast.period` (default 1.6 s). It is held at 0 while raft speed ≥ `maxRaftSpeed` (default 2), shown as "anchoring". Distance is `max(minDist 3, charge × castMax)`. `castMax` is a rod stat. The Lamplighter's Pole gives `castMax: 26`. |
| Release | `function H(R, I` (L128783) | distance, charge | `i.castDist`. `i.clean = charge >= cleanAt` (default 0.92, `yt(`). Bait is consumed here: `i.castBait` (the legend bait counts only if it is in stock), `i.castLoadout = nn()`, `i.castItem`. |
| Splashdown | `function Ee()` (L128978) | bob x,z | `i.cast = Ht(x, z, depth)`. It holds `place`, `area`, `mist`, `waterKey`, `giant`, `phase`, `baitId`, `clean`, `lure`, `condition`, `rumour`. `i.depth = ye(x,z)` is the world depth, 0 to 1. The sign/sight hit is `i.signHit = $j(x,z)`. Then `prepareRivalVisit()`, then either `zt()` (float) or `i.retrieve = { next: 1 }` (spinning). |

### 1.1 Presentation classification [loop, live]

- **Spinning** happens when `Nr() && k() && !i.castBait`: a lure is fitted and no bait went out. Code: `Nr() && k() && !i.castBait ? (... i.retrieve = { next: 1 })` (L129121). There is no species until a contact roll succeeds.
- **Bait (float)** covers every other case, including a **lure tipped with bait**. `zt()` picks the species at splashdown and schedules nibbles. A tipped lure still grades by the *lure*, because `Rl` checks the lure key first: `t && t !== "bare" && hasOwn(a, t) ? a[t] : a[R7(a, n)]` (`function Rl(`, L32451). For the landing roll, `getLoadout` puts the lure in `item` and the bait in `upgrade` (`Be.item ? (Be.upgrade = { id: Je, level: 1 }) : (Be.item = Je)`, L108249). `GP` takes the larger of the two hold bonuses.
- **Bare hook**: no lure and no bait. The table key is `"bare"`. The wait is ×2.5 and favour is −0.5: `wo.bare = { waitMult: 2.5, favour: -0.5 }` (L47220).
- **Legend bait** (Heartmoss, Glowcap Bulb) is passed to the ordinary pool as `null`, so other fish see a bare hook: `bait: oe(I) ? null : (I ?? null)` in `function Ce(` (L129262). `oe` tests `BAITS[].legend`.

### 1.2 Species pool: `placePool` = `function ute(` (L47686) [loop, live]

`ute(species, { placeId, phase, bait, wickId, water })` returns `{ list: [[sp, w]], giant: {sp, share, weight}|null, tot, place }`.

- It keeps species with `zone === water`, excludes `rarity === "legendary"`, and excludes `cove`.
- **Hard bait gate**: `if ((v.bait && v.bait !== o) ...) continue`. A species with a required bait never enters the pool without that bait. Live required baits (dumped): `threadling_eel: "spore_cake"`, `gloam_eel: "lumen_moss"`, `sleepspore_jelly: "amber_larvae"`. The two legends also carry baits but are excluded here.
- **Place resolution**: `d = c && !(c.kind === "night" && i !== "night") ? {...} : null`. A night place cast outside night counts as open water.
- **Hours filter**: `if (!ek(v).includes(i)) continue`, where `i` is the light (`YS`: calm/dawn/day → "day", dusk → "dusk", gloomtide/night → "night", L47659). There is a fallback: if the total weight is under 70 (`U7.common`), off-hour open-water fish are added at plain rarity weight. Every lake has an `"any"` common (dusk_minnow, netcloud_fry), so the fallback should never fire in open water (inferred).
- **Weights**: open fish use the rarity weight `U7 = { common: 70, uncommon: 24, rare: 6 }` (L37351). That weight is multiplied by `place.draws[id]` or `dayDraw 1.5`, and by `common 0.5` inside any place. Kind-matched fish use ×`kindWeight 2.5`. `own`/`place` fish use `6 × kept.weight 3 × kept.live 0.5`. `bestNight` fish get ×1.5 at night. A species whose `bait` equals the cast bait gets ×1.5.
- **Giants**: one giant per place, added only when cast in its own place. Share comes from `RP(`: `wo.giant.share = { inHour: 0.06, offHour: 0.025 }`, so giants appear off-hours at a lower share. Taper multiplies by `giantShare 1.3`, capped at `giantCap 0.12`.

### 1.3 Interest and presentation matching: `l1` → `G5` [loop, live]

`function l1(entries, { area, place, phase, lure, bait, hook, boost, water })` (L32480) returns `[{ sp, w, g }]`.
- **Area weight.** Outside a named place, `w *= ES(id, area, phase, water)`, which is `factors[light][sp] (or tilt) × raw[sp][area]`, with night overrides from `QQ`. Inside a place, only the phase tilt applies, via `C7`. Species missing from the `raw` table get 1 everywhere.
- **Presentation grade.** `g = Rl(id, { lure, bait, water })`, an integer 0 to 3. Then `w *= hook.mult[g]` with `mult: [0, 0.5, 1.6, 2.5]` (L31759). Grade 0 means zero weight, so the fish never bites.

`function G5(data, { pool, area, phase, lure, bait, wickId, rb, rule, taperFirst, preroll, comeback, notes, water })` (L32583) returns `{ entries: [{sp, p, from: "pool"|"preroll"|"comeback", g, giant?, guest?}], S, taper, waited }`. In order:
1. `I7(notes)`: owned notebooks add per-species `boost` multipliers and **guest** species gated by area and light (§6).
2. `rb` (rarity bonus) multiplies uncommon weights by `1 + 2·rb` and rare by `1 + 4·rb`. Sources are the rarityBonus stat, `cleanRarity 0.05` for a clean cast, and bait bonus (`zt`, L129368).
3. `rule` (a sign the cast landed in): its `makers` get ×`tilt` (3), or families get `predators`/`bottom` multipliers. This applies only if the result still passes `signRule { minSpecies: 2, maxShare: 0.8 }`.
4. Taper's first bite (`long_reach`) zeroes commons (`T7`).
5. `P7` adds the place giant (×`lure.share 1.5` when the fitted lure lists that giant in `wo.lures[x].giants`) and guests (×`tee = [0, 0.25, 1, 1.5]` by grade). It caps grade-0 rows at `hook.cap 0.01 × Σ`.
6. A `comeback` (Ashwick passive, or an Old Rival) returns probability 1 if its grade is above 0 and its bait matches.
7. A `preroll` (the fish attached to a sign or a sighted shadow) gets `p = _7(base, g)`: grade 0 gives `take.stray = 0`, grade 1 gives base, grade 2 gives `min(0.9, base + 0.1)`, grade 3 gives `min(0.9, base + 0.2)` (`function _7(`, L32456). Base by sign: `take: { rise: 1, swirl: 0.6, sight: 0.45, stray: 0 }` (L31763).

`AS(odds, u)` draws one entry. `N7(odds, u1, u2, strike, water)` draws one entry and keeps it only if `u2 < _7(strike, g)`. That is the per-contact spinner roll.

### 1.4 Float path: `function zt(nextFish` (L129342) [shared; loop branch live]

1. **Legend check.** All of these must hold: cast bait === the lake legend's `bait`; `C(species, phase)`; `i.clock >= i.legendDimUntil` (set to clock + `legend.rebiteDelay 20` s after a legend escape, L130733); in loop, `$(bn)`, meaning the cast's place has `LOOP.places[id].legend === species` and no mist. Then `i.legendCast = rollLegendBite(D(bait), lt)`, where `function rollLegendBite(` (L104008) returns `chance >= 1 || rng() < chance` and `chance = bait.legendBiteChance ?? 1`. Heartmoss has `legendBiteChance: 0.12` (L34817). Glowcap Bulb has no field, so its chance is 1 (inferred from `?? 1`).
2. Otherwise the species comes from `ke(...) → st(...) → Ce(...) → G5`, with sign `rule`, `preroll` and `comeback`.
3. **Snag.** `N()?.snagRoll({ legendCast:false, tutorial, rng })` = `function ct(` (L106806) can replace the fish with a find. The rate is `wo.finds.snag = { perBite: 0.05, firstEvening: 0, legendCast: 0 }` (dumped). It has no positional input.
4. `chooseRivalBite(ordinary)` (L128950) can swap in the active Old Rival (§7).
5. **Wait time.** `(waitBase 3 + Exp(mean 5.5)) / biteSpeed`, then × clean cast 0.85 × pity × Stub `waitMul 0.78` × quiet-water `waitMult` × bare 2.5 × loadout `waitMult` (Ferrywife's Thread 0.8). The result is clamped to [2, 25] s. A legend cast takes ×0.7, a sign rule `waitMult` 0.65, a sight take `takeWaitMult` 0.3, and a spook `waitMult 1.5`.
6. **Nibbles.** Drawn from `nibbles [0.2, 0.35, 0.3, 0.15]` (the count is 0 to 3, plus one for non-commons outside autofish). Bait casts get at least 2 bumps (`baitBumps`). A `feint` appears with chance 0.3 in zones with index ≥ 2, which never happens in Mossmere (index 0) (inferred). A `tell` replaces the last nibble when `nibbleTells ≥ 1` (a rod or bait stat).
7. **Size** is rolled lazily by `Ft()` (§1.6) at the tell (`on()`) or at strike.

### 1.5 Spinner path: `function lq(` (L134360) [loop, live]

- The lure moves straight at the raft at `LOOP.lureCast.pace = 1.2` units/s (code default 2.5) until it is within `inAt 2.4`. Then `pR()` reels in empty.
- Every 1 s (`Q.next += 1`) the code refreshes `i.cast.area = q(bob.x, bob.z)`, so **the area is re-evaluated along the retrieve path**. It then rebuilds odds with `Ce(...)` and rolls `N7(odds, u, u, lureCast.strike = 0.05, water)`. Per-second contact chance is therefore 0.05 for a grade-1 fish, 0.15 for grade 2 and 0.25 for grade 3, weighted by species choice.
- Extra contact path (checked): if `N7` returns nothing while an Old Rival is active and visiting (`e.state.meta.oldRivals.active`, `i.rivalVisit === target.id`), `lq` forces contact with the rival's entry whenever its `p > 0`. That is every 1 s tick, with no `_7` strike roll.
- On contact: `i.forceSpecies = sp`, `zt(!!Q.checkedSnag)` (snag only on the first contact), then `Ft()`, then `fishBacksOff()` (a refused fish keeps the lure winding), then `rollHardTake(true)`, then `Ut()` (the strike window opens with tell `"tug"`).

### 1.6 Size roll: `function Ft(` (L128427) [shared; loop live]

- Legendary species skip `ep`, the gear cap and `overCap` entirely: `z` is a plain `J1(0, …)` roll or `forceZ` (checked, L128434).
- Favour `mu = Le(cast, species).mu` (§1.9). The cap is `ep({ species, place, giantWater, size, loop })` (L103789). In loop, the cap is `min(z.max 3.6, classMaxZ[species.maxClass] or reachZ)` but **at most `elsewhereMaxZ = 2.64` (the top of trophy) unless the cast is in a place of `kind === "old"` or is the giant's own place.** So Elder size is possible only Under the Span, at the Gill Harp, at the Buoy Lights or Veilwater for their giants, and in similar places.
- `z = J1(mu, rng, { min, max: 3.6, sd: 1, cap })`, a truncated normal (`function J1(`, L103776). `BALANCE_V3.size.z = { sd: 1, min: -2, max: 3.6 }` (dumped). A comeback, preroll or rival uses its stored `z`.
- Class thresholds come from `size.classMaxZ = { keeper: 1.039, prize: 1.879, trophy: 2.64, elder: 3.6 }` (dumped). `ancient` is an elder with `isAncient(z)` (`size.ancient 3.2`).
- **Gear cap** `vn = Tt(species)` = `Bd(...)` (§2.3). On the first evening, in the tutorial, or with `run.arrival.cap === true`, z is clamped to the cap (no oversize fish exist). Otherwise `i.overCap = { by, cls, z, key, rig }` when `z > cap.z`.

### 1.7 Oversize back-off and hard takes [loop, live]

- `function passesOversizeFish(cap, random)` (L129706) returns `random() >= (cap.by === "line" ? 0.2 : 0.1)`, where true means the fish backs off. So 20% of line-limited fish and 10% of item- or grade-limited fish still commit.
- `function fishBacksOff()` (L129710) applies only with `ge()`, no find, no tutorial, no legend cast, no rival fight and no comeback. It is called in `on(natural)` (float, at the tell) and in `lq` (spinner contact). After a back-off the bait stays out and `zt(true)` re-rolls the next fish with no snag.
- `function rollHardTake(spinning)` (L129693) needs `xe() && pe()`, no find, no tutorial, an incomplete lesson ruled out, and `castBait || castItem || spinning`. It returns `rng < LOOP.hardTake.chance × (spinning ? spinMultiplier : 1)`. With `hardTake: { chance: 0.16, spinMultiplier: 1.75 }` (L46714) that gives 0.16 for bait and 0.28 for spinning. A hard take calls `Nn("struck", null, true)`, so the strike grade is fixed at `struck`.
- A fish that commits while still over the cap has `i.p = 0` in `Nn` (`i.overCap && (i.p = 0)`, L130217). The fish is certain to be lost as `"snapped"` (line) or `"thrown"`, and `gearEscapeAdvice(` (L32898) builds a shopping hint.

### 1.8 Strike window and grades [shared autofish model, live]

- `function Ut()` (L129599) opens the window. `window = AUTOFISH.strike.window[class] × rod hookWindow stat × (1 + bait hookWindow bonus) × place.hookWindowMult + place.hookWindowAdd`, clamped to [0.35, 1.4]. Per class: `window = { small: 0.6, keeper: 0.7, prize: 0.8, trophy: 0.85, elder: 0.9, ancient: 0.9, legend: 1 }` (dumped). A legend gets +`windowBonus 0.1` per prior wound. No live place sets `hookWindowMult`/`hookWindowAdd` (the dumped place keys contain neither).
- The clean notch spans `notch.at 0.22` to `+ notch.width 0.2` of the window.
- `function ot(` (L130048) grades the press:
  - Pressed during `waiting`, within `earlyGrace 0.3` s or the tell animation before the bite: grade **early**.
  - Pressed during `waiting` before that: **spooked**. `an()` emits `fishing:miss {reason:"spooked"}` and reels in after `spookReelIn 1.5`.
  - Pressed during `bite`: before 0 is **early**; inside the notch is **clean**; up to `window` is **struck**; after that is **late**.
  - No press by `window + lateGrace 0.3` ends as `fishing:miss {reason:"passed"}` with a bait refund. This is "let it pass" (`dq(`, L134537). It leaves `bite.letItPass = { favour: 0.15, cap: 0.3, resetAfter: 60, sameWater: { place: true, radius: 6 } }` for the next cast in the same water (L129109).
- `CATCH_V3.strike = { clean: 8, struck: 2, early: 0, late: 0 }` hold points (dumped).

### 1.9 Favour: biases the size roll, not bite odds [shared; loop subset live]

`function Le(` / `Pt(` / `ht(` (L128216 to L128355). `mu = min(favour.cap 1.8, Σ terms)`. The loop terms (`At = xe()`) are:

| Term | Value | Anchor |
|---|---|---|
| Inside a named place | `LOOP.place.favour.base 0.15 + window[kind]` (day 0.4, old 0.4, night 0.3, crown 0.2) | `family: "place"` |
| Phase dusk / dawn / gloomtide | +0.2 / +0.2 / +0.25 (`hour.nightRise`) | `id: "nightRise"` |
| Bait favour | `favour.tackle.bait`: mireworm 0.3, lumen_moss 0.3, spore_cake 0.3, amber_larvae 0.3 | `family: "tackle", id: R.baitId` |
| Lure favour (lures without a family only) | `tackle.lure[id]` | `bn && !bn.family` |
| Clean cast | +0.1 | `cleanCast` |
| Sign hit | `signs[kind]`: strike 0.6, nervous 0.3, bubbles 0.2 | `family: "signs"` |
| Bare hook | −0.5 | `LOOP.bare.favour` |
| Quiet water / let-go mercy | per water key (§7) | `family: "quiet"`, `"letGo"` |
| Wick terms | `N3(` | |
| Per species: depth in the lower third of `species.depth` | +0.25. Roster species have `depth: [0, 1]`, so this means **cast depth ≥ 0.667** | `depthLowerThird` |
| Per species: cut_strip on a predator | +0.3 | `cutStrip` |
| Per species: lure family equals fish family | `tackle.lure[id]` (glimmer_spoon 0.2, bone_jig 0.2, ...) | `Dt.family === R.family` |
| Per species: giant | +`LOOP.giant.favour 0.3` | `id: "giant"` |
| Per species: `R.prefers === cast.condition` | +0.3. **Dead**: `getCondition` has no provider in the bundle, so the condition is always null | `match.condition` |
| Per species: rumour | +0.3. **Dead**: `getTodaysRumour` has no provider | `match.rumour` |

### 1.10 Fight and landing [loop, live]

- `function Nn(grade, input, hardTake)` (L130155) calls `catchChance` = `q2` = `GP(species, sizeClass, loadout, { lake, strike, buffs, marked, wounds, landings, night, perRun })`.
- `function GP(` (L49041) returns `{ p, hold, fight, cap, lake, style, terms }`. It computes `p = max(floor 0.01, cap[class] / (1 + exp(-scale 0.1 × (hold − fight))))`.
  - `hold = wick 10 + rod·em.rod + line·em.line + reel·em.reel + max(item, upgrade hold) + strike + buffs + marked 6 + legend wounds`.
  - `fight = lake[water] (mossmere 0, sporewood 7) + style[style] + headline 2 + kept −2 (if sp.place) + class[cls] + lakeFightProfiles.get(id).pressure`.
  - A legend instead uses `legend.fight[id]` (belled_matriarch 16, drifting_grove 28) + `min(10, 2·landings)` with `cap.legend 0.5`.
  - Caps by class: `{ small: .95, keeper: .95, prize: .93, trophy: .88, elder: .84, ancient: .78, legend: .5 }`. Class term: `{ small: -10, keeper: -6, prize: 7, trophy: 15, elder: 18, ancient: 22 }`.
- Item hold comes from `function p1(` (L48940): `CATCH_V3.items[id]` grants `hold` if the fish is in `species[]`, or `family` matches, or `night` (night fish only), or `all`. Examples: `bell_spinner hold 10` for thousandcast_pike, hullkiss_lamprey and reedjaw_pike; `bent_spoon hold 3` for mossback_perch and overbold_bass; `cut_strip hold 4`.
- `previewGearLimits` (L49079) is used only by the journal preview. It zeroes `p` when `Bd` says the class exceeds the cap.
- Arrival penalty: `wo.arrival = { evenings: 3, cap: "cap", fight: [-10, -6, -3] }` is subtracted from `hold − fight` on the first evenings in a new lake (`ro = Bt(h()?.arrival?.fight, 0)`, L130204).
- **The outcome is decided at the strike**: `i.outcome = find || u < p ? "land" : "lose"` (L130221). The fight is an animation planned by `EB(` with `lakeFightProfiles` (L48988; durations and loads only). Player input during the fight does not change the outcome (read). Hurry (`i.hurry`) shortens small-fish fights (inferred cosmetic). Rowing away during `reeling` cuts the line: `Ti("moved")` → `Xa("slack", { cut: !0 })`.

---

## 2. The rig model [loop, live]

### 2.1 Slots

`getLoadout` = `function S()` in the loop module (L108204) returns `{ rod, line, reel, hold: {rod, line, reel}, item, upgrade, itemLevel, perRun, found?, playMult?, waitMult?, lineCap? }`.

| Slot | Values | What the engine reads |
|---|---|---|
| rod | tier index (`TACKLE.rod[]`; `wo.tackle.price [0, 50, 300, 1200, 6000, 32000, 100000]`). Recovered: `lamp_pole { castMax: 26, hookWindow: 1 }` | hold (×emphasis), `castMax`, `hookWindow` |
| line | tier index; `lineHold`; recovered `ferry_thread { waitMult: 0.8, hold: 2, cap: "trophy" }` | hold, **size cap** (§2.3), wait time |
| reel | tier index; recovered `belfry_winch { playMult: 0.6, hold: 2 }` | hold, fight duration |
| lure (`run.lure` / `fitted.lure`) | Mossmere: bent_spoon (start), feather_fly, glimmer_spoon, bone_jig, bell_spinner, guard_button (found). Sporewood: seedpod_twirl (start), spore_moth, ember_minnow, root_jig, sporelamp_fly. `guard_button` exists in both tables. (`wo.lures`, dumped) | grade key, spinning vs float, giant share, item hold, item cap |
| bait (`equippedBait`, consumed per cast) | Mossmere tins `["mireworm", "lumen_moss"]`, Sporewood `["spore_cake", "amber_larvae"]`, `cut_strip` (made from small fish: `wo.cut = { strips: 3, classes: ["small", "keeper"], hold: 0.6 }`), legend baits `heartmoss` and `glowcap_bulb` | grade key, hard bait gate, favour, item hold, legend trigger |
| hook | **no slot.** "bare" is the absence of lure and bait (`R7(` returns "bare") | grade key "bare" |
| float | **no slot.** It is the visual for a bait presentation (`O(!0, ..., "floating")`). The orange halo is hidden when a lure is fitted | cosmetic |
| notebook | `lostTackle.veil_notebook`, `lily_notebook` (owned, not fitted) | species boosts and guests (§6) |
| raft | `wo.raft.oars` speed, `keel { favour: 0.1 }`, `lantern { favour: 0.1, light: 0.15 }` | favour terms via `N3(` (inferred; not traced), sight lantern radius |

### 2.2 The presentation table (the per-fish rig preference)

`bs.<lake>.hook.table[speciesId][itemKey] ∈ {null, 0, 1, 2, 3}` (L31590 to L31608, L31995 to L32018).
- Mossmere keys, in order: `["bare", "mireworm", "lumen_moss", "cut_strip", "feather_fly", "glimmer_spoon", "bone_jig", "bell_spinner", "bent_spoon", "guard_button"]` (`Ph`, L31561).
- Sporewood keys: `["bare", "spore_cake", "amber_larvae", "cut_strip", "spore_moth", "ember_minnow", "root_jig", "sporelamp_fly", "seedpod_twirl", "guard_button"]` (`TS`). Sporewood `guard_button` is 2 for every fish except harpstring_eel, festival_puffer, threadling_eel and sleepspore_jelly, which get 0 (`kS`).
- Examples: `thousandcast_pike: [0,0,0,0,0,2,2,3,0,0]` (only glimmer_spoon, bone_jig and bell_spinner). `gloam_eel: [null,0,3,0,...]` (lumen_moss only). `hullkiss_lamprey: [0,0,0,0,0,1,0,3,0,0]`. `belled_matriarch` and `drifting_grove` are all null.
- One grade feeds four places: bite weight `mult [0, 0.5, 1.6, 2.5]`, the sign/sight take chance `_7`, the size cap `gearCap.grade [null, "keeper", "prize", "elder"]` (grade 0 maps to "keeper"), and guest weight `tee [0, 0.25, 1, 1.5]`. (Checked: `Rl` reads `hook.table[id]` and falls back to `hook.guests[id]` (`z7`, L32043). `mult` applies to ordinary pool rows in `l1`. The place giant in `P7` is scaled by `mult` only when its grade is 0 or 1 (`v <= 1 && (b *= d.mult[v])`, L32533 region), so grades 2 and 3 do not boost a giant. Guests use `tee` instead of `mult`. The grade cap is only one of the three `Bd` limits (item, line, grade). The tightest one wins.)

### 2.3 Size caps: `function Bd(data, species, { lure, bait, line, lineCap, lineHold, water })` (L32962)

Bd returns `{ cls, z, by: "item"|"line"|"grade" }`, the tightest of three limits:
- `item`: `gearCap.item = { bare: "keeper", bent_spoon: "keeper", cut_strip: "prize", seedpod_twirl: "keeper" }`.
- `line`: an explicit `lineCap` (Ferrywife's Thread gives "trophy"), else `lineHold` against `gearCap.lineAt = { mossmere: { trophy: 2, elder: 5 }, sporewood: { trophy: 4, elder: 7 } }` (below trophy → "prize", below elder → "trophy", otherwise "elder"), else `gearCap.line[tier] = ["prize", "trophy", "elder"]`.
- `grade`: from §2.2.

`z` is `classMaxZ[cls]`, or `size.z.max` (3.6) for elder. The same function feeds the oversize back-off, `gearEscapeAdvice`, `rivalPurchases`, `previewGearLimits` and the journal "Lands up to {class}" text (`Ca.gate`).

### 2.4 Retrieve styles [loop, cosmetic]

`const retrieveStyles = {` (L90077) defines motion and wake for 13 lures. Its only references are in the water-lure visuals (`makeWaterLures`, L90391 to L90607) and render (L101744). It never reaches `lq`. The retrieve is always straight, at constant pace (read). The handoff states this correctly.

### 2.5 What a fish record can express about the rig today

| Preference | Where | Live? |
|---|---|---|
| Grade 0 to 3 per bait, lure and bare hook | `hook.table` / `hook.guests` | yes |
| Must-have bait (hard gate) | `species.bait` | yes (3 fish) |
| Bait weight bonus ×1.5 when cast | `species.bait === cast bait` in `ute` | yes |
| Hold bonus from a specific item, family, night or all | `CATCH_V3.items[*].species/family/night/all` | yes |
| Size cap per item | `gearCap.item` | yes (4 items) |
| A giant prefers a lure (share ×1.5) | `wo.lures[id].giants`, `share` | yes (bell_spinner, sporelamp_fly) |
| Family match favour (size) | `species.family` against `lure.family` | yes |
| Retrieve speed, depth of retrieve, twitch, pause | none | **not found** |
| Line or rod as a bite condition (rather than a landing or cap condition) | none | **not found** |

---

## 3. Time and light

### 3.1 Phases of an outing

| Phase id (run.phase) | Light (`YS` / `id(`) | Loop trip duration | Legacy duration | Anchor |
|---|---|---|---|---|
| `calm` (shown as day) | day | **40 s** (`wo.evening.day`) | `EXPEDITION.phases.calm` / `calmByMode` | `function Y(Ie, et, kt)` L112394 |
| `dusk` | dusk | **20 s** (`wo.evening.dusk`) | `phases.dusk` | same |
| `gloomtide` (night) | night | **infinite** (`night: null`), lasts until the player goes home. Darkness ramps over `nightLook: 90` s | grows per day: `min(max 120, base + growth 6 × (day − 1))` | `N()` L112545 |
| `dawn` | day | not reached in a trip, because night never ends (inferred) | legacy only | `Jy = ["calm", "dusk", "gloomtide", "dawn"]` L112205 |

- `run.phaseTime += dt` in `function St(Ie, et)` (L113341). I did not verify whether dt pauses during menus or fights. A legendary fight at night clamps the phase so it cannot end mid-fight (`function Lt(`, L113320).
- A new trip always starts at `phase: "calm", phaseTime: 0` (`createTrip` = `function Ye(`, L105999).
- Night mode for trips is `"still"`, so the legacy Gloomtide threat is off.

### 3.2 Fish time fields

- **Roster (`SPECIES_V3`)**: `hours` is a string, normalised by `AQ(` into a key of `L5 = { any: [day, dusk, night], day: [day, dusk], dusk: [dusk, night], night: [night], "day,dusk", "dusk,night" }` (L30622). `"any, best at night"` becomes `any` with `bestNight: true` (×1.5 weight at night). **Quirk: `day` hours include dusk, and `dusk` hours include night.**
- **Legacy**: `time` is one of `any`, `calm`, `gloom`, `dawn`, mapped by `dte = { calm: [day, dusk], gloom: [night], dawn: [day] }` (L47674).
- In the controller, `C(sp, phase)` (L127802) uses `LOOP.hours` for roster keys, else `he(` (calm means not gloomtide; gloom means gloomtide).
- Live values (dumped):

| Hours | Fish |
|---|---|
| `any` | dusk_minnow, mossback_perch, gutter_crayfish, rustfin_sucker, weeping_carp, kissmark_trout, reedjaw_pike, bridgechain_sturgeon, netcloud_fry, capshell_crayfish, threadling_eel, cindertail_catfish, velvet_ray, harpstring_eel (bestNight) |
| `day,dusk` | likely_chub, overbold_bass, falsesmile_barb, lostsea_mackerel, downcast_catfish, drifting_grove |
| `calm` | candlefin_koi, sleepspore_jelly, belled_matriarch |
| `gloom` | lampsipper, mildew_angler, gloam_eel |
| `dusk,night` | milkeye_perch |
| `dusk` | thousandcast_pike |
| `night` | hullkiss_lamprey, festival_puffer, nightbloom_carp |

- Phase also tilts weights per species and area: `bs.<lake>.factors[light][sp]` overrides `tilts[sp][light]`, and Mossmere has `night` overrides (for example `milkeye_perch { margin: 2.5, deep: 1 }`). Place-kind gating by light: a `kind: "night"` place outside night is treated as open water (`Nt(`, L128158; and `ute`). `giantBack { every: [25, 45], dur: 3, phases: ["gloomtide"], places: ["under_the_span", "buoy_lights"] }` is a night-only giant sighting cue (consumer not traced).

### 3.3 Weather, moon, season

- `WEATHER = ["hush", "drip", "mist"]` (dumped) and `species.prefers` exist (legacy conditions). Every reader calls `getCondition`, which has no provider in the bundle. I grepped for `getCondition` and found only the call at L128179. **Dead.** (Checked: the `hush` hour favour term, `R.condition === "hush"`, L128242, is dead for the same reason. A runtime scan of `__gw` found no object exposing `getCondition` or `getTodaysRumour`.)
- Moon: grep for `moonPhase|lunar|moon:` finds one hit at L144746, which is in the render/audio code. There is **no moon condition.** "The moon looks in on the old bell" (`Ca.maps.bell_pool`) is flavour text.
- Season: grep `season` returns 0 hits. **Not found.**
- Wind: the only hits are audio mix values (L136709 onward). **Not found** as a condition.

---

## 4. Space: how the game knows where the float or lure is

### 4.1 Position primitives [shared, live]

- **Bob position** `c.bob.{x,z}`, raft `P()`. Distance from raft: `i.castDist` at the cast, `i.hookDist` at the strike (`Math.hypot(c.bob.x - P().x, ...)`, L130263). Neither is read by any fish record.
- **Depth** `ye(x,z) = clamp(world.getDepth(x,z), 0, 1)` (L127776), stored in `i.depth` and `s.depth`. `DEPTH_BANDS = { shallow: [0, 0.35], mid: [0.35, 0.75], deep: [0.75, 1] }` (dumped). In a trip the band is used only for the aim hint (the reticle is hidden in loop: `xe() ? (o.setReticle(!1)...`, L134317).
- **The depth filter is effectively gone in loop.** The roster merge sets `depth: [0, 1]` on every roster species (`I5(`, L30721), and the legacy `te(` filter by depth runs only when `xe()` is false. Depth now acts only through areas and the `depthLowerThird` size favour. The exceptions are gloam_eel `[0.4, 1]` and belled_matriarch `[0.8, 1]`, which keep legacy depth (dumped). Their depth is read only by the favour term, not as a gate.

### 4.2 Areas: `function s1(x, z, probe, { lane, arena, hulls, docks, geo })` (L32345) [loop, live]

Ten area ids, `hg = ["margin", "reeds", "pads", "stones", "dropoff", "lane", "open", "deep", "inflow", "outflow"]` (L31560). The first match wins:

| Area | Test (Mossmere geometry, L31618) |
|---|---|
| (null) | on land or inside an island disc |
| inflow | within r 9 of (54, 4) |
| outflow | ring r0 4.5 to r1 11 around the gate or (0, −49) |
| dropoff | ring 6 to 12 around the rim at (−4, −14), the Bell Pool; or depth 0.35 to 0.45 within 14 of shore or 6 of an island |
| pads | inside a lily bed disc (4 beds) |
| stones | within 4 of a pillar, dock or barge hull circle; within 3.5 of a tower, stair or roots island |
| reeds | ring around rock islands (r to 1.35r + 1.5); or 0.5 to 6 from shore within angle arcs `[100,112], [120,135], [232,244], [318,332]` (Sporewood uses `reedRuns` along the shore instead) |
| margin | depth < 0.35 |
| lane | inside the evening's lane rect (`r1(evening, phase)`, 4 × 50, seeded by the evening number, day and dusk only) |
| deep | depth ≥ 0.75 |
| open | otherwise |

- Inside a named place, `area = null` and only the place counts (`Dt.area = Dt.place || Dt.mist ? null : q(R, I)`, L128333).
- Per-species area weights: `raw` tables `GQ` (Mossmere, 12 natives) and `A7` (Sporewood, 9). For example `kissmark_trout: [0.2, 0.2, 0.1, 0.5, 2, 1.5, 1.2, 3, 2.5, 1]`, so deep ×3, inflow ×2.5 and dropoff ×2. Fish missing from these tables have no area preference.
- **The lane is the one existing "moves every evening" location.** Its position is a deterministic hash of the evening number (`B5(s, ...)`), so it is reproducible.

### 4.3 Named places [loop, live] (dumped)

Places come from `arena.places`. `placeAtV3(zone, x, z)` = `function Ste(` (L48865) uses `US(place, x, z)`, which is `!Number.isNaN(u1(place.water, x, z))`.

| Lake | Place id | Name | Kind | Area shape | LOOP.places data |
|---|---|---|---|---|---|
| Mossmere | lily_maze | The Lily Maze | day | disc (−40.5, 24.5) r 7.5 | price 60, draws koi 3, weeping_carp 1.5 |
| | under_the_span | Under the Span | old | path w 8 (2 pts) | giant thousandcast_pike, own bridgechain_sturgeon |
| | buoy_lights | The Buoy Lights | night | rect (−48, −2) w 4 | giant hullkiss_lamprey |
| | bell_pool | The Bell Pool | crown | disc (−4, −14) r 6 | legend belled_matriarch, price 500 |
| | veilback_brook | Veilback Brook | day | path w 5 | secret, revealedBy veil_notebook, `only: true`, own rosefleck_trout and rainglass_darter, `good: 1` |
| Sporewood | lullaby | The Lullaby | day | disc (−51.5, −35) r 7 | own sleepspore_jelly, draws velvet_ray 3 |
| | gill_harp | The Gill Harp | old | disc (0, 6.5) r 4.5 | giant harpstring_eel, draws cindertail_catfish 2 |
| | veilwater | The Veilwater | night | disc (−86, 38) r 5 | giant festival_puffer, price 1200 |
| | mothers_cup | The Mother's Cup | crown | disc (48, 6) r 6 | legend drifting_grove, price 2200 |

- **Mist**: a place the player has not bought (`maps.places`) or not "lifted" sets `cast.mist`, and `K(` emits `fishing:mist`. No fish can bite there (`ve(`, L127941).
- `legendPool` (`arena.legendPool`: Mossmere `{x:-4, z:-14, r:3.2, name:"Bell Pool"}`, Sporewood `{x:48, z:6, r:3.2, name:"The Mother's Cup"}`) is the legacy gate: `Math.hypot(bob - pool) <= r` applies only when `!xe()` (L129360). In loop the gate is the place disc (r 6). `legendPool` also keeps signs away (`Wj(`: no sign within r + 3).
- `deepPools` (for example `{ name: "Bell Pool", x: -4, z: -14, r: 13, depth: 0.9 }`) only carves terrain depth (L58200). It is not read by fishing.
- `giantSpots` is legacy, used only when the arena has no places (`rn(`, L128132).
- **Cover and obstacles** have no separate model. They are folded into the `stones` area (pillars, docks, hull circles, stone islands) and the `reeds` area (rock islands, reed arcs). Islands return a null area.

### 4.4 What a fish record can depend on spatially today

- Area weight (10 areas, per light, with night overrides)
- Named-place membership (`place`/`kind`/`own`/`draws`/`only`)
- Giant-in-own-place
- Elder size only in `old` places or a giant's own place (`ep(`)
- The evening lane
- Guest by area and light (notebooks)
- Sign and sight "maker" areas

**Not expressible**: depth as a gate (roster depth is flattened); distance from raft or shore; proximity to a specific landmark other than a place; float drift; bottom type.

---

## 5. Player actions the engine distinguishes

| Action | Effect | Live | Anchor |
|---|---|---|---|
| Cast distance (aim-meter timing × castMax) | where the float lands, and so area, place and depth | yes | `function sq(` |
| Clean cast (charge ≥ 0.92) | +0.1 size favour, rarity bonus 0.05, wait ×0.85 | yes | `i.clean = I >= yt(Pe)` |
| Raft still while aiming (speed < 2) | required to start the meter ("anchoring") | yes | `maxRaftSpeed` |
| Choice of presentation (lure alone, bait, both, bare) | §1.1 | yes | `Nr() && k() && !i.castBait` |
| Casting onto a sign | sign `rule` (maker tilt ×3, preroll take, wait ×0.65, favour) | yes | `$j(`, `j8(` |
| Casting *inside* a nervous, ruffle, cloud or stems sign | **spook**: no take, wait ×1.5, the sign fades | yes | `spookInside: !0`, `rule.spook` |
| Leading a sighted shadow (sight-casting) | lands within the lead box ahead of a moving fish, or 0.8 to 2 m from a still one: take chance 0.45, wait ×0.3 | yes | `function G0e(`, `function mD(`, `bs.mossmere.sight.lead` |
| Landing on a sighted fish (≤ 0.6 + length/2) or splashing within 2 | spooks it | yes | `function kM(` |
| Raft wake, raft too close, lantern | sight spook parameters `spook: { body: 0.6, splash: 2, quietR: 10, quietT: 30, wake: 1.2 }`, `lantern: { r: 8, ... }`, `keepOff` | yes (inferred from config; consumers not traced line by line) | `bs.mossmere.sight` |
| Strike timing | early, clean, struck or late (§1.8); striking during nibbles spooks | yes | `function ot(` |
| Not striking (let it pass) | bait refunded; +0.15 favour (cap 0.3) for the same water within 60 s or 6 m | yes | `letItPass` |
| Rowing during the wait | line breaks only if the bob is more than castDist + 4 away (`fishing:miss moved`) | yes | `function $b(` |
| Rowing during the fight | line cut (`slack`) | yes | `Xa("slack", { cut: !0 })` |
| Keep / let go after landing | let go: −1 spent bite in that water, +0.2 mercy favour (cap 0.4) | yes | `function z(ze)` L105800 |
| Hurry (press during a small fight, from evening 2) | shortens the fight; the outcome is already fixed (inferred) | yes | `i.hurry`, `af_hurry` |
| Retrieve speed, twitch, pause, stop-and-go, rod lift | **not found.** The spinner retrieve is automatic at `lureCast.pace` with no input read in `lq(`. I searched `twitch` (only fight-anim and rod-perk text hits), `retrieveSpeed` (0 hits), and `pause` (three.js only) | — | `function lq(` |
| Stillness of the float | **not found** as a condition. "stillness" appears only in `legendPoolToast` text | — | |
| Chum | `i.chumArmed` turns the next cast into a nervous sign | legacy (no loop source traced) | `Sj(` L129011 |

---

## 6. Knowledge items that already gate fish (closest existing "clue" mechanics)

- **Notebooks** (`wo.lostTackle`, L47421), found through snags:
  - `veil_notebook { boost: { kissmark_trout: 1.2 }, guest: { id: "rosefleck_trout", areas: ["inflow"], lights: ["day", "dusk"], share: 0.04 }, reveals: "veilback_brook" }`
  - `lily_notebook { boost: { weeping_carp: 1.5, candlefin_koi: 1.5 }, guest: { id: "nightbloom_carp", areas: ["pads"], lights: ["night"], share: 0.03 } }`
  - They are passed to G5 as `notes` (`qe()` → `n1(state)`). The journal text "{fish} bite at {where}, {lights}." is `Ca.lost.log.guest`. **This is already the "owned knowledge unlocks a fish at an area and an hour" pattern.**
- **Signs and tells** (`bs.<lake>.tells`, L31765). Kinds: rise (sip, splash, roll), boil, nervous (ruffle, spray), strike, bubbles, pinprick, cloud, stems, gas. Each has `hours` weights per light, `makers` species, `areas`, `within`, `after`, `respond`. A sign spawns a **prerolled real fish** (species plus z, `i.prerolls`) when its maker is in the local pool (`JC(`, L133480). The `sign:spawn` event carries the sizeClass. **Signs are an existing readable clue: "species X is here, now".**
- **Sight shadows** (`bs.<lake>.sight`). These are visible fish in shallow areas (`depth: 0.45`, `areas` margin, pads, inflow, stones, reeds, lily_maze). Body shape classes hint at species (`bodies`), some are `nightOnly`, and giants and the Matriarch are `exclude`d.
- **Bell Pool cue**: `bellPoolContact(` (L78807) rings a ripple before a Matriarch bite (`i.bellWarned`, L134429).
- **Journal clues** for an escaped fish and Old Rival `clue`/`observation` (§7).

---

## 7. State that persists and could act as a condition

| State | Scope | Values | Anchor |
|---|---|---|---|
| Bites spent per water | trip (run) | `run.bites[waterKey]`, where waterKey is a place id or `open:<zone>`. Good bites per water come from `ete(`: places `water.good = { day: 2, old: 3, night: 2, crown: 2 }` or `place.good`; open water = `holdSlots × 1 + 1` (+ Tallow) | `function be(ze` L105825, `bitesLeft` |
| Quiet-water penalty | trip | over = spent + 1 − good gives favour −0.15 per step (floor −1.2) and wait ×(1 + 0.3·over) up to 2.2; no signs spawn when bitesLeft ≤ 0 (`Ae()`) | `quietTerms` = `function tte(` |
| Let-go mercy | trip | `run.mercy[waterKey]` +0.2, capped at 0.4 | `function z(ze)` |
| Let it pass | session | `i.letPass {x, z, place, at, value}` lasts 60 s | `letItPass` |
| Legend rebite delay | session | `i.legendDimUntil = clock + 20` | `rebiteDelay` |
| Legend wounds and landings | meta | +6 hold per escape (cap 18); +2 fight per landing (cap 10); window +0.1 | `legend.woundPerEscape`, `growthPerLanding` |
| Giant mark | meta loop | an escaped giant is marked (`markGiant`); the next hook takes the mark for +6 hold | `function Y(ze` L105912, `takeGiantMark` |
| Comeback (Ashwick `burns_back`) | run | the last escaped ordinary fish `{waterKey, speciesId, z}` returns with p = 1 in that water | `function Y(ze`, `consumeComeback` |
| Taper first bite | run | `flags.taperFirst` (rarer first fish each evening) | `taperFirstOpen` |
| Evening counter | meta | `run.evening = meta.loop.evenings + 1`; drives the lane seed, `firstEvening` caps, hurry, Old Rival eligibility (> 1) | `evening: Math.max(0, ha(Ee.evenings)) + 1` |
| Arrival in a new lake | run | `run.arrival { cap, fight }` for `wo.arrival.evenings: 3` | `arrival` |
| Old Rival | meta | `meta.oldRivals.active = { id, name, speciesId, z, place, needsPurchase[], gap, escapes, sightings, clue, observation, evening }`. Created on an Elder over-cap loss in Mossmere with probability 0.8. It visits only at its `place` (null = open water), only when the rig has grade > 0, only once `needsPurchase` is empty, with `rollRivalVisit`: `gap >= 6 \|\| (gap >= 2 && random() < 0.3)` | `function loseOldRival(`, `function chooseRivalBite(`, `function prepareRivalVisit(` |
| What has been caught | meta | journal landed counts (catch-locked guides), `book.landed`, legendaries | `meta.journal`, `noteBest` |
| Maps owned and lifted, lures owned, bait counts, tackle tiers | meta loop | `maps.places`, `lifted`, `lures`, `bait[lake]`, `tackle` | `function Me()` L127923 |
| Tackle finds miss counter | meta | Veil notebook +0.05 share per missed snag (cap 0.4) | `m7(`, `tackleMiss` |
| Legacy pressure per place | session | `pressure.perCatch -0.12` (floor −0.6). Read only when `!At` (not loop) | `function Gt(` |

---

## 8. Condition table

| Condition | Can the engine test it today? | Anchor | Notes |
|---|---|---|---|
| Lake | yes | `Yt()`, `species.zone` | hard filter in `ute` |
| Named place (inside disc, path or rect) | yes | `placeAtV3` / `US(`, `cast.place` | hard filter for place-owned fish, giants, legend |
| Place owned and un-misted | yes | `ve(`, `cast.mist` | no fish in mist |
| Area (10 kinds) at bob | yes | `function s1(`, `cast.area` | soft weight per species; re-evaluated each second on a retrieve |
| Evening lane | yes | `function r1(` | moves per evening; day and dusk only |
| Depth at bob | yes (value) / no (as a species gate in loop) | `ye(`, `i.depth` | roster depth flattened to [0, 1]; only `depthLowerThird` favour |
| Distance from raft / shore | measured, not used by fish | `i.castDist`, `i.hookDist`, `probe.fromShore` | `fromShore` feeds the reeds and dropoff areas only |
| Cover / structure | indirectly | `stones`, `reeds` areas | no cover object model |
| Light (day / dusk / night) | yes | `id(`, `YS`, `j()` | hard filter via hours; soft via factors and tilts |
| Time within a phase (k, seconds left) | yes (value) / not read by fish | `getPhaseInfo` → `N()` (`time`, `k`, `remaining`) | could gate a feeding window |
| Phase durations | yes | `wo.evening = { day: 40, dusk: 20, night: null }` | night never ends in a trip |
| Weather / condition | no (dead) | `getCondition`, `WEATHER`, `prefers` | no provider |
| Moon | no | not found | grep `moonPhase\|lunar\|moon:` |
| Season | no | not found | grep `season` = 0 |
| Rumour of the day | no (dead) | `getTodaysRumour` | no provider |
| Presentation kind (spin / float / bare / tipped) | yes | `Nr() && k() && !i.castBait` | |
| Specific bait or lure (grade 0 to 3) | yes | `hook.table`, `function Rl(` | the main rig preference |
| Required bait | yes | `species.bait` in `ute` | hard gate |
| Legend bait plus bite chance | yes | `rollLegendBite`, `legendBiteChance 0.12` | Heartmoss only |
| Line / rod / reel tier | yes for size cap and landing; no for bite | `Bd(`, `GP(` | |
| Size cap against rolled size | yes | `i.overCap`, `passesOversizeFish` | 80 / 90% back off |
| Retrieve speed / twitch / pause | no | not found | retrieve is automatic |
| Retrieve path (areas crossed) | yes | `lq(` area refresh every 1 s | |
| Clean cast | yes | `i.clean` | small effects |
| Cast on a sign / sighted fish lead / spook | yes | `$j(`, `G0e(`, `kM(`, `spookInside` | presentation-accuracy tests exist |
| Strike timing grade | yes | `function ot(` | affects landing hold only (+8 clean, +2 struck) |
| Let it pass | yes | `letItPass` | |
| Raft movement | yes | `$b(`, `maxRaftSpeed`, sight `wake` | |
| Bites spent in this water this outing | yes | `run.bites`, `bitesLeft` | quiet water |
| Escapes of this individual / species | yes for legend wounds, giant mark, Old Rival, comeback | §7 | |
| Days (evenings) played | yes | `run.evening` | |
| Caught before (journal) | yes | journal counts | |
| Cooldown since last legend bite | yes | `legendDimUntil` 20 s | |
| Item owned (notebook) unlocks a guest at an area and light | yes | `I7(`, `lostTackle.*.guest` | ideal clue template |
| Hard take | yes | `rollHardTake` | 0.16 / 0.28 |
| Snag | yes (rate only) | `ct(`, `finds.snag.perBite 0.05` | no positional input |

---

## Where the handoff and the code disagree, or where the handoff is ambiguous

- Handoff: "If the limiting factor is the line, 20% of over-limit approaches still commit; lure/bait/hook 10%". Matches the code (`passesOversizeFish`).
- Handoff: hard takes 16% / 28%. Matches (`chance 0.16 × spinMultiplier 1.75`).
- Handoff: "Fight points adjust only the landing calculation". Matches (`pressure` in `GP`). The handoff's fight-duration table also matches `registerLakeFight`.
- Handoff, Bell Pool: "A small ring starts at the clapper shortly before a Belled Matriarch bite". The code fires the ring at `waitDur − sb − 0.62` s whenever the species is the Matriarch in `bell_pool` (`cq(`, L134429). Note that it is a cue, not a condition.
- The handoff does not mention three things that matter here. (a) In loop the roster flattens species depth to [0, 1], so depth is no longer a fish filter. (b) Elder size is capped to 2.64 z outside `old` and giant places (`ep(`). (c) `condition`/`rumour` favour terms are dead. All three were read in code.

---

## Hook points for the hunt loop

1. **Target-fish eligibility goes in `ute` (`placePool`) and `G5`.** Both already support hard gates (bait, hours, place `only`/`own`) and soft weights. A hunt monster can be a non-legendary-flagged record with `place`, `bait` and `hours`. Alternatively, add a `G5` branch like `comeback`/`preroll` that returns a forced entry when every hunt condition holds. The Old Rival path (`chooseRivalBite`, `prepareRivalVisit`, `rivalGate`, `rollRivalVisit`) is a working template for "one individual fish, at one place, behind a gear requirement, with a visit roll and a wake cue". It is Mossmere-only and hard-codes `"mossmere"` in several places.
2. **"Where it lives"** can use a place disc (`arena.places` + `LOOP.places`), an area id from `s1(`, or a per-evening seeded location like `r1(` (lane). The arena `legendPool` and `deepPools` entries already mark each lake's monster hole.
3. **"When it feeds"** can use `hours` keys (`L5`, `LOOP.hours`) for light, and `getPhaseInfo()` `k`/`time` for a sub-phase window. Because night never ends in a trip, a "late night" window needs `phaseTime` thresholds.
4. **"What bait and rig"** can use a new row in `bs.<lake>.hook.table` (grade 3 for the correct item, 0 for the rest), `species.bait` as a hard gate, `gearCap.item` / `Bd` for "must hold an Elder", and `CATCH_V3.items[x].species` for a hold bonus.
5. **"How to present"** can use the sign and sight systems. Casting onto a prerolled sign or leading a sighted shadow is an existing accuracy test with spook rules (`$j`, `G0e`, `kM`, `spookInside`). Add the monster as a `maker` of a dedicated tell, or as a sight `body`, and its sign becomes the clue the player reads. Clean cast and strike grade are further skill checks.
6. **Clues from other fish**: the notebook `guest`/`boost` structure (`I7(`, `lostTackle`) and the journal `Ca.lost.log` lines are a ready template for "learned knowledge unlocks a fish at an area and an hour". Escape advice (`gearEscapeAdvice`) and Old Rival `clue`/`observation` already produce rig hints from a lost fish.
7. **Landing gate to the next lake**: `GP(` legend branch (`legend.fight[id]`, `cap.legend 0.5`, wounds +6) and `LOOP.access` / `ZONES[].requires` (`"Land the Belled Matriarch"`, L33501, legacy). The current loop gate is `access.gear { sporewood: "rod:1" }` plus `waters.sporewood.lake 1400` (dumped). Another map covers this in detail.
8. **Events to listen on**: `fishing:land` (position, sign), `fishing:bite`, `fishing:tell`, `fishing:hook` (grade, hardTake), `fishing:miss` (reason: spooked, passed, late, moved, staggered), `fishing:escaped`, `sign:spawn` (kind, x, z, sizeClass), `fish:escaped`, `fishing:mist`.

## Gaps

- **No retrieve control.** There is no speed, twitch, pause, depth of retrieve or stop-and-go. `lq(` moves the lure at a constant pace and reads no input. A "how to present" condition based on retrieve must be built from scratch.
- **No depth gate in loop.** Roster depth is `[0, 1]`. (Checked at runtime: the only non-`[0,1]` Mossmere/Sporewood records are the non-roster `gloam_eel` `[0.4,1]` and the legend `belled_matriarch` `[0.8,1]`. Loop `te` still ignores them because it returns the `placePool` list. The legacy depth filter runs only if `xe()` is false or `F` returns null.) A "lives in the deepest hole" condition must use areas (`deep` ≥ 0.75, `dropoff`), a place, or restore `species.depth` filtering for loop.
- **No weather, moon or season.** The `WEATHER`/`prefers`/`getCondition` plumbing exists but has no provider. Reviving it needs a per-evening condition source.
- **No feeding window inside a phase.** Only light-level hours exist. Phases are 40 s and 20 s, then an unbounded night, so a "feeds at last light" test needs a new `phaseTime` check.
- **No float or bait position beyond splashdown.** There is no drift, no settle time and no "left still for N seconds" test. Float bumps and nibbles are scheduled at the cast and are cosmetic apart from early-strike spooking.
- **No condition on line, rod or reel at bite time.** These matter only for caps and landing.
- **No structure objects.** Cover is folded into the `stones` and `reeds` areas. A monster "under the sunken barge" needs a place or a new area.
- **No "investigated" state.** Nothing records which clues the player has seen (signs observed, places fished, baits tried) except journal catch counts, Old Rival `sightings`/`observation`, and notebooks owned. A hunt clue ledger is new work.
- **Legends sit outside most of the pipeline.** They bypass `placePool` (legendary is excluded), size caps, the oversize back-off and hard takes. They are reached only through `zt()`'s bait + place + hour + `legendBiteChance` check. The Drifting Grove bait has no `legendBiteChance`, so it bites every eligible cast (inferred from `?? 1`).
- **No full trip run in a browser.** The phase durations, the sign and sight consumers, and Glowcap's chance of 1 come from reading only.

## Checked

Sceptical re-check against `game.pretty.js` and a runtime probe of the unmodified HTML (verdict, then corrections where needed).

1. **One grade 0-3 per item per lake in `hook.table`, read by `Rl`; mult [0,0.5,1.6,2.5]; grade 0 never bites; grade sets the size cap and `_7` take chance.** Refuted in part. `Rl` (L32451) also falls back to `hook.guests` (`z7`, L32043). Lure-then-bait-then-bare precedence is correct. `mult` applies to ordinary rows (`l1`). The place giant is scaled only at grade 0 or 1 (`P7`), and guests use `tee [0,0.25,1,1.5]`. The grade is one of three `Bd` caps (item, line, grade; the tightest wins, grade 0 gives "keeper"), not the cap by itself. Grade 0 does give zero weight and `take.stray = 0`. Note added in 2.2.
2. **`ute` hard gates.** Refuted in part. The zone, not-legendary, not-cove, bait (`v.bait && v.bait !== o`), place-owned/kind and giant-own-place rules are as stated (L47686). The hours filter is not absolute: when the in-hour pool totals under 70 (`U7.common`), off-hour open-water fish are added. A night-kind place cast outside night is treated as open water. Giant share 0.06/0.025 is ×1.3 (cap 0.12) for Taper. Required baits confirmed at runtime: threadling_eel spore_cake, gloam_eel lumen_moss, sleepspore_jelly amber_larvae (legends drifting_grove glowcap_bulb and belled_matriarch heartmoss are excluded). Body 1.2 already says all this.
3. **Phases 40/20/infinite; L5 day→day+dusk, dusk→dusk+night.** Confirmed (`evening:` L46735; `function Y(Ie, et, kt)` L112394 uses `be() = LOOP.evening`; `L5` L30622; `YS` L47659).
4. **Depth not a species filter in loop.** Confirmed. `I5` sets `depth: [0, 1]` on roster records (L30690). Non-roster gloam_eel `[0.4,1]` exists but is not depth-filtered in loop. `te` (L129207) applies depth only when `xe()` is false or `F` returns null. `depthLowerThird` +0.25 is in `ht` (L128295). Area thresholds: `margin 0.35`, `deep 0.75`, `lip [0.35,0.45]` (L32052 to L32069).
5. **Spinner retrieve has no player control.** Confirmed: pace 1.2, `inAt 2.4`, 1 s area refresh, `N7(..., strike 0.05)` → 0.05/0.15/0.25 via `_7` (L134360; `lureCast` L46713). `retrieveStyles` (L90077) is only in visuals. Addendum: an active visiting Old Rival gets forced contact when the `N7` roll fails (added in 1.5).
6. **Oversize: `ep` clamp 2.64 except old/giant place; overCap; backoff 80/90%; p = 0.** Refuted in part. `ep` (L103789) also caps by `species.maxClass` / `reachZ`. In `Ft` (L128427), on the first evening, in the tutorial or under `run.arrival.cap`, z is clamped to the gear cap and no `overCap` is set. Legendaries skip `ep` and `overCap`. Backoff is exempt for find, tutorial, legend cast, rival fight and comeback. `p = 0` unless `i.find` (L130217). Body 1.6 is updated.
7. **Legend bite conditions.** Confirmed (`zt`, L129342 to L129362; `function $(R)` L128034; `rollLegendBite` L104008; Heartmoss 0.12 L34817; Glowcap L34827 has no `legendBiteChance`; `cap.legend 0.5` L43658). Addendum: a `forceSpecies` that is legendary also sets `legendCast`.
8. **Weather/rumour terms dead; no moon or season.** Confirmed. `getCondition`/`getTodaysRumour` appear only at L128179/L128187. The runtime probe found no provider. Moon has one render hit (L144746), and season has 0 hits.
