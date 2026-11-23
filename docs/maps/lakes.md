# Gloomwater map: the two playable lakes (key: lakes)

Scope: the content inventory of Mossmere and Sporewood in the current relaxed-fishing layer. It covers places, every catchable species (visitors included), non-fish catches, Murk's stock, the legend in one table, and which fish make good clue "witnesses".

**Anchors.** Each claim carries a search string that exists in both `Gloomwater-Mossmere.html` and `reading/game.pretty.js`. `(L12345)` is the reading-copy line, given for convenience only.

**Tags.**
- **[read]**: read in the code.
- **[ran]**: observed in Playwright/Chromium (swiftshader) on `smoke/main-fixed.html`, reading `window.__gw.data` after boot. The scripts are `scratchpad/tmp-lakes/dump.mjs`, `probe2.mjs` and `probe3.mjs`. Their output is `dump.json`, `probe2.json` and `probe3.json` in the same folder. Prices on Murk's shelf are quoted from the progression mapper's run (`tmp-progression/probe2.out`).
- **[inferred]**: my deduction. It was not executed.

**Layers.** LOOP is the current layer: `wo` (exported `LOOP: () => wo`), the text table `Ca` (`TEXT_LOOP`), and `LOOP_ENABLED` (`Er`), which this build sets to true. OLD is the survival-roguelite layer: the `Ms` fish table as authored (`var Ms = [`, L33768), `x0` baits, `ZONES`/`Wr`, and the V3 world places in `Mu`. Unless a row says OLD, everything below is LOOP and live.

**Prices.** Every LOOP shop price is the data value × `wo.cost.factor`, which is 2 in this build (`globalThis.GW_LOOP_COST=2`; `function SP(`, L47189). Tables give the data value and then the shelf value, e.g. "50 → 100". [read, ran]

---

## 0. How the live catch table is built (read this first)

- **The live species list is `SPECIES` (`Ms`), rebuilt at boot.** For Mossmere the block `if ((Object.assign(BS, TP), ... Er)) {` (L49260) builds from three sources:
  - the field-guide rows `O5` (`var O5 = {`, L30772) via `I5(O5, Nf, …)` (`function I5(`, L30690);
  - the V3 table `Nf`;
  - for ids in `wo.kept`, the kept records `Pf`.

  Sporewood is rebuilt in the loop `for (let [g, p] of Object.entries(wo.species))` (L49438). `wo.leftOut.sporewood = ["sporebelly_puffer","plumgill_perch","hushcap_koi"]` removes three OLD Sporewood fish (`wo.leftOut =`, L48022). [read]
- **Runtime count: 33 records** with `zone` mossmere or sporewood, or a `guestOf`, including the 2 legends. [ran]
- **Text fields.** The journal line is the live record's `lore`. The clue/haunt line is its `hint`. For a species that already had a `Nf`/OLD record, `I5` keeps that record's `lore`/`hint`. The `O5` `journal`/`haunt` strings are used only for new roster species (`lore: u.journal, hint: u.haunt` inside `I5`, L30763). The `O5` `play` string sets the fight style (`function zQ(`, L30636). So `O5.journal` for `dusk_minnow` ("Caught on a scrap of silver paper…") never shows; the live lore is the `Nf` one. [read, ran]
- **Weighted pool per cast:** `placePool` = `function ute(` (L47686), called from the live roll `Ce` → `G5(` (L129257).
  - Base weight by rarity: `U7 = { common: 70, uncommon: 24, rare: 6 }` (L37351). Epic is used only for giants.
  - Hour gate: the record's `time` maps to lights through `L5` (`var L5 = Object.freeze(`, L30622) and `dte = { calm: ["day","dusk"], gloom: ["night"], dawn: ["day"] }` (L47674). `"dusk"` means dusk **and night**. `"any"` means all three lights.
  - Light from phase: `YS = { calm: "day", dawn: "day", day: "day", dusk: "dusk", gloomtide: "night", night: "night" }` (L47659).
  - A record with `bait` set bites **only** on that bait: `if ((v.bait && v.bait !== o) ...) continue`. A matching bait multiplies the weight by 1.5.
  - At a place: commons ×0.5 (`place.common`). At a `day` place, non-commons ×1.5 (`dayDraw`) unless the place has a `draws` entry for that fish. A fish whose `kind` matches the place kind gets ×2.5 (`kindWeight`). A fish tied to a place (`place`, or `own` with `only`) gets 6 × 3 × 0.5 = 9 (`kept: { weight: 3, live: 0.5 }`).
  - **A `night` place counts as open water except at night** (`d = c && !(c.kind === "night" && i !== "night") ? …`).
  - If the total is under 70, off-hour open fish are added at base weight. This fallback is why Rosefleck shows up at Veilback Brook at night.
  - Legends are never in this pool (`v.rarity !== "legendary"`). [read, ran: full grid in `probe2.json`]
- **Giant share:** `function RP(` (L47680), `giant: { share: { inHour: 0.06, offHour: 0.025 } }` (L46855). The giant is added at weight `tot × share / (1 − share)`. The lure's `share: 1.5` multiplies the share when that lure lists the giant (`function P7(`, L32507). [read, ran]
- **Presentation filter ("hook table"):** `function Rl(` (L32451) looks up a grade 0–3 per species × item in `bs[water].hook.table`. A fitted lure takes precedence. Otherwise the bait is used, and with no bait the grade is `bare`. Weight × `mult: [0, 0.5, 1.6, 2.5]` (`l1`, L32480). Grade 0 means the fish refuses: weight 0 and take chance `stray: 0` (`function _7(`, L32456). Mossmere item order is `var Ph = [` (L31561): bare, mireworm, lumen_moss, cut_strip, feather_fly, glimmer_spoon, bone_jig, bell_spinner, bent_spoon, guard_button. Sporewood order is `TS = [` (L31967): bare, spore_cake, amber_larvae, cut_strip, spore_moth, ember_minnow, root_jig, sporelamp_fly, seedpod_twirl. Sporewood `guard_button` is computed: 2, or 0 for `kS.not` = harpstring_eel, festival_puffer, threadling_eel, sleepspore_jelly (`kS = Object.freeze(`, L32011). [read]
- **Where in open water (area):** in open water only (`!n && t`), the area raw weight `GQ` (Mossmere, L31575) or `A7` (Sporewood, L31984) multiplies the pool weight. The columns are `hg = ["margin","reeds","pads","stones","dropoff","lane","open","deep","inflow","outflow"]` (L31560). At a place, only the light tilt `C7` applies (`function ES(`, `function C7(`, L32440). [read]
- **Size cap ("needs a better rig"):** `function Bd(` (L32962) takes the lowest of three caps:
  - item cap `gearCap.item`: bare, bent_spoon and seedpod_twirl land up to keeper; cut_strip up to prize;
  - line cap `gearCap.lineAt`: Mossmere line hold < 2 → prize, < 5 → trophy, else elder. Sporewood < 4 → prize, < 7 → trophy, else elder;
  - hook-grade cap `gearCap.grade = [null,"keeper","prize","elder"]`, where grade 0 → keeper.

  (`wo.gearCap = {`, L47221; `wo.gearCap.lineAt`, L48093) [read]
- **Landing chance once hooked:** `function GP(` (L49041).
  - `p = max(0.01, cap[class] / (1 + e^(−0.1 × (hold − fight))))`.
  - fight = `lake` (mossmere 0, sporewood 7) + `style` (steady/darter 0, sinker/leaper 1, thrasher/runner/sulker 2) + `headline` 2 (reedjaw_pike, mildew_angler) + `kept` −2 (any record with `place`) + `class` (small −10, keeper −6, prize 7, trophy 15, elder 18) + the species `pressure` from `registerLakeFight(` (L48989).
  - hold = wick 10 + tackle + item + strike (clean 8 / struck 2).
  - cap = small/keeper 0.95, prize 0.93, trophy 0.88, elder 0.84. [read, ran: `CATCH_V3` values in `probe3.json`]
- **Sale value:** `fishClams` = `function $ee(` (L47242). `round(tier × rarityMult × clamp((L50/45)^0.5, 0.6, 1.6) × clamp(e^(0.9z), 0.4, 30) × classBonus)`, where:
  - tier is Mossmere 7 / Sporewood 12, and the **current water's** tier is used (`a()?.zone || H.zone`, L105741);
  - rarity is common 1, uncommon 2.4, rare 5.5, epic 12;
  - class bonus is trophy 1.25, elder 1.6 (`value:` in `wo`).

  OLD `value` fields are ignored. The tables give the median (z = 0) and z = 1.5 (prize). The formula was checked against `fishClams` in the page. [read, ran]
- **Size classes:** `SIZE_CLASSES`: small z < −0.25, keeper < 1.04, prize < 1.88, trophy < 2.65, elder above. [ran]

---

## 1. Mossmere

### 1.1 Places

Geometry is `Mu.places` (V3 world, `places: [` near `id: "bell_pool"`, L42495), read through `Q5` (L47642). LOOP rules are `wo.places` (`places: {` inside `wo`, L46812). Shelf rule: the Maps tab offers at most the **two cheapest** unowned, non-secret places of the barge water (`function X3(`, L105367, `.slice(0, 2)`). A bought place is then "lifted" out of the mist (`Ca.murk.firstMap: "It's in the mist. Go and look."`). A cast into an owned but unlifted place counts as mist (`cast.mist`). [read]

| id | Name | Kind | Shape, centre, size [ran] | Opens how | Special (LOOP) | Map line (`Ca.maps`) |
|---|---|---|---|---|---|---|
| (open water) | — | open | lake bounds; home mooring dock 0 at (24, 38) | always | all open-water fish, weighted by area | — |
| `lily_maze` | The Lily Maze | day | disc (−40.5, 24.5) r 7.5, depth 0.3–0.6 | buy 60 → **120** | `card: "candlefin_koi"`, `draws: { candlefin_koi: 3, weeping_carp: 1.5 }`, `out` path from the dock | "Koi glow under the pads like lanterns." |
| `under_the_span` | Under the Span | old | path (−40,−4)→(−19,5), width 8, depth 0.45–0.9 | buy 150 → **300** | giant `thousandcast_pike`; `own: ["bridgechain_sturgeon"]` | "The bridge kept its chain. Something kept it." |
| `buoy_lights` | The Buoy Lights | night | rect (−48, −2), 4 × 24, depth 0.4–0.8 | buy 260 → **520** | giant `hullkiss_lamprey`; acts as a place **only at night** | "The harbour lights went under, still lit." |
| `bell_pool` | The Bell Pool | crown | disc (−4, −14) r 6, depth 0.8–1; `legendPool` r 3.2 | buy 500 → **1000** | legend `belled_matriarch`; harbour-bell scenery | "The moon looks in on the old bell." |
| `veilback_brook` | Veilback Brook | day, `secret: !0` | path (60,4.1)→(75,5.1), width 5, depth 0.5–0.7 | free. Granted when the **Veil Angler's Notebook** is fished up (`lostTackle.veil_notebook.reveals`; `function v7(`, L31475, pushes it to `places.revealed` and `maps.places`) | `only: !0` with `own: ["rosefleck_trout","rainglass_darter"]` and `draws: { dusk_minnow: 1.5 }`, so **only those three fish bite** here; `good: 1` | Murk: "Water behind the Veil. Always said so." |

The world record for Veilback is `var J5 = Object.freeze({` (L47513): `lore: "Behind the falling water, the old cut still runs."`, `needs.veil: "mist"`, and a shore notch. [read]

**V3 places present in `Mu` but not live in LOOP** [read; ran: the LOOP arena lists only the 5 above]: `cupped_hands` (The Cupped Hands, "The Aqueduct Coughs"), `gatehouse_door`, `ferry_market` (Moonfall), `sluice_run` ("The Broken Teeth", `attract: { reedjaw_pike: 2, gloam_eel: 2 }`) and `moon_cistern` (secret, `reward: "reed_pole"`). The V3 rule blocks on the live places (`rule: { type: "targets", name: "Threading the Span" … }`, Lily Maze "Lanterns Under Snow", Buoy Lights "The Old Channel" with `gloomMult: 2`, Bell Pool `reveal: "moonfall"`) are **not carried** into the LOOP place record. `Q5` copies only `zP = ["id","name","x","z","access","stand","water","landmark","look","build"]` (L47641). I did not check whether any fishing code reads `Mu` rules directly. [read]

**Scenery and landmarks** (geometry [ran], `ZONE_BY_ID.mossmere.arena`):
- Islands: Drowned Gatehouse (tower, 22,−12, r 8), Mossbell Isle (rock, −30,14, r 6), Root Isle (34,20, r 5), Stair Isle (−14,28, r 4), Elder Sister (−30,−24, r 5) and Younger Sister (−18,−34, r 4).
- The gate is The Moss Sluice (0,−49, r 4.5). The `inflow` area is at (54,4) r 9 and is labelled "the Sluice Veil" (`Ca.lost.where.inflow`). The `outflow` is at (0,−49). Lily beds are at (−26,34), (40,28), (−20,−50) and (−6,52) (`bs = {` → `mossmere.geometry`, L31618).
- **Harbour bell:** `function buildHarbourBell(` (L78811) is placed on the Bell Pool disc (`let Te = y.find((ht) => ht.id === "bell_pool")`, L79690). It is visible only when the Bell Pool is lifted or lifting (`harbour.frame.visible = harbour.clapper.visible = !!(bank.lifted || bank.lift)`, L80484). The handoff says a ring starts at the clapper shortly before a Matriarch bite. I did not trace this; the legend mapper owns it.
- **Mossbell Isle angler:** `rockAngler = makeRockWick()` is built only when `o.id === "mossmere" && e.data?.LOOP_ENABLED` (L76927). It is visible whenever `flow === "playing"` (L78162). The handoff says he is ambient only, with no hooks into inventory, journal or economy. In my search, `rockAngler` is referenced only by build and update code. [read]
- **Giant's back:** `giantBack: { every: [25, 45], dur: 3, phases: ["gloomtide"], places: ["under_the_span","buoy_lights"] }` (L46858). This is a periodic surface ripple at a giant place at night, which emits `world:giantBack` (L80402). It is built inside the world builder after the old `tt` typo line, which was fixed in 5a216a5 ("Fix places layer failing to build on load"), so it runs. By design it rolls only while that place is still in mist (the `giantBack` gate), so a player who has bought Under the Span never sees it there.
- Heron isles list `["Mossbell Isle","Stair Isle","Drowned Gatehouse","Root Isle"]` is wildlife only (L46912).

### 1.2 Catchable species (live records)

Hook-grade notation: **3** best, **2** good, **1** weak, every other item 0 (refused). From `UQ = {` (L31590) and the guest table `E7 = {` (L31609). Area column: the top three of `GQ` (raw multipliers). "Pool weight" is from `probe2.json` (base, no bait unless noted). [ran]

| id | Name | Rarity | Size L50 cm (σ) → weight span kg | Lights (`time`) | Where | Hook grades | Fight: style / gait / pressure | Sale clams z0 / z1.5 |
|---|---|---|---|---|---|---|---|---|
| `dusk_minnow` | Dusk Minnow | common | 21.2 (0.10) → 0.07–1.19 | any | open: margin 2, lane 2, reeds 1.8. Veilback draw 1.5 | 3 mireworm; 2 lumen_moss, feather_fly, guard_button; 1 bare | darter / dart / −2 | 5 / 19 |
| `mossback_perch` | Mossback Perch | common | 28.3 (0.10) → 0.16–2.82 | any | stones 2.5, dropoff 2, outflow 2 | 3 mireworm, bone_jig; 2 cut_strip, glimmer_spoon, bell_spinner, bent_spoon, guard_button; 1 bare, feather_fly | steady / dart / −0.5 | 6 / 21 |
| `gutter_crayfish` | Gutter Crayfish | common | 19 (0.10) → 0.11–1.97 | any | stones 3, inflow 1.5, outflow 1.5; night tilt ×1.8, night stones 4.5 | 3 mireworm, cut_strip; 2 guard_button; 1 bare, lumen_moss | sinker / kick / −1.5 | 5 / 18 |
| `likely_chub` | Likely Chub | common | 37.7 (0.10) → 0.38–6.67 | day, dusk | inflow 2.5, stones 2, reeds 1.5 | 3 feather_fly; 2 mireworm, lumen_moss, cut_strip, bell_spinner, guard_button; 1 bare, glimmer, bone_jig, bent_spoon | darter / rush / +0.5 | 6 / 25 |
| `overbold_bass` | Overbold Bass | common | 32.5 (0.10) → 0.25–4.28 | day, dusk | stones 2.5, reeds/pads 1.5; `leaps: { overbold_bass: 0.3 }` | 3 bone_jig; 2 mireworm, cut_strip, feather_fly, glimmer_spoon, bell_spinner, bent_spoon, guard_button; 1 bare | leaper / rush / +1 | 6 / 23 |
| `rustfin_sucker` | Rustfin Sucker | common | 37.7 (0.10) → 0.32–5.65 | any | inflow 3.5, outflow 2.5, stones 1.2 | 3 mireworm; 2 guard_button; 1 bare, lumen_moss | steady / hold / 0 | 6 / 25 |
| `lampsipper` | Lampsipper | common | 26 (0.12) → 0.11–2.72 | **night only** (`gloom`) | lane 2, pads 1.8, margin 1.5 | 3 feather_fly; 2 lumen_moss, guard_button; 1 bare, mireworm | darter / dart / −2 | 5 / 21 |
| `weeping_carp` | Weeping Carp | uncommon | 52.6 (0.12) → 1.13–27.7 | any | margin/reeds/pads 2. Lily Maze draw 1.5 | 3 lumen_moss; 2 mireworm, guard_button | sinker / longRun / +1.5 | 18 / 70 |
| `candlefin_koi` | Candlefin Koi | uncommon | 46 (0.13) → 0.67–19.3 | day, dusk (`calm`) | pads 3, margin 1.5. **Lily Maze draw 3** (card fish) | 3 lumen_moss; 2 guard_button; 1 mireworm, feather_fly | darter / longRun / +1.5 | 17 / 66 |
| `milkeye_perch` | Milkeye Perch | uncommon | 52.6 (0.12) → 0.67–16.4 | dusk, night | dropoff 2.5, deep 2, outflow 1.5; at night margin 2.5 | 3 cut_strip, bone_jig; 2 glimmer_spoon, guard_button; 1 mireworm, bell_spinner, bent_spoon | darter / dart / −0.5 | 18 / 70 |
| `kissmark_trout` | Kissmark Trout | uncommon | 65.7 (0.12) → 1.52–37.1 | any | deep 3, inflow 2.5, dropoff 2 | 3 glimmer_spoon; 2 cut_strip, feather_fly, bone_jig, bell_spinner, guard_button; 1 mireworm, bent_spoon | sinker / runner / +1.5 | 20 / 78 |
| `reedjaw_pike` | Reedjaw Pike | rare | 61.2 (0.14) → 0.74–25.4 | any | reeds 3, pads 2, stones/dropoff 1.5 | 3 cut_strip, glimmer_spoon, bell_spinner; 2 bone_jig, guard_button | thrasher / rush / +2 (+2 headline) | 45 / 173 |
| `bridgechain_sturgeon` | Bridgechain Sturgeon | rare | 70 (0.16) → 0.79–37.7 | any | **Under the Span only** (`place: "under_the_span"`), weight 9 at every light | 3 mireworm, cut_strip; 2 guard_button | sinker / longRun / +2 (−2 kept) | 48 / 185 |
| `gloam_eel` | Gloam Eel | rare | 72 (0.13) → 0.38–10.9 | **night only** | **Buoy Lights at night, on Lumen Moss only** (`bait: "lumen_moss"`, patched `kind: "night"`), weight 22.5 | 3 lumen_moss, everything else 0 | leaper / wriggle / +0.5 | 49 / 188 |
| `thousandcast_pike` | Thousandcast Pike (giant) | epic | 69.4 (0.16) → 0.96–45.9 | `dusk` (dusk + night in-hour; off-hour share 0.025 by day) | Under the Span giant, share 0.06 (×1.5 on bell_spinner) | 3 bell_spinner; 2 glimmer_spoon, bone_jig | thrasher / rush / +2 (−2 kept) | 104 / 402 |
| `hullkiss_lamprey` | Hullkiss Lamprey (giant) | epic | 70.2 (0.16) → 0.29–13.9 | night | Buoy Lights giant at night, share 0.06 | 3 bell_spinner; 1 glimmer_spoon | sulker / wriggle / +0.5 (−2 kept) | 105 / 405 |
| `belled_matriarch` | The Belled Matriarch | legendary | L50 260 cm, W50 120 → 120–180 kg | `calm` | Bell Pool (legend roll, not the pool) | own bait only (`heartmoss`) | see 1.6 | first sale 900, then 360 |

**Visitors (guests)** (`wo.guests = { mossmere: ["rosefleck_trout","rainglass_darter","nightbloom_carp"] }`, L47494; rebuilt with `guestOf: "mossmere"` at L49288):

| id | Name | Rarity | Size | Lights | Where in Mossmere | Hook grades (`E7`) | Fight | Sale (Mossmere tier) z0 / z1.5 |
|---|---|---|---|---|---|---|---|---|
| `rosefleck_trout` | Rosefleck Trout | uncommon | 43.8 (0.12) → 0.45–11.0 | day, dusk | Veilback Brook (`own`, weight 9; 24 at night through the fallback); also an open-water guest in the `inflow` area by day/dusk at share 0.04 once the Veil notebook is held | 3 feather_fly; 2 cut_strip, glimmer_spoon, guard_button; 1 mireworm, bone_jig, bell_spinner, bent_spoon | darter / runner / +1.5 | 17 / 64 |
| `rainglass_darter` | Rainglass Darter | rare | 31 (0.14) → 0.14–4.84 | day, dusk | **Veilback Brook only** (`own`), weight 9 | 3 feather_fly; 2 guard_button; 1 mireworm | darter / dart / −2 | 32 / 123 |
| `nightbloom_carp` | Nightbloom Carp | rare | 73.4 (0.14) → 2.73–93.4 | night | open-water guest in `pads` at night, share 0.03, **only with the Lily Gardener's Notebook** (`lily_notebook.guest`) | 3 lumen_moss; 2 mireworm, guard_button; 1 bone_jig | sinker / longRun / +1.5 | 49 / 190 |

The guest share is `share × tee[grade]` with `tee = [0, 0.25, 1, 1.5]` (`var tee =`, L32549). The guest mechanism is `function I7(` (L32550). Guest fight `lake` comes from the record's zone through `BP(s)` unless the caller passes the lake: Rosefleck and Rainglass are `zone: "glasswater"` (lake 16), Nightbloom is `zone: "sporewood"` (lake 7). I did not check which applies in a live Mossmere fight [inferred].

**Journal (`lore`) and clue (`hint`) text, live records** [ran]:

| id | lore | hint |
|---|---|---|
| dusk_minnow | "They school beneath the raft like thrown pennies, pewter flecked with rust, each one wishing for nothing at all." | (none) |
| mossback_perch | "A pale lichen tuft takes root on its back by its third winter, and blooms a little more every year it is not caught." | (none) |
| gutter_crayfish | "It hoards drowned buttons in its burrow. No one knows whose coat it is trying to finish." | (none) |
| likely_chub | "It looks like a chub. Nobody has checked." | "Shallows under overhanging stone and reeds. Sign: a soft kiss on the surface." |
| overbold_bass | "Attacks lures its own size. It has never once won." | "Rocky shallows and drop-offs. Sign: a sharp strike splash." |
| rustfin_sucker | "Kisses every stone on the bottom, in case one of them is home." | "Stony bottom where water moves under the Span. Sign: a bubble trail." |
| lampsipper | "Two moth-wing spots on its flanks, an upturned mouth, and a weakness for lanterns. It drinks the light off the water like milk." | "Only at night, in the shallows. It rises to your own lantern." |
| weeping_carp | "Pewter and ivory, streaked as if with tears. The oldest trail barbels like mourning ribbons. They have never once said they were not mourning." | (none) |
| candlefin_koi | "Its fins burn without heat. More than one Wick has mistaken it for kin, and leaned too far." | (none) |
| milkeye_perch | "Eyes like two spilt saucers of milk. It sees you perfectly well." | "Deep murky water by day, the shallows after dark. Sign: two pale eye-points; nervous water at dusk." |
| kissmark_trout | "Star-spotted, and wearing one round scar where something let go." | "The deepest open water. Sign: none on top; a long slow drag-under." |
| reedjaw_pike | "Slate-blue, barred like reeds in ink. … The old ones carry pale scars from everyone who almost had them." | (none) |
| bridgechain_sturgeon | "Rust scutes run down its back like the links of the chain that held the bridge. The Mossmere's longest fish, and it knows it." | "Under the broken bridge, but only when the water goes still as a mirror." |
| gloam_eel | "An ink eel strung with moon-violet lights. It rises only when the Gloom does. Some say it is the Gloom, slowly learning to be a fish." | "Rises at night, in deep water. Drawn to the glow of Lumen Moss, and to the drowned buoy-lights." |
| thousandcast_pike | "Follows the lure to the raft, looks at you, and leaves. Ten thousand times." | "Old water under the Span, beside one drowned rock. Sign: a long shadow that follows the float and turns away." |
| hullkiss_lamprey | "It only wants to hold on to something. Anything. You will do." | "Night water at the Buoy Lights, on the lit buoys and under the hull. Sign: seven lavender points in a row." |
| belled_matriarch | "A harbour bell grew into her skull when she was young. …tolled for the drowned ever since." (epithet "She Who Tolls for the Drowned") | "Listen for a bell beneath the calm, far out in deep water. She takes only Heartmoss." |
| rosefleck_trout | "Blunt-nosed and rose-flecked, like something pressed in a book." | "Fast clear water at the foot of the Stilled Cascade. Sign: a rise ring in the current." |
| rainglass_darter | "Rain that fell into the cascade the moment it froze, and decided to stay." | "Under the Stilled Cascade, while the light lasts." |
| nightbloom_carp | "A plum carp whose scales open at night like amber spore-lamps. By day it is just a carp, and a little embarrassed about it." | "Anywhere in the Pools, but only at night, when its scales open." |

`O5` `play` lines (fight description), e.g. thousandcast_pike: "Thrasher. Follows and turns away before it ever bites. Slamming take, two leaps with head-shakes, a run under the raft." The full set is in `scratchpad/tmp-lakes/o5.json`. [read]

**Where the text or older data disagrees with the live roll** [read, ran]:
- `hullkiss_lamprey`. Text and fields: `O5.favours` "Predator: Cut Strip; Moth Popper." and `baits: ["moth_popper","cut_strip"]`. Live hook table: `bell_spinner` 3, `glimmer_spoon` 1, **cut_strip 0**. `moth_popper` is not sold in LOOP (absent from `wo.lures`).
- `thousandcast_pike`. Text: `O5.favours` "…Known to ignore it and take the plainest bait." Live: mireworm and bare are **0**.
- `bridgechain_sturgeon`. Text: hint "only when the water goes still as a mirror". Live: bites at every light. `weather` is in the `PARKED` list (the progression mapper's §1).
- `rosefleck_trout`, `rainglass_darter`. Text: hints name the Stilled Cascade (Glasswater). Live: they are at Veilback Brook and the Sluice Veil inflow.
- `nightbloom_carp`. Text: "Anywhere in the Pools". In Mossmere it is a notebook guest on pads at night. In Sporewood see 2.2: Veilwater only.
- `lampsipper`. Field: `lightAttract: 2` (L41254). It is never read (searched `lightAttract`: one hit), so "It rises to your own lantern" is flavour only.
- `candlefin_koi`. Field: `spots: { lily_maze: 3 }`. The species field `spots` is never read (searched `spots`). The live Lily Maze boost comes from `wo.places.lily_maze.draws`.
- `prefers` ("drip"/"hush"/"mist"). It adds a `match.condition` favour only when `R.prefers === I.condition` (L128304), and weather is parked. Probably inert [inferred].
- OLD `x0` bait `bonus.attract` lists (`var x0`/`x0 = [`, L34716) and OLD `value`/`food`/`oil`. LOOP ignores them: `baitAttract` is parked, and sale uses `$ee`.
- `gloam_eel` is **not** in `wo.species.mossmere` or `O5`. It survives as an OLD/`Nf` record and is patched to `kind: "night"` (`Object.entries({ gloam_eel: "night" })`, L49308). It is live (see the table), but it is **not counted** in the lake's species list for the catch seal, because `op()` uses `plainBaitOnly`.

### 1.3 Non-fish catches (snags)

All live LOOP. Snag chance is `snag: { perBite: 0.05, firstEvening: 0, legendCast: 0 }` (`wo.finds = {`, L47305; `function g7(`, L31387). On a snag the item is drawn from `findShares` = `function a1(` (L31341):
- tackle pieces split `tackle.share 0.48` equally among those not yet owned;
- parts and looks split up to `min(kind.cap 0.8, partCap 0.8 − tackle)`, starting at `kind.share 0.35`. After each treasure the share steps up by 0.15 (`function m7(`);
- treasures take the rest by grade share: plain 0.54, fine 0.29, precious 0.12, rare 0.04, jackpot 0.01.

Parts, looks and tackle are one-off (`!Zl(l, item.id)`). Treasures repeat. Fresh-save shares [ran]: each tackle piece 0.08, each part/look 0.0533, tin_spoon 0.0195, door_ring 0.0105, salt_lens 0.12, two_headed_coin 0.04, toll_purse 0.01.

| id | Name (`Ca.finds.items`) | Kind | Grade / slot | What it does or unlocks | Line |
|---|---|---|---|---|---|
| `tin_spoon` | Bent Tin Spoon | treasure | plain (×2) | clams | "Someone ate every meal with this, slowly." |
| `door_ring` | Brass Door-Ring | treasure | fine (×6) | clams | "Off a door four Wicks tall." |
| `salt_lens` | Salt-Glass Lens | treasure | precious (×15) | clams | "Fitted to a lantern long since drowned." |
| `two_headed_coin` | Two-Headed Coin | treasure | rare (×50) | clams | "Lucky, they said. Heads every time." |
| `toll_purse` | The Toll-Keeper's Purse | treasure | jackpot (×250) | clams | "Full. Nobody came to collect." |
| `buoy_bell` | Rust Buoy-Bell | part | `effect: "order"`, bow_post | +1 order, when Murk's Order Board ≥ 1 (`function w7(`) | "It rang the boats home once." |
| `gate_glass` | Gate Lamp-Glass | part | `effect: "bite"`, cabin_windows | +1 good bite per water (`function F5(`) | "Amber, from the Gate's drowned lamps." |
| `moat_bollard` | Moat Bollard | part | `effect: "bait"`, `bait: "mireworm"`, stern_deck | free bait floor, like the bait bed (`W2`) | "Carved stone. Boats tied here for centuries." |
| `rod_tassel` | Knotted Rod Tassel | look | wick_rod | cosmetic | "Every knot, a fish someone was proud of." |
| `toll_vane` | Toll-Tower Vane | look | raft_stern_post | cosmetic | "It still points into the wind." |
| `lily_boxes` | Night-Lily Window Boxes | look | barge_window_boxes | cosmetic | "A window box, still flowering." |
| `lamp_pole` | Lamplighter's Pole | tackle | rod | `castMax: 26, hookWindow: 1, hold: 0`. "Casts farther than any rod sold." | "It lit the drowned buoys, once." |
| `belfry_winch` | Belfry Winch | tackle | reel | `playMult: 0.6, hold: 2`. "Brings every fish in quicker." | "Cut from the belfry's clockwork." |
| `ferry_thread` | Ferrywife's Thread | tackle | line | `waitMult: 0.8, hold: 2, cap: "trophy"`. "Fish bite sooner on it." | "Spun on the ferry between rows." |
| `guard_button` | Gate-Guard's Button | tackle | lure | becomes a lure (`wo.lures.guard_button = { …, found: !0 }`). Grade 2 for most fish, 0 for giants and the gloam eel. "Most fish take it. Never giants." | "Off a gate guard's coat, drilled." |
| `veil_notebook` | The Veil Angler's Notebook | tackle | notebook | `boost: { kissmark_trout: 1.2 }`; Rosefleck guest at inflow, day/dusk, 0.04; **`reveals: "veilback_brook"`**. Pity counter: `guarantee: { item: "veil_notebook", step: 0.05, cap: 0.4 }`, `bonusCap: 0.2`, `tackleMiss[water]` | "Fished the Veil every day, it says." |
| `lily_notebook` | The Lily Gardener's Notebook | tackle | notebook | `boost: { weeping_carp: 1.5, candlefin_koi: 1.5 }`; Nightbloom guest on pads at night, 0.03 | "Every carp in the moat, by name." |

Anchors: `wo.finds.items.push(` (L47407), `wo.finds.tackle = {` (L47415), `wo.lostTackle = {` (L47421). Murk's lines: `firstTreasure` "The water keeps what it takes. Mostly.", `firstPart` "That'll fit her. I'll see to it by morning.", `firstTackle` "Somebody fished here before you."

### 1.4 Murk's stock in Mossmere

| Slot | id (name) | Data price → shelf | Effect |
|---|---|---|---|
| Rod | `willow_switch` (Willow Switch) start · `ashwood_rod` (Ashwood) · `whalebone_rod` (Whalebone) | 0 · 50 → 100 · 300 → 600 | hold 0/2/5; cast +0/+1.5/+3 m on 16 m; hookWindow ×1/1.04/1.08 (`wo.gear = {`, L48035, from `Gc`, L43307) |
| Line | `twine` · `braided_gut` (Braided Gut) · `waxed_silk` (Waxed Silk) | 0 · 100 · 600 | hold 0/2/5. Hold also sets the line size cap: <2 prize, <5 trophy, else elder |
| Reel | `wooden_winch` · `brass_spool` · `clockwork_reel` (Clockwork) | 0 · 100 · 600 | hold 0/2/5 |
| Lure | `bent_spoon` (start) | 0 | hold 3, caps at keeper, `favour: -0.25` |
| Lure | `feather_fly` (Feather Fly), family insect | 50 → 100 | "+5 Hold against insect eaters." / "For Dusk Minnows, Chub, Lampsippers and Koi." |
| Lure | `glimmer_spoon` (Glimmer Spoon), predator | 90 → 180 | "+6 Hold against predators." / "Flash, for pike and the big hunters." |
| Lure | `bone_jig` (Bone Jig), bottom | 110 → 220 | "+6 Hold against bottom feeders." / "Hopped deep, for big perch and bass." |
| Lure | `bell_spinner` (Harbour-Bell Spinner) | 180 → 360 | `giants: [thousandcast_pike, hullkiss_lamprey, reedjaw_pike]`, `share: 1.5`, `hold: 10`. "For the Mossmere's giants." |
| Bait tin | `mireworm` (Mire Worms) | tin → 20 [ran] | "Nearly every fish takes a worm." Start kit 10 (`wo.start`) |
| Bait tin | `lumen_moss` (Lumen Moss) | tin → 20 [ran] | "For the Gloam Eel and the Candlefin Koi." (an earlier shelf line, overwritten: "The Gloam Eel bites on nothing else.") |
| Bait | `cut_strip` (Cut Strip) | not sold: 3 strips from letting a small or keeper fish go (`wo.cut = { strips: 3, classes: ["small","keeper"] }`) | "Meat, for the hunters."; +0.3 favour vs predators; caps at prize |
| Legend bait | `heartmoss` (Heartmoss Ball) ×10 | 10 → 20 | `legendBiteChance: 0.12`, `consumeOnCast: true`. "Ten Heartmoss Balls. Fish the Bell Pool by day or dusk. Other fish take them too." |
| Maps | the four places in 1.1 | 120 / 300 / 520 / 1000 | two cheapest shown at a time |
| Hold | Lidded Creel 4, Double Creel 5, Wellbox 6 (start Wicker Creel 3) | 200/500/1000 → 400/1000/2000 | slots (`hold.ladder`, `shelfMax: 6`) |
| Raft | Oars I/II | 60/300 → 120/600 | speed 1.5 "Faster." |
| Raft | Keel I/II/III | 100/600/3000 → 200/1200/(6000) | `favour: 0.1` "Bigger fish." Keel III has `with: 4` |
| Raft | Lantern I/II | 100/500 → 200/1000 | `favour: 0.1, light: 0.15` "Bigger fish at night." |
| Home | Bait Bed I/II/III | 120/700/9000 | free bait floor 3/6/10 "Free bait every evening." |
| Home | Murk's Order Board I/II/III | 70/400/4000 | 1/2/3 orders; "Orders pay double." |
| Home | The Long Wall wings I–IV; Barge lights I–III | 250/30000/80000/150000; 200/1200/14000 | prints gallery; barge light |
| Looks | Slate Cloak Dye, Oxblood Pennant, Amber Lantern Glass | 300/400/600 → 600/800/1200 | cosmetic |

Anchors: `wo.lures = {` (L47114), `wo.tins = {` (L47128), `wo.raft = {` (L47130), `wo.home = Object.assign(` (L47135, L47817), `wo.looks = {` (L47822), the shelf strings `Object.assign(Ca.shelf, {` (L47147, L47203).

`with` is the water `order` that must be in `maps.lakes` (`function $re(`, L102560). Tiers whose `with` is 3 or more are never offered in this build (for example Keel III, Order Board III, Bait Bed III, Long Wall II–IV, Barge lights II–III). This is read for the home items and inferred for the raft. Note the progression mapper's finding: after a Sporewood trip, Murk in Mossmere sells **Sporewood** rods, lines, reels and raft parts (`gearWater` never resets).

### 1.5 The legend, today

| | The Belled Matriarch |
|---|---|
| Place | cast inside `bell_pool` (disc r 6); it must be **owned and lifted** |
| Bait | `heartmoss` only, spent on cast. Outside the pool it is treated as a bare hook (`bait: oe(I) ? null : …` in `Ce`, L129262) |
| Light | `time: "calm"` → any phase except gloomtide (day, dusk) |
| Chance | `rollLegendBite`: `legendBiteChance 0.12` per qualifying cast (L104008); 20 s rebite delay after a loss |
| Landing | fight 16 + 2 per landing (cap 10), legend cap 0.5, +6 hold per prior escape (cap 18) |
| Sale | `legendSale: 900` the first time, then × `legendRematch 0.4` = 360 |

The legend mapper (`maps/legend.md` §2) has the full check order.

---

## 2. Sporewood

### 2.1 Places

Geometry is `var _P = Object.freeze({ places:` (L47959). The lake outline is `var LP = Object.freeze({` (L48214). LOOP rules are `Object.assign(wo.places, {` (L47887). The chart costs `lake: 1400 → 2800`. Buying it grants every `lake: !0` place.

| id | Name | Kind | Shape, centre, size | Opens how | Special | Map line |
|---|---|---|---|---|---|---|
| (open) | — | open | 3 bowls: West Pool (−46,4) r 32, East Pool (40,−4) r 26, "the neck" (0,6) r 10; dock (36.59, 32.5) | when the lake opens (chart, plus `rod:1` and the Mossmere catch list; progression map §3b) | — | `sporewood`: "A harp in the Pools knows one song." |
| `lullaby` | The Lullaby | day | disc (−51.5, −35) r 7, depth 0.3–0.55 | free with the chart (`lake: !0`) | `card`/`own: ["sleepspore_jelly"]`, `draws: { velvet_ray: 3 }` | "Something sleeps under every lily raft." |
| `gill_harp` | The Gill Harp | old | disc (0, 6.5) r 4.5, depth 0.5–0.65 (in the neck) | free with the chart | giant `harpstring_eel`; `draws: { cindertail_catfish: 2 }` | "The gills hang down. One of them hums." |
| `veilwater` | The Veilwater | night | disc (−86, 38) r 5, depth 0.4–0.7 | buy 1200 → **2400** | giant `festival_puffer`; place only at night | "Behind the moss, a lantern floats." |
| `mothers_cup` | The Mother's Cup | crown | disc (48, 6) r 6, depth 0.8–1; `legendPool` r 3.2 | buy 2200 → **4400** | legend `drifting_grove` | "The Mother breathes. Big things breathe with her." |

Islands [ran]: Mossback Isle (moss, −50,−6), The Mother's Foot (cap, 59,12), Rootknot (22,−12), The Two Stools (−28,14 and −24,19.5) and The Tussock (−62,22). There is no gate. The inflow is (74.5,−24) r 8. The outflow is (−66,37), next to the Veilwater. Lily beds are at (−54,32), (−40,34.5) and (−76.5,34) (`bs.sporewood.geometry = {`, L32048). Sporewood has **no** `tells` and **no** `sight` table (`tells: null, sight: null`, L32039), so it has none of Mossmere's surface signs. [read]

OLD-only extras in `fP` (L42777): `gill_harp: { giantsWhile: "buff" }`, `veilwater: { attractAdd: { mildew_angler: 2 }, kept: ["hushcap_koi"] }` and `lullaby.rule "The Sleepers"`. They do not reach the LOOP pool: the runtime weights show no Veilwater boost for the angler. [ran]

### 2.2 Catchable species (live)

Hook grades are from `YQ = {` (L31995). Areas are the top three of `A7` (L31984).

| id | Name | Rarity | Size L50 (σ) → kg | Lights | Where | Hook grades | Fight style / gait / pressure (+7 lake) | Sale z0 / z1.5 |
|---|---|---|---|---|---|---|---|---|
| `netcloud_fry` | Netcloud Fry | common | 6.6 (0.10) → 0.002–0.036 | any | lane 2.2, margin 2, pads 1.8 | 3 spore_moth; 2 spore_cake, guard_button; 1 bare, amber_larvae, seedpod_twirl | darter / dart / −2 | 7 / 28 |
| `falsesmile_barb` | Falsesmile Barb | common | 21.2 (0.10) → 0.14–2.37 | day, dusk | pads 2.5, inflow 2, margin 1.5 | 3 spore_cake; 2 spore_moth, guard_button; 1 bare, amber_larvae, root_jig, seedpod_twirl | darter / dart / −0.5 | 8 / 32 |
| `capshell_crayfish` | Capshell Crayfish | common | 24 (0.10) → 0.23–3.97 | any | stones 3, outflow 1.8, margin 1.2 | 3 spore_cake; 2 cut_strip, root_jig, guard_button; 1 bare, amber_larvae | sinker / kick / −1.5 | 9 / 34 |
| `threadling_eel` | Threadling Eel | uncommon | 65.7 (0.12) → 0.22–5.39 | any | **Spore Cake only** (`bait: "spore_cake"`), weight 36 (54 at the Lullaby); margin 2.2, reeds 2, stones 2 | 3 spore_cake, else 0 | darter / wriggle / +0.5 | 35 / 134 |
| `cindertail_catfish` | Cindertail Catfish | uncommon | 57 (0.12) → 0.99–24.2 | any | stones 2.2, dropoff 2, outflow 2; **Gill Harp draw 2** | 3 cut_strip, ember_minnow; 2 root_jig, guard_button; 1 spore_cake, sporelamp_fly | thrasher / hold / +1.5 | 32 / 125 |
| `velvet_ray` | Velvet Ray | uncommon | 48.2 (0.12) → 0.65–16.0 | any | margin 1.8, open 1.6, dropoff 1.2; **Lullaby draw 3** | 3 root_jig; 2 spore_cake, cut_strip, guard_button; 1 amber_larvae | runner / hold / +1.5 | 30 / 115 |
| `lostsea_mackerel` | Lostsea Mackerel | rare | 77.5 (0.14) → 1.73–59.1 | day, dusk | lane 2.5, open 2.2, deep 1.6 | 3 ember_minnow; 2 cut_strip, sporelamp_fly, guard_button; 1 spore_moth | runner / runner / +1 | 87 / 334 |
| `downcast_catfish` | Downcast Catfish | rare | 77.5 (0.14) → 2.21–75.6 | day, dusk | deep 3, dropoff 2.2, open 1.2 | 3 spore_cake; 2 root_jig, sporelamp_fly, guard_button; 1 amber_larvae, cut_strip | runner / hold / +1.5 | 87 / 334 |
| `mildew_angler` | Mildew Angler | rare | 60 (0.16) → 1.41–67.3 | **night only** (`gloom`) | open water everywhere at night, weight 6; stones 2.5, pads 1.2, dropoff 1.2 | 3 amber_larvae; 2 cut_strip, guard_button; 1 spore_cake, ember_minnow | sinker / hold / 0 (+2 headline) | 76 / 294 |
| `sleepspore_jelly` | Sleepspore Jelly | rare | 33 (0.09) → 0.42–6.18 | day, dusk (`calm`) | **The Lullaby only, on Amber Larvae only** (`keptAs: { sleepspore_jelly: { place: "lullaby", bait: "amber_larvae" } }`, L48021), weight 13.5 | 3 amber_larvae, else 0 (button 0) | darter / pulse / −1 (−2 kept) | 57 / 218 |
| `nightbloom_carp` | Nightbloom Carp | rare | 73.4 (0.14) → 2.73–93.4 | night | **The Veilwater at night only** (`kind: "night"` matches only a night place), weight 15 | 3 amber_larvae; 2 spore_cake, sporelamp_fly, guard_button; 1 root_jig | sinker / longRun / +1.5 | ≈84 / ≈325 at Sporewood tier [inferred from formula] |
| `harpstring_eel` | Harpstring Eel (giant) | epic | 79.7 (0.16) → 0.43–20.4 | any (`bestNight` has no effect on a giant) | Gill Harp giant, share 0.06 at all lights (×1.5 on sporelamp_fly) | 3 sporelamp_fly; 2 ember_minnow; 1 root_jig | sulker / wriggle / +0.5 (−2) | 192 / 739 |
| `festival_puffer` | Festival Puffer (giant) | epic | 45.5 (0.16) → 1.08–51.8 | night | Veilwater giant at night, share 0.06 | 3 sporelamp_fly; 2 root_jig; 1 ember_minnow | sulker / hold / 0 (−2) | 145 / 559 |
| `drifting_grove` | The Drifting Grove | legendary | L50 300, W50 150 → 150–225 kg | day, dusk | Mother's Cup (legend roll) | `glowcap_bulb` only | see 2.5 | first sale 2200 (`waters.sporewood.prices.crown`; no `legendSale`), then 880 |

The Nightbloom sale at Sporewood tier 12 is computed from the formula [inferred]. The figure 49/190 in 1.2 is at the Mossmere tier [ran].

Text (live `lore` / `hint`):

| id | lore | hint |
|---|---|---|
| netcloud_fry | "Caught by the netful. Each one certain it is the exception." | "Surface shallows under the lily caps, in clouds. Sign: a shimmer of tiny rings." |
| falsesmile_barb | "Looks just like a Smilejaw until it smiles." | "Under the caps where things fall in. Sign: a plop and a ring." |
| capshell_crayfish | "It wears a small mushroom for a hat. When the mushroom dies it mourns, then finds another." | (none) |
| threadling_eel | "Mostly root, a little fish. It stitches the pool floor together while no one is watching." | "It feeds only on sweetness. Try Spore Cake." |
| cindertail_catfish | "Its tail is the last coal of a fire it does not remember." | "Deep channels and pool floors. Sign: a bubble trail, then nervous water." |
| velvet_ray | "It glides beneath the spore-rain like a shadow looking for the thing that cast it." | (none; `O5.haunt` "…more at the Mother's Cup and the Gill Harp" is unused) |
| lostsea_mackerel | "A sea fish that swam upriver and never found the way back." | "Open mid water, always moving. Sign: a fast straight wake." |
| downcast_catfish | "Its eyes are set low. It has only ever looked where it will sink." | "Deep open pools, mid water. Sign: a slow wide boil." |
| mildew_angler | "Its lure is one soft mushroom, lit like a window left on for someone who isn't coming." | "Its lure lights only at night, out where the water is deep." |
| sleepspore_jelly | "It drifts through other creatures' dreams to rest. Most never notice. Some wake up kinder." | "Drifts only in the calm, towards a gentle glow like Lumen Moss." |
| harpstring_eel | "It lives between the gill-strings and comes out only when the chord is right. It has perfect pitch and no patience." | "It only leaves the gill-strings while the Gill Harp sings." |
| festival_puffer | "Puffed, it is the last paper lantern of a festival nobody finished." | "Night water: the Veilwater's still shallows. Sign: an amber globe glowing just under the surface." |
| drifting_grove | "A whole meadow rides on her back. When she dives, it blooms beneath the water, where no one sees." (epithet "The Meadow That Swims") | "When the pools are quiet, something vast grazes in the deep. It hungers for Glowcap Bulbs." |

Disagreements [read, ran]:
- `velvet_ray`. Its `spots: { mothers_cup: 2, gill_harp: 2 }` and the O5 haunt both point at the Mother's Cup and the Gill Harp. The live boost is at **the Lullaby** (draw 3).
- `harpstring_eel`. `cond: "buff"` and the hint "only … while the Gill Harp sings". The LOOP giant share at the Gill Harp is 0.06 at every light, with no "buff" condition in `ute`/`RP`. `giantsWhile` is read only by `cn` (L128140), an OLD place helper [inferred].
- `sleepspore_jelly`. The hint says "a gentle glow like Lumen Moss", but Lumen Moss is not sold in Sporewood. The live bait is Amber Larvae.
- `mildew_angler`. Hint "out where the water is deep". `spots.veilwater` is unread. Live: every place and open water at night, at equal weight.
- OLD Sporewood fish `sporebelly_puffer`, `plumgill_perch` and `hushcap_koi` were removed from `SPECIES` (`wo.leftOut`). [ran: absent]

### 2.3 Non-fish catches

Sporewood has **treasures only** (`wo.finds.items.push(` at L48186): no parts, no looks and no tackle. [ran: `findShares` = seed_jar 0.54, skep_lid 0.29, gardeners_trowel 0.12, cloche_handle 0.04, seedkeeper_casket 0.01.] Snag chance is the same 0.05 per bite.

| id | Name | Grade | Line |
|---|---|---|---|
| `seed_jar` | Seed Jar | plain | "Still sealed. Still waiting for spring." |
| `skep_lid` | Bee-Skep Lid | fine | "Woven straw. The bees left long ago." |
| `gardeners_trowel` | Gardener's Trowel | precious | "Brass, worn bright on one side." |
| `cloche_handle` | Cloche Handle | rare | "From a glass bell over seedlings." |
| `seedkeeper_casket` | The Seed-Keeper's Casket | jackpot | "Every seed the gardens ever kept." |

### 2.4 Murk's stock in Sporewood

| Slot | Items | Data → shelf | Effect / shelf line |
|---|---|---|---|
| Rod | `stalkwood` (Stalkwood), `amberheart` (Amberheart) | 300 → 600, 1400 → 2800 | hold 3/6, cast +2/+4, hookWindow 1.04/1.08. "Light, and springs back." / "Amber at the heart. It holds." |
| Line | `rootthread`, `mothsilk` | 300 → 600, 1400 → 2800 | hold 3/7. The Sporewood line cap needs hold 4 for trophy and 7 for elder, so **Rootthread stays at prize** [read]. "Twisted root hair. Lands bigger fish." / "Lands the biggest fish." |
| Reel | `capwheel`, `burlwheel` | 300 → 600, 1400 → 2800 | hold 3/6 |
| Lure | `seedpod_twirl` (start), `spore_moth` (insect), `ember_minnow` (predator), `root_jig` (bottom), `sporelamp_fly` | 0, 240 → 480, 400 → 800, 440 → 880, 1000 → 2000 | the spore lamp fly has `giants: [harpstring_eel, festival_puffer]`, share 1.5, hold 10, "For the Pools' giants." Others: "Skates the top, for small risers." / "Wobbles warm, for the hunters." / "Hopped on the bottom, for rays." |
| Bait tin | `spore_cake`, `amber_larvae` | → 40 each [ran] | "Nearly everything here eats it." / "For the Jelly and the night carp." Start kit 10 spore_cake (`wo.start.sporewood`) |
| Legend bait | `glowcap_bulb` ×1 | 250 → 500 | "For the Mother's Cup. One try." |
| Maps | veilwater, mothers_cup | 2400, 4400 | — |
| Hold | Bark Creel 4, Rootwoven Creel 5, Mossbed Basket 6, Gardener's Hamper 7 | 300/500/1000/2000 → 600/1000/2000/4000 | `shelfMax: 7` |
| Raft | Capleaf Oars I/II, Root Keel I/II, Glowcap Lantern I/II | 100/500, 200/900, 200/800 → ×2 | `with: [2,2]`; effects assumed as in Mossmere (the Sporewood records carry only prices) [inferred] |
| Home, looks | same as Mossmere | same | — |

Anchors: `wo.gear = {` → `sporewood:` (L48043), `Object.assign(wo.lures, {` (L48078), `wo.tins.sporewood` (L48091), `Ca.gearNamesAt` (L48130), `Object.assign(Ca.shelf, {` (L48137). Leaving Mossmere: "Bought tackle, raft parts and creels stay here." / "Your hands keep a third of it." (`Ca.leave`; `wo.carry.share: 1/3`). The first 3 evenings after arrival apply `wo.arrival = { evenings: 3, cap: "cap", fight: [-10, -6, -3] }`.

### 2.5 The legend, today

| | The Drifting Grove |
|---|---|
| Place | cast inside `mothers_cup` (owned and lifted) |
| Bait | `glowcap_bulb` (1 per 500-clam purchase) |
| Light | `"day,dusk"` |
| Chance | **1.0** (no `legendBiteChance` on the bulb; `rollLegendBite` defaults to 1) |
| Landing | fight 28 (+2/landing), cap 0.5; the O5 play line says "Never better than a coin flip." |
| Sale | 2200 the first time, then 880 |

---

## 3. Witnesses: fish tied to one place, one light or one bait

Built from the live pool grid in `probe2.json` and the hook tables. [ran, read]

**Tied to exactly one place:**
- Mossmere: `bridgechain_sturgeon` (Under the Span, any light, mireworm or cut_strip) and `rainglass_darter` (Veilback Brook, day/dusk, feather_fly best). Both giants are also one-place fish: `thousandcast_pike` at Under the Span and `hullkiss_lamprey` at the Buoy Lights at night. `gloam_eel` is effectively one place, one light and one bait: Buoy Lights, night, Lumen Moss.
- Sporewood: `sleepspore_jelly` (Lullaby + Amber Larvae + day/dusk), `nightbloom_carp` (Veilwater + night), `harpstring_eel` (Gill Harp) and `festival_puffer` (Veilwater + night).

**Tied to one light:**
- Night only: `lampsipper`, `gloam_eel`, `hullkiss_lamprey` (Mossmere); `mildew_angler`, `nightbloom_carp`, `festival_puffer` (Sporewood).
- Day/dusk only: `likely_chub`, `overbold_bass`, `candlefin_koi`, `rosefleck_trout`, `rainglass_darter`; `falsesmile_barb`, `lostsea_mackerel`, `downcast_catfish`, `sleepspore_jelly`.
- Dusk + night: `milkeye_perch`.
- A dusk-weighted giant: `thousandcast_pike` (share 0.06 at dusk and night, 0.025 by day).

**Tied to one bait** (the only grade-3 item, all others 0): `gloam_eel` (Lumen Moss), `threadling_eel` (Spore Cake), `sleepspore_jelly` (Amber Larvae). Near-exclusive: `weeping_carp` and `candlefin_koi` take Lumen Moss at 3, with only mireworm/button behind it. `hullkiss_lamprey` is the Bell Spinner at 3 or the Glimmer at 1.

**Turn up everywhere** (any light, every place's open fraction, many grade-2 items): `dusk_minnow`, `mossback_perch`, `gutter_crayfish`, `rustfin_sucker`, `kissmark_trout`, `reedjaw_pike`, `weeping_carp`; `netcloud_fry`, `capshell_crayfish`, `cindertail_catfish`, `velvet_ray`. These are poor witnesses but good income. Within open water their area preferences (`GQ`/`A7`) are sharp, e.g. kissmark deep 3 vs pads 0.1, and rustfin inflow 3.5. Those preferences could still carry "where" clues.

---

## Hook points for the hunt loop

1. **The place record is the haunt.** `wo.places[id]` already has `kind` (which drives the light window), `legend`/`giant`, `card`, `own`/`only`, `draws` and price. `bell_pool` and `mothers_cup` are the monster haunts. A monster could carry `place`, `bait` and a time window exactly as `bridgechain_sturgeon`/`sleepspore_jelly` do (`place` + `keptAs`), and `ute` already enforces all three.
2. **The hook table is the "what rig" answer.** `bs[water].hook.table` grades (0 refuse … 3 best) and `Bd` size caps (item, line hold, grade) already express "needs this lure/bait and this line". A monster row with a single 3 and zeros elsewhere makes the rig a hard requirement. `Ca.gate.away` strings ("Too heavy for your line.", "It wants a better lure.") are ready-made negative feedback.
3. **Secret places and notebooks.** `veilback_brook` (`secret: !0`, `revealedBy: "veil_notebook"`) plus `lostTackle[*].reveals` and the `tackleMiss` pity counter are a working "find the clue item, the hidden water opens" chain. `v7` pushes the place into `maps.places`. The same can reveal a monster's haunt.
4. **Notebook boosts and guests.** `lostTackle.*.boost` and `guest` (area + lights + share) let a found item change who bites where. This suits "you learned it feeds at the inflow at dusk".
5. **Witness species as clue sources.** The one-place, one-light and one-bait fish in §3 can carry clue text in `hint`/`lore`. The journal shows them once caught (the clues mapper owns the UI).
6. **Mossmere surface signs.** `bs.mossmere.tells` (rise, boil, nervous, strike, bubbles, pinprick, cloud, stems, with `makers`, `areas` and `hours`, L31765) and `sight` (visible bodies) are a "read the water" vocabulary. The `giantBack` timer (`world:giantBack` event) is an existing "big fish sighted here" cue.
7. **The legend gate.** `rollLegendBite` + `legendBiteChance` (L104008) is the single dice roll that the hunt would replace with "all conditions met". The legend's light check, bait check and place check already exist in `zt` (see the legend map).
8. **The next-lake gate.** `wo.access` (`gear: { sporewood: "rod:1" }`, `list.plainBaitOnly`) is where a "monster landed" seal fits (the progression map's hook point 1).

## Gaps

- **No per-lake monster record.** Nothing names "the target fish" of a lake or tracks hunt state (clues found, haunt known, bait known, hooked, landed). The progression mapper searched `hunt`, `target`, `clue` and `monster`; I found nothing in `wo` either.
- **No live condition beyond light, place and bait.** Weather (`prefers`, "still as a mirror", "while the Gill Harp sings", `cond: "buff"`) is parked or unread in LOOP. "When it feeds" can only mean day/dusk/night today. Finer timing (moon, a rhythm such as the OLD `cupped_hands` "Aqueduct Coughs") exists only in the unused V3 place rules.
- **No presentation beyond item choice.** There is no depth, retrieve speed or tipped-lure test in the catch table: `Rl` lets a fitted lure override the bait. "How to present it" has no data today except area (open water only) and the lure/bait grade.
- **Sporewood has no signs.** `tells: null` and `sight: null`, and it has no parts, looks, tackle finds or notebook. Its clue sources would all be new.
- **Hint text is stale or contradicts the live rules** for several fish (hullkiss, thousandcast, rosefleck, rainglass, nightbloom, velvet ray, sleepspore, harpstring, mildew). A clue chain built on hints needs these rewritten first.
- **Legends sit outside the species pool.** `ute` drops `rarity === "legendary"`, so the monster cannot be "seen" by any of the pool, odds or tell machinery without new code.
- **Price-tier offers.** Several Murk tiers are keyed to water orders 3+ (`with` ≥ 3) and never appear. Murk's Mossmere tackle shows Sporewood gear after returning (progression quirk). A per-lake hunt economy would need that fixed.

## Checked

Sceptical re-check against `reading/game.pretty.js` (line numbers are that copy). Claims 3 and 5 were also re-run in Node. I loaded lines 1-50313 of the reading copy with `GW_V3/GW_LOOP/GW_LOOP_COST` set as in the HTML, then called `ute` and `a1` directly.

1. **Confirmed.** `ute` (L47686): `if ((v.bait && v.bait !== o) || (w && !w.has(v.id))) continue`; `o && v.bait === o && (b *= 1.5)`; legendaries are filtered out at L47696; a `night` place outside night gives `d = null`, i.e. open water (L47694). Also: `only: !0` places restrict the pool to `own` + `draws`, and when the total is under 70 the pool is padded with off-hour open-water species (L47730).
2. **Confirmed.** `Rl` (L32451): a fitted non-bare lure that is in the species row wins, else `R7(row, bait)`. `mult: [0, 0.5, 1.6, 2.5]` (L31759) is applied in `l1` (L32500). Grade 0 take = `take.stray = 0` (`_7`, L32458; L31763). `Ph` order matches (L31561). Nuance: for the giant entry, `P7` applies `mult` only when the grade is 0 or 1 (L32535). Grade 2/3 giants are not boosted.
3. **Confirmed** (re-run): gloam_eel only `buoy_lights`/gloomtide/lumen_moss 22.5; threadling only with spore_cake (every Sporewood place, all lights); sleepspore only `lullaby`/amber_larvae, calm/dusk/dawn 13.5; bridgechain only `under_the_span`, every light and bait, 9; rainglass only `veilback_brook` (day/dusk/dawn, not night), 9; nightbloom only `veilwater`/gloomtide, 15. These are pool weights only; the per-item hook grade still applies on top.
4. **Confirmed.** `wo.places.veilback_brook` (L47495), `reveals: "veilback_brook"` (L47436), `h7` adds to `maps.places` (L31247). Pity in `a1` (L31341): `bonus = max(0, min(bonusCap 0.2, cap 0.4 - base, 0.05 × misses))` (L47414-L47418).
5. **Confirmed** (re-run `a1` on an empty save). Mossmere: 6 tackle × 0.08, 6 parts/looks × 0.0533, and treasures salt_lens 0.12 / two_headed_coin 0.04 / tin_spoon 0.0195 / door_ring 0.0105 / toll_purse 0.01. Sporewood: 0.54 / 0.29 / 0.12 / 0.04 / 0.01. `g7` (L31387) returns 0 on a legend cast, on evening ≤ 1, **and on a tutorial cast**.
6. **Confirmed.** `i8` × `LOOP.cost.factor` (= `GW_LOOP_COST` 2, L46964). Maps are priced in `X3` (L105384) and excluded from the second pass (L105255), so there is no double ×2. Lullaby and Gill Harp have `price: 0, lake: !0` and are granted on lake purchase (L106190). `legendBait` heartmoss 10 (×10 balls) and glowcap 250 (×1) are shelved through `i8`.
7. **Confirmed.** Hullkiss row (L31605) gives cut_strip (index 3) 0. Its record has `baits: ["moth_popper","cut_strip"]`, and `moth_popper` is not in `LOOP.lures`. Velvet ray `spots: { mothers_cup: 2, gill_harp: 2 }`; live `lullaby.draws.velvet_ray: 3` (L47893). Harpstring `cond: "buff"` (L39633) is not checked by `ute`. `lightAttract` appears once (L41254). No reader of a species `spots` object was found; the other `.spots` hits are fishing spots, tide charts or a model `pattern`.
8. **Confirmed.** `$ee` (L47242) as stated, times `wo.priceFactor` (1). The tier comes from `zone = run.zone || species.zone` (L105740). Note: a preset `clams` on the creel line wins (L105729). The sale `A()` can add bonuses on top (`S(ze, H)`, and the "curious" wick first-catch floor, L105753-L105765). Legend price at L105735; the rematch factor also applies when another of the same legend is already in the creel.
