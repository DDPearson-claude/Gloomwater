# Legend encounter map (key: legend)

Scope: The Belled Matriarch (Mossmere) and The Drifting Grove (Sporewood), end to end; The Glass Sovereign and The Pale Leviathan / Lantern Swallower briefly.

Conventions. Every claim carries a search anchor that works in both the HTML and the reading copy (`reading/game.pretty.js`), then `~L<n>` (reading-copy line, convenience only). **[read]** = read directly in code. **[inferred]** = my deduction from code I read, not executed. **[ran]** = observed in a Playwright run of `smoke/main-fixed.html`. "Live" means current relaxed-fishing play: `LOOP_ENABLED === true` (observed true [ran]) and a session with `run.outing === "trip"` (created by `outing: "trip"` in `startTrip`, ~L50867). The predicate the fishing code uses for this is `xe = () => X && h()?.outing === "trip"` (~L127865).

Layers: **OLD** = survival-roguelite (zones `Wr`, boss phases, Gloomtide, oil/food, descent gates, `run.legendaries`). **LOOP** = relaxed fishing (`wo` = `LOOP`, `meta.loop`, places, charts, Murk's counter).

---

## 1. Data records

Four distinct record families define the legends. The live game reads different fields from different ones.

### 1.1 Species record (`SPECIES` -> `Ms`)

`SPECIES: () => Ms` (~L30453). `Ms` starts as the OLD fish table (`var Ms = [`, ~L33768) and is **rebuilt at boot** when `Su` (V3) is on: `(Ms.length = 0), Ms.push(...Nf.filter(...))` (~L49204), then for LOOP Mossmere `Ms.push(...c1, ...m)` (~L49287) and for LOOP Sporewood `Ms.push(...T.slice(0, O), ...L, ...T.slice(O))` (~L49475). [read]

`Nf` (`var Nf = [`, ~L41216) is a V3 table built with `mi(id, overrides, extra)`; `mi` starts from `Lee(e) = Ms.find(...)`, i.e. a copy of the OLD record, and overlays size/family/phase/legendPlace (`function mi(`, ~L41198). So OLD fields (bait, time, boss, legendSale, hint) survive into the live record unless overridden. [read]

| Field (live record) | Belled Matriarch | Drifting Grove | Source |
|---|---|---|---|
| id | `belled_matriarch` | `drifting_grove` | OLD `Ms` (`id: "belled_matriarch"`, ~L33960; `id: "drifting_grove"`, ~L34191) |
| rarity | `"legendary"` | `"legendary"` | OLD |
| bait (what the bite check compares) | `"heartmoss"` | `"glowcap_bulb"` | OLD (`bait: "heartmoss"`, `bait: "glowcap_bulb"`) |
| time (hour gate) | `"calm"` | `"day,dusk"` (re-derived) | Matriarch: OLD `time: "calm"`. Grove: LOOP guide row `hours: "day, dusk"` -> `AQ()` -> `"day,dusk"` inside `I5` (~L30700) |
| legendSale | `900` | absent | OLD `legendSale: 900` (~L33962); Grove has none |
| boss | `{enrage:60, phases:[The Slow Toll, Double Toll, Last Toll], cue}` | `{enrage:75, phases:[Grazing, False Bloom, Spore Veil], cue}` | OLD; used only by the OLD reel (`aF({... boss: R.boss ...})`, ~L131232) |
| difficulty | `Ta(3, "steady", !0)` | `Ta(4, "leaper", !0)` | OLD, OLD reel only |
| size | `U5(260, 120)` | `U5(300, 150)` | `Nf` `mi("belled_matriarch", { size: U5(260, 120), ... legendPlace: "bell_pool" })` (~L41420); `mi("drifting_grove", {... legendPlace: "mothers_cup"})` (~L41563) |
| legendPlace | `"bell_pool"` | `"mothers_cup"` | `Nf` (not read by the bite check; see 2) |
| model | patched to catfish with bell: `shape: "catfish", whiskers: 2, head: "shovel", tail: "eel", bell: !0` | `drifting_grove: { model: { shape: "disc", ...` (~L42331) | `Ms.findIndex((c) => c.id === "belled_matriarch")` patch (~L49371) |
| hint | "Listen for a bell beneath the calm, far out in deep water. She takes only Heartmoss." | Guide `haunt`: "Crown: the Mother's Cup, the floor of the Grove Well. Sign: the pool's glimmer; the float stops as if set down." | OLD hint / LOOP guide row |
| giant | false | **true** (guide row `giant: !0`) | `I5` copies `giant: !!u.giant` (~L30716) [read]; effect on legend code: none found that matters [inferred] |

The LOOP field-guide rows (`var O5 = {`, ~L30770; fields `hours, place, placeName, favours, haunt, play`) contain **a row for The Drifting Grove** (`id: "drifting_grove"` at ~L31021: `hours: "day, dusk"`, `place: "crown"`, `placeName: "the Mother's Cup"`, `family: "legend"`, `favours: "Her bait only: Glowcap Bulb."`, `play: "...Never better than a coin flip."`). **There is no O5 row for the Belled Matriarch** (searched `Matriarch` and `bell_pool` in the O5 range; only hits are OLD zone and OLD `Ms`). The Matriarch's live record is therefore the `Nf`/OLD one. [read]

In `I5` the bait is `v = y ?? (h?.bait && !String(h.bait).includes("heart") ? h.bait : null)` (~L30703): a legend's bait survives only because the Grove's is not "heart..." and the Matriarch never goes through `I5`. A Mossmere O5 Matriarch row added later would silently drop `heartmoss`. [read; consequence inferred]

### 1.2 OLD zone record (`ZONES` -> `Wr`)

`ZONES: () => Wr` (~L30498), `Wr = [` (~L33369). Each zone has `legendary`, `arena.legendPool`, `unlock.requires`:

| Zone | legendary | arena.legendPool | unlock.requires |
|---|---|---|---|
| mossmere | `"belled_matriarch"` | `{ x: -4, z: -14, r: 3.2, name: "Bell Pool" }` | `[]` |
| sporewood | `"drifting_grove"` | OLD `{ x: 28, z: -16, r: 3.2, name: "Grove Well" }`; **replaced live** by `LP` -> `{ x: 48, z: 6, r: 3.2, name: "The Mother's Cup" }` (`i && (i.arena = Ki(LP))`, ~L49532; `legendPool` in `var LP`, ~L48453) | `{ type: "legendary", id: "belled_matriarch", label: "Land the Belled Matriarch" }` |
| glasswater | `"glass_sovereign"` | `{ x: 0, z: -37, ..., name: "North Trench" }` | land drifting_grove |
| paleabyss | `"pale_leviathan"` -> renamed `"lantern_swallower"` (`i.legendary === "pale_leviathan" && (i.legendary = "lantern_swallower")`, ~L49528) | `{ x: 0, z: -52, ..., name: "The Well" }` | land glass_sovereign |

**Live use:** the fishing bite check reads `zone.legendary` and `zone.arena.legendPool` through `We()` (`function We()`, ~L128484) to find the species and its bait. The world also builds a pool glow ("legendBreath") at `arena.legendPool`. The `unlock.requires` legendary gate is checked by the OLD descent gate code (`case "legendary": return !!me.legendaries?.[ce.id];`, ~L110562). LOOP travel uses different seals (see 4.4). [read]

### 1.3 Bait record (`BAITS` -> `x0`)

`BAITS: () => x0` (~L30370), `x0 = [` (~L34716):

| id | name | price | count | legend | consumeOnCast | legendBiteChance | zone |
|---|---|---|---|---|---|---|---|
| `heartmoss` | Heartmoss Ball | 10 | 10 | `!0` | `true` | `0.12` | mossmere |
| `glowcap_bulb` | Glowcap Bulb | 90 | 1 | `!0` | (absent) | (absent -> 1) | sporewood |
| `prism_moth` | Prism Moth | 170 | 1 | `!0` | - | - | glasswater |
| `pale_marrow` -> renamed `last_candle` "Last Candle" (~L49218) | | 320 | 1 | `!0` | - | - | paleabyss |

`x0` `price` is the OLD price. The LOOP shop uses `LOOP.legendBait` instead (1.4). OLD-only extra: `legendBaits: { heartmoss: 10, glowcap_bulb: 90, prism_moth: 170, last_candle: 320 }` (~L45357).

### 1.4 LOOP records (`wo`, exported `LOOP: () => wo`)

- Places with a legend (`legend:` key): `bell_pool: { water: "mossmere", kind: "crown", price: 500, card: "belled_matriarch", legend: "belled_matriarch" }` (~L46841) and `mothers_cup: { water: "sporewood", kind: "crown", price: 2200, card: "drifting_grove", legend: "drifting_grove", out: [...] }` (~L47945). These are the only two (searched `legend: "` across the file). [read]
- Place geometry: Bell Pool `id: "bell_pool"`, `legend: !0`, `water: { kind: "disc", x: -4, z: -14, r: 6, depth: [0.8, 1] }`, `phase: 2`, `reveal: "moonfall"`, `maxClass: "trophy"` (~L42497). Mother's Cup `id: "mothers_cup"`, `water: { kind: "disc", x: 48, z: 6, r: 6, depth: [0.8, 1] }`, `look: "a deep well under the Mother Cap"` (~L47996 in `_P.places`).
- Shop bait: `legendBait: { mossmere: { id: "heartmoss", price: 10 } }` (~L46856); `wo.legendBait.sporewood = { id: "glowcap_bulb", price: 250 };` (~L48023). The Grove bait is 250 per single bulb (pack `count: 1`). Prices are before the shop price factor (`priceFactor`/`wo.cost.factor`). [read]
- Shelf lines: `heartmoss: "Ten Heartmoss Balls. Fish the Bell Pool by day or dusk. Other fish take them too."` (~L47016); `glowcap_bulb: "For the Mother's Cup. One try."` (~L48150); generic `"Allows a legendary bite in its pool."` (~L164327).
- Hours table: `LOOP.hours` has `day: ["calm","dusk"]`, `"day,dusk": ["calm","dusk"]`, `night: ["gloomtide"]`, `any: [...]` (search `"day,dusk": ["calm", "dusk"]`, ~L46740). [read]
- Sale values: `value: { ... legendRematch: 0.4 }` (~L46710); Sporewood `prices: { night: 1200, crown: 2200 }` (`wo.waters.sporewood = {`, ~L47876); Mossmere `prices: { day: 60, old: 150, night: 260, crown: 500 }` (~L46755).
- Snag table: `snag: { perBite: 0.05, firstEvening: 0, legendCast: 0 }` (~L47306): no snags on a legend cast.
- Murk line: `legendFirst: "Her. You brought me her. Sit down, I'll count it twice."` (~L47040).

### 1.5 Fight and landing config

- Landing curve (`Wi = {`, ~L43655; exported `CATCH_V3: () => Wi`): `scale: 0.1`, `floor: 0.01`, `cap: { ..., legend: 0.5 }`, `wick: 10`, `strike: { clean: 4, struck: 2, early: 0, late: 0 }` (patched live to `clean: 8`: `Wi.strike = { ...Wi.strike, clean: 8 }`, ~L49376).
- `Wi.legend` (~L43719): `fight: { belled_matriarch: 16, drifting_grove: 28, glass_sovereign: 40, lantern_swallower: 56 }`, `fightRun: { 14, 22, 30, 36 }`, `style: { belled_matriarch: "steady", drifting_grove: "leaper", glass_sovereign: "leaper", lantern_swallower: "sinker" }`, `woundPerEscape: 6`, `woundCap: 18`, `growthPerLanding: 2`, `growthCap: 10`.
- Authored fight scripts (`Ds = {`, ~L43764): `Ds.play.legend = { dur: [30, 60], authored: !0 }` (search `legend: { dur: [30, 60], authored: !0 }`, ~L43879) and `legendPlays` (~L43933): `belled_matriarch: { dur: 36, set: ["take", "toll", "run", "toll", "circle", "lastStand", "lift"] }`, `drifting_grove: { dur: 44, set: ["take", "bloomingDive", "leap", "run", "bloomingDive", "leap", "lift"], leaps: [0.4, 0.8] }`, plus `glass_sovereign` (50 s) and `lantern_swallower` (60 s). Strike window class `legend: 1` (`window: { ... legend: 1 }`, ~L43766).
- OLD fishing config `xi.legend` (~L33320): `{ guaranteed: !0, woundedCarry: 0.5, woundedMax: 0.4, rebiteDelay: 20, windowBonus: 0.1, bannerDelay: 0.4, nibbles: 2 }`; `xi.spots.legend: { radius: 3.2, waitMult: 0.7, minDistFromRaft: 18 }`. `guaranteed` is not read anywhere (searched `.guaranteed`). `rebiteDelay`, `bannerDelay`, `nibbles`, `windowBonus` and `spots.legend.waitMult` are read by live code; `woundedCarry`/`woundedMax` only by the OLD reel (see 3.4).

---

## 2. When a legend can bite today

### 2.1 Where the roll happens

`function zt(nextFish = false)` in the fishing module (~L129345) picks the species for each cast. The legend block, verbatim order (~L129352-129366):

```
(i.legendCast = !1) ...
let bn = We();
!nextFish && bn && At && At === bn.baitId && C(bn.species, Dt) &&
  i.clock >= i.legendDimUntil &&
  (xe() ? $(bn) : Math.hypot(c.bob.x - bn.x, c.bob.z - bn.z) <= bn.r) &&
  (i.legendCast = rollLegendBite(D(At), lt));
...
if (i.forceSpecies) ... else if (i.legendCast) vn = bn.species; else { ordinary table }
```

`function rollLegendBite(bait, rng)` (~L104008): `const chance = bait?.legendBiteChance ?? 1; return chance >= 1 || rng() < chance;` The rng is `lt = () => (i.rng || Math.random)()`.

### 2.2 The checks, in order (live trip)

| # | Check | Code | Matriarch | Grove |
|---|---|---|---|---|
| 1 | Not the second fish of a cast | `!nextFish` | | |
| 2 | Current zone has a legend and a pool | `We()`: `R?.arena?.legendPool` + `Z(R?.legendary)`; caches `{x,z,r,species,baitId: Q.bait}` | Bell Pool / heartmoss | Mother's Cup / glowcap_bulb |
| 3 | Bait on this cast equals the species' bait | `At = i.castBait`; `At === bn.baitId` | `heartmoss` | `glowcap_bulb` |
| 4 | Hour | `C(bn.species, Dt)` with `Dt = j()` (survival phase). Live `C`: if `species.time` is not `calm`/`gloom`/`dawn` and `LOOP.hours[time]` exists, use it; else OLD `he`: `calm` -> phase `!== "gloomtide"` (~L127800) | time `"calm"` -> any phase except `gloomtide` (so calm, dusk and dawn) | `"day,dusk"` -> `["calm","dusk"]` |
| 5 | Not in rebite cooldown | `i.clock >= i.legendDimUntil` | | |
| 6 | Cast is inside the legend's place and its mist is lifted | `function $(R)`: `!!I && !i.cast.mist && t().LOOP?.places?.[I.id]?.legend === R?.species?.id` (~L128034) | cast lands in `bell_pool` disc r 6 | cast lands in `mothers_cup` disc r 6 |
| 7 | Roll | `rollLegendBite(D(At), lt)` | 12% | **always (chance 1)** |

How `cast.mist` is set: `function Nt(R, I)` (~L128141) gives `Ke.mist = Q.id` when `ve(Q)`, and `ve(R) = !!R && xe() && !!I && (!I.owned.has(R.id) || !I.lifted.has(R.id))` (~L127890). `owned` = `meta.loop.maps.places`, `lifted` = the loop's lifted list. So the place must be **bought (chart) and lifted**. A cast into locked mist refunds Heartmoss (`refundBait` when `consumeOnCast`, ~L129156). [read]

Outside a trip (`xe()` false: OLD descent or `outing: "first"`), check 6 is instead "bob within `r` (3.2) of `arena.legendPool`". [read]

### 2.3 Things that are NOT checks (searched, not found)

- **No first-evening or tutorial exclusion** in the legend roll. The `zt` condition has no `i.tutorial`, `evening`, `arrival.cap` or `meta.loop.tutorial` term (compare the Old Rival gate `prepareRivalVisit`, ~L128820, which has all of them). The practical gate is that the player owns no Heartmoss and no Bell Pool chart at first. [read; practical gate inferred]
- **No per-day / per-trip cap** on legend bites, and no "already landed" check in LOOP. The OLD shop refuses a legend bait "Already landed this descent" (`"Already landed this descent"`, ~L107471), OLD only.
- **No light / lantern condition** beyond the phase check.
- **No gear size cap**: `function Tt(R)` returns `null` for `R.rarity === "legendary"` (~L128374), so `overCap` is never set and `fishBacksOff()` excludes `i.legendCast` (~L129713).
- `xi.legend.guaranteed` is unused.

### 2.4 Cooldown

`legendDimUntil` = `i.clock + rebiteDelay (20)` after a legend loss in the LOOP fight (`Oe() && (i.legendDimUntil = i.clock + Bt(n("legend").rebiteDelay, 20))`, ~L130733) and after an OLD-reel escape (`Xa`, ~L132522). Reset to `-1` on `zone:change` and `run:start` (~L135024, ~L135034). It is a 20-second in-session timer, not a day or trip cooldown. [read]

### 2.5 Bait consumption

- Heartmoss (`consumeOnCast: true`): spent on cast like ordinary bait (`(ft.legend && !ft.consumeOnCast) || ((ce.bait[me] = Qt - 1) ...)`, ~L110027). Refunded on early retrieve / locked mist / let-pass (`refundBait` when `!oe(bait) || consumeOnCast`, ~L129156, ~L129864, ~L134796). Outside the Bell Pool, the cast's bait is treated as no bait (`xe() && oe(Pe) && (Pe = null)` in `Ht`, ~L128318), and the shelf line says "Other fish take them too". [read]
- Glowcap Bulb (legend, no `consumeOnCast`): **not spent on cast**. It is spent at the strike only if the hooked fish is a legend: `if (vn && At && !D(Q.bait)?.consumeOnCast) N()?.spendBait?.(i.castBait || Q.bait)` in `Nn` (~L130177). Its cast keeps `i.castBait` while the count is above 0: `i.castBait = At || (Dt?.legend && !Dt.consumeOnCast && Bt(h()?.bait?.[Ke], 1) > 0 ? Ke : null)` (~L128800). [read]
- Consequence [inferred]: in the Mother's Cup, by day or dusk, with a bulb on, **every cast** brings the Grove (chance 1). The bulb goes only when the player strikes. "One try" means one strike per 250-clam bulb.

### 2.6 Is the Sporewood legend reachable by the same path?

Yes, it uses the same `zt` code. `We()` reads Sporewood's live arena (`LP`, Mother's Cup) and `legendary: "drifting_grove"`. `$()` matches `LOOP.places.mothers_cup.legend`, and the shop stocks `glowcap_bulb` when the barge is in Sporewood (`for (let [S, P] of Object.entries(Ln(a.legendBait) ...` with `S !== O` skip, ~L105191). Two parameters differ: the bite chance is 1, not 0.12, and the bait is spent at the strike, not on the cast. There is also an extra precondition: Sporewood must be reached and the 2200-clam Mother's Cup chart bought and lifted. [read; not driven in browser]

---

## 3. What the player sees

### 3.1 Before the bite

| Cue | Live in a trip? | Anchor |
|---|---|---|
| "golden stillness" toast `legendPoolToast: "A golden stillness gathers far out. Something legendary is listening."` | **No.** Guarded by `!xe()` (~L132880) | `legendPoolToast` (~L37616, ~L132884) |
| Water-shader pool ring `o.setLegendPool(...)` | **No.** First arg is `!xe()` -> off in a trip | `o.setLegendPool(!xe(), Pe.x, Pe.z, Pe.r, i.legendK, Dt ? 0.35 : 1)` (~L132888) |
| Spot slot glow at the pool `o.setSlot(rz, ...)` | **No** when the size system is on (`!Q` where `Q = Lc() = ee()`); size system observed on [ran: `sizeZ: true`, `SIZE_CLASSES` array] | ~L132889 |
| World "legendBreath" column + halo at `arena.legendPool` | **Plausibly yes** [inferred]. Intensity `It = landedThisRun ? 0.14 : pool.active ? 1 : pool.dim ? 0.25 : 0.55`, zeroed while the mist covers it. `gi.legendPool` is published in a trip when `de(Pe)` (place owned and lifted). Mesh `legendBreath` exists, invisible at title [ran]. Mossmere's `arena.legendPool` (-4,-14) coincides with the Bell Pool place centre; Sporewood's `LP` (48,6) with the Mother's Cup. | `b.name = "legendBreath"` (~L78609); `w.legendK = It` (~L81587); `function de(R)` (~L128038) |
| `pool.active` meaning | bait count > 0 for the legend's bait **in inventory** (not fitted) and hour OK and not dim | `At = !!Pe.baitId && Bt(Ke?.bait?.[Pe.baitId], 0) > 0 ... tn = At && C(Pe.species, j()) && !Dt` (~L132876) |
| Bell Pool ambient toll `bell_pool: { sfx: "moss_toll", every: [18, 32], volume: 0.9 }` | Yes (ambient, unrelated to bites) | `var MW = Object.freeze({` (~L137391) |
| Harbour bell model (frame + clapper) | Yes once unlocked | `buildHarbourBell`, `"Bell Pool clapper"` (~L79698) |
| Map marker "legend" at the pool | OLD HUD; checks `equippedBait === species.bait`, hour, not landed this run | `en("legend", { x: Tt.x, ...` (~L150071) |

Note: the `tt is not defined` typo sits in the same `pN` world builder, at `uPool: { value: tt && tt.area.kind === "disc" ...` (~L80273), a few hundred lines after the bell is built. The bell mesh is built before the throw, but anything after it in `pN` is skipped on the unfixed build. [read; scope of the breakage belongs to the world mapper]

### 3.2 The bite

- Wait: clamp, then `i.legendCast && (Fn *= Bt(I.legend?.waitMult, 0.7))` (~L129494); rule/preroll wait multipliers skipped for legend casts.
- Nibbles: exactly `xi.legend.nibbles = 2` (`if (i.legendCast) va = Bt(Pe.nibbles, 2)`, ~L129506); no feints.
- No find, rival or comeback roll on a legend cast (`!i.legendCast` guards, ~L129435).
- **Bell clapper ripple** (Matriarch only): in `function cq(R)` (~L134421), when `i.species?.id === "belled_matriarch" && i.cast?.place?.id === "bell_pool" && i.stateT >= i.waitDur - sb - 0.62` (`sb = 0.9`), once per cast: `const pt = bellPoolContact(area); e.water?.addRipple?.(pt.x, pt.z, 0.58)`. `function bellPoolContact(area)` (~L78807) offsets the bell contact by (+0.16, +0.07). The ripple therefore comes about 1.52 s before the bite moment, and only when the Matriarch was actually chosen. No Grove equivalent (searched `drifting_grove` in the fishing module: only the OLD leap spore burst `ya()` ~L131391). [read] [checked] Both legends do still get a pre-bite cue that is not legend-specific: the `dome` bite tell (`i.tell = ... R?.rarity === "legendary" ? "dome" : ...`, ~L129737), which starts at `waitDur - (0.6 + lastDip 0.25)` and is the same tell Elder-class fish use (`id: "elder" ... bite: "dome"`, ~L40655). In a trip `s.legendary = !0` is also set on that tell (~L129758).
- Bite tell class: `Q.rarity === "legendary" ? "dome"` (~L129625). Strike window: `Ds.strike.window.legend = 1`, plus `windowBonus 0.1` if `meta.legendWounds[id] > 0` (`Q.rarity === "legendary" && Kt(Q.id).wounds > 0 && (qn += Bt(I.windowBonus, 0.1))`, ~L129639).
- Hard take: allowed. `rollHardTake` (~L129693) has no legend exclusion (`LOOP.hardTake.chance 0.16`, ×1.75 spinning). It calls `Nn("struck", ...)`.

### 3.3 The fight (live: outcome decided at the strike)

`function Nn(R, I = null, hardTake = false)` (~L130155):
1. `bn = At ? Kt(Q.id) : {...}` where `function Kt(R)` (~L130001) returns `wounds = meta.legendWounds[id]` and `landings = meta.records.legendGrowth[id].length`.
2. `Fn = Pe.catchChance(Q, Dt, tn, Qn)` -> `q2` -> `function GP(` (~L49040). For a legend: class forced to `"legend"`; style `Wi.legend.style[id]`; `hold = wick(10) + rod/line/reel hold × style emphasis + strike (clean 8 / struck 2 / early,late 0) + buffs + wounds×6 (cap 18)`; lure and bait items count 0; `fight = Wi.legend.fight[id] (16 / 28) + min(10, landings×2)` (`fightRun` only when `perRun`; live loadout sets `perRun: !1`, ~L108217, so `fight` applies); `p = max(0.01, 0.5 / (1 + e^(−0.1 × (hold − fight))))`. **The hooked-landing probability is always below 50%.**
3. `i.outcome = i.find || va < i.p ? "land" : "lose"` with `va = zB(lt).u`.
4. Plan: `EB("legend", z, seed, { legendId: Q.id, ... })` -> `if (m) return Jce(w, l.legendPlays[m], ...)` (~L123690). `Jce` sets `dur = legendPlays[id].dur` (36 s Matriarch, 44 s Grove), `music: "boss"`, `bend 1`, `tow 2.5`, and spreads the `set` beats evenly between `take` and `lift`. `Ds.play.legend.dur [30,60]` is not used when a `legendPlays` entry exists. [read]
5. Loss shape: `CB(...)` with loss weights from `Qce`, mapping `t === "legend" ? "elder"` (~L123737).
6. Banner `e.ui.banner(name, epithet)` 0.4 s after the hookset (`(i.bannerT = Bt(n("legend").bannerDelay, 0.4))`, ~L130316, fired ~L130500). OLD text template `legendaryHooked: "{name}: {epithet}"`.
7. Hurry button disabled for legend plans (`!i.plan || i.plan.legend` in `function Fe()`, ~L130018).

The OLD reel with boss phases (`bo()`, `aF({... boss, legendary ...})`, ~L131220; phase toasts, `surgeWarn` "dusk_toll" for the Matriarch, ~L131305) is the OLD layer. In a trip the strike goes through `Nn`. [read; that `bo()` is unreachable in a trip is inferred]

### 3.4 Escape: wounds and rebite

- Live: on loss `g("fish:escaped", loss)` (~L130881). The progression `onEscaped` handler calls `ne(F.id)`, i.e. `addLegendWound` (`function oe(ge = {}, ...)`, ~L108863): `meta.legendWounds[id] = min(3, +1)` (cap `be() = round(18/6) = 3`). The next hook gets +6 Hold per wound (max +18) and +0.1 s strike window. Cleared on landing (`me.rarity === "legendary" && Ne.clearLegendWounds(me.id)`, ~L110361). Odds sheet line: `Wounded once: +6` / `twice` / `N times` (~L148485). The place sheet shows wounds only when `!LOOP_ENABLED` (~L161443). [read]
- Rebite: 20 s `legendDimUntil` (2.4).
- OLD only: `run.flags.wounded[id] = min(woundedMax 0.4, max(prev, woundedCarry 0.5 × reel progress))` in `Xa` (~L132514). It feeds `startP` of the OLD reel and the OLD summary line "`{name} escaped wounded. It will remember the hook.`" (~L169243). Not on the live path. [read/inferred]
- Escape also marks the journal entry `seen` and appends `gotAway` (generic `onEscaped`).

### 3.5 Landing, catch card, sale

- On landing: `journal[id].caught++` (generic), `run.legendaries[id] = !0` (`me.rarity === "legendary" && ((ft.legendaries = ...`, ~L110322; also ~L110105), wounds cleared. Card: gold styling (`te.legendary ? "#efd9a6"`), seal stamp `KD(..., { legendary: true }) -> ID.elder` (~L137041 `function KD(`), land chime "special" voicing. Audio: Matriarch toll `fw = { sfx: "moss_toll", pitch: 0.62, place: "bell_pool", legend: "belled_matriarch" }` played for a legendary Matriarch event (`IW(fe)`, ~L137506). Which event drives `Fe()` there: not settled.
- Keep: the fish needs a free hold slot. `function j(ze)` returns `holdFull` when `B()` (~L105782); its price is stored on keep (`ze.clams = Ee`).
- Price, `function M(ze)` (~L105727): for legendary, `te = H.legendSale ?? LOOP.waters[zone].prices.crown`. First = `meta.loop.legends[id] === 0` **and** no other of the same species already in the creel. Otherwise `te × legendRematch (0.4)`.

| | First | Rematch |
|---|---|---|
| Matriarch | 900 (`legendSale`) | 360 |
| Grove | 2200 (fallback `prices.crown`, which is the same number as the chart price) | 880 |

  A second Matriarch kept on the same trip prices at 360, because the first is already in the creel.
- Evening sale `function xF(` (~L105070): `e.legends[r.speciesId] = ha(e.legends[r.speciesId]) + 1` for each legend line sold. **`meta.loop.legends` counts legends sold, not landed.** Murk then says `legendFirst` once (`f.some((u) => u.legend) && !i.legendFirst ? "legendFirst"`, ~L161649).

---

## 4. What is recorded and who reads it

| Record | Written | Read by | Layer |
|---|---|---|---|
| `meta.loop.legends[id]` (int, sales) | `xF` on evening sale (~L105077); initialised `legends: {}` (~L104877, ~L105099) | sale price first/rematch (~L105738); home sill stones `GA` (~L97868); eave trophy (`tle`, ~L102784; `i.eave` in `GA`); place sheet `giantLanded` (~L161433) | LOOP |
| `meta.journal[id].caught / .seen / .gotAway` | landing / escape | odds sheet visibility (`ew`, ~L103880); `se()` landings for odds preview (~L108344); place sheet `giantLanded` | both |
| `meta.legendWounds[id]` (0..3) | `addLegendWound` on escape; cleared on landing | live `Kt()` hold bonus; odds sheet wounds line | V3, live |
| `meta.records.legendGrowth[id]` (array) | **never written** (searched `Growth`: one reader, ~L130006) | live `Kt().landings` -> always 0 | dead |
| `run.legendaries[id] = true` | landing (~L110322) | OLD gate `case "legendary"`; HUD `setTrophies(count)` (~L101434); world glow 0.14 (~L81583); OLD Murk stock (~L107471, ~L107785); OLD map marker | OLD mostly; written live too |
| `run.flags.wounded[id]` | OLD reel escape only | OLD reel start progress, OLD summary | OLD |
| `meta.loop.prints[id]` | landing `notePrint` (generic) | eave print needs `legends[id] >= 1 && prints[id].length > 0` | LOOP |

**Home stones (gilt / ink / blank).** `function GA(e, t = ["mossmere"])` (~L97868): four sill stones. Slot d is `blank` if `t[d]` is missing or not in `meta.loop.barge.towed`, otherwise `gilt` if `legends[r[water]]` else `ink`, with `r = { mossmere: "belled_matriarch" }` only. Called as `GA(e.state?.meta?.loop, P.waterOrder)` (~L98149). So **only the Mossmere stone can turn gilt**. A towed Sporewood stone shows `ink` even after the Grove is sold. Rendered in `function fre(` (~L97549) with `stoneGilt`/`stoneInk`/`stoneBlank`. [read] The eave trophy is likewise Mossmere-only (`r` mapping; `tle(e, t, n = ["mossmere"])`).

### 4.4 Lake travel today

LOOP travel (`function sw(` ~L105335, `function Zy(` ~L105357) needs three seals: map (`waters.sporewood.lake: 1400`), gear (`access.gear: { sporewood: "rod:1" }`), and catch (`Yy` = every species of the previous lake in place kinds `["open","day","old"]` on plain bait). The catch list `op()` explicitly filters `r.rarity !== "legendary"` (~L105287). **Landing a legend plays no part in opening Sporewood in LOOP.** Only the OLD zone gate (`unlock.requires: [{ type: "legendary", ... }]`) ties travel to a legend. [read]

---

## 5. Journal and odds pages

- Taper's odds sheet builder (~L104380): `_t = be?.legend || LOOP.places[be.id].legend`; `ht` = legend place and bait is `legendBait` and `loopHours(species)` includes the light; `legendShare = ht ? (V3(t, p)?.legendBiteChance ?? 1) : 0`. When `legendShare === 1` the ordinary table is skipped entirely (`Ht = legendShare === 1 ? {} : G3(...)`). Otherwise ordinary shares are multiplied by `1 − legendShare` and the legend gets `legendShare`. Undiscovered species (not caught and not seen) are counted in `Le` and not listed. The legend row: `{ id, legend: !0, share, land: { legend: Vy(t, re, "legend", E) } }`. So the sheet shows the Matriarch at 12% (others ×0.88) and the Grove at 100%, each with a single "Legend" landing %, and only after the legend has been seen or caught. [read]
- The sheet's hour test (`loopHours = ek`, ~L47675: `dte.calm = ["day","dusk"]`) excludes dawn. The live `he` test admits the Matriarch at dawn. Minor mismatch [inferred].
- Landing % on the sheet uses `landings = journal[id].caught` (~L108344), so it predicts up to +10 fight difficulty after 5 landings. The live roll uses `legendGrowth` (never written), so real odds do not decline. **The sheet under-reports repeat-catch odds.** [read; magnitude inferred]
- Rendering: `gw-odds-row gw-odds-legend` (~L165560), wounds line `gw-odds-wounds`, unseen text `"Land or lose one to learn its odds."`. Field-guide prints and tally rows give legends gold/star styling (`t.giant || t.legend ? " gw-print--gold"`, ~L159664).

---

## 6. Glass Sovereign and Pale Leviathan / Lantern Swallower: data only (confirmed)

- Records exist: OLD `Ms` (`id: "glass_sovereign"` ~L34421, `id: "pale_leviathan"` ~L34658 with `final: !0`), `Nf` (`mi("glass_sovereign", {... legendPlace: "fallen_chandelier"})` ~L41720; `mi("pale_leviathan", {... legendPlace: "the_bottomless", renamedFrom: "pale_leviathan"}, { id: "lantern_swallower", ...})` ~L41866), `Wi.legend.fight` 40 / 56, `legendPlays` 50 s / 60 s, baits `prism_moth` and `last_candle`, OLD zones with legend pools.
- Unreachable in LOOP: `LOOP.waters` defines only `mossmere` and `sporewood` (searched `wo.waters.`); `shipped: "sporewood"` and `iw()` refuses any water without an order. No `LOOP.places` entry has `legend: "glass_sovereign"` or `"lantern_swallower"`, and `LOOP.legendBait` has only mossmere and sporewood keys. So `$()` can never pass for them. They are reachable only via OLD descent/`forceSpecies`. [read]

---

## 7. Handoff check (handoff.md vs code)

| Handoff claim | Code |
|---|---|
| "In the unlocked Bell Pool, Heartmoss gives a 12% chance per eligible day or dusk cast" | True. Also dawn (`he`: any phase except gloomtide). |
| "The existing cooldown still applies after an escape" | It is a 20 s session-clock `legendDimUntil`, nothing longer. |
| "The clapper ripple signals an actual Matriarch bite. ... It also plays before a hard take." | True: it fires only when the species is the Matriarch in `bell_pool`, about 1.52 s before the bite, hard take or not. |
| "strike and hard-take paths then use the existing gear-dependent landing calculation" | Partly. A legend uses its own branch of `GP` (cap 0.5, fixed fight 16/28, lure/bait ignored, no gear size cap). |
| "Murk now pays 900 ... and 360 for each rematch" | True for the Matriarch. "First" also requires no other Matriarch already in the creel. |
| The two legends have "individual legendary sequences, timings and landing rules" | Sequences: `legendPlays` 36 s / 44 s. "Landing rules": the outcome is rolled at the strike; the fight is a played-back plan. |
| (implied) Grove works like the Matriarch | Same path, but chance 1 (every eligible cast), bait spent on strike, 250 per bulb, chart 2200, sale 2200/880. No Grove-specific pre-bite cue (it still gets the shared `dome` bite tell and exactly 2 nibbles, like the Matriarch). Not exercised in the handoff's checks. |

---

## Hook points for the hunt loop

1. **The legend gate is one boolean expression.** `zt` (`i.legendCast = rollLegendBite(D(At), lt)`, ~L129361) is the single place where "can the monster bite this cast" is decided. Every investigative condition (right spot, right hour, right bait, right rig, right presentation, clue progress) can be added as a term of that `&&` chain, or folded into `rollLegendBite(bait, rng)` (rename to take a context). `forceSpecies` (~L129364) already lets a scripted moment override it.
2. **Per-lake target already exists twice.** `zone.legendary` + `arena.legendPool` (`We()`) and `LOOP.places[*].legend`. One target per lake is already the data model. Pick `LOOP.places[x].legend` as canonical; `We()` only needs the species and bait.
3. **Hours.** `LOOP.hours` + `C()` already map string hours ("day,dusk", "night", "dusk,night") onto phases. A monster's feeding window can be expressed as a `time` string with a `LOOP.hours` entry. Change Matriarch `time: "calm"` to `"day,dusk"` (or whatever) for the live check and the sheet to agree.
4. **Place / mist / chart unlocks.** `ve()` / `cast.mist` / `maps.places` + `lifted` give a purchasable, revealable "where it lives" gate. The hunt could swap "buy the chart" for "deduce the spot" by changing what adds the place to `owned`/`lifted`.
5. **Bait.** `legendBiteChance`, `consumeOnCast` and the strike-time `spendBait` give two consumption models. `LOOP.legendBait[water]` puts the bait in Murk's stock per lake.
6. **Pre-bite cue.** The `bellPoolContact` ripple in `cq()` is a per-legend tell hook (`i.bellWarned`, fires at `waitDur - sb - 0.62`). The world `legendBreath` glow intensity (`It` in the world update, fed by `gi.legendPool.active/dim`) is a ready "the monster is here and hungry" visual. The OLD `legendPoolToast` / `setLegendPool` are switched off in trips by `!xe()` and could be re-enabled for clue moments.
7. **Fight and odds.** `Wi.legend.fight/style`, `legendPlays`, wounds (`addLegendWound`, +6 Hold, +0.1 s window) give "failed attempts teach you" for free. The odds sheet already renders a legend row and a wounds line.
8. **"Landed" signal for the next lake.** `run.legendaries[id]` (set at landing) and `journal[id].caught` are the reliable "has landed" flags. The LOOP seal function `sw()` / `Zy()` is the place to add a `legend` seal next to `map`/`gear`/`catch`. The OLD `unlock.requires: [{type:"legendary"}]` + `case "legendary"` pattern is a ready template.
9. **Clue sources.** Ordinary fish already carry `O5` guide text (`haunt`, `favours`, `play`). `gotAway`/`seen` journal plumbing exists for recording sightings.

## Gaps

- **No investigation or clue state.** Nothing records "the player has learned the spot / hour / bait / rig" for a legend. The only knowledge gate is journal `seen`/`caught` hiding the odds row. (Searched `clue`, `legendKnown`, `learned` in the legend paths: not found.)
- **No rig or presentation requirement.** Legend landing ignores lure and bait items (`f = r || !n.item ? 0`), there is no gear size cap for legends, and the bite ignores the lure, retrieve, depth and cast quality. Only bait identity and place matter.
- **No legend seal for travel in LOOP.** `op()` excludes legendaries from the catch seal; `sw()` has no legend term.
- **Grove asymmetry.** Chance 1 makes the Sporewood legend a purchase, not a hunt. There is no Grove-specific pre-bite cue (only the `dome` tell shared with Elder-class fish, and 2 nibbles), no Sporewood gilt stone (`r = { mossmere: ... }`), no Sporewood eave trophy, and the Grove has no `legendSale` (its price falls back to the chart price).
- **Odds drift.** The sheet uses `journal.caught` for growth and the live roll uses the never-written `records.legendGrowth`. The sheet also excludes dawn for the Matriarch while the live check allows it.
- **Matriarch has no LOOP guide row** (`O5`), so her field-guide `haunt/favours/play` text, which other fish use as clue text, is missing. Adding one would drop `heartmoss` through the `includes("heart")` filter in `I5` unless `favours` says "bites on Heartmoss Ball only".
- **No feeding schedule beyond phase.** There is no per-day variation, tide or moon. `reveal: "moonfall"` on the Bell Pool place is a reveal rule, not a feeding rule; I did not trace it.
- **Cooldown is only 20 s and session-local.** Nothing models a monster that spooks for the rest of the evening.
- **`meta.loop.legends` counts sales, not landings**, and a legend needs a free hold slot to be kept. A design keyed on "landed" should read `journal.caught` or `run.legendaries`.
- Glass Sovereign / Lantern Swallower: species, fight and bait data exist, but there are no LOOP waters, places or shop entries for them.

## Checked

Sceptical re-check against `reading/game.pretty.js` (line numbers are that copy).

1. **Confirmed.** Live legend bite chain in `zt()` (~L129354-L129361): `!nextFish && bn && At && At === bn.baitId && C(bn.species, Dt) && i.clock >= i.legendDimUntil && (xe() ? $(bn) : hypot <= bn.r) && rollLegendBite(D(At), lt)`. No tutorial, first-evening, per-day or already-landed term. Two side notes: `bn = We()` needs the zone's `legendary` plus an `arena.legendPool` (both lakes have one); and a `forceSpecies` (the retrieve-take path ~L134392 or the debug `forceBite`/`Kb`) overrides `legendCast` to `forced.rarity === "legendary"` (~L129365).
2. **Confirmed.** `rollLegendBite` uses `bait?.legendBiteChance ?? 1` (~L104008). Heartmoss 0.12 (~L34817); Glowcap Bulb has no field (~L34827). The hour check `C()` with `time: "calm"` means "not gloomtide", so dawn also counts (YS maps dawn to day). The bulb is not `consumeOnCast`; it is spent at the strike (~L130179).
3. **Confirmed.** `ve(R)` = `xe() && I && (!owned.has(id) || !lifted.has(id))` (~L127941); `Nt()` sets `Ke.mist` from it (~L128141). The only LOOP places with `legend:` are `bell_pool` (price 500, ~L46845) and `mothers_cup` (price 2200, ~L47950).
4. **Confirmed.** `GP()` (~L49041): `p = max(0.01, 0.5/(1+exp(-0.1*(hold-fight))))`; item/upgrade terms are 0 for legends; `Tt()` returns null for legendary (~L128375); `legendPlays` 36 s / 44 s (~L43933). Fight is `fight[id]` (or `fightRun` when `perRun`) `+ min(10, landings*2)`. In a LOOP trip the loadout has `perRun: !1` (~L108217), and `landings` reads the never-written `records.legendGrowth`, so the fight is 16 / 28 in practice. The arrival `fight` add-on is skipped for legends (`vn && !At`, ~L130203).
5. **Confirmed.** The escape handler calls `ne()` (= `addLegendWound`) for a legend even on a trip (~L108878); cap `round(18/6) = 3`; `+6` Hold per wound, max 18; `windowBonus 0.1` (~L129639); cleared on landing (~L110361); `legendDimUntil = clock + 20` (~L130733, ~L132522). Also exists: `run.flags.wounded[id]` (`woundedCarry 0.5`, max 0.4) feeds `startP` of the OLD reel `aF()` only (~L131241).
6. **Confirmed.** `xF()` increments `e.legends[speciesId]` for sold creel lines (~L105077). Price `legendSale ?? waters[zone].prices.crown` then `× legendRematch 0.4` once `legends[id] > 0` or another of the same legend is in the creel (~L105735). `GA()` maps only `mossmere -> belled_matriarch` (~L97868).
7. **Confirmed.** `op()` drops legendary, epic, giant and cove species (~L105273); `sw()` returns only map / gear (`access.gear.sporewood = "rod:1"`) / catch (~L105335); `Zy()` adds nothing legend-related. Only OLD `unlock.requires {type:"legendary"}` (~L33501, L33590, L33673) ties travel to a legend.
8. **Refuted (last sentence).** Toast and `setLegendPool` are gated by `!xe()` (~L132880, ~L132888), and the bell-clapper ripple fires at `waitDur - 0.9 - 0.62` for the Matriarch only (~L134433). But "the Grove has no pre-bite cue" is wrong. Both legends get the `dome` bite tell, which starts about 0.85 s before the bite (0.6 + lastDip 0.25, ~L129737-L129753), plus exactly 2 nibbles and no feints (~L129506). That tell is not legend-specific: Elder-class fish also use `dome` (~L40655). Corrected: the Grove has no **legend-specific** pre-bite cue. Fixed in 3.2 and in the two Grove notes.
