# The hunt, per lake

The monster hunt's code works for any lake that has an entry in `wo.hunts` (its rules) and `Ca.hunts` (its
words), both keyed by the water's id. A lake with no entry has no hunt: every hunt check there says no.
Mossmere and Sporewood have whole hunts. The save keeps one hunt record per lake in `loop.hunt[water]`, as it
always has; an older save gains a fresh record for a lake whose hunt it has not met.

A lake may supply pieces before its whole hunt. An entry with no `legend` is not a hunt (`huntOf` says no, so
there is no record, tale, character, find, rig or ending there), and only the pieces it names work:
`huntTimeOf` and `huntTimeWords` read the `time` piece of any entry, whole hunt or not.

## What a lake's rules must supply (`wo.hunts[water]`)

- `legend`: the legend the hunt is for. She is never sold: she is measured and let go.
- `hidden`: true keeps her nameless ("the thief", "the wandering island") until she is first landed.
- `lakeEvenings`: true counts the thresholds below (`taleEvening`, `character.lampEvening`, `time.fromEvening`, and
  the Drowned Greenhouse's lamp) in the evenings spent in this lake (`huntLakeEvening`, from the trip's
  `run.lakeEvening`), not the whole game's. Sporewood's does; Mossmere's counts the game's evenings, as before.
- `taleEvening`: the first tally evening Murk may tell the tale.
- `character`: the one who gives the first clue: `island` (its name in the lake's arena) or `place` (a place whose
  `greenhouse` door he waits by: Burr's), `lampEvening`, `phases` (the hours he talks, when given: Burr's are dusk
  and night, while his lamp is lit), `reach`, `leave`, and `worn` (the part whose loss his last line waits for:
  "leader" unless named).
- `part`: the patch of lake on his map, as `padBlobPts` numbers, or `{ eddy: metres }`: the water that near the
  evening's eddy. Being in it in her time starts the nudges.
- `time`: the time clue: `fromEvening`, `at`, `strokes`, `strokeGap`, `herTime`, `tries`, `sound`, `pitch`, `volume`, `late`, `flare`, `roostFlock`, `roostNear`. `phase` "dusk" strikes by the dusk's clock, running on into the night (Sporewood's seedfall); with no `phase` it is the night's. `tries`, `flare` and `roostFlock` may be left out.
- `find`: her water: `place`, `x`, `z`, `theft`, the boils (`boilSpread`, `boilEvery`, `boilSeen`, `boilClose`,
  `nudgedEvery`, `nudgedSeen`), `corkOffset`. Or, for water that moves (Sporewood's), `eddy: true`: her water is
  the evening's spore drift eddy (`herWaterAt(water, evening)`), found when the raft first comes within `rise`
  metres of it in her time once the character's map is drawn (no theft, no place to own); she takes a cast within
  `take` metres of it; `rafts` (`from`, `pace`, `sink`) sets moss rafts drifting in to it in place of the boils.
- `scene`: the cutscene after the find: `kind` names its director in `HUNT_SCENES`; the rest is its own timing.
  Or `scenes`, a list of several, each `{ kind, on, after, length }`: `on` "find" plays as her water is found,
  "next" at the first time clue after that night, `after` seconds from its first stroke; `length` is the plain
  title card's when there is no director of that kind. Each is seen once, in `record.scenesSeen[kind]`.
  Mossmere keeps its one `scene` and its `birdCutsceneSeen`.
- `rig`: `order` (fight order), `right`, `at`, `cause`, `takeNeeds`, and `wire` (the leader she feels and lets go).
  `depth` ("lead" unless named; Sporewood's "drift") and `bait` (one bait she takes, at the top grade's chance,
  in place of her water's bait table: Sporewood's Capseed).
- `lineup`: the suspects, in drawing order.
- `marks`: the bite marks other fish carry (`cuts`, `holes`, `ring`) and `leftBy`. Or `order` (the marks this hunt
  knows), `own` (each line-up fish's own mark, shown on its catch card) and `pod` (`mark`, `near`, `chance`: a
  cast within `near` metres of her water in her time brings up a cracked pod carrying her mark), and `art`.
- `beats`: the tackle arrivals her clues bring: `map`, `theft`, `ring`, or a mark's name (Sporewood's `person`,
  the first cracked pod).
- `pad`: the notepad: `art` (its drawings in `PAD_ART`), `places` (key, number, page of each sketch), `oldSwirl`.
- `bounty`: the clams Murk pays at the tally after the landing, into the purse of the lake she is landed in.
- `relic`: the keepsake given then (an id in `wo.relics`; its tally picture in `RELIC_ART`).
- `opens`: the water whose chart her landing lays down (`wo.access.monster` is made from this), or null for none
  yet (Sporewood's: Glasswater does not exist, and the ending's `murk.next` says so).

## What a lake's words must supply (`Ca.hunts[water]`)

- `tale`, `murk` (his tally lines and nudges), `drawn`, `marks`, `water` (boils, the theft, the cork; Sporewood's
  `rise` and its moss rafts in the boils' keys), and `scenes` (each scene's `title` for a plain title card and
  `after`, the line when it ends). Sporewood's `marks` are `own` (each line-up fish's card line), `pod` and
  `person` (the cracked pod's two lines).
- `hob`: the character's talk (`tag`, `first`, `nights`, `greeting`, `after`, `next`, `ok`).
- `pad`: the notepad's words, with `lake` (the name at the head of each page) and `tab`.
- `refusal`, `ending` (the measuring card, the bounty row, Murk's lines, the relic's name and line, the rod).
  `ending.murk.next`, when given, is said after the keepsake (Sporewood's word that Glasswater is not charted).
- `time`: the time clue's lines (`strikes`, `missing`, `still`, `birds`, `birdTaken`, `odds`, `holdFull`, `bites`, `feeds`). `first`, when given, is said at the lake's very first time clue in place of `strikes` (kept in `said["time:<water>:first"]`); `missing` is said only by a hunt that has her water.
- `seal`: what the chart her landing opens calls her until she is landed.

## Other per-lake tables the hunt leans on

- `wo.arrivals[water]`: the tackle that reaches Murk's shelf with the story (order, parts, beats: `fish`, `runs`,
  `quiet`), what a quiet tally waits for (`quietAfter`) and what Murk says when an arrival brings one part of several
  (`alone`). The hunt's own beats name an arrival (`beats.map`, `theft`, `ring`, or a mark's name). In Sporewood
  Burr's almanac brings both leaders (`sporewood_leaders`; one alone as `traceOnly` or `snoodOnly`), the first
  toothy fish brings the Brass Trace sooner, and the first cracked pod brings the Burl Hook (with Murk's hunt line,
  `Ca.arrivals.hunt`), which also comes on a quiet tally once Murk's gifts are given. Its `gifts` are Murk's
  gifts there, in order (the first at the first tally with a sale in that lake, each later one at the tally after the
  one before it; Sporewood's Drift Float and Seed Pouch). Mossmere's lead and tin keep their own older rule.
- `wo.orders.practice[water]`: practice orders (first, after, max, parts). No entry: no practice orders.
- `bs[water]`: the lake's bite tables, among them the rig parts' tags (`leader`, `hookSet`), the parts a loss on the
  Plain Knot or the Mere Hook names (`lossParts`), and its signs on the water (`tells`, `sight`).
- `Ca.legendAway[legend]`: why she got away, by legend (it was already per legend).

## What the hunt passes to Sporewood's pieces, and when

The pieces are the art's (`Sporewood's pieces`, below). The hunt looks each up when it needs it (`typeof` first), so a
build without one plays on with no error and no blank screen.

- **`HUNT_SCENES.island`, `HUNT_SCENES.crunch`**: made once, when first due, as `HUNT_SCENES[kind](game, { report,
cue })` (`cue()` gives the scene now playing), and begun with `begin(cue)` only when it is due (`huntSceneDueOf`)
  and nothing is on screen: the island on the evening her water is found, as soon as the screen is free; the crunch at
  the first seedfall after that night, 6 s after the first sigh. `cue` is `{ kind, water, evening, rule, x, z (her
water tonight: the evening's eddy), raft: { x, z }, title, after }`, so `begin` reads it as its `at`. The hunt marks
  the scene seen as it starts (`record.scenesSeen[kind]`), calls `update(dt)` every frame, `skip()` on a press and
  `stop()` when the trip ends, and takes the scene as over once `state()` is null and the cinematic is off. The art's
  scene says its own line (`Ca.hunts.sporewood.time.islandRose`, `.crunched`). If the director is missing, throws or
  its `begin` says no, a plain title card plays (`titleSceneDirector`: the camera on her water, the scene's title,
  rings on the water) and the hunt says the same line itself (`scenes[kind].after`). `wo.hunts.sporewood.scenes` is a
  list, so it overrides none of the art's timings.
- **`PAD_ART.sporewood(key, text, at, view, fresh)`**: called by the notepad with Mossmere's keys (`map`, `taken`,
  `lineup`, `swirl`, `back`), `text` = `Ca.hunts.sporewood.pad` and `view` = the loop's `notepad("sporewood")`:
  Mossmere's fields, plus `eddies` (`{ id, x, z }` of the four), `eddiesMarked`, `foundAt`, `depth` ("drift") and
  `pods`; `marks` are of `beak`, `plates`, `razor`, `pads`, `person`; `swirlKind` is "left", "float" or "lure". The
  marks strip's matches come from `wo.hunts.sporewood.marks.leftBy`. A drawn sketch whose drawing is missing, empty
  or fails shows its words alone (`padPlainPanels`).
- **`PAD_MARKS[mark].card`**: put on a line-up fish's catch card picture (`.gw-cc-art`, given `gw-cc-marked`), under
  its mark's line, from Burr's almanac until she is landed.
- **`RELIC_ART.burrs_seed`**: the keepsake's picture on the ending's tally card.
- **`makeBurr({ low })`**: made the first time his lamp is lit, added to the arena at `greenhouse.burr` with its
  `yaw`, shown only while the lamp is lit and no cutscene plays, updated with `(dt, { raft, night })`.
- **`makeMossRaft({ low })`**, **`makeCrackedPod({ low })`**: pooled and reused, never disposed. Every frame the hunt
  sets the group's x and z on its path, its scale (1 down to 0 as it sinks) and turn, and calls `update(dt, {
height, night, k })`, where `height` is the water's height there plus the path's lift (a pod rises to the raft
  over 0.7 s, is held, and is gone after 3 s). They are put away when the trip ends.
- **`makeMeadowOnRaft({ low })`**: made once Burr's Seed is the player's, mounted on the raft's deck at
  `HUNT_ART_MOUNT.meadow` with `meadowScale`, updated with `(dt, { night })` each frame with the raft's finds.

## Still Mossmere's alone, reached through its entry

- The notepad's drawings (`PAD_ART.mossmere`: the map of Mossmere, the X, the line-up fish, the rig slices), and
  its catch-card marks (`catchMarkSvg`).
- The bird at midnight (`HUNT_SCENES.bird`), the bell's sound and the toll-tower flare (`time.sound`, `time.flare`).
- The 3D scene is untouched: the harbour bell frame and cork at the Bell Pool, Hob and his lamp on his rock,
  the lamp on the raft's bow, the bell heard while she is hooked. These name Mossmere's places and models
  directly; a new lake builds its own beside them.

## Adding a lake's hunt

1. Add its entry to `wo.hunts` and `Ca.hunts`, and to `wo.arrivals` and `wo.orders.practice` if it has them.
2. Add its notepad drawings to `PAD_ART` and, if its cutscene is new, its director to `HUNT_SCENES`.
3. Add its relic to `wo.relics` and `RELIC_ART`.
4. Build its own scenery pieces (the character on his island, her water's marker). Nothing else needs code.

## Sporewood's pieces

What is seen in Sporewood's hunt, built apart from its rules (step 5b of `sporewood-plan.md`). The rules call these
names and decide when; nothing here triggers itself. Each 3D piece adds no light (glows are unlit colours or
sprites), and makes nothing until it is called. `low` is `game.render.getQuality() === "low"`: fewer segments and
small things, the same silhouette. To see any piece on its own: `?debug=1`, then `__gw.debug.huntArt` (`show`,
`scene`, `make`, `pad`, `card`, `relic`, `clear`), and `tools/scenery-shots.mjs --lake sporewood` has a view of each.

- **`makeBurr({ low })`** returns `{ root, update(dt, { raft, night }), dispose() }`. His front is +Z and his feet are
  at 0, as Hob's. Put him at the spot the Greenhouse keeps (the arena's `greenhouse.burr`, `{ x, y, z, yaw }`, the
  same as `gwGreenhouse(...).burr`): `root.position.set(x, y, z)`, `root.rotation.y = yaw`, and add `root` to the
  scene once. Each frame he is shown: `update(dt, { raft: game.player.position, night })`, where `night` is 0 by day
  to 1 at night (the caps on his brim glow more). He breathes and sways, now and then looks down at his seed tray,
  and turns his head (and his body a little) to the raft when it is within 14 m in front of him. Show and hide him
  with `root.visible`; `dispose()` takes him off the scene and frees him. Four draw calls, about 6,100 triangles (on low
  about 3,800); with the raft over 40 m away he is not drawn at all (the lamp's halo marks the place).
- **`HUNT_SCENES.island`** and **`HUNT_SCENES.crunch`**: directors with the bird's signature, `(game, { report })`,
  and contract: `begin(at)`, `update(dt)`, `skip()`, `stop()`, `state()`. `begin` plays at once and returns true if
  the game can show a scene (on the water, no other scene or lift, a run on): it does not judge whether the scene is
  due, so call it only when your rule says so (as the flow calls the bird after `huntSceneDue`), and mark it seen
  then. `at` is `{ x, z }`; left out, the evening's eddy (`sporeDriftOf(run.evening, run.zone).eddy`). She comes up
  there, or 8 m (crunch: 7 m) from the raft towards it when the raft is nearer, never under the raft. The scene sets
  `game.cinematic` (the evening's clock stops) and `game.sceneHush` (the spore drift's band and eddy fade down while
  it plays and ease back after), frames her with the landmark camera, and builds her model
  (`game.models.createFish("drifting_grove")`, 5.2 m long), a few pods and, for the crunch, the pod she cracks (lit,
  larger than the drifting pods) and its pieces; all of it is freed at its end. `update(dt)` each frame (the flow's own update, as the bird's); `skip()` ends it at once (a
  press); `stop()` puts everything back with no line (leaving the water). On its end (played or skipped) it shows
  the line `Ca.hunts[water].time[rule.line]` as a lore toast if there is one (`islandRose`, `crunched`), and emits
  `hunt:islandScene` / `hunt:crunchScene` with `{ phase: "start" | "end", x, z, skipped }` (the crunch also
  `phase: "crunch"` at the crack). Lengths: the island about 10 s, the crunch about 7 s. Its timing is
  `HUNT_SCENE_RULES[kind]`; any of it may be overridden by `wo.hunts[water].scenes[kind]` (the same object your
  `scenes` entry names it by). The crunch plays the new sound `pod_crunch`.
- **The Meadowback Pacu**: her 3D model is the legend's own (`merePortraits.drifting_grove`, form "pacu", mark
  "meadow"), so the fight, the landing and every other place the game draws `drifting_grove` in 3D draw her. Her flat
  drawing (the measuring card, the Journal) is a deep, round fish with teeth like a person's (shape "bream", as the
  Silver Dollar's), and she is held at the landing as a fish, not as a ray. The Sporewood field guide
  (`src/spore-guide.html`) draws the same model, with a portrait made from it; when it shows her is the rules' part.
- **`PAD_ART.sporewood`**: `(key, text, at, view, fresh)` as `PAD_ART.mossmere` (`padPanels`), by the same keys:
  `map` (1, "Where the spores gather", Burr's almanac page), `taken` (2, "The island rises"), `lineup` (3),
  `swirl` (4, "The refusal"), `back` (5, "What came back"); `almanac`, `island` and `refusal` are taken as `map`,
  `taken` and `swirl`. Its words from `text` (Ca.hunts.sporewood.pad): `map`, `taken`, `swirl[view.swirlKind]`
  with `{bait}`, `back[part]` (parts `hook`, `leader`, `line`, else `held`), `lineup` (`head`, `fish[id].name` and
  `.why`, `frame`, `none`, `landed`, `marks[mark].open`, `.match`, `.landed`), `art` (each drawing's label for
  readers), and `labels` on sketch 1: `cup`, `eddies`, `greenhouse`, `home` (a missing label is not drawn). From
  `view`: `swirlKind` and `swirlRig.bait` (the refused bait), `back` (the parts lost, in fight order), `crossed`,
  `marks` and `landed`. The line-up draws the hunt's `lineup` (else the plan's five, in order), and the marks strip
  each of `view.marks` in the order `person`, `beak`, `plates`, `razor`, `pads`; a mark's line becomes its `match`
  once a fish in `marks.leftBy[mark]` (one id or a list) is crossed out.
- **`PAD_MARKS[mark]`**, for `beak`, `plates`, `razor`, `pads` and `person`: `strokes` (the strip's drawing in the
  notepad's stroke code, `PAD_LU.markVb`) and `card` (an `<svg>` string with its own style: append it to the catch
  card's picture box, `.gw-cc-art`, which must be `position: relative`). Each is drawn on a seed pod; on the card the
  pod is an inset in the picture's lower left corner, the mark in red.
- **`makeCrackedPod({ open, marks, low, glow })`** returns `{ group, setOpen(k), update(dt, { height }), dispose() }`: the
  seedfall's pod (0.22 by 0.17 by 0.34 m), two halves on a hinge at the stalk; `open` 0 to 1 (default 0.55, cracked
  clean through, its pale flesh and empty seed bed showing; past half open the halves also come apart), `marks`
  (default true) the person marks, `glow` a warm halo and a lit shell (the crunch's). Hang it on the
  line, or float it: `update(dt, { height })` bobs it at the water's height there. 3 draw calls.
- **`makeMossRaft({ low })`** returns `{ group, update(dt, { height, night }), dispose() }`: a clump about 1 m across.
  Set `group.position.x` and `.z` (it drifts where you move it); `update` bobs and turns it and sets its y from
  `height`. All rafts share one geometry and material (never freed): one draw call each (and on medium and best one
  glow sprite after dark). About 130 triangles on low, 800 otherwise.
- **`makeMeadowOnRaft({ low })`** returns `{ group, update(dt, { night }), dispose() }`: Burr's Seed grown in a box.
  Mount it on the raft's deck as Hob's Lamp is (`hH`, the raft's finds): `group.position.set(...HUNT_ART_MOUNT.meadow)`
  (0.4, 0.24, 0.8: the stern's corner across from the brazier), `group.scale.setScalar(HUNT_ART_MOUNT.meadowScale)`,
  `deck.add(group)`, and `update(dt, { night })` each frame; remove and `dispose()` it as the lamp is.
- **`RELIC_ART.burrs_seed`**: its tally picture, in `HOBS_LAMP_ART`'s style: a seed split at its top with a sprout.
