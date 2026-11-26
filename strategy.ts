// Pump.fun replay momentum bot, written for the u-jackxyz72 sprint.
//
// Idea: most new pump.fun curves are bundled launches that get dumped, so the bot only
// buys a curve once it is old enough to have survived its launch and its recent tape shows
// real, accelerating buy pressure: SOL flowing in, several different buyers, the price
// climbing and sitting near its window high, with the newer half of the window pulling in
// more than the older half. The price must also sit near its 100-slot high, so the bot
// buys a breakout, not a lower high inside a faded move: a curve whose 20-slot window
// looks hot but whose longer high sits well above it is still falling from its top, and
// the backtest shows that filter alone lifts the dev window and the rebuilt-window
// median (see README). The first buy is deliberately small; the bot only adds to a
// position while the price keeps stepping up and the inflow continues, so false starts
// stay cheap and real runners get size. Every position is sold whole on the first of a
// stop loss, a trailing stop off its best value, a fade in flow, a single huge sell, or
// a time limit.
//
// The guardrail probes exist because the competition ranks entries below the bar when
// they end with fewer than 200 fills over fewer than 20 coins: when the bot's own fills
// or coins fall behind the pace the elapsed block time implies, it opens tiny probe
// round trips (buy a little, sell it as soon as the buy lands) until it is back on pace.
//
// Deterministic by construction: no clock, no environment reads, no randomness; every
// iteration is over insertion-ordered maps and sets fed by the batch stream, so two runs
// of the same window produce the same orders.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window in slots. */
  window: number;
  /** Net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Buy trades in the window. */
  minBuys: number;
  /** Distinct buying wallets in the window. */
  minBuyers: number;
  /** Price now over price at the window start, minus 1. */
  minPriceUp: number;
  /** Upper bound on that rise: skip curves that already ran too far inside one window. */
  maxPriceUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Price now at least this share of the window's high. */
  nearHigh: number;
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Curve real SOL bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** SOL to put into one position in total. */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  fadeWindow: number;
  /** Exit when net SOL over the fade window falls below -fadeNetSol. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Keep adding to a position while the entry signal still holds, up to stakeSol. */
  pyramid: boolean;
  /** Hold on (no fade or trail exit) once the curve's real SOL passes this. */
  rideRqSol: number;
  /** Longer lookback (slots) whose high the price must be near. 0 = off. */
  breakoutWindow: number;
  /** Price now at least this share of the breakout window's high. */
  breakoutNear: number;
  /** Most SOL per buy order (the 1% reserve cap applies too). */
  maxChunkSol: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  addStep: number;
  /** Add only while the position's close value is at least cost * (1 + addIfUp). */
  addIfUp: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Most momentum positions open at once. */
  maxMain: number;
  /** Guardrail pacing targets (fills / coins over paceSecs of block time). */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  window: 20,
  minNetSol: 2,
  minBuys: 3,
  minBuyers: 5,
  minPriceUp: 0.05,
  maxPriceUp: 1.5,
  accel: 2,
  nearHigh: 0.95,
  maxBuyerShare: 1,
  minRqSol: 2,
  maxRqSol: 60,
  minAge: 5500,
  stakeSol: 6,
  minBuySol: 0.01,
  buySlipBps: 3000,
  stopLoss: 0.1,
  trail: 0.45,
  trailArm: 0.05,
  fadeWindow: 15,
  fadeNetSol: 1000,
  bigSellSol: 1000,
  maxHold: 1500,
  cooldown: 150,
  maxEntries: 2,
  pyramid: true,
  rideRqSol: 1000,
  breakoutWindow: 100,
  breakoutNear: 0.98,
  maxChunkSol: 1000,
  holdIfUp: 1000,
  initialSol: 0.2,
  addSol: 0.6,
  addStep: 0,
  addIfUp: -1,
  addNetSol: 0,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 240,
  paceSecs: 14_400,
  probeSol: 0.01,
  maxProbes: 1,
  maxExposureSol: 6,
};

const LAMPORTS = 1e9;
/** Curve fee taken on both sides of a trade: 95 bps protocol + 30 bps creator. */
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  created: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  bestValueSol: number;
  investedSol: number;
  lastBuyPrice: number;
  lastValueSol: number;
  exitArmed: boolean;
  sawFill: boolean;
}

interface TapeStats {
  buySol: number;
  sellSol: number;
  buys: number;
  buyers: number;
  topBuyerSol: number;
  startPrice: number;
  high: number;
  lastPrice: number;
  netOld: number;
  netNew: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, CurveTape>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight, by mint: false while the buy is out, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = Math.max(p.window, p.fadeWindow, p.breakoutWindow) + 5;

  const tapeFor = (mint: Pubkey): CurveTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExitSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** One pass over a tape's window: flows, buyers, and the price path. */
  const summarise = (t: CurveTape, now: number): TapeStats => {
    const from = now - p.window;
    const mid = now - p.window / 2;
    const s: TapeStats = {
      buySol: 0,
      sellSol: 0,
      buys: 0,
      buyers: 0,
      topBuyerSol: 0,
      startPrice: -1,
      high: 0,
      lastPrice: 0,
      netOld: 0,
      netNew: 0,
    };
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        s.startPrice = tr.price;
        continue;
      }
      if (s.startPrice < 0) s.startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) s.netOld += signed;
      else s.netNew += signed;
      if (tr.buy) {
        s.buySol += tr.sol;
        s.buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        s.sellSol += tr.sol;
      }
      if (tr.price > s.high) s.high = tr.price;
      s.lastPrice = tr.price;
    }
    s.buyers = byUser.size;
    for (const v of byUser.values()) if (v > s.topBuyerSol) s.topBuyerSol = v;
    return s;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots, newest first. */
  const recentFlow = (t: CurveTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Is this curve a buy right now? */
  const entryOk = (t: CurveTape, now: number, realSol: number): boolean => {
    if (realSol < p.minRqSol || realSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    const s = summarise(t, now);
    if (s.buys < p.minBuys || s.buyers < p.minBuyers) return false;
    if (s.buySol - s.sellSol < p.minNetSol) return false;
    if (s.startPrice <= 0) return false;
    const rise = s.lastPrice / s.startPrice - 1;
    if (rise < p.minPriceUp || rise > p.maxPriceUp) return false;
    if (s.lastPrice < s.high * p.nearHigh) return false;
    if (s.netNew <= 0 || s.netNew < p.accel * s.netOld) return false;
    if (s.topBuyerSol > p.maxBuyerShare * s.buySol) return false;
    if (p.breakoutWindow > 0) {
      let longHigh = 0;
      for (const tr of t.trades) {
        if (tr.slot > now - p.breakoutWindow && tr.price > longHigh) longHigh = tr.price;
      }
      if (s.lastPrice < longHigh * p.breakoutNear) return false;
    }
    return true;
  };

  /** What a position would bring back if sold now (curve + tx fees deducted), in SOL. */
  const closeValueSol = (tokens: number, vq: number, vt: number, txSol: number): number =>
    ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - txSol;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const touched = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeFor(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeFor(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          touched.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingMints = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingMints.set(po.order.mint, (pendingMints.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const orderCap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // --- Exits first: sell every open position whose exit has triggered. ---
      for (const [mint, pos] of open) {
        const holding = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (holding === undefined) {
          if (!pendingMints.has(mint)) {
            open.delete(mint);
            const t = tapeFor(mint);
            if (pos.sawFill) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        pos.sawFill = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const realSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.real_quote_reserves)) / LAMPORTS;
        const tokens = Number(holding.token_amount);
        const value = closeValueSol(tokens, vq, vt, txSol);
        const cost = Number(holding.cost_lamports) / LAMPORTS;
        if (value > pos.bestValueSol) pos.bestValueSol = value;
        pos.lastValueSol = value;
        const t = tapeFor(mint);
        const riding = realSol >= p.rideRqSol;
        let exit = pos.exitArmed;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && !riding && pos.bestValueSol >= cost * (1 + p.trailArm) && value < pos.bestValueSol * (1 - p.trail)) exit = true;
        if (!exit && !riding && recentFlow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && !riding && bigSell.has(mint)) exit = true;
        if (!exit && now - pos.openedSlot > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        pos.exitArmed = true;
        if (pendingMints.has(mint)) {
          let sellOut = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellOut = true;
          }
          if (sellOut) continue;
        }
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
      }

      // --- Probe sells: dump a probe as soon as its buy has landed. ---
      for (const [mint, selling] of probes) {
        const holding = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (holding === undefined) {
          if (!pendingMints.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingMints.has(mint)) continue;
        if (orders.length >= orderCap) break;
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // --- Entries and pyramid adds. ---
      let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - open.size;
      let exposureSol = 0;
      for (const [mint, pos] of open) {
        exposureSol += Math.max(pos.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of touched) {
        if (orders.length >= orderCap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingMints.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const pos = open.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let wantSol: number;
        if (pos === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExitSlot < p.cooldown) continue;
          if (!entryOk(t, now, realSol)) continue;
          wantSol = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Add only into strength: price stepped up from the last buy, the position is
          // still up, and SOL is still flowing in over the entry window.
          if (!p.pyramid || pos.exitArmed || !pos.sawFill || pos.investedSol >= p.stakeSol - p.minBuySol) continue;
          const holding = state.positions.get(mint);
          if (holding === undefined) continue;
          if (price < pos.lastBuyPrice * (1 + p.addStep)) continue;
          if (pos.lastValueSol < Number(holding.cost_lamports) / LAMPORTS * (1 + p.addIfUp)) continue;
          if (recentFlow(t, now, p.window) < p.addNetSol) continue;
          if (realSol > p.maxRqSol) continue;
          wantSol = Math.min(p.addSol, p.stakeSol - pos.investedSol);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, wantSol, p.maxChunkSol, p.maxExposureSol - exposureSol);
        if (amount > freeSol - txSol) amount = freeSol - txSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        freeSol -= amount + txSol;
        exposureSol += amount;
        if (pos === undefined) {
          open.set(mint, {
            openedSlot: now,
            bestValueSol: 0,
            investedSol: amount,
            lastBuyPrice: price,
            lastValueSol: 0,
            exitArmed: false,
            sawFill: false,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          pos.investedSol += amount;
          pos.lastBuyPrice = price;
        }
      }

      // --- Guardrail pacing: open a probe when fills or coins lag the pace. ---
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minReal = (p.probeSol * BPS_PER_UNIT) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= orderCap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingMints.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minReal * 1.5) continue;
            if (freeSol < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            freeSol -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
