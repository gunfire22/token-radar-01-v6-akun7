/**
 * Token launch odds model.
 * - Peers are protocols that are not excluded by category, version suffix,
 *   staking keywords or known exchange names.
 * - Features: intercept, log‑age (years+1), log‑TVL (relative to 1e8 USD),
 *   7‑day change (as fraction).
 * - Logistic regression trained by deterministic gradient descent
 *   (800 iters, lr=0.5, L2=1 on non‑intercept weights).
 * - Category offsets are fitted on residuals after the logistic weights,
 *   shrunk by n/(n+16) and scaled by 4 (logit scale).
 * - Leave‑one‑out (LOO) refits the full model per peer to compute proper
 *   Brier score and accuracy.
 * - Buckets summarise label share by years listed.
 */

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

export interface OddsBucket {
  label: string;
  n: number;
  share: number;
}
export interface OddsModel {
  coefficients: number[]; // [intercept, age, tvl, growth]
  categoryOffset: Map<string, number>;
  peers: number;
  labelled: number;
  baseRate: number;
  baseBrier: number;
  looBrier: number;
  shareCalledRight: number;
  buckets: OddsBucket[];
  medianAgeDays: number;
  // v6: per-peer leave-one-out predictions + labels (peer order), for the
  // calibration deciles. Collected in the LOO loop below at no extra cost.
  looPreds: number[];
  looLabels: number[];
  predict(p: Proto): number;
  logitTerms(p: Proto): {
    intercept: number;
    age: number;
    tvl: number;
    growth: number;
    category: number;
  };
}

const SNAPSHOT_DAY = Date.parse('2026-11-14T00:00:00Z');

const EXCL_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGES = new Set([
  'binance',
  'coinbase',
  'bybit',
  'kraken',
  'bitget',
  'okx',
  'bitfinex',
  'gemini',
]);
const VERSION_REGEX = /\s+(v\d+(\.\d+)*|\d+\.\d+)$/i;
const STAKING_REGEX = /\b(wrapped|staked|staking)\b/i;

function parseListedAt(v: string | number | null): number | null {
  if (v === null) return null;
  if (typeof v === 'number') {
    // treat as seconds if < 1e12, else ms
    const ms = v < 1e12 ? v * 1000 : v;
    return ms;
  }
  const ms = Date.parse(v);
  return isNaN(ms) ? null : ms;
}

function computeAgeDays(listedMs: number | null): number | null {
  if (listedMs === null) return null;
  const diff = SNAPSHOT_DAY - listedMs;
  if (diff < 0) return 0;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

// v6: the odds model's age for one protocol (floor, null when undated). The
// snapshot encoder uses this — not model.ts's rounded age — because the
// logit reads this exact value. (On this snapshot every listed_at is a
// date-only string, so the two agree; the export keeps it true by
// construction rather than by luck.)
export function oddsAgeDays(p: Proto): number | null {
  return computeAgeDays(parseListedAt(p.listed_at));
}

function isPeer(p: Proto): boolean {
  if (EXCL_CATEGORIES.has(p.category)) return false;
  if (VERSION_REGEX.test(p.name)) return false;
  if (STAKING_REGEX.test(p.name)) return false;
  const first = p.name.trim().split(/\s+/)[0].toLowerCase();
  if (EXCHANGES.has(first)) return false;
  return true;
}

function sigmoid(z: number): number {
  if (z > 30) return 1;
  if (z < -30) return 0;
  return 1 / (1 + Math.exp(-z));
}

function trainLogistic(
  X: number[][],
  y: number[],
  categories: string[]
): { weights: number[]; catOffset: Map<string, number> } {
  const N = X.length;
  const w = [0, 0, 0, 0]; // intercept, age, tvl, growth
  const lr = 0.5;
  const L2 = 1.0;

  for (let iter = 0; iter < 800; iter++) {
    const grads = [0, 0, 0, 0];
    for (let i = 0; i < N; i++) {
      const xi = X[i];
      let z = 0;
      for (let j = 0; j < 4; j++) z += w[j] * xi[j];
      if (z > 30) z = 30;
      else if (z < -30) z = -30;
      const pi = sigmoid(z);
      const err = pi - y[i];
      for (let j = 0; j < 4; j++) {
        let g = err * xi[j];
        if (j > 0) g += (L2 / N) * w[j];
        grads[j] += g;
      }
    }
    for (let j = 0; j < 4; j++) {
      grads[j] /= N;
      w[j] -= lr * grads[j];
    }
  }

  // compute residuals and category offsets
  const residualSum = new Map<string, { sum: number; cnt: number }>();
  for (let i = 0; i < N; i++) {
    const xi = X[i];
    let z = 0;
    for (let j = 0; j < 4; j++) z += w[j] * xi[j];
    const pi = sigmoid(z);
    const resid = y[i] - pi;
    const cat = categories[i];
    const cur = residualSum.get(cat);
    if (cur) {
      cur.sum += resid;
      cur.cnt += 1;
    } else {
      residualSum.set(cat, { sum: resid, cnt: 1 });
    }
  }

  const catOffset = new Map<string, number>();
  residualSum.forEach((v, cat) => {
    const meanRes = v.sum / v.cnt;
    const shrink = v.cnt / (v.cnt + 16);
    catOffset.set(cat, meanRes * shrink * 4);
  });

  return { weights: w, catOffset };
}

export function buildOddsModel(protos: Proto[]): OddsModel {
  // 1️⃣ filter peers
  const peers = protos.filter(isPeer);
  const peerCount = peers.length;

  // 2️⃣ labels
  const labels = peers.map(p => (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null ? 1 : 0));
  const labelledCount = labels.reduce((a, b) => a + b, 0);
  const baseRate = labelledCount / peerCount;
  const baseBrier = baseRate * (1 - baseRate);

  // 3️⃣ ages
  const rawAges: (number | null)[] = peers.map(p => computeAgeDays(parseListedAt(p.listed_at)));
  const agesForMedian = rawAges.filter((a): a is number => a !== null).sort((a, b) => a - b);
  const medianAgeDays = agesForMedian.length
    ? agesForMedian[Math.floor(agesForMedian.length / 2)]
    : 0;

  const ages = rawAges.map(a => (a === null ? medianAgeDays : a));

  // 4️⃣ features
  const X: number[][] = [];
  const cats: string[] = [];
  for (let i = 0; i < peerCount; i++) {
    const ageDays = ages[i];
    const ageYears = ageDays / 365;
    const x1 = Math.log10(ageYears + 1);
    const x2 = Math.log10(peers[i].tvl_usd / 1e8);
    const x3 = peers[i].change_7d === null ? 0 : peers[i].change_7d! / 100;
    X.push([1, x1, x2, x3]);
    cats.push(peers[i].category);
  }

  // 5️⃣ train on full data
  const { weights, catOffset } = trainLogistic(X, labels, cats);

  // 6️⃣ buckets (exclude undated peers)
  const bucketDefs: [string, number, number][] = [
    ['<6 mo', 0, 0.5],
    ['6-12 mo', 0.5, 1],
    ['1-1.5 y', 1, 1.5],
    ['1.5-2 y', 1.5, 2],
    ['2-3 y', 2, 3],
    ['3-4 y', 3, 4],
    ['4 y+', 4, Infinity],
  ];
  const bucketMap = new Map<string, { n: number; sum: number }>();
  for (const [lbl] of bucketDefs) bucketMap.set(lbl, { n: 0, sum: 0 });
  for (let i = 0; i < peerCount; i++) {
    if (rawAges[i] === null) continue; // exclude undated
    const years = rawAges[i]! / 365;
    const lbl = bucketDefs.find(b => years >= b[1] && years < b[2])![0];
    const bucket = bucketMap.get(lbl)!;
    bucket.n += 1;
    bucket.sum += labels[i];
  }
  const buckets: OddsBucket[] = bucketDefs.map(([lbl]) => {
    const b = bucketMap.get(lbl)!;
    return {
      label: lbl,
      n: b.n,
      share: b.n ? b.sum / b.n : 0,
    };
  });

  // 7️⃣ LOO Brier and accuracy
  let looBrierSum = 0;
  let correct = 0;
  const looPreds: number[] = [];
  const looLabels: number[] = [];
  for (let i = 0; i < peerCount; i++) {
    const Xsub = X.slice(0, i).concat(X.slice(i + 1));
    const ysub = labels.slice(0, i).concat(labels.slice(i + 1));
    const catsub = cats.slice(0, i).concat(cats.slice(i + 1));
    const { weights: wloo, catOffset: clo } = trainLogistic(Xsub, ysub, catsub);
    const xi = X[i];
    let logit = 0;
    for (let j = 0; j < 4; j++) logit += wloo[j] * xi[j];
    const catAdj = clo.get(cats[i]) ?? 0;
    logit += catAdj;
    const prob = sigmoid(logit);
    const y = labels[i];
    looPreds.push(prob);
    looLabels.push(y);
    looBrierSum += (prob - y) ** 2;
    if ((prob >= 0.5 ? 1 : 0) === y) correct++;
  }
  const looBrier = looBrierSum / peerCount;
  const shareCalledRight = correct / peerCount;

  // 8️⃣ model API
  function predict(p: Proto): number {
    const ageMs = computeAgeDays(parseListedAt(p.listed_at));
    const age = ageMs === null ? medianAgeDays : ageMs;
    const ageYears = age / 365;
    const x1 = Math.log10(ageYears + 1);
    const x2 = Math.log10(p.tvl_usd / 1e8);
    const x3 = p.change_7d === null ? 0 : p.change_7d! / 100;
    let logit = weights[0] + weights[1] * x1 + weights[2] * x2 + weights[3] * x3;
    const catAdj = catOffset.get(p.category) ?? 0;
    logit += catAdj;
    return sigmoid(logit);
  }

  function logitTerms(p: Proto): {
    intercept: number;
    age: number;
    tvl: number;
    growth: number;
    category: number;
  } {
    const ageMs = computeAgeDays(parseListedAt(p.listed_at));
    const age = ageMs === null ? medianAgeDays : ageMs;
    const ageYears = age / 365;
    const x1 = Math.log10(ageYears + 1);
    const x2 = Math.log10(p.tvl_usd / 1e8);
    const x3 = p.change_7d === null ? 0 : p.change_7d! / 100;
    const intercept = weights[0];
    const ageTerm = weights[1] * x1;
    const tvlTerm = weights[2] * x2;
    const growthTerm = weights[3] * x3;
    const categoryTerm = catOffset.get(p.category) ?? 0;
    return {
      intercept,
      age: ageTerm,
      tvl: tvlTerm,
      growth: growthTerm,
      category: categoryTerm,
    };
  }

  return {
    coefficients: weights,
    categoryOffset: catOffset,
    peers: peerCount,
    labelled: labelledCount,
    baseRate,
    baseBrier,
    looBrier,
    shareCalledRight,
    buckets,
    medianAgeDays,
    looPreds,
    looLabels,
    predict,
    logitTerms,
  };
}
