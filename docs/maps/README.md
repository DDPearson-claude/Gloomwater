# Code maps

Reference maps of how the game works today, written by reading the bundled build and checked against it. They exist so that new work reuses what is already there.

| Map | Covers |
|---|---|
| [legend.md](legend.md) | The legendary-fish encounter from cast to sale |
| [progression.md](progression.md) | Lakes, travel between them, and the save |
| [clues.md](clues.md) | Every way the game already tells the player something they can act on |
| [conditions.md](conditions.md) | The bite pipeline, the rig model, and what the engine can test about a cast |
| [lakes.md](lakes.md) | Content inventory of Mossmere and Sporewood: places, fish, finds, shop stock |
| [show.md](show.md) | The River Monsters list turned into hunt templates |

## Reading them

- Findings are cited by search anchor: a function name, property name or string that can be searched for in the game script.
- Line numbers such as `L32480` refer to `src/game.js`. They were taken from a single-pass formatting of the build these maps were made from: exact up to about line 58200, up to 4 lines out after that, and they drift as the code changes. The anchors do not.
- Each map ends with a "Checked" section. A second agent tried to refute its key claims against the code: 33 of 40 held, and the 7 that did not were corrected in place.
- The maps describe the build as it stood on 21 November 2026. Treat anything in them as a starting point to confirm, not as a guarantee.
