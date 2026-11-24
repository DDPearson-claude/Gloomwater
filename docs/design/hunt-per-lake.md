# The hunt, per lake

The monster hunt's code works for any lake that has an entry in `wo.hunts` (its rules) and `Ca.hunts` (its
words), both keyed by the water's id. A lake with no entry has no hunt: every hunt check there says no.
Mossmere's entry is the only one. Sporewood has none yet. The save keeps one hunt record per lake in
`loop.hunt[water]`, as it always has.

## What a lake's rules must supply (`wo.hunts[water]`)

- `legend`: the legend the hunt is for. She is never sold: she is measured and let go.
- `hidden`: true keeps her nameless ("the thief") until she is first landed.
- `taleEvening`: the first tally evening Murk may tell the tale.
- `character`: the one who gives the first clue: `island` (its name in the lake's arena), `lampEvening`, `reach`, `leave`.
- `part`: the patch of lake on his map, as `padBlobPts` numbers. Being in it in her time starts the nudges.
- `time`: the time clue: `fromEvening`, `at`, `strokes`, `strokeGap`, `herTime`, `tries`, `sound`, `pitch`, `volume`, `late`, `flare`, `roostFlock`, `roostNear`.
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
- `time`: the time clue's lines (`strikes`, `missing`, `still`, `birds`, `birdTaken`, `odds`, `holdFull`, `bites`, `feeds`).
- `seal`: what the chart her landing opens calls her until she is landed.

## Other per-lake tables the hunt leans on

- `wo.arrivals[water]`: the tackle that reaches Murk's shelf with the story (order, parts, beats).
- `wo.orders.practice[water]`: practice orders (first, after, max, parts). No entry: no practice orders.
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
