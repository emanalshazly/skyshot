# Methodology

## The problem as we read it

A booth game is judged by people who walk past. It has about three seconds to explain itself and about three minutes to finish, and it has to do that hundreds of times a day without a staff member touching the keyboard. That gave us four design constraints, taken straight from the Category 3 brief:

1. **Instant understanding.** No tutorial. One verb: click.
2. **Short, repeatable sessions.** Under 3 minutes, with a reason to queue again.
3. **Booth-proof operation.** A clean reset between players and no slowdown over a long day.
4. **Relevance to competitive play.** Train a real esports skill, and measure it.

## Approach

**One mechanic, tuned deep.** We picked flick aim and reaction time as the core skill. Every input is a click on a target. Depth comes from tuning rather than extra rules: a speed bonus rewards fast reactions, a combo multiplier rewards consistency, gold orbs reward target priority, and moving orbs in the second half force genuine flicks. Orbs never spawn under the cursor, so a player can't camp one spot.

**A difficulty curve that sorts players without frustrating them.** Spawn rate, orb size, orb lifetime, maximum orbs on screen and the share of moving orbs all follow one smoothstep curve over the round. The first 10 seconds are gentle, so a first-timer scores something. The last 15 seconds separate the top of the leaderboard.

**Feedback that teaches.** The results screen shows accuracy, average reaction time in milliseconds, best combo and orbs hit. A player learns what to improve: "I was accurate but slow." That gives them a concrete reason for the second run.

**The leaderboard as the replay engine.** A public daily top 10, shown on the attract screen and on a separate monitor, is the social hook. A run that misses the top 10 is told the exact score it needs ("Top 10 needs 14,921. One more run?").

## Booth-readiness engineering

| Risk at a booth | Mitigation |
|---|---|
| The last player's click starts the next round | 1.2s input guard on every screen change |
| A player walks away mid-results | Initials auto-save after 25s, then the game returns to attract |
| State leaks between players | Each round builds a new state object from a factory; effect pools are cleared |
| Slowdown over hours | One `requestAnimationFrame` loop, fixed-size particle and text pools, no per-round listeners, background pre-rendered once per resize |
| Frame hitches teleporting targets | Simulation step clamped to 1/20s |
| Venue Wi-Fi drops | No network use. Scores live in `localStorage`, bucketed by local day |
| Second-screen sync | `BroadcastChannel` + `storage` events, with a 2s polling fallback |
| Rude initials on a public screen | Small blocklist swaps them for a neutral tag |
| Staff needs the data | `Ctrl+Shift+E` exports every run (all days) to CSV |

## Verification

We did not rely on manual play alone. `tests/soak_test.py` plays the game in a real browser for many consecutive rounds, with outside network blocked, and asserts on the game's internal state after every transition. It reports frame timing and heap size. The results are in the README and in `tests/soak_report_*.json`.

## What we would do next

- Gamepad and arcade-button support for a cabinet build
- An attract-mode ghost replay of the day's best run
- A staff settings panel (round length, sound, leaderboard size) instead of URL parameters
