# Save fixtures

Real saves written by the game: each file is the exact string the game kept in localStorage under
`gloomwater.save.v1`, taken at home after Murk's tally. They were made by `tools/make-fixtures.mjs`
from the build at commit 3bacf14, before the legend was renamed, so they stand for existing players'
saves. The scenario tests (`npm run scenarios`, `tools/scenarios.mjs`) load them. Do not edit them by
hand; to make a new kind of save, add a step to `tools/make-fixtures.mjs`.

Every step plays the game in headless Chromium with `?debug=1`. Fish are landed with the game's
`__gw.debug.instantCatch` (no cast or fight is played) and kept or let go on the catch card; purchases go through Murk's shelf
(`__gw.progression.loop.buy`); evenings end with Home and the tally. The Wick is Tallow throughout.

| File | How it was made |
| --- | --- |
| `fresh-first-evening.json` | New Game as Tallow, the opening tow, then the first evening: a Dusk Minnow and a Mossback Perch kept and sold. |
| `mid-mossmere.json` | From the first: three more Mossmere evenings (ten fish landed and sold, eight new kinds, so ten kinds in the journal), then 37 clams given (`debug.loop.giveClams`, to make up 160) and The Lily Maze, ten Heartmoss Balls and ten Lumen Moss bought; the Lily Maze lifted at the next set-out. Heartmoss, Lumen Moss and Mire Worms are in stock. |
| `legend-sold.json` | From mid-Mossmere: 2,000 clams given (`debug.loop.giveClams`), Under the Span, The Buoy Lights and The Bell Pool bought, then an evening at the Bell Pool with the Heartmoss Ball fitted in which the legend (`belled_matriarch`) was landed, kept and sold at the tally for her 900. |
| `sporewood-crossed.json` | From mid-Mossmere: an evening landing the rest of the Mossmere list, 3,000 clams given, the Ashwood rod and the Sporewood chart bought, then Sporewood picked on the chart, the tow, and one Sporewood evening (two fish sold). The barge is left at Sporewood. |
