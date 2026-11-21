# Map: River Monsters as design material (key: show)

Source list: `scratchpad/reading/river-monsters-fish.md` (590 lines, 66,044 bytes). It was read in full. Game context comes from `scratchpad/reading/handoff.md` (skimmed) and a few targeted greps of `scratchpad/reading/game.pretty.js`.

**Marks used in this file**
- **[L]**: read directly from the list. Anchor: the episode number and title as they appear in the row (for example `| 9 | Death Ray |`).
- **[K]**: my general knowledge of the show, not in the list. Treat as unverified.
- **[I]**: my inference or classification, for example the water type I assigned.
- **[OPINION]**: a design suggestion for the designer.
- **[C]**: read in the game code (reading copy). Anchor given, with the reading-copy line as a convenience.
- **(?)**: an entry the list itself marks as resting on one weak source. Every (?) entry this map relies on is flagged where it is used.

---

## 0. What the list contains (verifiable counts)

| Claim | Value | How to check |
|---|---|---|
| Regular episodes, rows numbered 1 to 57 | 57 | rows matching `^\| [0-9]+ \|` |
| Special rows | 31, plus 2 "Extra" Lost Reels rows | rows starting `\| Special \|` and `\| Extra \|` |
| Specials with catches unique to them | "no catches unique to them were found" (header). In practice 3 specials have bold catches: "River Monsters Goes Tribal" (Grey reef shark), "Lair of Giants" (Arapaima), "Jurassic-Sized Prehistoric Terror" (Pacific hagfish). The Lost Reels add Arapaima and Golden mahseer. | the Special rows |
| Rows in "Part 2: every fish he caught, A to Z" | 173 | the table under `## Part 2` |
| Header claim | "about **172 distinct kinds of fish**" plus "11 animals he caught that are not fish" | line 5 |
| Real distinct species | **fewer than 172** [I]. Part 2 lists several species under more than one name, for example *Ageneiosus inermis* three times ("Bocon catfish", "Dawala", "Fidalgo catfish"), *Pygocentrus nattereri* three times ("Red-bellied piranha", "Palometa piranha", "Piranha (Wikipedia: red-bellied)"), and pairs such as "Piraíba"/"Piraiba (lau-lau)", "Candiru-acu"/"Candiru-açu", "Chinook salmon"/"Chinook (king) salmon", "Black piranha"/"Black (redeye) piranha", "Barbado"/"Blinker", "Coalfish (saithe)"/"Saithe (coalfish) (?)", "Anjumara"/"Himara", "Giant grouper (Queensland groper)"/"Queensland (giant) grouper". | compare scientific names in Part 2 |
| "(?)" marks in the whole file | 37 occurrences | `grep -o '(?)'` |
| Regular rows containing at least one (?) | 20 | |
| **Bold headline fish carrying a (?)** | **none** of the 57 | every (?) in a regular row is in a supporting or "Also" entry |
| Distinct headline species (by scientific name) | 48. This drops to 47 if *Arapaima gigas* (ep 5) and *Arapaima sp.* (ep 40) are merged. | |
| Headline species that repeat | Bull shark ×3 (eps 7, 14, 22); twice each: Red-bellied piranha (1, 29), Alligator gar (3, 43), Wels catfish (4, 30), Piraíba (6, 38), African tigerfish (23, 46), Greenland shark (34, 53), Redtail catfish (35, 36), Arapaima (5, 40) | |
| Regular rows with a "hooked and lost" entry | 22 | |
| Regular rows where **the headline species itself** was hooked and lost first | **11**: eps 8, 9, 14, 21, 27, 30, 31, 37, 40, 54, 56 | "hooked and lost:" in the Also column |
| Regular rows with "caught by others" | 20 | |
| Regular rows with "seen only" | 49 | |
| Regular rows with "status unconfirmed" | 16 | |
| Regular rows whose only catch is the headline fish | 6: eps 2, 3, 15, 16, 46, 54 | |
| Bullets under "### Hooked and lost" (Part 2) | 25 | lines under `### Hooked and lost` |
| Bullets under "### Caught, but not fish" | 11 | |

---

## 1. The episode formula as a game loop

The beats below are the typical shape of an episode. Their order and texture are **[K]**: the list does not record episode structure. The **evidence** column uses only the list's own categories **[L]**.

| # | Beat | What happens on the show [K] | Evidence in the list [L] | Game mechanic it suggests [OPINION] |
|---|---|---|---|---|
| 1 | **The rumour / attack story** | Cold open on an attack, a disappearance or a local legend. The title names the "monster" ("Killer Catfish", "Death Ray", "Body Snatcher"). | Titles. In several episodes the monster in the title is not the fish he landed. Ep 20 "Cold Blooded Horror": headline Amur catfish "small", while the giant salamander is under "caught, not a fish". Ep 48 "Death Down Under": "caught, not a fish: Box jellyfish". Ep 51 "Devil of the Deep": "caught, not a fish: Humboldt squid", headline Skipjack tuna. Ep 55 "Return of the Killer Catfish": headline Golden mahseer, "hooked and lost: Goonch catfish". | Each lake opens with a **case file**: a story told by Murk or a lake NPC, with a *named but unseen* monster. The journal entry starts locked, as the existing catch-locked guides already do. |
| 2 | **Local testimony and evidence** | Interviews with fishermen, villagers and scientists. He looks at market fish, photographs and carcasses. | "caught by others" in 20 rows. In 8 of them the others caught **the headline species itself**: ep 3 "Alligator gar (2 ft, research team's net)"; ep 8 "Goliath tigerfish (locals' catches)"; ep 10 "Giant snakehead (adult female)"; ep 11 "Kamba catfish (villagers' fish)"; ep 13 "Nile perch (commercial and local catches)"; ep 14 "Bull shark (2009 record fish)"; ep 18 "Largetooth sawfish pup (about 2 ft)"; ep 53 "Greenland shark (long line, Greenland)". "seen only" evidence: ep 55 "Goonch catfish (market fish)", "Goonch catfish (archive)"; ep 57 "Tapah (market fish)", "Tapah (guide's bait)"; Himalayan Giant "Goonch catfish (photo of 100+ kg fish)". | **Clues** that are objects and people: an NPC's catch on the jetty, a carcass, a scale, a photo or a market stall. Each clue narrows one variable (place, time, bait, tackle). This could reuse the Mossbell rock angler (`makeRockWick`) as a visible "caught by others" source. |
| 3 | **Suspects ruled out by catching them** | He catches the lesser species that could explain the story and shows each one cannot be the culprit (too small, wrong teeth). | The supporting catches in nearly every row. The clearest case is ep 32 "Colombian Slasher": 10 catches, seven of them rays or catfish ("Discus ray (giant stingray of the finale)", "Ocellated river stingray (motoro)", "River stingrays on a multi-hook line"…), before the finale ray. Ep 22 "American Killers": 8 catches (three catfish, grouper, tarpon) before the bull shark. Ep 52 "Killers from the Abyss": 8 catches. | **Elimination board**: landing (or measuring) a suspect species crosses it off and gives a clue ("bite marks too small", "wrong depth"). The lake's other fish stay as income *and* as evidence. |
| 4 | **Narrowing the place** | Moves between waters in one country: main river, tributary, pool, below a dam. | The "Where" column lists several sites for most episodes, for example ep 1 "a fast tributary, a dam reservoir, a floating village"; ep 24 "Zambezi River, Batoka Gorge, Lake Kariba, below Kariba Dam"; ep 29 "rapids below an abandoned dam and an oxbow lake". Specific spots are named: ep 10 "a lure cast at an abandoned raft"; ep 35 "out of sunken timber"; ep 21 "from a narrow creek". | **Place gating**: the monster lives at one named spot (the game already has named places: "the Bell Pool", "the Mother's Cup", "Under the Span", "the Gill Harp"). Clues reveal *which* spot. |
| 5 | **Narrowing the time** | Night sessions, tide, season, water level, spawning runs. | Few explicit times in the list: ep 21 Anjumara "landed at night". Seasonal runs are implied by salmon catches (ep 26 "Chum salmon", ep 44 "Chinook (king) salmon"; ep 33 lamprey "under Willamette Falls"). | **Time gating** by hour (`hours: "day, dusk"` already exists per species [C]), weather (`weather: "hush"` on Bridgechain Sturgeon [C]) or a lake cycle such as tide or flow. |
| 6 | **Choosing bait and tackle** | Live bait versus dead bait, heavy line, wire traces, rope handlines, lures. | Methods the list states: ep 10 "On a lure"; ep 29 "Several on lures"; Special "Goes Tribal" "bare handline from a dugout canoe"; ep 33 lamprey "Caught by hand"; ep 47 conger "on mackerel bait over rough ground"; Himalayan Giant "on a lure"; ep 56 "on a lure in the jungle river"; ep 45 "Rod and reel over coral reef"; Special "Jurassic-Sized" "baited traps"; ep 32 "multi-hook line". Live bait: ep 57 "Catfish used as live bait (keli / walking catfish per fan wiki) (?)", **a (?) entry**; ep 17 "Armored catfish (used as bait)"; ep 45 "Tilapia (bait)" (status unconfirmed). | **Presentation puzzle**: the monster accepts one specific bait **and** a minimum rig (line, hook, trace). Gloomwater already has single-bait legends (Heartmoss, Glowcap Bulb [C]) and size caps per rig (`passesOversizeFish`, per handoff). |
| 7 | **The lost fish** | The first big take is lost: a snapped line, a pulled hook, a snag. He regroups and changes tackle. | **11 of 57** regular episodes record the headline species itself as hooked and lost before the landing (eps 8, 9, 14, 21, 27, 30, 31, 37, 40, 54, 56). In ep 55 the title monster (goonch) is only lost. Part 2 "### Hooked and lost" has 25 bullets, 9 of them unidentified ("Unidentified large fish", "Unidentified heavy fish (presumed goonch)"…). | **Fail forward**: a loss produces a diagnosis (the existing `gearEscapeAdvice`) and a named rematch (the existing Old Rivals flow: `loseOldRival`, `rivalGate`, `rivalPurchases`). A lost *unidentified* heavy fish is itself a clue that the monster is real. |
| 8 | **The final catch** | Long fight, measurement, release, reflection. Sometimes a juvenile proves the species is present when the giant is not landed. | Sizes stated: ep 6 Piraíba "About 80 lb (36 kg) after a fight of nearly half an hour; released"; ep 18 sawfish "Nearly 7 ft long, rostrum about 1.5 ft with 39 teeth"; Goes Tribal shark "About 80 lb"; ep 39 ray "About 2 ft across and 20 lb"; Killer Catfish extended cut "the 161 lb fish". **Partial wins**: the headline is a juvenile or small fish in ep 10 "Giant snakehead (juvenile)… about one tenth of adult size", ep 11 "Kamba catfish (juvenile)", ep 20 "Amur catfish… small", ep 47 conger "'not a big one'", ep 56 "Papuan black bass (small)". | **Landing gate**: landing the monster opens the next lake. An optional "proof" (a juvenile or a smaller relative) could give a partial clue or reward without opening the gate. |

**Lesser categories as mechanics [OPINION]**
- *caught by others* → NPC catches, displays and clues.
- *seen only* (49 of 57 rows) → ambient wildlife and sightings that set mood or act as hints. Gloomwater already has ambient heron, lampbills and the rock angler (handoff "Mossmere wildlife remodel").
- *hooked and lost* → the rival loop.
- *status unconfirmed* (16 rows) → rumours the player can confirm or disprove.
- *caught, not a fish* → the twist: the "monster" turns out to be something else (eps 20, 48, 51).

---

## 2. Catalogue of headline monsters (57 regular episodes)

Water type is **my classification [I]**, taken from the "Where" column. The "Method / condition" column quotes the list where it says something **[L]**. Otherwise it is marked **[K]** or left as "—". The supporting cast is Jeremy's other catches **[L]**. "lost" marks a headline species that was hooked and lost first **[L]**.

### Big river (22)

| Ep | Title | Headline monster | Method / condition | Supporting cast |
|---|---|---|---|---|
| 1 | Piranha | Red-bellied piranha | — | Black piranha; Payara; Ripsaw catfish |
| 3 | Alligator Gar | Alligator gar | [K] slow river, air-breathing fish seen rolling | (only catch) |
| 4 | European Maneater | Wels catfish | caught on the Ebro [I from "Where"] | Zander |
| 6 | Amazon Flesh Eaters | Piraíba | "About 80 lb (36 kg) after a fight of nearly half an hour; released" | Jau, Redtail, Candiru, Candiru-açu |
| 11 | Congo Killer | Kamba catfish (juvenile) | juvenile only; adult was a villagers' catch | Vundu catfish |
| 12 | Alaskan Horror | White sturgeon | Columbia River [I]; the Alaska lake rumour was unsolved [K] | Northern pike |
| 13 | Rift Valley Killers | Nile perch | below Murchison Falls / Nile [I] | Nile tilapia; Semutundu catfish |
| 15 | The Mutilator | Red-bellied pacu | — | (only catch) |
| 17 | Silent Assassin | Short-tailed river stingray | — | Palometa piranha; Surubi; Pati; Golden dorado; Mandube |
| 18 | Chainsaw Predator | Largetooth sawfish | "Nearly 7 ft… rod and line; released" | Bull shark |
| 19 | Electric Executioner | Electric eel | — | Black piranha; Spotted river stingray; Redtail; Trahira; Mussum; Fidalgo |
| 23 | Pack of Teeth | African tigerfish | Okavango Delta | Sharptooth catfish; African pike; small fish |
| 24 | Invisible Executioner | Vundu catfish | Zambezi / below Kariba Dam | Sharptooth catfish; Brown squeaker; African tigerfish |
| 26 | Russian Killer | Kaluga sturgeon | — | Chum salmon; Amur catfish; small roach-like fish **(?)** |
| 32 | Colombian Slasher | Freshwater stingray, a kind new to him | "On rod at Leticia… exact species uncertain"; finale Discus ray | Discus ray; Motoro; rays on multi-hook line; Bocon; Ripsaw; Red-bellied piranha; unidentified catfish |
| 35 | Amazon Apocalypse | Redtail catfish (pirarara) | "'One red tail after another' out of sunken timber" | Piraíba; Black and Red-bellied piranha; Candiru-acu; Piracatinga |
| 36 | Jungle Terminator | Redtail catfish | "Two big fish on consecutive casts… kept as food for the village" | Red-bellied piranha; Tiger sorubim |
| 38 | Man-Eating Monster | Piraíba (lau-lau) | — | Redtail; Dawala; Blinker; Basha; bait fish |
| 39 | Bone Crusher | Smoothback river stingray | "About 2 ft across and 20 lb; a species new to him" | Redtail catfish (+ anaconda, not a fish) |
| 42 | Mekong Mutilator | Freshwater pufferfish (Fang's puffer) | — | Pacu-like fish; small net fish **(?)**; Asian redtail; Giant barb; Mekong giant catfish |
| 43 | Prehistoric Terror | Alligator gar | "A heavy female slid onto a beach. About 6.5 ft" | Indo-Pacific sailfish; White sturgeon |
| 46 | Africa's Deadliest | African tigerfish | Okavango Delta | (only catch) |

### Rapids, fast or mountain river, creek, falls (9)

| Ep | Title | Headline monster | Method / condition | Supporting cast |
|---|---|---|---|---|
| 2 | Killer Catfish | Goonch catfish | Kali River pools; extended cut: "small ones, then the 161 lb fish"; final hook-up lost in extended cut | (only catch) |
| 8 | Demon Fish | Goliath tigerfish | Congo rapids; **lost** "earlier takes"; locals' catches shown | "Kaki" (unconfirmed species) |
| 21 | Jungle Killer | Anjumara (giant wolf fish) | "'A big one' landed at night from a narrow creek"; **lost** first one | Black piranha; Redtail |
| 27 | Mongolian Mauler | Taimen | **lost** first one; [K] surface "mouse" lure | Siberian dace; Lenok; Arctic grayling |
| 29 | Face Ripper | Red-bellied piranha | "rapids below an abandoned dam"; "Several on lures; a treble hook went into his thumb" | Black piranha; Arapaima; Payara; Freshwater stingray |
| 33 | Vampires of the Deep | Pacific lamprey | "Caught by hand under Willamette Falls" | Longnose gar; Bowfin; Redhorse; Carp; Lake trout; Chinook |
| 37 | River of Blood | Golden dorado | Uruguay River "below Salto Grande Dam" [I site]; **lost** one | Spotted sorubim; Boga; Palometa; Armoured catfish |
| 55 | Return of the Killer Catfish | Golden mahseer | Karnali River; the title goonch was **hooked and lost**, not landed | Snakehead |
| 56 | Volcanic Island Terror | Papuan black bass (small, then big) | "on a lure in the jungle river; smaller than it felt"; **lost** first take | Golden snapper; Coral trout; Giant trevally; Barracuda; Bull shark |

### Lake / pond (5)

| Ep | Title | Headline monster | Method / condition | Supporting cast |
|---|---|---|---|---|
| 5 | Amazon Assassins | Arapaima | forest lakes; [K] spotted when it rises to breathe | Tiger sorubim; Tambaqui |
| 20 | Cold Blooded Horror | Amur catfish (namazu) | "Southern Lake Biwa; small"; the title monster is the giant salamander (caught, not a fish) | — |
| 25 | Asian Slayer | Asian redtail catfish | "Thai lake" (a stocked fishing lake); the Indian river fish were lost ("Sareng (wallago) catfish (?)", a **(?)** entry) | Amazon redtail (introduced); Mekong giant catfish; Golden mahseer; Chinese seerfish |
| 40 | Body Snatcher | Arapaima | "hidden jungle ponds"; **lost** one | Redtail; Black piranha |
| 41 | Canadian Horror | Muskellunge | Eagle Lake, Ontario | Lake trout; Northern pike; Smallmouth bass |

### Reservoir / man-made water (3)

| Ep | Title | Headline monster | Method / condition | Supporting cast |
|---|---|---|---|---|
| 10 | Killer Snakehead | Giant snakehead (juvenile) | "On a lure cast at an abandoned raft; about one tenth of adult size"; Khao Laem reservoir | Bullseye snakehead; Butterfly peacock bass; Silver carp |
| 30 | Atomic Assassin | Wels catfish | "Chernobyl cooling pond and reactor channels"; **lost** one | Zander; Northern pike; European perch; European chub |
| 57 | Malaysian Lake Monster | Tapah | Lake Kenyir ([K] a dammed reservoir); live catfish bait **(?)** | Giant snakehead (toman); jungle-river snakehead |

### Estuary, tidal river, lagoon, canals (6)

| Ep | Title | Headline monster | Method / condition | Supporting cast |
|---|---|---|---|---|
| 7 | Freshwater Shark | Bull shark | "Gold Coast canals, coast, a river mouth, Brisbane River system upriver" | Giant grouper |
| 9 | Death Ray | Giant freshwater stingray | "tidal river at Samut Songkhram"; **lost** first hook-up | Mekong giant catfish |
| 14 | Hidden Predator | Bull shark | Breede River mouth; **lost** hook-ups; record fish caught by others | Spotted grunter; Butterfly ray; White sea catfish; Bluespotted stingray |
| 22 | American Killers | Bull shark | "About 6 ft juvenile; from the shore; released"; Indian River Lagoon | Blue, Flathead, Channel **(?)** catfish; Goliath grouper; Tarpon |
| 28 | Phantom Assassin | Northern river shark | Fitzroy River and King Sound | Bull shark; unidentified small shark; Barramundi; Freshwater whipray |
| 31 | Killer Torpedo | Atlantic tarpon | "brackish lagoons"; **lost** one | Horse-eye jack |

### Cave (1)

| Ep | Title | Headline monster | Method / condition | Supporting cast |
|---|---|---|---|---|
| 16 | Flesh Ripper | New Zealand longfin eel | "Waitomo Caves, Lake Manapouri and South Island backwaters". [I] The list does not say which site produced the catch, so "cave" is a weak classification. | (only catch) |

### Sea: coast, reef, fjord, deep (11)

| Ep | Title | Headline monster | Method / condition | Supporting cast |
|---|---|---|---|---|
| 34 | Legend of Loch Ness | Greenland shark | Loch Ness frame; caught in Norway or Iceland [I] | Norwegian skate; European eel; Cod; Haddock; Coalfish; Plaice |
| 44 | Alaska's Cold Water Killer | Pacific halibut | coastal salt water | Chinook; China rockfish; Lingcod |
| 45 | South Pacific Terrors | Giant trevally | "Rod and reel over coral reef" | Giant mottled eel |
| 47 | Deep Sea Demon | European conger eel | "on mackerel bait over rough ground; 'not a big one'. Released." | Common ling; Atlantic mackerel |
| 48 | Death Down Under | Tiger shark | the title monster is a box jellyfish (caught, not a fish) | Queensland grouper |
| 49 | Razorhead | Great barracuda | Keys channels and wrecks; a bull shark was lost | Mangrove snapper; Grouper |
| 50 | Terror in Paradise | Caribbean reef shark | Andros blue holes | Bonefish; Yellowfin tuna; Mahi-mahi |
| 51 | Devil of the Deep | Skipjack tuna | the title "devil" is the Humboldt squid (caught, not a fish) | Striped marlin |
| 52 | Killers from the Abyss | Bluntnose sixgill shark | deep water; Ascension, Cape Point | Ocean triggerfish; Snoek; Grouper; Black jack; Skipjack; Mahi-mahi; Horse-eye jack |
| 53 | Ice Cold Killer | Greenland shark (two, Norway) | fjord near Tromsø | Cod; Redfish; Saithe **(?)**; Cusk |
| 54 | Coral Reef Killer | Needlefish ('sori') | reef / Bajau village; **lost** first attempt; marlin lost | (only catch) |

Total: 22 + 9 + 5 + 3 + 6 + 1 + 11 = 57.

**Patterns [I]**: freshwater (big river, rapids, lake, reservoir) covers 39 of 57 episodes. That suits Gloomwater, whose three defined waters are freshwater ("The Mossmere", "Glasswater Vault", "Sporewood Pools" in `var O5 = { waters:` [C], reading copy ~30772). The sea episodes come almost all from seasons 8 and 9 (eps 47 to 54), when the show moved offshore.

---

## 3. Hunt archetypes (templates for lakes)

Each archetype is defined by where the monster is, how you find it, what it takes and how you lose it. The examples are list rows **[L]**. The behavioural reasons are **[K]** unless quoted.

| # | Archetype | The puzzle | List examples | Gloomwater levers that already exist |
|---|---|---|---|---|
| A | **The Snag-Hole Ambusher**: lives in one deep hole or under timber and runs for cover when hooked | Find the one hole. Use heavy line to stop the first run. | ep 35 redtail "out of sunken timber"; ep 47 conger "over rough ground"; ep 2 goonch (Kali pools); ep 24 vundu; eps 6 and 38 piraíba; ep 56 Papuan black bass (first take lost); eps 4 and 30 wels | place gates, `play: "Sinker… Tests the line."`, line Hold |
| B | **The Bottom-Clamper**: a flat or heavy fish that pins itself to the floor | Find the soft-bottom area, then lift a fish that will not move. A long, low fight. | ep 9 giant freshwater stingray (first hook-up lost); ep 17 short-tailed stingray; ep 32 discus ray finale; ep 39 smoothback ray; ep 44 halibut; ep 12 white sturgeon; ep 26 kaluga | Grove's authored sequence "take, clamp to the bottom…" [C]; ray profile "Heavy low hold" (handoff fight table) |
| C | **The Rapids Hunter**: a fast predator holding in current | Fish moving lures in white water; a bony mouth or acrobatics throw the hook. | ep 8 goliath tigerfish (earlier takes lost); ep 27 taimen (first lost); ep 29 piranha "rapids below an abandoned dam… on lures"; ep 37 golden dorado (lost one); ep 55 golden mahseer; ep 56 black bass "on a lure in the jungle river" | spinner hard takes (28%, handoff); "Leaper… Thrown hooks on the leap" |
| D | **The Breather / Sight-Spotted Giant**: betrays itself at the surface | Watch for the rise, roll or bubble, then put the bait where it surfaced. | ep 5 and ep 40 arapaima ([K] gulps air); eps 3 and 43 alligator gar ([K] air-breather); ep 10 giant snakehead "lure cast at an abandoned raft"; ep 57 tapah / toman | journal "Sign:" strings ("Sign: a slow wide boil", "Sign: nervous water, then a strike splash") [C, O5] |
| E | **The Tide Visitor**: a salt-water fish that comes up the river on the tide | The right place at the right *phase*: tide, mouth versus upriver. | ep 7 bull shark "canals, coast, a river mouth… upriver"; ep 14 bull shark at the Breede mouth; ep 22 bull shark in a lagoon; ep 28 northern river shark (King Sound); ep 9 stingray in a "tidal river"; ep 31 tarpon in "brackish lagoons"; ep 18 sawfish | visiting species already exist (Nightbloom Carp, Rosefleck Trout are "visitors", handoff); no tide clock (see Gaps) |
| F | **The Pack**: many mouths, and the big one hides among them | Survive the small bites (bait stripped), then pick out the big one with the right hook or trace. | eps 1 and 29 piranha; eps 23 and 46 African tigerfish ("Pack of Teeth"); ep 17 palometa; Milkeye Perch already "A pack fish: bites come in threes" [C] | bite cadence, bait consumption |
| G | **The Night Feeder**: only comes on at night, in a narrow place | Fish the right hour, often by lantern, in a confined spot. | ep 21 anjumara "landed at night from a narrow creek" (the only explicit night catch in the list); [K] wels and goonch are night-active | `hours: "night"` per species [C]; Hullkiss Lamprey "night" at "the Buoy Lights" [C] |
| H | **The Abyss Sleeper**: deep, cold, slow and huge, needing a long wait on a deep bait | A long drop and long soak, then a heavy, sluggish fight. Patience is the cost. | eps 34 and 53 Greenland shark; ep 52 sixgill; ep 44 halibut; Special "Jurassic-Sized" hagfish "baited traps… in about 320 ft" | depth bands (`depth: [0.8, 1]` on both legends [C]) |

**Cross-cutting modifiers** (not archetypes, but each can be added to any of them):
- *The Lost Fish*: 11 of 57 headline species were lost before being landed [L]. This maps to the Old Rivals loop.
- *Proof by a Juvenile*: eps 10, 11, 20, 47 and 56 [L].
- *The Twist*: the monster is not a fish, in eps 20, 48 and 51 [L].
- *The Live-Bait Fish*: ep 57 live catfish bait **(?)**; ep 17 "Armored catfish (used as bait)" [L]. Live bait has to be caught first, so one lake fish becomes the key to the monster [OPINION].

---

## 4. First mapping onto Gloomwater [OPINION]

### What the two legends are in the code today [C]

| | The Belled Matriarch | The Drifting Grove |
|---|---|---|
| id | `belled_matriarch` | `drifting_grove` |
| Older roguelite entry (zone/food/oil/boss) | `zone: "mossmere"`, `tier: 3`, `weight: [12, 30]`, `time: "calm"`, `depth: [0.8, 1]`, `bait: "heartmoss"`, `behavior: "steady"`, boss phases "The Slow Toll" / "Double Toll" / "Last Toll", model `shape: "carp"`, `pattern: "scales"` (reading copy ~33961). This is the **older layer**. Whether its boss phases are live is not settled here. | `zone: "sporewood"`, `tier: 4`, `weight: [20, 45]`, `time: "calm"`, `depth: [0.8, 1]`, `bait: "glowcap_bulb"`, `behavior: "leaper"`, phases "Grazing" / "False Bloom" / "Spore Veil", model `shape: "ray"`, epithet "The Meadow That Swims" (~34192). Older layer. |
| Current override / journal | `mi("belled_matriarch", { size: U5(260, 120), family: "bottom", … legendPlace: "bell_pool" }` with lore "A harbour bell grew into her skull…" (~41420) | `O5.fish` entry: `hours: "day, dusk"`, `place: "crown"`, `placeName: "the Mother's Cup"`, `favours: "Her bait only: Glowcap Bulb."`, `play: "Leaper. Authored: take, clamp to the bottom, blooming dive, leap, run, blooming dive, lift. Never better than a coin flip."`, `sizeModel: { L50: 300, sigma: 0.02, fullyGrown: 345 }` (~31021) |
| Bait gate | Heartmoss item `legendBiteChance: 0.12` (~34817); `function rollLegendBite(bait, rng)` uses `bait?.legendBiteChance ?? 1` (~104009) | The Glowcap Bulb item has **no** `legendBiteChance` field (~34827), so `rollLegendBite` returns true. Other gates (place, hour) were not checked. `wo.legendBait.sporewood = { id: "glowcap_bulb", price: 250 }` (~48023) |

The two legends' *hint* strings are already River Monsters clues: "Listen for a bell beneath the calm, far out in deep water. She takes only Heartmoss." and "When the pools are quiet, something vast grazes in the deep. It hungers for Glowcap Bulbs." [C, older-layer entries].

### The Belled Matriarch (Mossmere: bell-haunted lake, drowned buildings)

| Option | Echoes | Why it fits | Suspect cast from Mossmere's roster [C, O5] |
|---|---|---|---|
| **M1: Wels catfish** (eps 4 "European Maneater", 30 "Atomic Assassin") | A man-made, ruined water ("Chernobyl cooling pond and reactor channels"); European folklore of swallowing swimmers [K] | Drowned buildings correspond to reactor channels. The supporting cast of ep 30 is *Zander, Northern pike, European perch, European chub*, an almost exact match for Mossmere's perch, pike and chub. A wels was also "hooked and lost" in ep 30, which gives a ready-made lost-fish beat. Against it: the Matriarch model is `shape: "carp"`, `pattern: "scales"`, and a wels has no scales. | Mossback Perch (zander analogue), Reedjaw Pike / Thousandcast Pike (pike), Milkeye Perch (perch), Likely Chub (chub), Weeping Carp |
| **M2: Arapaima** (eps 5 "Amazon Assassins", 40 "Body Snatcher") | Huge scaled fish of still forest lakes and ponds; it surfaces to breathe [K] | Her "scales have gone the colour of tarnished bronze" [C]. Arapaima is the great *scaled* monster (archetype D). The clapper ring that signals her bite matches the breather's surface tell. "Body Snatcher" suits "She Who Tolls for the Drowned". Ep 40 also has a lost arapaima. | Weeping Carp ("Deep, soft bottom", a big scaled decoy), Kissmark Trout ("Sign: none on top; a long slow drag-under"), Bridgechain Sturgeon ("The Mossmere's longest fish"), Reedjaw Pike |
| **M3: Goonch** (eps 2 "Killer Catfish", 55 "Return of the Killer Catfish") | A deep pool on a sacred river; the story of feeding on the dead [K] | Strongest thematic match for "tolls for the drowned". The list makes it the classic hard monster: ep 55 failed to land it ("hooked and lost: Goonch catfish"), and the extended cut records a "final hook-up" lost. A good *second* lake, or a template for a harder Matriarch. Against it: it is scaleless and its home is fast water. | Golden mahseer → Kissmark Trout or Overbold Bass; Bridgechain Sturgeon; Hullkiss Lamprey as the night red herring |

Also consider **Bridgechain Sturgeon as the "Alaskan Horror" red herring** [OPINION]. In ep 12 the white sturgeon is offered as the explanation for a lake-monster rumour [K]. In the game, "Under the broken bridge, but only when the water goes still as a mirror" (`weather: "hush"`, ~41387) makes it the natural first wrong answer.

### The Drifting Grove (Sporewood: fungal pool; a ray-like "meadow that swims")

| Option | Echoes | Why it fits | Suspect cast from Sporewood's roster [C, O5] |
|---|---|---|---|
| **G1: Giant freshwater stingray** (ep 9 "Death Ray") | The giant that clamps itself to the bed of a tidal river; the first hook-up was lost [L] | The Grove's authored fight already starts "take, clamp to the bottom" (archetype B). The "Never better than a coin flip" landing odds suit a fish known for long, immovable fights [K]. The first-hook-up loss gives a lost-fish beat. | **Velvet Ray** (an uncommon ray, "A flat slide, then a fast run along the bottom"), the obvious lookalike to rule out; Downcast Catfish ("One enormous steady run the length of the pool"); Cindertail Catfish (the Mekong giant catfish is ep 9's supporting fish) |
| **G2: Discus ray, finale of "Colombian Slasher"** (ep 32) | Many rays caught first, then the giant one [L] | Ep 32 is the model *suspects-by-catching* episode: 10 catches, mostly rays and catfish, before "Discus ray (giant stingray of the finale)". The puzzle becomes "which ray is the meadow?". | Velvet Ray; Threadling Eel; Cindertail Catfish; Festival Puffer |
| **G3: Short-tailed river stingray** (ep 17 "Silent Assassin") with its Paraná cast | A broad river ray with a busy supporting cast [L] | Ep 17's cast (palometa, surubi, pati, golden dorado, mandube) maps onto Sporewood: Falsesmile Barb ↔ palometa (a "false smile" of teeth), Cindertail/Downcast Catfish ↔ surubi and pati, Lostsea Mackerel ↔ golden dorado (a fast runner). The risk is that it makes the Grove a little "ordinary". | as listed |

A side note for a **future lake** [OPINION]: Sporewood's **Festival Puffer** ("Its beak cuts the line: snapped") already echoes ep 42 "Mekong Mutilator", whose headline was a freshwater pufferfish. It could be a future monster rather than a suspect.

---

## 5. Scale: how many lakes the list supports

- **Without repeating an archetype: 8 lakes** (A to H), each with at least three list examples, except G (Night Feeder) with one explicit list example (ep 21) [L] plus [K].
- **With modifiers** (lost fish, juvenile proof, twist, live bait) and varied water types, each archetype can be used twice with a different feel, so about 16 before it feels repeated [I]. There are 48 distinct headline species to theme them [L].

**Suggested order, gentle to brutal [OPINION]**. Each step teaches one new reading skill.

| Order | Archetype | Why at this point | Fit to existing lakes |
|---|---|---|---|
| 1 | D, Breather / Sight-Spotted | It teaches "read the sign". The game already prints "Sign:" for every species. | **Mossmere** (Matriarch as M2 arapaima: bell or clapper as the surface tell) |
| 2 | B, Bottom-Clamper | It teaches place plus patience; the lift is a gear check. | **Sporewood** (Grove as G1 or G2) |
| 3 | F, The Pack | It teaches bait economy and hook or trace choice. | new lake |
| 4 | A, Snag-Hole Ambusher | It needs a heavy-line purchase; the first loss is near certain. | new lake (or the Mossmere M1 wels variant) |
| 5 | G, Night Feeder | It adds the hour as a hard gate and lantern play. | new lake |
| 6 | C, Rapids Hunter | Moving lures in current; thrown hooks. | Glasswater Vault already has fast water: "The Stilled Cascade: fast shallow water" (Rainglass Darter haunt [C]) |
| 7 | E, Tide Visitor | It combines place and phase; the fish is absent most of the time. | new lake, needs a cycle |
| 8 | H, Abyss Sleeper | A long soak, the deepest depth band, the hardest fight. | final lake (the older layer names a "paleabyss" zone [per task brief], not checked here) |

---

## Hook points for the hunt loop

Anchors are from the reading copy **[C]** unless marked "(handoff)", which means named in the handoff and only confirmed to exist by a grep count here.

1. **Monster identity and place**: `legendPlace: "bell_pool"` on the Matriarch override (~41421); `place: "crown"`, `placeName: "the Mother's Cup"` on the Grove's `O5.fish` entry (~31030). The hunt's "where" answer can be these fields.
2. **Monster time**: per-species `hours:` strings in `O5.fish` (for example `"day, dusk"`, `"night"`, `"any, best at night"`); `weather: "hush"` on `bridgechain_sturgeon` (~41387).
3. **Monster bait gate**: `function rollLegendBite(bait, rng)` (~104009) with `legendBiteChance` on the bait item (Heartmoss `0.12`, ~34817). Replacing the dice roll with "all conditions met" is a single seam, since the function already returns true when the chance is ≥ 1.
4. **Clue text**: `O5.fish[].haunt` ("… Sign: …"), `.play`, `.favours` and `.journal`. The older layer's `hint:` strings are already worded as clues ("Listen for a bell beneath the calm…").
5. **Suspects and journal**: catch-locked field guides (handoff: "the first landed catch unlocks a species' appearance"); `fillRivalJournal` (2 hits).
6. **Lost fish and rematch**: `loseOldRival` (2 hits), `rivalGate` (5), `rivalPurchases` (3), `gearEscapeAdvice` (2) (handoff "Old Rivals"). These map directly onto beat 7. Note that the handoff says legends are *excluded* from rivalries today.
7. **Caught by others / testimony**: `makeRockWick`, "Mossbell rock angler" (handoff: "has no hooks into the player's inventory, fish journal or economy"). It is an ambient NPC that could show evidence catches. Murk's counter (`murkCounter`) is the obvious testimony source.
8. **Feeding-current clues** (proposal only, handoff): `lullaby` (19 hits), `gill_harp` (17). A designed "where/when" clue system for Sporewood.
9. **Lake gate**: `function WH(` and `function GH(` (1 hit each; handoff: "calculate inherited bonuses", "apply the first tow"). The "landing the monster opens the next lake" change attaches here.
10. **Fight**: the Grove's authored sequence and "Never better than a coin flip"; `lakeFightProfiles`, `catchParts` (handoff).

## Gaps

- **No case-file / clue-board system: not found.** I ran case-insensitive greps over the reading copy: `suspect` 0 hits, `evidence` 0 hits, `clue` 8 hits. All 8 `clue` hits belong to the Old Rivals gear clue (`fish.clue = loss.overCap.advice`, "A clue is in Journal → Sheet → Rivals."). There is no system for monster-location or monster-time clues.
- **No "caught by others" evidence objects.** The rock angler is cosmetic and disconnected from the journal (handoff).
- **No tide cycle in the relaxed layer** for archetype E. Grep counts: `gloomtide`/`Gloomtide` 233 hits, `tide` 18, `tideAt` 3, `tideChart` 3. All belong to the **older roguelite layer**: the Gloomtide cycle behind `time: "gloom"`/`"calm"` on species, and a "Tide Chart" shop item, `id: "tide_chart"`, "Two rich feeding spots surface now and stay until dusk." (~35128). Whether the Gloomtide is live in current play was not checked; if it is, it could serve as the lake cycle. The current layer has `hours` and `weather` per species.
- **No juvenile / proof catch** of a legend: legends have fixed bespoke size models (`fullyGrown: 345` for the Grove).
- **Legends excluded from Old Rivals** (handoff: "Scripted legendaries… cannot start a rivalry"), so beat 7 needs that rule lifted or a parallel path.
- **No live-bait chain** (catch fish X to use as bait for monster Y). The baits read here are bought items (`price`, `count`).
- **No "twist" handling** (a non-fish culprit).
- **Only 3 waters defined** (`O5.waters`: Mossmere, Glasswater Vault, Sporewood Pools). Only two are playable per the brief, so lakes 3 to 8 need new waters.
- **The list itself**: no episode structure, little timing data (only ep 21 says "night"), few methods, and an unverified second check ("the independent second check has not been run", line 3). The beat structure in section 1 rests on [K].

### (?) entries relied on in this map
- ep 57 "Catfish used as live bait (keli / walking catfish per fan wiki) (?)": the live-bait modifier.
- ep 25 "Sareng (wallago) catfish (?)": the lost-fish note in ep 25.
- ep 22 "Channel catfish (?)": supporting cast only.
- ep 26 "Small roach-like fish (4 to 5 oz) (?)", ep 42 "Assorted small net fish (not identified) (?)", ep 53 "Saithe (coalfish) (?)": supporting cast only.
- ep 2 "Golden mahseer (?)" (seen only): not relied on.
