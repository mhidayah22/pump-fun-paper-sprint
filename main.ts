// Pump.fun paper bot: launch sniper with a rug filter and fast exits.
//
// Idea: almost every new pump.fun coin dies, a few run far. So the bot
// buys at launch — within a few slots of creation, once real buyers have
// put SOL into the curve — and only launches that pass a rug filter:
// the creator has not sold, the creator did not buy a huge stack, and
// the early buyers are few (a launch bundled by many wallets is usually
// the creator's cluster waiting to dump). It risks a fixed stake, banks
// a quick +40%, cuts at -12%, never holds past 60 slots, and leaves at
// once when the creator sells. At most 5 positions are open at once, so
// slots recycle across many coins in the 6-hour window; the guardrail
// needs round trips of >= 0.01 SOL on >= 20 distinct coins with
// drawdown <= 50%.
//
// A sell is only sent when its estimated proceeds clear the tx fee with
// margin: the harness refuses a dust sell as zero_amount, and retrying
// one every batch floods the run with rejects.
//
// Deterministic by construction: no randomness, no clock, no network.
// All price comparisons are exact bigint cross-multiplications, and coins
// are visited in first-seen (insertion) order, so two runs on the same
// data produce the same action log byte for byte.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// ---- tunable strategy knobs (one variant = one set of values) ----
const CONFIG = {
  stakeLamports: (LAMPORTS_PER_SOL * 1n) / 10n, // 0.1 SOL per coin
  minBuyLamports: (LAMPORTS_PER_SOL * 5n) / 1000n, // 0.005 SOL
  entryMaxAgeSlots: 3, // buy at launch, within a few slots of creation
  entryMinBuys: 1, // at least one buy trade since creation
  maxBuyers: 3, // distinct non-creator buyers before entry, at most
  maxCreatorBuyLamports: LAMPORTS_PER_SOL, // creator stack <= 1 SOL
  minRealLamports: (LAMPORTS_PER_SOL * 3n) / 10n, // real reserves >= 0.3 SOL
  maxRealLamports: LAMPORTS_PER_SOL * 30n, // real reserves <= 30 SOL
  maxRunupBps: 20000, // price at most 2x its create price
  stopLossBps: 8800, // sell everything at <= 88% of entry price (-12%)
  takeProfitBps: 14000, // sell everything at >= 140% of entry price (+40%)
  maxHoldSlots: 60, // never hold past this long
  staleSlots: 120, // exit when no trade has hit the coin for this long
  maxSlippageBps: 10000, // wide: never miss an exit for slippage
  // Never send a sell the harness must refuse: a position whose proceeds
  // after curve fees would not cover its tx fee is rejected as
  // zero_amount, and retrying it every batch floods the run with
  // rejects (V1: 57,062). Dust is written off free at flatten instead.
  minSellProceedsLamports: 500000n, // 0.0005 SOL
};

const BPS = 10000n;

interface Coin {
  mint: string;
  createdSlot: number;
  creator: string;
  createQ: bigint; // virtual quote reserves at creation
  createT: bigint; // virtual token reserves at creation
  buys: number;
  buySol: bigint;
  sellSol: bigint;
  creatorBuySol: bigint;
  creatorSold: boolean;
  buyers: Set<string>; // distinct non-creator buyers
  lastTradeSlot: number;
  decided: boolean; // a buy was already sent (or the coin was skipped)
  entryQ: bigint; // virtual quote reserves when the buy was decided
  entryT: bigint;
  entrySlot: number;
}

const coins = new Map<string, Coin>();

// priceNow / priceRef >= bps / 10000  <=>  q * refT * 10000 >= t * refQ * bps
function atLeastBps(q: bigint, t: bigint, refQ: bigint, refT: bigint, bps: bigint): boolean {
  if (t === 0n || refT === 0n || refQ === 0n) return false;
  return q * refT * BPS >= t * refQ * bps;
}

// priceNow / priceRef <= bps / 10000
function atMostBps(q: bigint, t: bigint, refQ: bigint, refT: bigint, bps: bigint): boolean {
  if (t === 0n || refT === 0n || refQ === 0n) return true;
  return q * refT * BPS <= t * refQ * bps;
}

function priceOf(state: BotState, mint: string): { q: bigint; t: bigint } | null {
  const curve = state.curves.get(mint);
  if (curve === undefined) return null;
  if (curve.virtual_token_reserves === 0n) return null;
  return { q: curve.virtual_quote_reserves, t: curve.virtual_token_reserves };
}

await runBot({
  onBatch(state: BotState, batch: Batch): Array<BuyInput | SellInput> {
    const orders: Array<BuyInput | SellInput> = [];
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();

    // --- fold this batch's events into per-coin flow stats ---
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            mint: e.mint,
            createdSlot: e.slot,
            creator: e.creator,
            createQ: BigInt(e.virtual_sol_reserves),
            createT: BigInt(e.virtual_token_reserves),
            buys: 0,
            buySol: 0n,
            sellSol: 0n,
            creatorBuySol: 0n,
            creatorSold: false,
            buyers: new Set<string>(),
            lastTradeSlot: e.slot,
            decided: false,
            entryQ: 0n,
            entryT: 0n,
            entrySlot: 0,
          });
        }
      } else if (e.event === "TradeEvent") {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.lastTradeSlot = e.slot;
          if (e.user === c.creator) {
            if (e.is_buy) c.creatorBuySol += BigInt(e.sol_amount);
            else c.creatorSold = true;
          } else {
            if (e.is_buy) {
              c.buys += 1;
              c.buySol += BigInt(e.sol_amount);
              c.buyers.add(e.user);
            } else {
              c.sellSol += BigInt(e.sol_amount);
            }
          }
        }
      } else if (e.event === "CompleteEvent") {
        const c = coins.get(e.mint);
        if (c !== undefined) c.decided = true; // never buy a completed curve
      }
    }

    // --- exits first: free slots before considering new entries ---
    for (const [mint, holding] of state.positions) {
      const c = coins.get(mint);
      const p = priceOf(state, mint);
      if (c === undefined || p === null) continue;
      // A sell already in flight for this mint: wait for its fill.
      // Recomputed every batch from the live pending set, so a filled
      // sell stops blocking the next exit.
      let sellPending = false;
      for (const pend of state.pending.values()) {
        if (pend.order.mint === mint && pend.order.side === "sell") {
          sellPending = true;
          break;
        }
      }
      if (sellPending) continue;

      const tokens = holding.token_amount;
      if (tokens <= 0n) continue;

      let sellTokens = 0n;
      if (c.creatorSold) {
        sellTokens = tokens; // creator dumped: leave at once
      } else if (atMostBps(p.q, p.t, c.entryQ, c.entryT, BigInt(CONFIG.stopLossBps))) {
        sellTokens = tokens; // stop-loss: out entirely
      } else if (atLeastBps(p.q, p.t, c.entryQ, c.entryT, BigInt(CONFIG.takeProfitBps))) {
        sellTokens = tokens; // quick profit: out entirely
      } else if (batch.slot - c.entrySlot >= CONFIG.maxHoldSlots) {
        sellTokens = tokens; // never hold past the window
      } else if (batch.slot - c.lastTradeSlot >= CONFIG.staleSlots) {
        sellTokens = tokens; // dead tape: free the slot
      }

      if (sellTokens > 0n) {
        // Skip dust sells the harness must refuse (see CONFIG).
        const estValue = (sellTokens * p.q) / p.t;
        const estProceeds = (estValue * 9875n) / BPS - tx;
        if (estProceeds < CONFIG.minSellProceedsLamports) continue;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (free < tx) break;
        orders.push({
          side: "sell",
          mint,
          token_amount: sellTokens,
          max_slippage_bps: CONFIG.maxSlippageBps,
        });
        free -= tx;
      }
    }

    // --- entries: launches that pass the rug filter ---
    if (slots > 0) {
      for (const c of coins.values()) {
        if (slots <= 0) break;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (c.decided) continue;
        if (batch.slot - c.createdSlot > CONFIG.entryMaxAgeSlots) {
          c.decided = true; // too old: skip for good
          continue;
        }
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) {
          c.decided = true;
          continue;
        }
        if (c.creatorSold) {
          c.decided = true; // creator already dumped: never buy
          continue;
        }
        if (c.creatorBuySol > CONFIG.maxCreatorBuyLamports) {
          c.decided = true;
          continue;
        }
        if (c.buyers.size > CONFIG.maxBuyers) {
          c.decided = true; // bundled launch: a dump in waiting
          continue;
        }
        if (c.buys < CONFIG.entryMinBuys) continue;
        if (curve.real_quote_reserves < CONFIG.minRealLamports) continue;
        if (curve.real_quote_reserves > CONFIG.maxRealLamports) {
          c.decided = true;
          continue;
        }
        const p = priceOf(state, c.mint);
        if (p === null) continue;
        if (!atMostBps(p.q, p.t, c.createQ, c.createT, BigInt(CONFIG.maxRunupBps))) continue;

        const cap = state.maxBuyLamports(c.mint);
        if (cap < CONFIG.minBuyLamports) continue;
        const amount = cap < CONFIG.stakeLamports ? cap : CONFIG.stakeLamports;
        if (free < amount + tx) continue;

        orders.push({
          side: "buy",
          mint: c.mint,
          quote_lamports: amount,
          max_slippage_bps: CONFIG.maxSlippageBps,
        });
        free -= amount + tx;
        slots -= 1;
        c.decided = true;
        c.entryQ = p.q;
        c.entryT = p.t;
        c.entrySlot = batch.slot;
      }
    }

    return orders;
  },

  onDone() {
    // The harness flattens whatever is left; nothing to do here.
  },
});
