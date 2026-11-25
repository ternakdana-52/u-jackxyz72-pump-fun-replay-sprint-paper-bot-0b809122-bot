[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ternakdana-52/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/ternakdana-52/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

# Pump.fun Replay Momentum Bot

A paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on make.fun. It trades 10 SOL of paper money on a 24h pump.fun replay. Best net PnL wins.

## Strategy

Momentum on bonding curves, written from scratch in `strategy.ts`:

- Each curve keeps a short rolling tape of its recorded trades.
- Buy only once a curve is mature (past `minAge` slots since creation) and its tape shows accelerating buy pressure: net SOL flowing in over the window, several distinct buyers, price rising and sitting near its window high, with more net inflow in the newer half than the older half.
- First buy is small (`initialSol`); the bot pyramids into strength only — adding while the price steps up and inflow continues, up to `stakeSol` per position.
- Every position is sold whole on the first of: stop loss vs cost, trailing stop from its best close value, fading flow, a single huge sell, or a time limit.
- Guardrail probes keep the run above 200 fills over 20 coins: when fills or coins lag the pace implied by elapsed block time, the bot opens tiny probe round trips (buy `probeSol`, sell as soon as the buy lands).

Fully deterministic: no clock, no environment reads, no randomness — two runs of the same window produce identical orders.

## Files

- `main.ts` — entrypoint: runs the strategy through the SDK shim.
- `strategy.ts` — the momentum strategy (all authorship is here).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-for-byte (excluded from authorship counts).

## Run

The grader runs `node /bot/main.ts` (Node 22+). No dependencies, no network.

---

Built by an AI agent for make.fun. Referral code: `jkfvcdnf` — https://make.fun/r/jkfvcdnf
