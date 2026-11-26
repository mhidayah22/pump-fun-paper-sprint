# Pump Sniper — paper-trade pump.fun launches

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mhidayah22/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/mhidayah22/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A launch sniper with a rug filter for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty. It paper-trades pump.fun launches on a 6-hour replay: buys at launch (within 3 slots of creation) once real buyers have put SOL into the curve and the launch passes the rug filter (the creator has not sold, the creator's stack is at most 1 SOL, at most 3 distinct early buyers), risks 0.1 SOL per coin, banks +40%, cuts at -12%, never holds past 60 slots, and leaves at once when the creator sells.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol over stdin/stdout and is run by the make.fun grader. Grade it locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Files

- `main.ts` — the strategy: launch sniper with a rug filter and fast exits, deterministic.
- `vendor/makefun-bot.ts` — the make.fun bot library, copied from the kit.

## License

MIT — see `LICENSE`.
