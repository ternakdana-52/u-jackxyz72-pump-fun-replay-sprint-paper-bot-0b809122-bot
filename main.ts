// Pump.fun replay momentum bot for the u-jackxyz72 sprint.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);
const bot = {
  ...strategy,
  onHello(state: Parameters<NonNullable<typeof strategy.onHello>>[0]) {
    // Diagnostics go to stderr only; stdout carries replies.
    const h = state.hello;
    console.error(
      `[pump-momentum] hello: capital=${h.capital.lamports} lamports ` +
        `maxOpen=${h.caps.max_open_positions} maxOrderBps=${h.caps.max_order_bps_of_real_reserve} ` +
        `maxOrdersPerBatch=${h.caps.max_orders_per_batch} latency=${h.latency_slots} ` +
        `window=${DEFAULT_PARAMS.window} stakeSol=${DEFAULT_PARAMS.stakeSol} ` +
        `stopLoss=${DEFAULT_PARAMS.stopLoss} trail=${DEFAULT_PARAMS.trail}`,
    );
    return strategy.onHello?.(state);
  },
  onDone(state: Parameters<NonNullable<typeof strategy.onDone>>[0], done: Parameters<NonNullable<typeof strategy.onDone>>[1]) {
    console.error(`[pump-momentum] done: reason=${done.reason} cash=${state.cash} positions=${state.positions.size}`);
    return strategy.onDone?.(state, done);
  },
};

await runBot(bot);
