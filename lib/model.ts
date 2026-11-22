// token-radar v5 — model: a size curve fitted on traded tokens, times token
// odds from the peers' record. Everything below is computed from the
// snapshot passed in; nothing about a protocol is hard-coded.
//
// Method (disclosed on the dashboard's Method tab):
//   1. Comps = traded protocols, cleaned: bridges and version listings
//      dropped, mcap/TVL ratios outside 1/500..50x trimmed (19 rows).
//      Plain least squares on log10(mcap) ~ log10(TVL).
//   2. Value-if-launches = the size curve ONLY. Every other term (family and
//      category offsets, 7-day growth, age, chain count) was tested in BOTH
//      leave-one-out and walk-forward; none lowers the miss in both, so none
//      is kept. The full table is in lib/evidence.ts and on the dashboard.
//   3. Token odds = logistic regression on 442 peers (every protocol the
//      house rule does not exclude), features age / TVL / 7-day growth plus
//      a shrunk category offset. LOO Brier 0.20 vs 0.25 base rate. The odds
//      are the peers' record, not a prediction: they say how often protocols
//      like this one record a token, never whether this one will.
//   4. Implied value = value-if-launches x token odds. Bands from the
//      curve's leave-one-out residuals (P25-P75 / P10-P90), with the
//      coverage printed beside them.
//   5. Sibling rule: a pre-token protocol whose first word matches a traded
//      token's first word is a likely variant, not a fresh launch —
//      excluded, unless it is on the watchlist (kept at half value).
//   6. Farm economics: slice = capital/(TVL+capital) x airdrop share x
//      implied value; net = slice - fees - T-bill forgone (4%/yr). The
//      verdict is judged at a $10,000 ticket, because at a $1,000 ticket no
//      farm on this board pays more than $4.53 an hour — the wage test would
//      be dead on arrival. FARM beats everything AND pays $25 an hour at
//      $10K; THIN pays at $10K but not the wage; SKIP pays at neither.
//      The $1,000 net stays on the board as the small-ticket reference.
//   7. Ledger: all 758 snapshot protocols land in exactly one group
//      (ranked / token trades / token recorded without a cap / out by rule),
//      and the board carries an FNV checksum the page recomputes.

import { buildOddsModel, oddsAgeDays } from './odds.ts';
import { buildEvidence } from './evidence.ts';
import type { DeriveData, DeriveRow, DeriveComp, DecileRow } from './snapshot.ts';

export interface Proto {
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | number | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export interface FarmStep {
  text: string;
  cost: number;
  minutes: number;
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface OddsTerms {
  intercept: number;
  age: number;
  tvl: number;
  growth: number;
  category: number;
}

export interface RowDetail extends BoardRow {
  category: string;
  chains: string[];
  tvl: number;
  change7dPct: number | null;
  ageDays: number | null;
  watchlist: boolean;
  sibling: boolean;
  early: boolean;
  curveValue: number;
  valueIfLaunches: number;
  odds: number;
  oddsTerms: OddsTerms;
  bandLo: number;
  bandHi: number;
  play: string;
  farmChain: string;
  fees: number;
  holdDays: number;
  workMin: number;
  slice1k: number;
  net1k: number;
  slice10k: number;
  net10k: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  perHour: number | null;
  // v6: minimum ticket paying $25/hour, closed form from the same farm
  // arithmetic (see depositBreakEven). null when no ticket reaches $25/hour.
  deposit25: number | null;
  breakEven: number;
  paysFrom: number | null;
  sensitivity: number[][]; // rows: drop 5/10/20%; cols: capital 1k/10k/100k
  top20Rate: number;
  rankLo: number;
  rankHi: number;
  steps: FarmStep[];
  peers: { slug: string; name: string; tvl: number; mcap: number }[];
}

export interface SetAside {
  slug: string;
  name: string;
  reason: string;
}

export interface TradeRow {
  slug: string;
  name: string;
  category: string;
  tvl: number;
  mcap: number;
  multiple: number;
  inFit: boolean;
}

export interface LedgerGroup {
  key: string;
  label: string;
  n: number;
}

export interface Radar {
  fit: {
    alpha: number; beta: number; r2: number; n: number;
    nRaw: number; nDropped: number;
  };
  oos: {
    looTmf: number; looFlatTmf: number;
    timeTmf: number | null; timeFlatTmf: number | null;
    timeTrain: number; timeTest: number;
  };
  odds: {
    brier: number; baseBrier: number; shareRight: number;
    peers: number; labelled: number; coefficients: number[];
    buckets: { label: string; n: number; share: number }[];
  };
  evidence: {
    terms: { label: string; loo: number; wf: number; verdict: string; note?: string }[];
    range: { half50: number; cover50: number; half80: number; cover80: number };
    wfTrain: number; wfTest: number;
  };
  ledger: { groups: LedgerGroup[]; total: number };
  checksum: string;
  verdictCounts: { FARM: number; THIN: number; SKIP: number };
  bestPerHour: { slug: string; name: string; perHour: number }[];
  totalImplied: number;
  setAside: SetAside[];
  trades: TradeRow[];
  heatmap: { category: string; tier: string; medianResidual: number; n: number }[];
  siblingCount: number;
  generated: string;
}

const BANNED_CATEGORIES = new Set([
  'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking',
  'Restaked BTC', 'CEX',
]);
const VERSION_TAIL = /\s+(v\d+(\.\d+)*|\d+\.\d+)$/i;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];
const RATIO_LO = 1 / 500;
const RATIO_HI = 50;
const TBILL = 0.04;
const HOLD_DAYS = 90;
const AIRDROP_SHARE = 0.1;
const CAPITAL = 1000;
const FARM_PER_HOUR = 25;
const GAS: Record<string, number> = {
  Ethereum: 12, Arbitrum: 0.8, Base: 0.4, Solana: 0.05, Optimism: 0.6,
  Polygon: 0.1, Avalanche: 0.3, BSC: 0.15, Binance: 0.15, Sui: 0.05, Aptos: 0.05,
  Ink: 0.2, Monad: 0.1, Hyperliquid: 0.1, Berachain: 0.2, Sonic: 0.1,
  Plume: 0.15, Bittensor: 0.2, Tron: 0.3, Provenance: 0.2, Stellar: 0.05,
  Flare: 0.1, Sei: 0.05, 'BNB Chain': 0.15,
};
const PLAYS: Record<string, string> = {
  Lending: 'supply and borrow',
  Dexs: 'liquidity and swaps',
  Yield: 'vault deposit',
  'Yield Aggregator': 'curated vault',
  'Basis Trading': 'delta-neutral dollar',
  CDP: 'mint and save',
  RWA: 'tokenised asset',
  'Prediction Market': 'margin and volume',
  Derivatives: 'perp volume',
  Options: 'options volume',
  'Options Vault': 'options vault',
  Insurance: 'cover deposit',
  Indexes: 'index deposit',
  'Cross Chain': 'bridge volume',
  Staking: 'stake and hold',
  'Staking Pool': 'stake and hold',
  'Reserve Currency': 'bond and stake',
  'Algo-Stables': 'mint and stake',
  Farm: 'liquidity and swaps',
  'Leveraged Farming': 'leveraged deposit',
  'Uncollateralized Lending': 'supply and borrow',
  'NFT Lending': 'supply and borrow',
  'RWA Lending': 'supply and borrow',
  Restaking: 'restake and hold',
  'Liquid Restaking': 'restake and hold',
  'Onchain Capital Allocator': 'curated vault',
  'Risk Curators': 'curated vault',
  'Chain': 'stake and hold',
  'SoFi': 'deposit and hold',
  'Services': 'deposit and hold',
  'Privacy': 'deposit and hold',
  'Gaming': 'deposit and hold',
  'NFT Marketplace': 'trade volume',
  'Launchpad': 'deposit and hold',
  'Payments': 'deposit and hold',
  'Oracle': 'deposit and hold',
  'Interoperability': 'bridge volume',
};
const SNAPSHOT_DAY = Date.parse('2026-11-14T00:00:00Z');

// Ledger group order (v6: module scope so the ledger loop can record each
// protocol's group code while it counts — the packed ledger in snapshot.js
// uses these indices).
const LEDGER_ORDER = [
  'ranked-watchlist', 'ranked-early', 'ranked-offlist',
  'trades-fit', 'trades-dropped', 'token-no-mcap',
  'out-bridge', 'out-versioned', 'out-wrapped', 'out-exchange', 'out-sibling',
];

function log10(x: number): number { return Math.log10(Math.max(x, 1)); }

function ols(xs: number[], ys: number[]): { a: number; b: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0; let sxx = 0; let sst = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    sst += (ys[i] - my) ** 2;
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (a + b * xs[i])) ** 2;
  return { a, b, r2: sst === 0 ? 0 : 1 - sse / sst };
}

function median(xs: number[]): number {
  const s = [...xs].sort((p, q) => p - q);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((p, q) => p - q);
  if (!s.length) return 0;
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)));
  return s[i];
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function listedEpoch(p: Proto): number | null {
  if (p.listed_at === null || p.listed_at === undefined) return null;
  if (typeof p.listed_at === 'number') return p.listed_at < 1e12 ? p.listed_at * 1000 : p.listed_at;
  const t = Date.parse(p.listed_at);
  return Number.isNaN(t) ? null : t;
}

function ageDays(p: Proto): number | null {
  const t = listedEpoch(p);
  if (t === null) return null;
  return Math.max(0, Math.round((SNAPSHOT_DAY - t) / 86400000));
}

function firstWord(name: string): string {
  const m = /^[A-Za-z]+/.exec((name || '').trim());
  const w = m ? m[0].toLowerCase() : '';
  return w.length >= 3 ? w : '';
}

function gasOf(chain: string): number {
  return GAS[chain] ?? 1.0;
}

function cheapestChain(chains: string[]): { chain: string; gas: number } {
  // The plan runs on the cheapest of the protocol's TOP THREE chains (the
  // snapshot lists chains in order of importance). Picking the cheapest of
  // all twelve would put a vault on a chain where it barely exists.
  const top = chains.slice(0, 3);
  let best = { chain: top[0] ?? 'Ethereum', gas: Infinity };
  for (const c of top) {
    const g = gasOf(c);
    if (g < best.gas) best = { chain: c, gas: g };
  }
  if (!Number.isFinite(best.gas)) best = { chain: 'Ethereum', gas: gasOf('Ethereum') };
  return best;
}

function pctText(pct: number): string {
  return pct >= 0.001 ? `${pct.toFixed(3)}%` : 'under 0.001%';
}

function fmtMoney(x: number): string {
  if (!Number.isFinite(x)) return '$0';
  const sign = x < 0 ? '-$' : '$';
  const v = Math.abs(x);
  if (v >= 1e9) return `${sign}${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${sign}${(v / 1e6).toFixed(1)}M`;
  if (v >= 1000) return `${sign}${(v / 1000).toFixed(1)}K`;
  if (v >= 10) return `${sign}${v.toFixed(0)}`;
  return `${sign}${v.toFixed(2)}`;
}

// v6 — deposit break-even: the minimum ticket D with perHour(D) >= $25,
// in closed form from the SAME farm arithmetic as the verdict (not a new
// formula). net(c) = (c/(T+c)) x A - fees - k x c, with A = 0.1 x implied,
// k = TBILL x HOLD_DAYS/365. perHour >= 25 means net >= 25 x workMin/60;
// clearing the denominator gives k x D^2 - B x D + (fees+need) x T <= 0
// with B = A - k x T - fees - need, and D is the smaller root. Feasible
// only when B > 0 and the discriminant is non-negative — otherwise no
// ticket reaches $25/hour (typically the largest pools, where the T-bill
// forgone on the capital needed exceeds the slice at every ticket).
// The bracketing self-check below guards the algebra: a closed form that
// disagrees with the arithmetic it came from reports null, not a number.
function depositBreakEven(
  tvl: number,
  implied: number,
  fees: number,
  workMin: number,
): number | null {
  const k = TBILL * (HOLD_DAYS / 365);
  const need = FARM_PER_HOUR * (workMin / 60);
  const A = AIRDROP_SHARE * implied;
  const B = A - k * tvl - fees - need;
  const disc = B * B - 4 * k * (fees + need) * tvl;
  if (!(B > 0) || !(disc >= 0)) return null;
  const d = (B - Math.sqrt(disc)) / (2 * k);
  const perHour = (c: number) => (((c / (tvl + c)) * A - fees - k * c) / workMin) * 60;
  if (!(perHour(d) >= FARM_PER_HOUR - 1e-9) || !(perHour(d / 2) < FARM_PER_HOUR)) return null;
  return d;
}

// v6 — calibration deciles: peers sorted by leave-one-out predicted odds,
// split into ten near-equal groups; each row is the group's mean predicted
// odds against the share that actually recorded a token.
function buildDeciles(preds: number[], labels: number[]): DecileRow[] {
  const idx = preds.map((_, i) => i).sort((a, b) => preds[a] - preds[b] || a - b);
  const n = idx.length;
  const out: DecileRow[] = [];
  for (let d = 0; d < 10; d++) {
    const group = idx.slice(Math.floor((d * n) / 10), Math.floor(((d + 1) * n) / 10));
    out.push({
      pred: group.reduce((s, i) => s + preds[i], 0) / group.length,
      actual: group.reduce((s, i) => s + labels[i], 0) / group.length,
      n: group.length,
    });
  }
  return out;
}

export function buildRadar(snap: Snapshot): { board: BoardRow[]; rows: RowDetail[]; radar: Radar; issues: string[]; derive: DeriveData } {
  const issues: string[] = [];
  const protos = snap.protocols;
  const watch = new Set(snap.watchlist);

  // ---- 1. Comps: traded protocols, cleaned ---------------------------------
  const rawComps = protos.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const comps: Proto[] = [];
  let dropped = 0;
  for (const p of rawComps) {
    if (p.category === 'Bridge' || p.category === 'Canonical Bridge') { dropped++; continue; }
    if (VERSION_TAIL.test(p.name)) { dropped++; continue; }
    const ratio = (p.mcap_usd as number) / p.tvl_usd;
    if (ratio < RATIO_LO || ratio > RATIO_HI) { dropped++; continue; }
    comps.push(p);
  }
  const cx = comps.map((p) => log10(p.tvl_usd));
  const cy = comps.map((p) => log10(p.mcap_usd as number));
  const { a: alpha, b: beta, r2 } = ols(cx, cy);
  const resid = comps.map((p, i) => cy[i] - (alpha + beta * cx[i]));
  // v6: comps for the browser refit — log TVL and log multiple only.
  const deriveComps: DeriveComp[] = comps.map((p) => ({
    logTvl: log10(p.tvl_usd),
    logMult: Math.log10((p.mcap_usd as number) / p.tvl_usd),
  }));

  // ---- 2. Evidence: per-term LOO + walk-forward, range coverage ------------
  const evidence = buildEvidence(comps);
  const curveTerm = evidence.terms[1];
  const flatTerm = evidence.terms[0];

  // ---- 3. Token odds: logistic on the peers' record -------------------------
  const oddsModel = buildOddsModel(protos);
  // v6: category codes for the snapshot (sorted snapshot categories; every
  // ranked row's category is in this list by construction) + calibration.
  const categories = [...new Set(protos.map((p) => p.category))].sort();
  const catIndex = new Map(categories.map((c, i) => [c, i]));
  const catOffsets = categories.map((c) => oddsModel.categoryOffset.get(c) ?? 0);
  const deciles = buildDeciles(oddsModel.looPreds, oddsModel.looLabels);

  // ---- 4. Sibling set + launchable filter ----------------------------------
  const tradedFirst = new Set<string>();
  for (const p of protos) {
    if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) {
      const w = firstWord(p.name);
      if (w) tradedFirst.add(w);
    }
  }
  const setAside: SetAside[] = [];
  const launchable: Proto[] = [];
  for (const p of protos) {
    const preToken = p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
    if (!preToken) continue;
    if (BANNED_CATEGORIES.has(p.category)) { setAside.push({ slug: p.slug, name: p.name, reason: `category ${p.category}` }); continue; }
    if (VERSION_TAIL.test(p.name)) { setAside.push({ slug: p.slug, name: p.name, reason: 'version listing' }); continue; }
    if (WRAPPED_WORD.test(p.name)) { setAside.push({ slug: p.slug, name: p.name, reason: 'wrapped / staked name' }); continue; }
    const first = (p.name || '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (EXCHANGES.includes(first)) { setAside.push({ slug: p.slug, name: p.name, reason: 'exchange name' }); continue; }
    // NOTE: no TVL floor here. The snapshot's floor_usd ($50M) defines the
    // WATCHLIST, not the board: the starter kit itself is 40 watchlist rows
    // plus the largest pre-token protocols BELOW the floor. The snapshot
    // holds 758 protocols over $5M TVL.
    launchable.push(p);
  }
  // Sibling pass: non-watchlist siblings leave the board; watchlist siblings
  // stay at half value.
  const rows: Proto[] = [];
  let siblingCount = 0;
  const siblingSlugs = new Set<string>();
  for (const p of launchable) {
    const w = firstWord(p.name);
    if (w && tradedFirst.has(w)) {
      siblingCount++;
      siblingSlugs.add(p.slug);
      if (!watch.has(p.slug)) {
        setAside.push({ slug: p.slug, name: p.name, reason: 'sibling of a traded token' });
        continue;
      }
    }
    rows.push(p);
  }
  // Defensive: every watchlist slug on the board, even if a filter above
  // would have dropped it (gate requires full coverage).
  for (const slug of snap.watchlist) {
    if (!rows.some((p) => p.slug === slug)) {
      const p = protos.find((x) => x.slug === slug);
      if (p) {
        rows.push(p);
        issues.push(`watchlist ${slug} force-included`);
      } else {
        issues.push(`watchlist ${slug} missing from snapshot`);
      }
    }
  }

  // ---- 5. Score: curve x odds, bands from LOO residuals --------------------
  const half50 = evidence.range.half50;
  const half80 = evidence.range.half80;
  const ranked = rows
    .map((p) => {
      const curve = 10 ** (alpha + beta * log10(p.tvl_usd));
      const sibling = siblingSlugs.has(p.slug);
      const valueIfLaunches = sibling ? curve * 0.5 : curve;
      const odds = oddsModel.predict(p);
      const oddsTerms = oddsModel.logitTerms(p);
      const implied = Math.max(1, Math.round(valueIfLaunches * odds));
      const bandLo = Math.max(1, Math.round(valueIfLaunches * odds / 10 ** half80));
      const bandHi = Math.max(1, Math.round(valueIfLaunches * odds * 10 ** half80));
      return { p, curve, valueIfLaunches, odds, oddsTerms, implied, bandLo, bandHi, sibling };
    })
    .sort((a, b) => b.implied - a.implied || a.p.slug.localeCompare(b.p.slug));

  const bootstrap = bootstrapRanks(ranked, comps, oddsModel);
  const totalImplied = ranked.reduce((s, r) => s + r.implied, 0);
  const bySlug = new Map(protos.map((p) => [p.slug, p]));

  // ---- 6. Farm economics + verdicts -----------------------------------------
  const details: RowDetail[] = [];
  const verdictCounts = { FARM: 0, THIN: 0, SKIP: 0 };
  const deriveRows: DeriveRow[] = [];
  const deriveWatch: boolean[] = [];
  const deriveSib: boolean[] = [];
  for (const [i, r] of ranked.entries()) {
    const p = r.p;
    const play = PLAYS[p.category] ?? 'deposit and hold';
    const { chain, gas } = cheapestChain(p.chains);
    const steps = farmPlan(p, play, chain, gas, r.implied, r.bandLo, r.bandHi, r.odds);
    const fees = steps.reduce((s, s2) => s + s2.cost, 0);
    const workMin = steps.reduce((s, s2) => s + s2.minutes, 0);
    const slice = (c: number) => (c / (p.tvl_usd + c)) * AIRDROP_SHARE * r.implied;
    const slice1k = slice(CAPITAL);
    const forgone = CAPITAL * TBILL * (HOLD_DAYS / 365);
    const net1k = slice1k - fees - forgone;
    // The verdict is judged at a $10,000 ticket: at $1,000 no farm on this
    // board pays more than $4.53 an hour, so a $25/hour wage test at $1K
    // would call everything SKIP and say nothing. At $10K the same test
    // separates 18 farms that pay a real wage from the rest.
    const slice10k = slice(10000);
    const net10k = slice10k - fees - 10000 * TBILL * (HOLD_DAYS / 365);
    const perHour = workMin > 0 ? (net10k / workMin) * 60 : null;
    // A farm call is a bet on the implied value, so FARM demands the $10K
    // ticket pays AND the hour pays $25. THIN pays at $10K but not the wage.
    const verdict: RowDetail['verdict'] =
      net10k > 0 && perHour !== null && perHour >= FARM_PER_HOUR
        ? 'FARM'
        : net10k > 0
          ? 'THIN'
          : 'SKIP';
    verdictCounts[verdict]++;
    // v6: minimum ticket paying $25/hour (closed form, same arithmetic).
    const deposit25 = depositBreakEven(p.tvl_usd, r.implied, fees, workMin);
    // v6: this row's inputs for the browser re-derivation (rank order).
    const ci = catIndex.get(p.category);
    if (ci === undefined) issues.push(`row ${p.slug} has a category outside the snapshot list`);
    deriveRows.push({
      logTvl: log10(p.tvl_usd),
      ageDays: oddsAgeDays(p),
      change7d: p.change_7d,
      catIdx: ci ?? 0,
      gasCents: Math.round(gas * 100),
    });
    deriveWatch.push(watch.has(p.slug));
    deriveSib.push(r.sibling);
    // Break-even capital: solve slice = fees + forgone over a capital grid.
    let breakEven = Infinity;
    for (let c = 100; c <= 1e9; c *= 2) {
      if (slice(c) - fees - c * TBILL * (HOLD_DAYS / 365) > 0) { breakEven = c; break; }
    }
    const paysFrom = Number.isFinite(breakEven) ? breakEven : null;
    const sensitivity: number[][] = [];
    for (const drop of [0.05, 0.1, 0.2]) {
      const row: number[] = [];
      for (const c of [1000, 10000, 100000]) {
        const sl = (c / (p.tvl_usd * (1 + drop) + c)) * AIRDROP_SHARE * r.implied;
        row.push(sl - fees - c * TBILL * (HOLD_DAYS / 365));
      }
      sensitivity.push(row);
    }
    const boot = bootstrap.get(p.slug) ?? { top20: 0, rankLo: i + 1, rankHi: i + 1 };
    details.push({
      slug: p.slug,
      name: p.name,
      rank: i + 1,
      implied_value_usd: r.implied,
      farm_steps: steps.map((s) => s.text),
      category: p.category,
      chains: p.chains,
      tvl: p.tvl_usd,
      change7dPct: p.change_7d,
      ageDays: ageDays(p),
      watchlist: watch.has(p.slug),
      sibling: r.sibling,
      early: ageDays(p) !== null && (ageDays(p) as number) < 180,
      curveValue: r.curve,
      valueIfLaunches: r.valueIfLaunches,
      odds: r.odds,
      oddsTerms: r.oddsTerms,
      bandLo: r.bandLo,
      bandHi: r.bandHi,
      play,
      farmChain: chain,
      fees,
      holdDays: HOLD_DAYS,
      workMin,
      slice1k,
      net1k,
      slice10k,
      net10k,
      verdict,
      perHour,
      deposit25,
      breakEven: Number.isFinite(breakEven) ? breakEven : -1,
      paysFrom,
      sensitivity,
      top20Rate: boot.top20,
      rankLo: boot.rankLo,
      rankHi: boot.rankHi,
      steps,
      peers: nearestPeers(p, comps),
    });
  }

  const board: BoardRow[] = details.map((d) => ({
    slug: d.slug,
    name: d.name,
    rank: d.rank,
    implied_value_usd: d.implied_value_usd,
    farm_steps: d.farm_steps,
  }));

  // ---- 7. Ledger: all 758 protocols, exactly one group each -----------------
  const boardSlugs = new Set(board.map((b) => b.slug));
  const boardSet = new Set(board.map((b) => b.slug));
  const compSlugs = new Set(comps.map((p) => p.slug));
  const ledgerCount: Record<string, number> = {};
  // v6: each protocol's group code, in snapshot order, for the packed ledger.
  const ledgerCodes: number[] = [];
  const bump = (k: string) => {
    ledgerCount[k] = (ledgerCount[k] ?? 0) + 1;
    ledgerCodes.push(LEDGER_ORDER.indexOf(k));
  };
  for (const p of protos) {
    if (boardSet.has(p.slug)) {
      bump(watch.has(p.slug) ? 'ranked-watchlist' : (ageDays(p) !== null && (ageDays(p) as number) < 180 ? 'ranked-early' : 'ranked-offlist'));
      continue;
    }
    if (p.mcap_usd !== null) {
      bump(compSlugs.has(p.slug) ? 'trades-fit' : 'trades-dropped');
      continue;
    }
    if (p.gecko_id !== null || p.symbol !== null) { bump('token-no-mcap'); continue; }
    if (BANNED_CATEGORIES.has(p.category)) { bump('out-bridge'); continue; }
    if (VERSION_TAIL.test(p.name)) { bump('out-versioned'); continue; }
    if (WRAPPED_WORD.test(p.name)) { bump('out-wrapped'); continue; }
    const first = (p.name || '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (EXCHANGES.includes(first)) { bump('out-exchange'); continue; }
    bump('out-sibling');
  }
  const ledgerLabels: Record<string, string> = {
    'ranked-watchlist': 'ranked — on the watchlist',
    'ranked-early': 'ranked — listed under 6 months',
    'ranked-offlist': 'ranked — other pre-token',
    'trades-fit': 'already trading — used to fit the curve',
    'trades-dropped': 'already trading — dropped from the fit',
    'token-no-mcap': 'token recorded, no market cap',
    'out-bridge': 'out — bridge / liquid staking / CEX',
    'out-versioned': 'out — version listing',
    'out-wrapped': 'out — wrapped or staked name',
    'out-exchange': 'out — exchange name',
    'out-sibling': 'out — sibling of a traded token',
  };
  const ledgerGroups: LedgerGroup[] = LEDGER_ORDER.map((key) => ({
    key,
    label: ledgerLabels[key],
    n: ledgerCount[key] ?? 0,
  }));
  const ledgerTotal = ledgerGroups.reduce((s, g) => s + g.n, 0);
  if (ledgerTotal !== protos.length) {
    issues.push(`ledger accounts for ${ledgerTotal} of ${protos.length} protocols`);
  }

  // ---- 8. Checksum the board (the page recomputes it) ----------------------
  const canonical = board.map((r) => `${r.slug}:${r.rank}:${r.implied_value_usd}`).join('|');
  const checksum = fnv1a(canonical);

  // ---- 9. Trades table + heatmap --------------------------------------------
  const trades: TradeRow[] = rawComps
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl: p.tvl_usd,
      mcap: p.mcap_usd as number,
      multiple: (p.mcap_usd as number) / p.tvl_usd,
      inFit: compSlugs.has(p.slug),
    }))
    .sort((a, b) => b.multiple - a.multiple);
  const heatmap = buildHeatmap(comps, resid);

  const bestPerHour = details
    .filter((d) => d.verdict === 'FARM' && d.perHour !== null)
    .sort((a, b) => (b.perHour as number) - (a.perHour as number))
    .slice(0, 5)
    .map((d) => ({ slug: d.slug, name: d.name, perHour: d.perHour as number }));

  const radar: Radar = {
    fit: { alpha, beta, r2, n: comps.length, nRaw: rawComps.length, nDropped: dropped },
    oos: {
      looTmf: curveTerm.loo,
      looFlatTmf: flatTerm.loo,
      timeTmf: curveTerm.wf,
      timeFlatTmf: flatTerm.wf,
      timeTrain: evidence.wfTrain,
      timeTest: evidence.wfTest,
    },
    odds: {
      brier: oddsModel.looBrier,
      baseBrier: oddsModel.baseBrier,
      shareRight: oddsModel.shareCalledRight,
      peers: oddsModel.peers,
      labelled: oddsModel.labelled,
      coefficients: oddsModel.coefficients,
      buckets: oddsModel.buckets,
    },
    evidence: {
      terms: evidence.terms,
      range: evidence.range,
      wfTrain: evidence.wfTrain,
      wfTest: evidence.wfTest,
    },
    ledger: { groups: ledgerGroups, total: ledgerTotal },
    checksum,
    verdictCounts,
    bestPerHour,
    totalImplied,
    setAside,
    trades,
    heatmap,
    siblingCount,
    generated: '2026-11-22',
  };
  // v6: everything the browser needs to re-derive the board, in one object.
  const derive: DeriveData = {
    rows: deriveRows,
    comps: deriveComps,
    ledgerCodes,
    catOffsets,
    coef: oddsModel.coefficients,
    deciles,
    watch: deriveWatch,
    sibling: deriveSib,
    medianAgeDays: oddsModel.medianAgeDays,
  };
  return { board, rows: details, radar, issues, derive };
}

function bootstrapRanks(
  ranked: { p: Proto; valueIfLaunches: number; odds: number; implied: number; sibling: boolean }[],
  comps: Proto[],
  oddsModel: ReturnType<typeof buildOddsModel>,
): Map<string, { top20: number; rankLo: number; rankHi: number }> {
  // Refit only the size curve (200 bootstrap refits of the 109 comps); the
  // odds stay fixed per protocol — they are the peers' record, not a fit.
  // Each refit re-ranks the board, and a protocol's rank spread across the
  // 200 refits is its rank range (P5-P95), with the share of refits it
  // spends in the top 20.
  const rng = mulberry32(20261114);
  const n = comps.length;
  const x = comps.map((p) => log10(p.tvl_usd));
  const y = comps.map((p) => log10(p.mcap_usd as number));
  const counts = new Map(ranked.map((r) => [r.p.slug, { ranks: [] as number[], top20: 0 }]));
  const REFS = 200;
  for (let k = 0; k < REFS; k++) {
    const bx: number[] = [];
    const by: number[] = [];
    for (let i = 0; i < n; i++) {
      const j = Math.floor(rng() * n);
      bx.push(x[j]);
      by.push(y[j]);
    }
    const f = ols(bx, by);
    const scored = ranked
      .map((r) => ({
        slug: r.p.slug,
        v: 10 ** (f.a + f.b * log10(r.p.tvl_usd)) * (r.sibling ? 0.5 : 1) * r.odds,
      }))
      .sort((a, b) => b.v - a.v || a.slug.localeCompare(b.slug));
    for (let i = 0; i < scored.length; i++) {
      const c = counts.get(scored[i].slug)!;
      c.ranks.push(i + 1);
      if (i < 20) c.top20++;
    }
  }
  const out = new Map<string, { top20: number; rankLo: number; rankHi: number }>();
  for (const [slug, c] of counts) {
    out.set(slug, {
      top20: c.top20 / REFS,
      rankLo: quantile(c.ranks, 0.05),
      rankHi: quantile(c.ranks, 0.95),
    });
  }
  return out;
}

function nearestPeers(p: Proto, comps: Proto[]): RowDetail['peers'] {
  // Three traded tokens nearest in log TVL and 7-day growth — the reader can
  // see what "like this one" actually traded at.
  const tg = p.change_7d ?? 0;
  return comps
    .map((c) => ({
      slug: c.slug,
      name: c.name,
      tvl: c.tvl_usd,
      mcap: c.mcap_usd as number,
      d: Math.abs(log10(c.tvl_usd) - log10(p.tvl_usd)) + 0.5 * Math.abs((c.change_7d ?? 0) - tg) / 100,
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ slug, name, tvl, mcap }) => ({ slug, name, tvl, mcap }));
}

function buildHeatmap(
  comps: Proto[],
  resid: number[],
): Radar['heatmap'] {
  // Median residual of the size curve, by category x TVL tier — a view of
  // where the curve over- and under-prices. It is a DIAGNOSTIC only: the
  // category offsets it suggests did not survive the walk-forward test, so
  // they are not part of the value.
  const tiers: [string, number, number][] = [['<$100M', 0, 1e8], ['$100M-$1B', 1e8, 1e9], ['>$1B', 1e9, Infinity]];
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < comps.length; i++) {
    const p = comps[i];
    const t = tiers.find(([, lo, hi]) => p.tvl_usd >= lo && p.tvl_usd < hi)?.[0] ?? '>$1B';
    const key = `${p.category}|||${t}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(resid[i]);
  }
  const out: Radar['heatmap'] = [];
  for (const [key, vals] of buckets) {
    const [category, tier] = key.split('|||');
    out.push({ category, tier, medianResidual: median(vals), n: vals.length });
  }
  return out.sort((a, b) => b.n - a.n);
}

function farmPlan(
  p: Proto,
  play: string,
  chain: string,
  gas: number,
  implied: number,
  bandLo: number,
  bandHi: number,
  odds: number,
): FarmStep[] {
  const name = p.name;
  const tvl = fmtMoney(p.tvl_usd);
  const steps: FarmStep[] = [
    {
      text: `Set up: create a fresh wallet on ${chain} and fund it with $1,000 USDC plus $${(gas * 8).toFixed(2)} for fees. Keep a second wallet empty for the claim, so the claim does not link back to the farm.`,
      cost: gas,
      minutes: 20,
    },
    {
      text: `Deploy: ${play} ${name} with the full $1,000 on ${chain}. The protocol holds ${tvl} of TVL, so this ticket is about ${pctText(1000 / p.tvl_usd * 100)} of the pool.`,
      cost: gas,
      minutes: 15,
    },
    {
      text: `Value the prize: if ${name} launches a token, the size curve puts it at ${fmtMoney(implied / odds)}; the peers' record says protocols like this one record a token ${Math.round(odds * 100)}% of the time, so the odds-adjusted prize is ${fmtMoney(implied)}. The P10-P90 range is ${fmtMoney(bandLo)}-${fmtMoney(bandHi)}.`,
      cost: 0,
      minutes: 5,
    },
    {
      text: `Stay: hold the position 90 days. Keep the funds in the same wallet and chain — moving them mid-season resets the "active days" most airdrop formulas count.`,
      cost: 0,
      minutes: 0,
    },
    {
      text: `Show up: return twice a week (2 x 8 weeks) to top up, claim yield and do one small interaction per visit. Each visit costs about $${gas.toFixed(2)} in fees and 10 minutes of your time.`,
      cost: gas * 16,
      minutes: 160,
    },
    {
      text: `Watch the clock: the odds come from the peers' record as of the snapshot (14 Nov 2026). If ${name} launches a token before the snapshot ages, the prize is gone; check its announcement channel weekly.`,
      cost: 0,
      minutes: 0,
    },
    {
      text: `Exit: withdraw at day 90 and close the position. A clean exit costs about $${gas.toFixed(2)} in fees.`,
      cost: gas,
      minutes: 10,
    },
    {
      text: `Claim: if a token was announced, claim the airdrop to the second wallet and sell within a day. Early airdrop tokens usually lose value in the first week.`,
      cost: gas,
      minutes: 10,
    },
  ];
  return steps;
}
