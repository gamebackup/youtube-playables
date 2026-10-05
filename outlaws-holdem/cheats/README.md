# Outlaws Cheat Shop

An in-game shop of eleven poker cheats, layered over the stock Texas Hold'em
playable as a DOM overlay. It reads and writes the live game model directly, so
nothing here is a simulation of the cheat — the buttons mutate the same objects
the engine reads every frame.

```
cheats/
  shop.js        overlay UI + cheat engine
  shop.css       overlay styling
  mockup.html    standalone harness: the shop against a stubbed table
  patch-main.js  installs the two hooks into main.js
  icons/         icons.json manifest + your art (see below)
```

## Setup

```sh
node cheats/patch-main.js            # add the hooks (idempotent)
node cheats/patch-main.js --check    # report hook status, change nothing
node cheats/patch-main.js --revert   # put main.js back
```

`index.html` already links `shop.css` and `shop.js`. Serve the folder over HTTP
and open it; opening `index.html` from `file://` will not work.

## Swapping in your own art

Drop a file into `cheats/icons/`, then point the cheat at it in
`cheats/icons/icons.json`:

```json
{
  "xray": "xray.png",
  "tell": "xray.png"
}
```

| Icon id | Cheat | | Icon id | Cheat |
|---|---|---|---|---|
| `badge` | shop button | | `dice` | Loaded Dice |
| `xray` | X-Ray Vision | | `stack` | Stacked Deck |
| `tell` | Tell Detector | | `bottom` | Bottom Deal |
| `predictor` | Fold Predictor | | `shredder` | Card Shredder |
| `sleeves` | Sleeve Swap | | `mindcontrol` | Mind Control |
| `insidejob` | Inside Job | | `taxman` | The Taxman |

Any cheat not listed (or listed as `null`, which is how the file ships) renders a
built-in inline placeholder, so you can supply art one cheat at a time and
nothing ever appears broken. Paths are relative to `cheats/icons/` and may point
at any format the browser renders; a bad path also leaves the placeholder rather
than a broken image. The manifest is read with `cache: 'no-store'`, so editing it
and reloading shows the new icons immediately.

The manifest exists instead of probing for `<id>.png` / `<id>.svg` automatically
because a missing-file probe logs one console error per icon per page load —
twelve of them until the art arrives. Keys starting with `_` are ignored, so the
file can carry a note like `_readme` without it being treated as a mapping.

## How the cheats work

| Cheat | Price | What it touches |
|---|---|---|
| X-Ray Vision | 120 | sets `currentHand.Card1/Card2.cardFaceUp = true` on every live opponent |
| Tell Detector | 200 | calls the engine's `CardCalculator.getCardCombination` for the category, then Monte Carlo for equity |
| Fold Predictor | 180 | runs the bot's own `handleTurn` five times with a frozen `_random`, then restores it |
| Sleeve Swap | 150 | overwrites `currentHand.Card1.cardIndex` on your hand |
| Inside Job | 250 | skims 25% of each opponent's bet increases into your `moneyPool` |
| The Taxman | 300 | on a bot's CHECK action, moves a fee from their stack to yours |
| Loaded Dice | 150 | refunds your ante when you fold pre-flop |
| Stacked Deck | 350 | reorders `_cards` so the two best remaining come off the top |
| Bottom Deal | 300 | swaps a chosen card to the next undealt position |
| Card Shredder | 275 | strips the 2s, 3s and 4s from a freshly shuffled shoe |
| Mind Control | 400 | shadows `handleTurn` on each bot's `logicController` |

A few notes on the less obvious ones:

**Fold Predictor** does not reimplement the AI. The casual bot's decision code
is branchy and RNG-sensitive, so a copy would drift from the real thing. The
cheat instead temporarily replaces the bot's `_random` with a fixed value, calls
the genuine `handleTurn`, and puts `_random` back — so the answer comes from the
same code that will actually run. `handleTurn` receives `timeLeft` normalised to
`0..1` and gives up once it passes `0.97`, so the probe samples at `0.5`.

**Deck cheats share one shuffle stamp.** Stacked Deck, Bottom Deal and Card
Shredder all reorder `_cards`, and each stamps the deck *after* writing so it
does not mistake its own change for a fresh shuffle. Without this they would
either undo each other or re-fire forever.

**Equity is self-computed.** The engine's `CardCalculator` is authoritative for
hand category but too slow for thousands of samples, so the percentage comes
from a local 7-card evaluator run over a seeded Monte Carlo. Results are stable
frame to frame.

## Credits

Cheats are bought with credits, not chips — your stack is never at risk. You
start with 150 and earn 20 per completed hand plus 1 per 100 chips you won.
Progress lives in `localStorage` under `outlaws-cheats-v1`, separate from the
game's own save.

## Previewing without the game

`mockup.html` boots the overlay against a stub table with the same shape as the
real one (same property names, same action ids, a stand-in AI controller). It is
the fastest way to check layout or a cheat's logic:

```sh
python -m http.server 8941
# open http://127.0.0.1:8941/cheats/mockup.html
```

A toolbar in the corner deals rounds, makes bots act, and grants everything.
`window.__bootErr` surfaces any harness error, and `window.CheatShop` exposes
`items`, `state`, `equity`, `evaluate` and `tick` for poking at from the console.

Clearing `CheatShop.state.active` from the console fully unwinds a cheat — the
same cleanup runs as when you click Disable, rather than only the button path.
The tick loop notices a cheat has gone inactive and runs its teardown, so cards
drop back face down, bot controllers get their real `handleTurn` back, and no
override is left shadowing the engine.

## Not implemented

Marked-deck glow, wildcards, four-card straights and double down all need new
Pixi textures or changes inside `CardCalculator`, so they are out of scope here.