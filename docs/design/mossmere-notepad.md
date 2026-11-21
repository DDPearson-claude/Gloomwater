# The fisherman's notepad (Mossmere)

Mock-up: `notepad-mockup.html` (open it on a phone and press **Gain a clue**, then **Next catch**).

## The short version

- A pocket notepad, spiral at the top, in Murk's shelf-book paper and ink. Pencil for drawing, red crayon only for crossing out.
- Exactly five sketches on three pages, under the hunt's three headings: **Where** (1 Hob's map, 2 Taken at midnight), **Which fish it isn't** (3 The line-up), **Gear** (4 The swirl, 5 What came back).
- Each sketch has a title, a pencil drawing and one or two handwritten sentences from the design (hunt part 2). Sketch 1 has a second drawing, Hob's taped line end, with its own sentence. Sketch 5 grows: each loss adds one small drawing and one sentence. Nothing else is written on the pad.
- When you gain a clue, the pad turns to the right page and a pencil draws the sketch in, stroke by stroke. Then the words write themselves.
- The line-up crosses off one fish per first catch, with a drawing of why. Bite marks collect at its foot. Nothing on the pad or in the page source shows or names what the thief is, and the words call it "it".
- Sketches are inline line art made in code: about 1 to 8 KB each as drawn, under 3 KB gzipped. All five come to about 11 KB gzipped.
- Two yes/no questions about the look are at the end.

## How the pad opens

- **Where it lives.** It is a **Notepad** tab in the Journal, beside the lake, Prints and Giants tabs (hunt part 2 puts it there). It opens at the page with the newest sketch. On a phone you see one page, with paper tabs below. On a desktop it lies open: Where on the left, the other two pages on the right.
- **First open** (evening 2, after Murk's tale). The guide box: "This is your notepad. Each time you find a clue, you draw it here. Look at the pictures to work out what you're hunting, and where." All five places show "Not found yet".
- **The foot line.** Under the pad, one narrator line says **What to try next**, from the hunt's list. It always points to a place or a person, never the answer.

## What happens on screen when a sketch is gained

1. The moment plays as usual: Hob talks, a fish is taken off your line, something turns under your rig, the thief gets away.
2. Its line shows as the game's toast, ending "You draw it in your notepad." where the design has one.
3. The pad slides up over the lower half of the screen at the right page (question 1). The fight and the world keep going behind it.
4. A pencil draws the sketch, about 3 to 6 seconds, then writes its words. A tap finishes it at once.
5. The pad slides away. A red dot stays on that page's tab until you look.
6. **The line-up.** Each first catch of one of the five fish crosses it off: one red line, then the reason drawn beside it, then its words. A catch with a new bite mark adds that mark to the strip, and catching the fish that leaves it rewrites its line. When all five are off, the empty frame's words change from "It isn't any of these, so far." to "It's none of them. Nobody here has ever caught it."
7. **What came back.** The first loss starts sketch 5 and each later loss adds to it, in fight order: hook, then leader, then line. Only the part that broke is drawn, so a part you never got wrong never appears.

## The five sketches, as drawn

| # | Picture | Words |
|---|---|---|
| 1 | Mossmere's real shore from above; the Sluice, Gatehouse, two Sisters, Mossbell Isle with Hob's lamp, the broken Span, home. Labels in Hob's hand. A dotted, hatched patch between the Gatehouse and the Sisters, about an eighth of the lake. It holds the whole 8 m circle of the thief's water with 2 m to spare, and that water sits well south of the patch's middle, so the patch never points at the spot. Under the map, Hob's old line end taped to the page: a sound line that goes pale and swollen where it was rubbed, ending in three loose strands. | Hob lost it somewhere in this shaded part, between the Gatehouse and the Sisters. Under the line end: This is Hob's old line end. It is worn rough, not cut. |
| 2 | A close-up of that corner: the Gatehouse and Sisters for bearings, a bold X where the float went under, broken boil rings round it. Across the top, the far shore and the old city wall, with the leaning toll-tower (two windows, a pointed cap, no bell drawn) and twelve tally strokes beside it, all one picture. | Something took a fish off the line, right here. It happened just after the bell struck midnight. |
| 3 | One fish to a row: Pike, Milkeye, Kissmark, Carp and Sturgeon traced from the field-guide portraits, plus a frame holding only "?". Each reason is drawn large beside its fish, so it reads at 390 px: saw teeth, with a clean cut beside Hob's worn end; a head with two long fangs and two holes a thumb apart; the trout's scar ringed in red, and the ring of scrapes close up; tube lips with a worm and weed; a snout from below with a tiny mouth and a snail. Marks strip: cuts, two holes, a ring of scrapes, each on a small fish with its sentence beside it. | Head: These five fish are big enough to pull a rod in. Frame: It isn't any of these, so far. Reasons and marks: the hunt's own sentences (hunt part 2, section 3). |
| 4 | A slice through the water at night: float and worms on the surface line, a dark turning swirl below with no shape inside, an arrow curling out of the swirl and down to a small live fish lying on the bottom. | It left the worms. It wants something alive, down on the bottom. |
| 5 | Up to three small drawings, one per loss, each beside its sentence: the bare hook on its knot; your end and Hob's taped end side by side, labelled "mine" and "Hob's", worn exactly the same way; the top of the rod with its rings and the line snapped just below the tip. | The hook pulled out of a soft mouth and came back bare. / The end came back worn rough, just like Hob's. / The line snapped by the rod, so it is too heavy for this line. |

## How sketches are made, stored and drawn

- **Made.** Each sketch is a list of strokes, one short string each. The first letter is the kind: `p` pencil, `b` heavy pencil, `f` faint, `d` dotted, `r` red crayon, `h`/`k` hatching inside a shape, `F` a traced fish, `t` handwriting, `T` tape. Paths use M L Q C Z. Sketches 1 and 2 are in lake units, so the map is Mossmere's own shore and islands, not a picture of them.
- **Fish.** Outlines are traced once, offline, from the portraits' alpha in `src/field-guide.html`, then simplified to 40 to 60 points: about 330 bytes a fish, plus four to eight hand strokes for eye, gill and fins. Her portrait is never traced or shipped.
- **Drawn.** As inline SVG. Each line gets a seeded wobble (the game's own RNG, `function Dr(`), a little overshoot at loose ends and a faint second pass. A grain filter goes on top. To draw in, each stroke animates `stroke-dashoffset` over `pathLength="1"` while a pencil follows `getPointAtLength`. Words wipe in with the game's `gwInkIn`.
- **Bytes**, as expanded strokes (raw / gzipped): map 7.5 / 2.7 KB; Hob's line end 0.8 / 0.3; close-up 4.2 / 1.3; line-up with reasons and marks 7.2 / 2.8; swirl 5.1 / 2.0; what came back, all three parts, 3.7 / 1.3; six fish outlines 1.9 / 0.9. All of it: 30 KB raw, 11 KB gzipped, in an 8.6 MB page. Kept as authoring code (as in the mock-up) it is smaller still. The mock-up is 71 KB, all inline.

## Where the journal lives in the code today (`src/game.js`, confirmed)

- Journal opener `function Pt(K = {})` (L167868); loop catalogue `function Ht(K = {})` (L168069, `cls: "gw-m-catalogue"`); its tabs in `function Ct(K, we)` (L168204): lakes, then `Oe.push({ id: "prints", ... })` and giants. The Notepad tab is one more `Oe.push`, with `Ot(vt)` taught the new id.
- Paper and ink: `.gw-book {` (L160092): paper `rgb(238, 228, 210)`, ink `rgb(38, 29, 44)`. Hand font `--f-hand: 'Cedarville Cursive', ...` (L141807), loaded by `src/shell.html` from Google Fonts. The mock-up adds a local fallback so offline text stays a hand or an italic, never upright.
- Line art to reuse: shelf engravings `function Eb(` (L156068), brush and stamp filters in `function AG(` (L145173), `@keyframes gwInkIn` (L143660), RNG `function Dr(` (L29988). The catch card's ink `function Or(e, t, n = {})` (L147792) is a raster filter and cannot be drawn in stroke by stroke, so the pad does not use it.
- Map data: Mossmere arena `id: "mossmere"` (L33371): Gatehouse (22, -12), Elder Sister (-30, -24), Younger Sister (-18, -34), Mossbell Isle (-30, 14), Sluice (0, -49); her water `deepPools` (L33382) at (-4, -14). Shore from `function x1(` (L57959). Toll-tower mesh `tollTower` (L79902), placed beyond the Sluice by `function Qe()` (L81180).

## What the save needs

Inside the hunt record (`hunt.mossmere`, hunt part 2 B4), with no save version bump (`Z3 = 4`, L104754):
- `sketches: { map, taken, lineup, swirl, back }` as evening numbers, and `unseen: [n]` for sketches not yet drawn in front of the player. An unseen sketch draws in the next time the pad opens.
- `crossed: { fishId: evening }` and `marks: { cuts, holes, ring }` (already in B4), plus `swirlKind` and `back` (the parts lost, in fight order) so sketches 4 and 5 redraw as they happened.
- Art is never saved, only ids, so a sketch can be redrawn later without touching saves. Old saves follow hunt B4: sketches drawn from what they already hold.

## Build pieces (rough sizes)

| Piece | Size |
|---|---|
| Notepad tab: three pages, paper tabs, phone and desktop layouts | small to medium |
| Sketch engine: wobble, hatching, draw-in pencil, tap to finish (about 6 KB of code) | small |
| The five sketches, the swirl's variants, sketch 5's three parts and the What held page | medium (art time) |
| Line-up: five traced fish, five reasons, three marks, crossing out on first catch | small to medium |
| The slide-up on a gained clue, the tab dot, the foot line | small |
| Save fields, old saves, a scenario test that her name never appears | small |

It is hunt part 2's build step 4 ("the notepad").

## Risks

1. **Small screens.** The line-up is one fish to a row, so at 390 px each reason is drawn about 200 px wide. Check on a 320 px phone.
2. **The hand typeface.** Cedarville Cursive is thin. With no network the mock-up falls back to an italic serif (most shots); with the font it reads well (`phone-8-with-web-fonts.png`).
3. **Sketch 5 is three small diagrams.** Each shows only what that loss brought back, so the page stays true to a real line: the snapped line is drawn at the rod, not beside the worn end.
4. **The worn end** has to read as worn rough at small sizes. It is drawn the same way everywhere (map, line-up, sketch 5): a dark sound line that goes pale and swollen, with a few nicks, ending in three loose strands. Watch it in playtest.
5. **The pad over a fight** (question 1). If it hides too much, it waits until the fight card closes.
6. **Desktop.** The spread fits 1280 x 800 with the map at 270 px; the paper tabs fall just below the fold.

## Gaps I filled

- Three pages, one per question, rather than five pages, so the two Where sketches can be studied together.
- "Not found yet" in a dashed frame for an empty place; small labels on the pictures ("cut", "Hob's", "mine", "a thumb").
- The toll-tower stands small on a far wall across the top of sketch 2, so it reads as far off and not on the water.
- The mock-up draws only sketch 4's worms version, and a player who gets all three parts wrong, so sketch 5 builds up over three presses of **Gain a clue**.
- The marks strip has no heading: each mark's own sentence says what it is.

## Questions for the designer (yes or no)

1. **When you gain a clue, does the pad slide up and draw it straight away, over the water?** Recommend **yes**: seeing the pencil draw is the reward, and it never stops the fishing.
2. **Are the five line-up fish drawn in full pencil from the start, so you know which to catch, while the sixth frame stays a "?"?** Recommend **yes**: it tells you what to go and catch, and still says nothing about her.
