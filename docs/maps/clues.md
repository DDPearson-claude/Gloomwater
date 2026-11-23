# Clue surfaces in Gloomwater (key: clues)

> **Out of date.** This map describes the game of 21 November 2026. Her hunt has been redesigned since: she is the Bellhead Catfish (never "the Matriarch"), the Worm Bunch replaced Heartmoss, the notepad's five sketches replaced the Case page and the bell hints, and the midnight bell tells the player when she feeds. See `docs/design/decisions.md` (it wins over this file) and `docs/design/mossmere-hunt-2.md`. Section 1.5 (escapes are not recorded on a trip) is still true.

Scope: every way the game already tells the player something they can act on. Raw material for a River Monsters style hunt loop (one target monster per lake).

Conventions
- Every claim has a **search anchor** that works in both `Gloomwater-Mossmere.html` and the reading copy `reading/game.pretty.js`. `(L12345)` is the reading-copy line, a convenience only.
- **[read]** = read directly in code. **[inferred]** = my reading of how pieces connect, not traced end to end. **[not run]** = no browser check was done (nothing here was driven in a browser; all claims come from reading).
- Layers: **LOOP** = current relaxed-fishing layer (`wo` = `data.LOOP`, `Ca` = `data.TEXT_LOOP`, save in `meta.loop`, gated by `LOOP_ENABLED` and `run.outing === "trip"`). **OLD** = survival-roguelite layer (zones mossmere/sporewood/glasswater/paleabyss, Gloomtide, oil/food, boss phases, Memories, relics). **V3/AF** = the intermediate "autofish"/CATCH_V3 layer whose text tables (`AUTOFISH.text`, `TEXT_V3`) the LOOP still borrows.
- Key data object locations: `wo = {` (L46703), `Ca = {` (L46996), `bs = {` (habitat + tells, L31616), species table entries such as `id: "belled_matriarch"` (L33960).

Where the handoff is wrong, it is flagged with **HANDOFF DISAGREES**.

---

## 1. The journal

### 1.1 Which journal is live
`function Pt(K = {})` (L167803) is the journal opener. Its first line `if (B()) return Ht(K);` sends LOOP play to `function Ht(K = {})` (L168004), the "catalogue" journal (`cls: "gw-m-catalogue"`, `Ut.dataset.loop = "catalogue"`). The older grid journal in `Pt` (cards `gw-jr-card`, "Glimpsed", `n of m names written`) is OLD/V3 only. [read]

LOOP journal tabs (built in `function Ct(K, we)` L168139):
| Tab | id | Shown when | Content |
|---|---|---|---|
| Sheet | `sheet` | when the Wick sheet exists (`z()`) | Wick character sheet (section 6) |
| One tab per owned lake | lake id (`mossmere`, `sporewood`) | lake in `meta.loop.maps.lakes` and shipped | lake page |
| Prints | `prints` | always | trophy prints, only of landed species |
| Giants | `giants` (star icon, aria "Giants") | always | giants + legends list |

### 1.2 Species state: locked / unknown
Save: `meta.journal[speciesId] = { caught, biggest, pbLength, pbWeight, seen?, gotAway[], escape, released{} ... }`.
- Landed test: `function landedInGuide(record) { return Number(record?.caught) > 0; }` (L167678). Used by catalogue, giants, prints and the 3D guide. [read]
- "Met" test used by the Odds page: `ew = (e, t) => { let n = e?.journal?.[t]; return !!n && (na(n.caught) > 0 || !!n.seen); }` [read]
- Locked card: `undiscoveredArt(width, height)` (L167681) renders a "?" span (class `gw-guide-unknown`); name is `"\xB7 \xB7 \xB7"` (`· · ·`). Clicking a locked card in the LOOP catalogue opens a "big" view whose art text is **"Catch to reveal"** plus the card's glyphs (in `Ct`, search `$e.textContent = "Catch to reveal"`). Only caught species open the species detail view. [read]

### 1.3 What a locked card already gives away (glyphs) — important for the hunt
The lake page view model is `function $3(e, t, n)` (L105405) mapped by `function m4(e, t)` (L161552). For every species of the lake, **caught or not**, it carries:
- `hours: TF(t, L)` — `function TF` (L105323) returns `[]` if the species bites in all three lights, else icons from `_le = { day: "sun", dusk: "dusk", night: "moon" }`.
- `bait: Lle(t, L)` — the species' `bait` field if it is a lake tin or a legend bait. Glyph map `Yhe = { heartmoss: "mossball", lumen_moss: "moss", mireworm: "worm" }` (L161551). [checked] Any other bait falls back to the `worm` glyph (`Yhe[a.bait] || "worm"`, L161559), so Glowcap Bulb, Spore Cake and Amber Larvae all show a worm. The bait glyph is only on group (non-listed) cards.
- `place`: species are grouped by chart place. `groups[]` each have `kind` (day/old/night/crown) shown as a `kind_<kind>` icon; the place **name is shown only when owned** (`name: a.owned === !0 ? (a.name ?? null) : null`). Secret places (`secret: !0`, e.g. veilback_brook) appear only once in `maps.places`.
- `listed` cards (the lake "list" from `op(t, n)`) show a notch (`gw-jr-notch`, lit when caught) and kind+hours glyphs instead of hours+bait.
So today a locked Belled Matriarch card already shows: "· · ·", a star (legend: `star`, `gold`), a crown-kind group icon, its hour icons, and the mossball bait icon. [read; exact rendering not run]

Per-card "need" line: `Tt(K, we)` adds `<small class="gw-cat-need">` from `function r8(e, t, n)` (L105555): if no owned rig can hold the species, text is one of `Ca.gate.hint` = **"Needs a lure."**, **"Needs bait."**, **"Needs a better line."**; once a journal entry exists it names the item via `Ca.gate.needs` = **"Needs {item}."** (e.g. "Needs the Feather Fly."). Species detail adds `SF` (L105491) text **"Lands up to {class}."** [read]

### 1.4 Species detail (caught only, LOOP)
`function _t(K, we, {...})` (L167708). Shows name, epithet, rarity kicker, `lore`, facts (Biggest / Caught / First / Weight with "said to reach {w}"), and a where-line from `function rt(K, we = !1)` (L165683). With `we = true` (caught path) it ignores `K.hint` and generates, e.g. **"feeds while the water is calm · deep water · answers only Heartmoss Balls"** from `time` (`"gloom"` → "rises only in the Gloomtide", `"calm"` → "feeds while the water is calm", else "bites at any hour"), `depth`, `bait`. Then odds rows (`pe(K, hl)`), a "Odds ›" button. Also `Z().orderSay.wants` = **"Murk wants one."** when an order wants it. [read]

Species `hint` strings exist in the species table, e.g. Matriarch `hint: "Listen for a bell beneath the calm, far out in deep water. She takes only Heartmoss."` (L33994 area). They are shown only by `rt(K)` without the flag, i.e. in the OLD journal's Undiscovered/Glimpsed/Unnamed detail. **In LOOP play no screen shows `species.hint`** (locked cards never open `_t`). [read]

### 1.5 Written clues left by escaped fish — HANDOFF DISAGREES
Handoff: "An escaped fish can leave a written clue." In code, the escape-to-journal writer is in `function oe(ge = {}, { comeback: k = !1 } = {})` (L108863, `onEscaped: oe`). Its block `if (f(q)) { ... e.requestSave(); return; }` (L108876) runs first, where `f = (ge) => d() && ge?.outing === "trip"` and `d = () => n().LOOP_ENABLED === !0` (L108111). So on a LOOP trip it only handles legends (`ne(F.id)`), marked-fish rehooks and `gt(...)` marked fish, then returns. The lines that set `Et.seen = !0`, push `Et.gotAway` (last `journalLast: 5`) and `Et.escape`, and emit `"journal:seen"` (L108893-L108912) are **never reached in LOOP trips**. No other writer of `journal[id].seen` exists (searched `\.seen = ` / `seen: !0`). [read, high confidence; not run]
Consequences in LOOP: an escaped-only species stays fully locked; it does not count as "met" on the Odds page; `r8` keeps the generic need text. The "Glimpsed" detail text — **"Got away: {class}, {size}, {place}, day {n}."** / **"It got away before you could name it properly."** — and the "Got away" list `J(K, we)` (L165567, header "Got away") are OLD-journal only.

What LOOP escapes do record: `function Y(ze = {})` (L105912, `onEscaped: Y`): `capLost = true` on the run if over cap; for a giant lost in its own place, `Gt(id)` sets `meta.loop.giants[id] = { landed, marked: 1 }` (L106623; the `marked` flag is not displayed in LOOP: `marked: p && !L ? ... : !1`, L161442); Ashwick Wick "burns_back" sets `meta.loop.comeback = { waterKey, speciesId, z, zone, sizeClass }`.

### 1.6 Giants list
`function BV(e, t, n = ["mossmere"])` (L161593) lists species of owned lakes with `giant === !0` or `rarity === "legendary"`; name `· · ·` until caught; best weight from `pbLength`. Rendered by `function De(K, we, te)` (L168430): locked giant click shows "Catch to reveal" with the same glyphs as the lake page. Mossmere giants per `wo.places`: `thousandcast_pike` (under_the_span), `hullkiss_lamprey` (buoy_lights); legend `belled_matriarch` (bell_pool). Sporewood: `harpstring_eel` (gill_harp), `festival_puffer` (veilwater); legend `drifting_grove` (mothers_cup). [read]

### 1.7 Odds page ("Landing odds once hooked")
Title string `AUTOFISH.text.log.title = "Landing odds once hooked"` (L44575), used as `table.yourOdds`. View model built in the sheet (rows at "for (let [re, De] of Object.entries(Ht))", L104421; mapped at L163880). The page lets the player pick place (including "Where you last cast", `Ca.sheet.lastCast`), light (`Ca.sheet.hours` Day/Dusk/Night), lure/bait, and size class; it shows:
- `sizeHead: "How big they run here."` and per-family size shares.
- **"Who bites"** table: share of each **met** species (unmet ones only counted: **"and {n} you have not met"**), landing odds per class (`AUTOFISH.rating.words`: "a coin flip", "a long shot", "rarely held", "beyond this tackle"), cap line **"Lands up to {class}."**
- Legend row only when the chosen bait is that water's legend bait and the hour matches: share = `legendBiteChance` (`legendBiteChance: 0.12`, L34817).
- Foot: `AUTOFISH.text.log.strike` = "A clean strike adds a little; an early or late one costs a little."
This is a full what/where/when simulator, but it reveals only species already caught (in LOOP). [read]

### 1.8 Per-lake pages
Lake head: water name and `count` = `have/need` from `Yy(e, t, n)` (the lake list). The tab badge shows the same count. Below: the list, place groups (1.3), a guests group (`gw-cat-group--guest`, book icon) for notebook guests from `Ole` (L105481): a guest appears if it has a journal entry or its notebook has been found. Finds row (`e.finds.renderRow`). [read]

### 1.9 3D field guide
Button **"3D field guide"** on Mossmere/Sporewood lake pages. `function openCatchGuide(lake)` (L167692): `window.open`, sets `guide.readGloomwaterJournal = () => h()?.journal || {}`, writes the JSON-encoded template from `#gw-field-guide-template` or `#gw-spore-guide-template`. Popup blocked: toast "Allow the guide to open in a new tab." Locking inside the guide is by `caught` (per handoff; the guide's own code is inside the template string and was not read). [read; template internals not read]

**Adding entries:** species data lives in the species table (search `id: "belled_matriarch"`); glyph sources are `time`, `bait`, `place`/`kind`; adding a field to `$3`'s `c()` record and to `m4`'s `glyphs` is the extension point.

---

## 2. Notebooks, charts and places

### 2.1 Notebooks (LOOP, Mossmere)
Item defs: `wo.finds.items.push(` (L47407): `{ id: "veil_notebook", water: "mossmere", kind: "tackle", slot: "notebook", ... }`, `lily_notebook` likewise.
Effects `wo.lostTackle` (L47423):
| Notebook | boost (bite weight ×) | guest | reveals |
|---|---|---|---|
| `veil_notebook` | `kissmark_trout: 1.2` | `rosefleck_trout` from glasswater, areas `["inflow"]`, lights `["day","dusk"]`, share 0.04 | `"veilback_brook"` |
| `lily_notebook` | `weeping_carp: 1.5, candlefin_koi: 1.5` | `nightbloom_carp` from sporewood, areas `["pads"]`, lights `["night"]`, share 0.03 | none |

Names/lines `Ca.finds.items`: "The Veil Angler's Notebook" — does "Trout notes, and a hidden water." line "Fished the Veil every day, it says."; "The Lily Gardener's Notebook" — "Carp notes, and one far carp." / "Every carp in the moat, by name."
Generated clue lines: `function N5(e, t, ...)` (L31253) using `Ca.lost.log`: boost → **"{fish} come more often."**; guest → **"{fish} bite at {where}, {lights}."** (`where`: inflow = "the Sluice Veil", pads = "the lily beds"); reveals → **"Shows the way to {place}."** So the Veil notebook reads: "Kissmark Trout come more often." / "Rosefleck Trout bite at the Sluice Veil, day and dusk." / "Shows the way to Veilback Brook." [read; rendered via `e4(...)` at L148522, L163600, L163644, L164316]
Drop rule: `wo.finds.tackle = { share: 0.48, bonusCap: 0.2, guarantee: { item: "veil_notebook", step: 0.05, cap: 0.4 }, partCap: 0.8 }`; snag `snag: { perBite: 0.05, ... }` (L47306). Save: `meta.loop.finds.got[id]`, `finds.tackleMiss[water]`. Murk on first tackle: **"Somebody fished here before you."** Physical props on the barge chart table: search `if (ic(e, "veil_notebook"))` (L96200).
**Pattern value:** a notebook is a data-driven clue packet (boost + named species + area + lights + revealed place). This is the closest existing "evidence item".

### 2.2 Charts sold by Murk (LOOP)
`wo.places` (`places: {` L46812) and `Object.assign(wo.places, {` Sporewood (L47887):
| place | water | kind | price | card | giant / legend |
|---|---|---|---|---|---|
| lily_maze | mossmere | day | 60 | candlefin_koi | — |
| under_the_span | mossmere | old | 150 | thousandcast_pike | giant |
| buoy_lights | mossmere | night | 260 | hullkiss_lamprey | giant |
| bell_pool | mossmere | crown | 500 | belled_matriarch | legend |
| veilback_brook | mossmere | day, `secret: !0`, `revealedBy: "veil_notebook"` | 0 | — | — |
| lullaby | sporewood | day, `lake: !0` | 0 | sleepspore_jelly | — |
| gill_harp | sporewood | old, `lake: !0` | 0 | harpstring_eel | giant |
| veilwater | sporewood | night | 1200 | festival_puffer | giant |
| mothers_cup | sporewood | crown | 2200 | drifting_grove | legend |
Shop offer: `function X3(e, t, ...)` (L105367) offers the **two cheapest** unowned, non-secret places of the barge's lake, id `place:<id>`, with `fish: card`, `hours: TF(card species)` and `line: Ca.maps[id]`. Flavour lines (`Ca.maps`): lily_maze "Koi glow under the pads like lanterns."; under_the_span "The bridge kept its chain. Something kept it."; buoy_lights "The harbour lights went under, still lit."; bell_pool "The moon looks in on the old bell."; lullaby "Something sleeps under every lily raft."; gill_harp "The gills hang down. One of them hums."; veilwater "Behind the moss, a lantern floats."; mothers_cup "The Mother breathes. Big things breathe with her."; lake map sporewood "A harp in the Pools knows one song." Buying (`je.slot === "place"`, L106184) pushes to `meta.loop.maps.places`; buying a lake adds its `lake: !0` places. Murk's first map line: **"It's in the mist. Go and look."** (`sayOnce("firstMap")`). [read]

### 2.3 places.revealed, lifted, mist and the reveal camera (LOOP)
Save fields (`function yF(e)`, L104861): `maps: { lakes, places }`, `places: { revealed: [] }`, `lifted: []`.
- Reveal: on landing a tackle find with `lostTackle[id].reveals`, code at L31489 pushes to `meta.loop.places.revealed` and calls `h7(e, s)` which also pushes into `maps.places` (L31247). Migration re-applies `h7` for every revealed id (L31244). [read]
- Locked = owned-not-lifted or not owned: world mist per place (`at.op`, `at.lifted`, `at.lift`, L80412-L80601). Casting into mist: `cast.mist` (bait refunded per handoff).
- Lift queue: `function Ple(e, t)` (L105396, exposed as `liftDue`) = owned places not in `lifted`, cheapest first. On `startTrip` (and `run:start` with `continued`), `Se()` (L50648) queues them and `ye()` plays: `place:lift {phase:"start"}` → `world.liftMist(id, thin)` → `render.frameLandmark(anchor, { dur: thin + title, back })` with `wo.lift = { thin: 3, title: 1.2, back: 0.6 }` → `place:lift {phase:"title"}` shows the place name (`function Zhe`, L161617; handler L163299) → `phase:"end"` → `markLifted(id)` (`cn`, L106611) pushes to `meta.loop.lifted`. Veilback Brook additionally uses a sail `glide` path and emits `place:veil {phase:"glide"}` (L51039). Sound: `RM = { giantBack: "giant_roll", liftStart: "mist_lift", seal: "seal_press" }` (L137452). [read]
- Murk line when Veilback Brook is revealed: **"Water behind the Veil. Always said so."** (`Ca.murk.brook`, chosen first in `Xhe` when `places.revealed` includes `veilback_brook`). Place lore `lore: "Behind the falling water, the old cut still runs."` (J5, L47520).
**Hook value:** reveal + lift + named title camera is a complete, data-driven "you found where it lives" beat, already save-backed.

---

## 3. Escape feedback (LOOP)

Flow in `function pi()` (L130807), called once after the loss animation:
1. Builds `loss = { speciesId, sizeClass, ancient, z, approxLength, reason, place, x, zPos, markedFish, grade, legendary, zone, overCap? }`. `overCap` is present when the fish exceeded the rig's cap (`i.overCap`) and is not legendary, with `advice: gearEscapeAdvice(...)`.
2. Elder in Mossmere with overCap or rival fight: `loss.observation = "It took " + items + " " + hour + " here."` e.g. **"It took Mire Worms by day here."** (`hour`: "by day"/"at dusk"/"at night").
3. `loseOldRival(...)` (section 4); if a rival, appends `rivalShoppingClue`.
4. `g("fish:escaped", loss)`.

`function gearEscapeAdvice(data, loop, species, z, cap, rig)` (L32898): returns "" without cap/rig. Opening: line-limited **"It took the hook, but your line only holds up to {Class}."**; otherwise **"The fish took it. {subject} can only hold up to {Class} for this fish."** (subject = lure/bait name, "This hook setup" or "Your bare hook"). It then searches every local lure (owned or buyable; found lures only if owned), every tin plus `cut_strip`, and every local line tier against `Bd(...)` caps for the **actual z**, ranks by covers/changes/cost, and ends **"Try {X line} and {Y}."** / **"Raise the limit with ..."** / **"Try smaller fish here."** It never names the species. [read]

Display in LOOP trips: listener `Pt("fish:escaped", (te) => { b() ? te.overCap && kt(te) : $.push(...) })` (L148929) with `b = () => s().LOOP_ENABLED === !0 && c()?.outing === "trip"`. So in LOOP only over-cap escapes show text: `function kt(te)` (L149365) puts `advice` (fallback `Ca.gate.away[key|by]`: "Too heavy for your line.", "Too big for a bare hook.", "Too big for the Bent Spoon.", "Too big for Cut Strip.", "It wants a better lure.", "It wants a better bait.") in the strike word element (`gw-strike-gear`) for 6 s. Ordinary escapes (not over cap) show **no text** in LOOP. The species-naming "THE ONE THAT GOT AWAY" card (`function pU`, L148356; `function H(te)`, L149399, with species art via `Or`) is the non-LOOP path. [read]
Other listeners: tutorial step (L50031), sfx "gotaway" for trophy/elder/legend when `V3_ENABLED` (L141199), `d.away = !0` for Murk's next line (L170632). Guide box `Ca.guide.boxes.away`: "That one got away! Big fish can break free, and some are too big for your gear. Better line and lures will hold them." Murk at home after an escape: Mossmere **"Lost a big one? Better gear holds them."** (`Ca.murk.firstAway`), Sporewood **"Lost a big one? Rootthread holds them."** (`Ca.murk.at.sporewood.away`).

---

## 4. Old Rivals (LOOP, Mossmere only) — the reusable "hunt one named fish" pattern

Save: `meta.oldRivals = { active: Rival | null, landed: Rival[] }`.
Rival record (created in `loseOldRival`, L32855): `{ id: "mere-" + (landed.length + 1), name, needsPurchase: string[], speciesId, z, ancient, place, evening, escapes: 1, gap: 0, sightings: 0, clue, observation }`; later fields `lastNote`; on landing `length, weight, landedEvening, landedAt`.

Life cycle:
| Step | Function (anchor) | Rule (exact) |
|---|---|---|
| Birth | `function loseOldRival(meta, data, run, loss, rematchId, rig = null, random = Math.random)` (L32823) | Requires `run.outing === "trip"`, `run.zone === "mossmere"`, not legendary, `loss.sizeClass === "elder"` (Elder or Ancient), finite z, reason not `"cut"`; no active rival; `loss.overCap.advice` present; no rematchId; reason in `["snapped","thrown"]`; species not legendary; `rivalPurchases(...)` non-empty; `random() < 0.8`. Caller also requires not tutorial, not a find, tutorial done (L130871). |
| Name | `K3(data, species, id + ":" + loss.z, "mossmere") \|\| "The Hook-Thief"` | Elder names from `ELDER_NAMES` (`ELDER_NAMES: () => Pee`). |
| Gate (what to buy) | `function rivalPurchases(data, loop, run, fish, rig)` (L32767) | All complete rigs (each Mossmere line tier × {failed rig, each local non-found lure, each tin}) whose `Bd` cap z ≥ fish.z; returns the union of minimal missing Murk keys `line:<level>`, `lure:<id>`, `tin:<id>`; `[]` if the player already owns a working rig (then no rival is born). |
| Gate check | `function rivalGate(meta, data, run = null)` (L32803) | Returns `active.needsPurchase` (migrates old saves by recomputing). |
| Gate open | shop buy (L106182, L106211) | If bought key is in `rivalGate` → `needsPurchase = []`, `gap = 0`. Only exact keys count. |
| Escape toast | `pi()` (L130883) | First: **"{name} slipped away. A clue is in Journal → Sheet → Rivals."** later **"{name} slipped away again."**; advice gets **"Before it will bite again, buy from Murk: X."** / **"... buy one of these from Murk: X, Y."** (`function rivalShoppingClue`, L32811). |
| Visit roll per cast | `function prepareRivalVisit()` (L128821), called after cast lands (L129119) | Skips if not LOOP trip, not Mossmere, no cast, `cast.mist`, tutorial, `run.arrival.cap`, `run.evening <= 1`, tutorial not done, forced species/find, `cast.place.id !== fish.place` (null = open water), no bait and no lure, or Heartmoss cast; and the fish must have `p > 0` in the current bite table. If gate is open: `rollRivalVisit` → `i.rivalVisit`. |
| Cadence | `function rollRivalVisit(fish, random)` (L32894) | `gap++`; true if `gap >= 6 \|\| (gap >= 2 && random() < 0.3)`. |
| Sign on the water | inside `prepareRivalVisit` + `function showRivalWake(dt)` (L128900) | Wake when `clock >= nextRivalWake` and (gate closed and never sighted, or `gap === 1`, or a visit is due); `nextRivalWake = clock + 20`. Wake crosses the line from the side ≤ 6 m out: 8 ripples 0.28 s apart, a dark 3.2×0.83 shadow mesh "Rival under the lantern", a 2-particle silver burst at step 3. `sightings++`; toast on sighting 1 and every 4th: **"A heavy wake crosses your line. {name} is still here."** |
| Bite | `function chooseRivalBite(ordinary)` (L128950), and lure path (L134387) | Replaces the ordinary bite with the rival's species and exact z (`prerollSp`, `prerollZ`), sets `rivalFight`, `gap = 0`. Requires gate open, `rivalVisit === id`, species can take the rig (`Rl(...) !== 0`). |
| Hook | L130288 | Manual strike: toast **"{name} is back on the line."**; hard take: no text. |
| Re-escape | `loseOldRival` with `rematchId` | Same id/species/z: `escapes++`, `gap = 0`, stores `observation`; if over cap → new `clue`; else `lastNote = "Your setup could hold it. Try these waters again."` |
| Landing | `function landOldRival(meta, run, catchFish)` (L32871) | Catch must carry `oldRivalId` (tagged at L131946 when species and z match), same species and z, Mossmere trip; moves the record to `landed` with `length, weight, landedEvening, landedAt`; `active = null`. |
| Keepsake | `showKeepsake()` (L93935) | Last landed rival's bent hook on Murk's measuring board; tag: name and **"Evening {n} · {k} slip(s)"**. Cosmetic. |

Journal entry: `function fillRivalJournal(section, meta, data)` (L164206), on the Sheet's **Rivals** page (lazy, first open). Empty: **"Murk keeps a page for the big ones that get away."** Active: small "Still out there", h4 name, "{place name or "Mossmere open water"} · {n} escape(s)", `clue`, `observation` (only if escapes > 1), `lastNote`, then either the shopping clue or **"Watch for a wake crossing your line and a brief silver glint."** (if sighted) or **"First hooked on evening {n}. Return to {where} and cast again."** Landed: "Recovered hook", species art (canvas `ch(...)`), "{Elder|Ancient} {species} · {weight} · {length} cm", **"“{name}’s Bent Hook” · Landed on evening {n} · {date}"**. The species is never named while active.

Pattern to reuse: persistent individual (species + fixed size + home place) → gear gate keyed to Murk shop ids → per-cast visit roll with breather and pity (6) → positional sign (wake/shadow/glint) → forced bite → individual-tagged catch closes the entry → keepsake. Limits: one active rival; Mossmere only (hard-coded `"mossmere"` in `rivalPurchases`, `loseOldRival`, `prepareRivalVisit`, `landOldRival`); born only from an escape; no time-of-day rule (only `observation` text records the light); the only gate is gear.

---

## 5. Signs on the water

### 5.1 Tells (LOOP; the live sign system)
`Nr = () => Lc() && xe() && !!bs?.[Yt()]?.tells` (L133345): in LOOP trips, signs come from `bs.<water>.tells` via `function JC(R, I = {})` (L133480). The legacy `fm()` / `signKinds` path (`GO = ["rise","boil","nervous","strike","bubbles","glow"]`, L71709; `signKinds: f ? GO.slice() : void 0`, L73194) is OLD/V3 and is bypassed when `Nr()`.
Mossmere tells (`tells: {` L31765): rise (forms sip/splash/roll), boil, nervous (ruffle/spray), strike, bubbles, pinprick, cloud, stems, gas, `glow: { retired: !0 }`, `alive: { day: [2,4], dusk: [2,4], night: [2,3], max: 6 }`. Each has `hours` weights per light, `makers` (species that can produce it), `areas` (habitat or place ids such as `lily_maze`, `under_the_span`, `buoy_lights`, `bell_pool`), `within` (cast radius), and a `respond` animation (riseAgain, slapAgain, bowWave, ruffleDrift, sprayAgain, fizzTurn, thicken, puff, knock). Sporewood: `bs.sporewood.tells = {` (L32150) with its own makers.
Each sign pre-rolls a species and size from its makers in that spot's bite table (`function Gj`, L133562) and emits `"sign:spawn" { id, kind, form, x, z, sizeClass? }`; a cast at it uses the preroll (`i.prerolls`). `Gj` filters out `sp.giant` and `rarity === "legendary"`: **tells never point at giants or legends.** [read]

### 5.2 Sight fishing (LOOP, Mossmere)
`sight: {` inside `bs.mossmere` (L31921): visible fish bodies in shallow areas (`areas: ["margin","pads","inflow","stones","reeds","lily_maze"]`, `depth: 0.45`), spook rules, lantern radius, body types; `exclude: ["thousandcast_pike","hullkiss_lamprey","belled_matriarch","bridgechain_sturgeon","kissmark_trout","gloam_eel"]`. [read; runtime consumer not traced]

### 5.3 Giant back (LOOP)
`wo.giantBack = { every: [25, 45], dur: 3, phases: ["gloomtide"], places: ["under_the_span", "buoy_lights"] }` (L46858). World code (L80340-L80440): a back mesh `"giantBack"` rolls through a place every 25-45 s for 3 s **only while that place is still in mist** (`!(!Le || at.lifted || at.lift || at.op < 0.5)`) and only in phase `gloomtide` (the LOOP night hour; `wo.hours.night = ["gloomtide"]`). Emits `"world:giantBack" { placeId, x, z }`, sound `giant_roll`. It advertises an unbought chart; it is not a clue to a fish you can cast at. [read]

### 5.4 Bell Pool clapper ring (LOOP)
In the waiting state (L134430): if the pre-chosen species is `belled_matriarch` in `bell_pool`, at `waitDur - sb - 0.62` s one ripple at `bellPoolContact(area)` (L78807). A tell that the legend is about to bite, not a locating clue. The harbour bell model shows only when bell_pool is lifted (`harbour.frame.visible = ... bank.lifted || bank.lift`, L80484).

### 5.5 Other positional cues
- Rival wake (section 4).
- Float feints vs tells: `Pe.type === "feint"` / `"tell"` (L134451); grey vs gold with experience (`i.tells >= 2`).
- Hooked Elder heartbeat: `Ca.heart = { elder: "An Elder.", ancient: "Something ancient." }`, `wo.heart` audio/haptic.
- OLD only: legend pool golden glow `setLegendPool(!xe(), ...)` and toast "A golden stillness gathers far out…" (L132883, gated `!xe()`); the shader spot `setSlot(rz, ...)` at the pool may still draw in LOOP when Heartmoss is carried and the hour fits [inferred, not verified].
- Not found: feeding currents / spore ribbons / Gill Harp pulse (handoff "Teach the player to read feeding currents") — searched `feedingTrail|feeding trail|gillPulse|harpPulse|glowTrail`; only `glowTrailRangeMult` (OLD) exists. Proposal only.

---

## 6. Murk and other voices

### 6.1 Murk's once-only lines (LOOP)
Storage `meta.loop.said = {}` (L104881) via `sayOnce(key)`. Selection at the home tally `function Xhe({...})` (L161628), first match wins: `brook` → `listComplete` → `at:<water>:home` → (empty trip: `at:<water>:away` or `firstAway`) → `legendFirst` → `firstGiant` → `firstJackpot` → (after firstSale) away line, `firstTackle`, `firstPart`, `firstTreasure`, `firstTrophy`; else `firstSale`.
Strings (`Ca.murk`, L47024 and additions): empty "Nothing? The water keeps its own counsel. Go again."; wake "Awake, little Wick? Good. Fish sell. Clams buy. That's the whole of it."; firstChart "Three slots in that hold. Fill them and come home."; firstSale "Clams. Spend them here. I'm the only shop left."; firstQuiet "Quiet water. Move on, or go home."; firstLetGo "Let one go and the water remembers."; firstTrophy "Now that's a fish."; sailOut ["Bring me something with a story.", "The big ones come up at dusk. They always did.", "Back already? Good. Out you go."]; firstMap "It's in the mist. Go and look."; firstGiant "That one had a name before you met it."; legendFirst "Her. You brought me her. Sit down, I'll count it twice."; listComplete "Every fish in this water. I'll write that down."; firstSmall "Small ones make good bait. Press and hold “Let go”."; firstAway; firstTackle; brook; firstTreasure "The water keeps what it takes. Mostly."; firstPart "That'll fit her. I'll see to it by morning."; firstJackpot "Somebody's whole fortune. Now it's yours."; shelfBare "Shelf's bare. Keep the rest; the road goes on."; `at.sporewood` map "New water, new tackle. Your hands keep a third.", home "Spore Cake on the hook. They like it sweet here.", away (above).
Shop shelf lines are species clues: `Ca.shelf` e.g. lumen_moss "For the Gloam Eel and the Candlefin Koi." (earlier "The Gloam Eel bites on nothing else."), feather_fly "For Dusk Minnows, Chub, Lampsippers and Koi.", glimmer_spoon "Flash, for pike and the big hunters.", bone_jig "Hopped deep, for big perch and bass.", bell_spinner "For the Mossmere's giants.", heartmoss "Ten Heartmoss Balls. Fish the Bell Pool by day or dusk. Other fish take them too." **Heartmoss's shelf line is the only place the legend's where+when+bait is spelled out.**

### 6.2 Rumours (OLD data, dead in LOOP)
`RUMOURS: () => Dee` (L43018): 24 three-tier rumours across 4 zones, each `{ id, zone, place, species, tiers: [3 strings] }`, e.g. `r_span` (under_the_span, bridgechain_sturgeon) "The bridge kept its chain. Something else kept the bridge." / "Thread the arches of the Toppled Bridge with a clean cast." / .... `TODAYS_RUMOUR: () => Wee`: `{ perRealDay: 1, giantsOnly: !0, residentChance: 0.6, favour: 0.3, lines: ["An Elder {species} turns at {place}.", "Something old feeds at {place} tonight.", "{place} is holding a giant. Murk swears it.", ...] }`. Relic "Rumour Shell" ("+1 rumour tier per visit to Murk"). Consumer: only `Ze()?.getTodaysRumour?.()` (L128187); **no `getTodaysRumour` implementation exists** (searched). A cast-time `rumour` match bonus (+0.3, L128306) is therefore inert. Tiered, escalating clue text is exactly the hunt's shape; the data is reusable, the system is not live. [read]

### 6.3 Toasts, banners, tutorial, firsts
- Fishing toasts (LOOP-relevant): "No open water there."; rival toasts (section 4). OLD-only toasts include "The water goes very still.", "{name} is enraged.".
- Tutorial `Ca.guide.boxes` (welcome, chart, cast, bite, fight, card, tackle, home, murk, away) and `Ca.guide.newWater` "New water: new gear, lures and bait at Murk's."; save `meta.loop.tutorial = { done, step }`; tips use `seenTips`. Teaching captions `Ca.teach = { notches: "How big they run here.", dots: "Good bites left here tonight." }`.
- Firsts/seals: `meta.loop.firsts = { seen: [], seals: [], best: {} }`, updated by `function Nle(e, t, n, ...)` (L105612) on catch (new kind, `"<species>|<class>"` seal, best). Lake map seals gate the next lake (`sw(...)`, `seals`) — owned by the travel-gating map, not detailed here.
- Lift title (section 2.3).

---

## 7. Character sheet pages
Sheet = first journal tab (`Ca.sheet.title = "{name}'s Sheet"`). Pages (L165056): `pages = { buffs, tackle, raft, home, odds, rivals }`, labels **Overview, Tackle, Raft, Home, Odds, Rivals** (`nav.className = "gw-kit-tabs"`). HANDOFF lists five; there are six.
- Overview: context "On the water"/"At home · preview" · place · hour; guide line **"Hold helps you land a fish once it is hooked."**; rows from `function currentKitRows(model, view, data, firstOpen)` (L164280) as `{ source, effect, when }`: Wick passive (Taper: "The first fish bite of the outing skips common fish." / "Giant bite weight ×{share}, up to {cap}% share."), each tackle slot ("+n Hold · m cast · ±% strike time" + found-item lines), lure/bait plates ("+n Hold against fish that favour it.", legend bait "Allows a legendary bite in its pool."), carried bonus, buffs (bigger/keel, family, lantern "Night only", sooner, rarer, giants "Bite weight ×k for its target giants.", creel, good "n good bites before the water quiets.", orders, bed, oars, letGo/quiet), plus size-share moves "{Class} share a% → b%".
- Odds: section 1.7. Rivals: section 4.
**Hook value:** `currentKitRows` is the natural place to show "your rig vs the monster's needs".

---

## Hook points for the hunt loop
1. **Old Rivals as the monster template.** Generalise `meta.oldRivals.active` to a per-lake authored monster (`speciesId`, `z`, `place`, plus new `light`/`bait`/`presentation` requirements). Reuse `rivalGate`/`rivalPurchases` for the rig requirement, `rollRivalVisit` cadence, `prepareRivalVisit` eligibility, `chooseRivalBite` forced bite, `showRivalWake` sign, `landOldRival` closure, `fillRivalJournal` page and `showKeepsake`. Remove the `"mossmere"` literals and the escape-only birth.
2. **Landing → next lake.** `landOldRival` (and the legend landing path `ne(F.id)` / `meta.loop.legends`) is the event to open the next lake; the OLD zone table already has `unlock.requires: [{ type: "legendary", id: "belled_matriarch", label: "Land the Belled Matriarch" }]` (L33501) and `drifting_grove` (L33590) as a data precedent.
3. **Where it lives:** chart purchase / notebook `reveals` → `places.revealed` → `maps.places` → `liftDue` → lift camera with title. A "monster place" can be a `secret: !0` place revealed by a clue item, exactly like `veilback_brook`.
4. **Evidence items:** notebooks (`wo.lostTackle[*].boost/guest/reveals`, text via `N5` and `Ca.lost.log`) are data-driven clue packets dropped by the finds table; a monster notebook could carry its hours and bait lines.
5. **Locked-card glyphs:** `$3`/`m4` already expose hours, bait and place-kind for unknown species; add monster-specific glyphs that light up as clues are found.
6. **Tells:** add a monster-specific tell to `bs.<water>.tells` (makers currently exclude giants/legends in `Gj`), or reuse the rival wake as the "it is here now" sign; `"sign:spawn"` and `"world:giantBack"` are bus events to hang clue logic on.
7. **Escape advice:** `gearEscapeAdvice` already computes the actual missing gear against the fish's real size and never names it; `loss.observation` records bait + light + place.
8. **Murk:** `Xhe` + `sayOnce` + `Ca.murk.at.<water>` keyed lines are the place for staged rumours; the dead `RUMOURS` (3 tiers per species/place) and `TODAYS_RUMOUR` templates are ready text structures.
9. **Odds page:** with a "pinned" target (`pinGear`, `pinned`) the sheet could show the monster's row once enough clues are known.

## Gaps
- No per-species clue progression or "clues found" state anywhere in `meta.loop` (searched `clue` — only rival `clue` text). Nothing records that the player has learned a monster's place, hour or bait.
- LOOP escapes do not write the journal (section 1.5): no "glimpsed" state, no escape history, escaped fish are not "met" on the Odds page.
- `species.hint` text is never shown in LOOP.
- No feeding-time window per individual fish: rivals have no light rule; legend hours come only from species `time`. Feeding currents are a proposal only (not found).
- No presentation requirement beyond lure/bait id and line/hook caps (no depth, retrieve style or cast placement rule for a bite; retrieve styles are visual only per handoff `retrieveStyles`).
- Rumours have no implementation (`getTodaysRumour` missing).
- Tells exclude giants and legends; the giant back only shows in unlifted mist; there is no sign that locates a monster inside an unlocked place except the rival wake.
- Old Rivals: Mossmere only, one at a time, gate is purchase only, born only from an escape.
- Lake travel is gated by map seals and price (`sw`, `wo.access.gear = { sporewood: "rod:1" }`, `wo.waters.sporewood.lake = 1400`), not by landing anything in LOOP.

## Checked

Sceptical re-check against `reading/game.pretty.js` (line numbers are that copy).

1. **Confirmed.** `oe()` (L108863): `if (f(q)) { ... e.requestSave(); return; }` with `f = (ge) => d() && ge?.outing === "trip"` (L108111). It runs before any `journal[id]`, `seen`, `gotAway`, `escape`, `elderLog` or `journal:seen` write. The only other `journal:seen` emit and `Et.seen = !0` are in the same function, after the return (L108895, L108909). On a trip the branch still does `ne(F.id)` (legend wound) and the marked-fish `gt()` / `rehooked` updates. `ew` = `caught > 0 || !!seen` (L103875).
2. **Confirmed, with one nuance.** `$3` (L105405) / `m4` (L161552). Glyphs depend on the card type. Seal-list cards (`list`, from `op()`) get `kind_<kind>` plus hours. Group cards get hours plus a bait glyph; the group header carries the kind and the name, and the name shows only when owned. The bait glyph falls back to `worm` for any bait not in `Yhe`. Uncaught cards open only the "big" view with "Catch to reveal" (L168132, L168287). Species detail `_t` runs only for caught cards. The other route into it is `openLog` from the got-away card, and `H()` returns early on LOOP trips (L149400). So `species.hint` is not reachable in normal LOOP play.
3. **Confirmed.** `loseOldRival` (L32823): trip, mossmere, not legendary, `sizeClass === "elder"` (ancients keep `sizeClass` elder with `ancient` flag), finite z, not `cut`; birth needs `overCap.advice`, no `rematchId`, reason `snapped`/`thrown`, non-empty `rivalPurchases`, `random() < 0.8`. Id `mere-` + (landed.length+1); name `K3(...) || "The Hook-Thief"`; one `book.active`. The call site adds more gates: `xe() && !i.tutorial && !i.find && Yt() === "mossmere" && meta.loop.tutorial.done !== false` (L130870).
4. **Confirmed.** `rollRivalVisit` (L32894) matches. `prepareRivalVisit` (L128821) also returns early on: `run.arrival.cap`, tutorial not done, `forceSpecies`/`forceFind`, no bait **and** no lure fitted, and a rival species absent or at p=0 in the cast's odds. `gap++` only runs when the gate is open (`!waiting && rollRivalVisit`). The gate opens in the buy handler only if the bought shelf id is in `needsPurchase` (L106211). Shelf ids are `line:<n>`, `lure:<id>` and `tin:<id>` (L103065, L103081, L103108).
5. **Confirmed.** `gearEscapeAdvice` (L32898) wording and search as stated. It uses only local lures that are not `found` or are owned, `tins[water]` plus `cut_strip`, and line tiers. The handler `b() ? te.overCap && kt(te) : ...` (L148930) applies; `kt` shows the text for `Ge = 6` s. On a rival birth, `rivalShoppingClue` text is appended to the advice (L130879).
6. **Confirmed.** Notebook `reveals` push to `places.revealed` and `h7` to `maps.places` (L31489, L31247); `Ple` = owned, not lifted, cheapest first (L105396); `lift: { thin: 3, title: 1.2, back: 0.6 }` (L46857); `markLifted` at phase end (L50709). Only `veil_notebook` has `reveals` (L47436). Bought places use the same lift queue; reduced motion sets `thin` to 0.
7. **Confirmed.** `Gj` (L133562) filters `!giant && rarity !== "legendary"` and returns null in mist. The non-`Gj` fallback `_4` (L132902) drops giants in LOOP and draws from the pool, which has no legendaries. `giantBack` gate `Re.places.includes(id) && phase in ["gloomtide"] && !(at.lifted || at.lift || at.op < 0.5)` (L80405-L80412). There is also a debug `forceBack`.
8. **Confirmed.** Searched `getTodaysRumour`, `TODAYS_RUMOUR`, `RUMOURS`, `Rumour`, `todaysRumour`: the only call is `Ze()?.getTodaysRumour?.()` (L128187); no implementation. `Dee` (L43018) has 24 entries with 3 tiers each; `Wee` (L43296) is data only.
