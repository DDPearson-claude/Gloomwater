# The hunt, per lake

The monster hunt's code works for any lake that has an entry in `wo.hunts` (its rules) and `Ca.hunts` (its
words), both keyed by the water's id. A lake with no entry has no hunt: every hunt check there says no.
Mossmere's entry is the only whole hunt. The save keeps one hunt record per lake in `loop.hunt[water]`, as it
always has.

A lake may supply pieces before its whole hunt. An entry with no `legend` is not a hunt (`huntOf` says no, so
there is no record, tale, character, find, rig or ending there), and only the pieces it names work. Sporewood's
entry supplies its time clue alone, the seedfall: `huntTimeOf` and `huntTimeWords` read the `time` piece of any
entry, whole hunt or not.

## What a lake's rules must supply (`wo.hunts[water]`)

- `legend`: the legend the hunt is for. She is never sold: she is measured and let go.
- `hidden`: true keeps her nameless ("the thief") until she is first landed.
- `taleEvening`: the first tally evening Murk may tell the tale.
- `character`: the one who gives the first clue: `island` (its name in the lake's arena), `lampEvening`, `reach`, `leave`.
- `part`: the patch of lake on his map, as `padBlobPts` numbers. Being in it in her time starts the nudges.
- `time`: the time clue: `fromEvening`, `at`, `strokes`, `strokeGap`, `herTime`, `tries`, `sound`, `pitch`, `volume`, `late`, `flare`, `roostFlock`, `roostNear`. `phase` "dusk" strikes by the dusk's clock, running on into the night (Sporewood's seedfall); with no `phase` it is the night's. `tries`, `flare` and `roostFlock` may be left out.
- `find`: her water: `place`, `x`, `z`, `theft`, the boils (`boilSpread`, `boilEvery`, `boilSeen`, `boilClose`, `nudgedEvery`, `nudgedSeen`), `corkOffset`.
- `scene`: the cutscene after the find: `kind` names its director in `HUNT_SCENES`; the rest is its own timing.
- `rig`: `order` (fight order), `right`, `at`, `cause`, `takeNeeds`, and `wire` (the leader she feels and lets go).
- `lineup`: the suspects, in drawing order.
- `marks`: the bite marks other fish carry (`cuts`, `holes`, `ring`) and `leftBy`.
- `beats`: the tackle arrivals her clues bring: `map`, `theft`, `ring`.
- `pad`: the notepad: `art` (its drawings in `PAD_ART`), `places` (key, number, page of each sketch), `oldSwirl`.
- `bounty`: the clams Murk pays at the tally after the landing.
- `relic`: the keepsake given then (an id in `wo.relics`; its tally picture in `RELIC_ART`).
- `opens`: the water whose chart her landing lays down (`wo.access.monster` is made from this).

## What a lake's words must supply (`Ca.hunts[water]`)

- `tale`, `murk` (his tally lines and nudges), `drawn`, `marks`, `water` (boils, the theft, the cork).
- `hob`: the character's talk (`tag`, `first`, `nights`, `greeting`, `after`, `next`, `ok`).
- `pad`: the notepad's words, with `lake` (the name at the head of each page) and `tab`.
- `refusal`, `ending` (the measuring card, the bounty row, Murk's lines, the relic's name and line, the rod).
- `time`: the time clue's lines (`strikes`, `missing`, `still`, `birds`, `birdTaken`, `odds`, `holdFull`, `bites`, `feeds`). `first`, when given, is said at the lake's very first time clue in place of `strikes` (kept in `said["time:<water>:first"]`); `missing` is said only by a hunt that has her water.
- `seal`: what the chart her landing opens calls her until she is landed.

## Other per-lake tables the hunt leans on

- `wo.arrivals[water]`: the tackle that reaches Murk's shelf with the story (order, parts, beats: `fish`, `runs`,
  `quiet`), what a quiet tally waits for (`quietAfter`) and what Murk says when an arrival brings one part of several
  (`alone`). The hunt's own beats name an arrival (`beats.map`, `theft`, `ring`). Sporewood's three (the Burl Hook,
  the Brass Trace, the Mossthread Snood) come on quiet tallies until its hunt supplies Burr's almanac and the first
  cracked pod as their beats, and wait on quiet tallies for Murk's gifts. Its `gifts` are Murk's
  gifts there, in order (the first at the first tally with a sale in that lake, each later one at the tally after the
  one before it; Sporewood's Drift Float and Seed Pouch). Mossmere's lead and tin keep their own older rule.
- `wo.orders.practice[water]`: practice orders (first, after, max, parts). No entry: no practice orders.
- `bs[water]`: the lake's bite tables, among them the rig parts' tags (`leader`, `hookSet`), the parts a loss on the
  Plain Knot or the Mere Hook names (`lossParts`), and its signs on the water (`tells`, `sight`).
- `Ca.legendAway[legend]`: why she got away, by legend (it was already per legend).

## Still Mossmere's alone, reached through its entry

- The notepad's drawings (`PAD_ART.mossmere`: the map of Mossmere, the X, the line-up fish, the rig slices).
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
