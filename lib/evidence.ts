/**
 * Evidence builder for the token‑launch‑radar value model.
 *
 * The model predicts log10(mcap) from log10(TVL) and optional additive terms:
 * 0) flat – median of (log10 mcap − log10 TVL) across the training set.
 * 1) curve – OLS regression of log10 mcap on log10 TVL.
 * 2) family – curve + ridge‑shrunk per‑category offset (K = 16).
 * 3) category – curve + ridge‑shrunk per‑category offset (K = 64) (replaces family).
 * 4) growth – term 3 + linear coefficient on change_7d/100 (clamped to [‑1, 1]).
 * 5) age – term 4 + linear coefficient on log10(ageDays/365) (clamped).
 * 6) chains – term 5 + linear coefficient on log2(max(1, chains.length)) (clamped).
 * 7) control – term 6 + linear coefficient on the next row’s change_7d/100 (placebo).
 *
 * Two validation tests are run:
 *   • LOO – leave-one-out, refitting the model for every held-out row.
 *   • WF  – walk-forward split at 2025-01-01 (undated rows excluded).
 *
 * A term is "kept" only if it reduces the median miss (10^|log-error|) in *both*
 * tests compared to the previous term. According to the snapshot only the
 * "curve" term satisfies this rule. The control row is a placebo by
 * construction: it is never kept, whatever the two tests say; its apparent
 * gain bounds the noise in the 29-row walk-forward test.
 *
 * The module exports `buildEvidence(comps)` returning the table of terms,
 * range coverage derived from the curve-only LOO residuals, and basic counts.
 *
 * No randomness, I/O or external imports are used – all helpers are defined
 * locally and the code is fully deterministic.
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

export interface TermRow {
  label: string;
  loo: number;
  wf: number;
  verdict: 'baseline' | 'kept' | 'not kept';
  note?: string;
}
export interface RangeCoverage {
  half50: number; cover50: number;
  half80: number; cover80: number;
}
export interface Evidence {
  terms: TermRow[];
  range: RangeCoverage;
  wfTrain: number;
  wfTest: number;
  n: number;
}
export function buildEvidence(comps: Proto[]): Evidence {
  const SNAPSHOT_DAY = Date.parse('2026-11-14T00:00:00Z');
  const WF_CUT = Date.parse('2025-01-01T00:00:00Z');
  const LOG10_2 = Math.log10(2);

  // ---------- helpers ----------
  const median = (arr: number[]) => {
    const a = [...arr].sort((x, y) => x - y);
    const n = a.length;
    if (n === 0) return 0;
    const mid = n >> 1;
    return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  };
  const quantile = (arr: number[], q: number) => {
    const a = [...arr].sort((x, y) => x - y);
    const pos = (a.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    if (lo === hi) return a[lo];
    const w = pos - lo;
    return a[lo] * (1 - w) + a[hi] * w;
  };
  const ols = (x: number[], y: number[]) => {
    const n = x.length;
    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
    for (let i = 0; i < n; ++i) {
      const xi = x[i];
      const yi = y[i];
      sumX += xi;
      sumY += yi;
      sumXX += xi * xi;
      sumXY += xi * yi;
    }
    const denom = n * sumXX - sumX * sumX;
    if (denom === 0) return { intercept: 0, slope: 0 };
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return { intercept, slope };
  };
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const parseListedAt = (val: string | number | null): number | null => {
    if (val === null) return null;
    if (typeof val === 'string') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
        const t = Date.parse(val + 'T00:00:00Z');
        return isNaN(t) ? null : t;
      }
      const t = Date.parse(val);
      return isNaN(t) ? null : t;
    }
    // number – could be seconds or ms
    const num = val as number;
    const ms = num > 1e11 ? num : num * 1_000;
    return ms;
  };

  // ---------- pre‑compute features ----------
  const n = comps.length;
  const logTvl: number[] = new Array(n);
  const logMcap: number[] = new Array(n);
  const changeNorm: number[] = new Array(n);
  const ageNorm: number[] = new Array(n);
  const chainsNorm: number[] = new Array(n);
  const listedAtMs: (number | null)[] = new Array(n);
  const category: string[] = new Array(n);
  for (let i = 0; i < n; ++i) {
    const c = comps[i];
    logTvl[i] = Math.log10(c.tvl_usd);
    logMcap[i] = Math.log10(c.mcap_usd!);
    changeNorm[i] = (c.change_7d ?? 0) / 100;
    const la = parseListedAt(c.listed_at);
    listedAtMs[i] = la;
    if (la !== null) {
      const ageDays = (SNAPSHOT_DAY - la) / (1000 * 60 * 60 * 24);
      ageNorm[i] = ageDays > 0 ? Math.log10(ageDays / 365) : 0;
    } else {
      ageNorm[i] = 0;
    }
    const chainCount = c.chains?.length ?? 0;
    chainsNorm[i] = Math.log2(Math.max(1, chainCount));
    category[i] = c.category;
  }
  // next row change (placebo)
  const nextChangeNorm: number[] = new Array(n);
  for (let i = 0; i < n; ++i) {
    nextChangeNorm[i] = changeNorm[(i + 1) % n];
  }

  // ---------- split for WF ----------
  const trainIdxWF: number[] = [];
  const testIdxWF: number[] = [];
  for (let i = 0; i < n; ++i) {
    const la = listedAtMs[i];
    if (la === null) continue;
    if (la < WF_CUT) trainIdxWF.push(i);
    else testIdxWF.push(i);
  }
  const wfTrain = trainIdxWF.length;
  const wfTest = testIdxWF.length;

  // ---------- core fitting routine ----------
  interface FitParams {
    flatMedian: number;
    curve: { intercept: number; slope: number };
    offsetFamily: Map<string, number>;
    offsetCategory: Map<string, number>;
    growthCoeff: number;
    ageCoeff: number;
    chainsCoeff: number;
    controlCoeff: number;
  }

  const fitAll = (trainIdx: number[]): FitParams => {
    const idx = trainIdx;
    const m = idx.length;
    const lt = new Array(m);
    const lm = new Array(m);
    const ch = new Array(m);
    const ag = new Array(m);
    const ca = new Array(m);
    const catArr = new Array(m);
    for (let i = 0; i < m; ++i) {
      const j = idx[i];
      lt[i] = logTvl[j];
      lm[i] = logMcap[j];
      ch[i] = changeNorm[j];
      ag[i] = ageNorm[j];
      ca[i] = chainsNorm[j];
      catArr[i] = category[j];
    }

    // flat median
    const diffs = lt.map((v, i) => lm[i] - v);
    const flatMedian = median(diffs);

    // curve
    const curve = ols(lt, lm);
    const curvePred = lt.map(x => curve.intercept + curve.slope * x);
    const residCurve = lm.map((y, i) => y - curvePred[i]);

    // category offsets
    const mapFamily = new Map<string, number>();
    const mapCategory = new Map<string, number>();
    const catCounts = new Map<string, { sum: number; n: number }>();
    for (let i = 0; i < m; ++i) {
      const cat = catArr[i];
      const rec = catCounts.get(cat) ?? { sum: 0, n: 0 };
      rec.sum += residCurve[i];
      rec.n += 1;
      catCounts.set(cat, rec);
    }
    for (const [cat, rec] of catCounts.entries()) {
      const mean = rec.sum / rec.n;
      const shrinkFamily = rec.n / (rec.n + 16);
      const shrinkCat = rec.n / (rec.n + 64);
      const offF = clamp(mean * shrinkFamily, -LOG10_2, LOG10_2);
      const offC = clamp(mean * shrinkCat, -LOG10_2, LOG10_2);
      mapFamily.set(cat, offF);
      mapCategory.set(cat, offC);
    }

    // growth coefficient (term 4): fitted on the residual after curve +
    // CATEGORY offset (K=64, the term-3 baseline the later terms build on).
    const predCat = curvePred.map((p, i) => p + (mapCategory.get(catArr[i]) ?? 0));
    const residAfterCat = lm.map((y, i) => y - predCat[i]);
    const sumXYG = residAfterCat.reduce((s, r, i) => s + ch[i] * r, 0);
    const sumXXG = ch.reduce((s, x) => s + x * x, 0);
    const growthCoeff = clamp(sumXXG ? sumXYG / sumXXG : 0, -1, 1);

    // age coefficient (term 5)
    const predGrowth = predCat.map((p, i) => p + growthCoeff * ch[i]);
    const residAfterGrowth = lm.map((y, i) => y - predGrowth[i]);
    const sumXYA = residAfterGrowth.reduce((s, r, i) => s + ag[i] * r, 0);
    const sumXXA = ag.reduce((s, x) => s + x * x, 0);
    const ageCoeff = clamp(sumXXA ? sumXYA / sumXXA : 0, -1, 1);

    // chains coefficient (term 6)
    const predAge = predGrowth.map((p, i) => p + ageCoeff * ag[i]);
    const residAfterAge = lm.map((y, i) => y - predAge[i]);
    const sumXYC = residAfterAge.reduce((s, r, i) => s + ca[i] * r, 0);
    const sumXXC = ca.reduce((s, x) => s + x * x, 0);
    const chainsCoeff = clamp(sumXXC ? sumXYC / sumXXC : 0, -1, 1);

    // control coefficient (term 7)
    const predChains = predAge.map((p, i) => p + chainsCoeff * ca[i]);
    const residAfterChains = lm.map((y, i) => y - predChains[i]);
    const nextCh = idx.map(j => nextChangeNorm[j]);
    const sumXYCtrl = residAfterChains.reduce((s, r, i) => s + nextCh[i] * r, 0);
    const sumXXCtrl = nextCh.reduce((s, x) => s + x * x, 0);
    const controlCoeff = clamp(sumXXCtrl ? sumXYCtrl / sumXXCtrl : 0, -1, 1);

    return {
      flatMedian,
      curve,
      offsetFamily: mapFamily,
      offsetCategory: mapCategory,
      growthCoeff,
      ageCoeff,
      chainsCoeff,
      controlCoeff,
    };
  };

  const predict = (
    i: number,
    termIdx: number,
    p: FitParams
  ): number => {
    const tvl = logTvl[i];
    const cat = category[i];
    const flat = tvl + p.flatMedian;
    if (termIdx === 0) return flat;
    const curve = p.curve.intercept + p.curve.slope * tvl;
    if (termIdx === 1) return curve;
    const offFam = p.offsetFamily.get(cat) ?? 0;
    const offCat = p.offsetCategory.get(cat) ?? 0;
    const offset = termIdx === 2 ? offFam : offCat; // term 2 = family, term 3 = category
    const pred3 = curve + offset;
    if (termIdx === 2) return pred3; // family
    if (termIdx === 3) return pred3; // category
    const pred4 = pred3 + p.growthCoeff * changeNorm[i];
    if (termIdx === 4) return pred4;
    const pred5 = pred4 + p.ageCoeff * ageNorm[i];
    if (termIdx === 5) return pred5;
    const pred6 = pred5 + p.chainsCoeff * chainsNorm[i];
    if (termIdx === 6) return pred6;
    const pred7 = pred6 + p.controlCoeff * nextChangeNorm[i];
    return pred7;
  };

  // ---------- LOO evaluation ----------
  const termCount = 8;
  const looAbsResiduals: number[][] = Array.from({ length: termCount }, () => []);
  for (let hold = 0; hold < n; ++hold) {
    const trainIdx = [];
    for (let j = 0; j < n; ++j) if (j !== hold) trainIdx.push(j);
    const params = fitAll(trainIdx);
    for (let t = 0; t < termCount; ++t) {
      const pred = predict(hold, t, params);
      looAbsResiduals[t].push(Math.abs(logMcap[hold] - pred));
    }
  }
  const looMedians = looAbsResiduals.map(arr => Math.pow(10, median(arr)));

  // ---------- WF evaluation ----------
  const wfParams = fitAll(trainIdxWF);
  const wfAbsResiduals: number[][] = Array.from({ length: termCount }, () => []);
  for (const i of testIdxWF) {
    for (let t = 0; t < termCount; ++t) {
      const pred = predict(i, t, wfParams);
      wfAbsResiduals[t].push(Math.abs(logMcap[i] - pred));
    }
  }
  const wfMedians = wfAbsResiduals.map(arr => arr.length ? Math.pow(10, median(arr)) : 0);

  // ---------- range coverage from curve LOO ----------
  const curveAbs = looAbsResiduals[1]; // term index 1 = curve
  const half50 = median(curveAbs);
  const half80 = quantile(curveAbs, 0.8);
  const cover50 = curveAbs.filter(v => v <= half50).length / n;
  const cover80 = curveAbs.filter(v => v <= half80).length / n;

  // ---------- assemble term rows ----------
  const labels = [
    'flat median multiple',
    '+ size curve, ln TVL',
    '+ family effect, ridge 16',
    '+ category effect, ridge 64',
    '+ 7-day TVL growth',
    '+ age, years listed',
    '+ chain count, ln',
    '+ control: growth of another row'
  ];
  const terms: TermRow[] = [];
  let prevLoo = looMedians[0];
  let prevWf = wfMedians[0];
  for (let t = 0; t < termCount; ++t) {
    let verdict: TermRow['verdict'];
    let note: string | undefined;
    if (t === 0) verdict = 'baseline';
    else if (t === termCount - 1) {
      // The control is a placebo by construction: another row's growth cannot
      // carry signal about this row's value. Whatever the two tests say, it is
      // never kept; its apparent gain bounds the noise in the 29-row
      // walk-forward test, and the dashboard says so.
      verdict = 'not kept';
      note = 'Placebo by construction: a shuffled feature carries no signal. Its apparent gain bounds the noise in the 29-row walk-forward test.';
    } else {
      verdict = (looMedians[t] < prevLoo && wfMedians[t] < prevWf) ? 'kept' : 'not kept';
    }
    terms.push({
      label: labels[t],
      loo: looMedians[t],
      wf: wfMedians[t],
      verdict,
      ...(note ? { note } : {}),
    });
    prevLoo = looMedians[t];
    prevWf = wfMedians[t];
  }

  // ---------- final object ----------
  const range: RangeCoverage = {
    half50,
    cover50,
    half80,
    cover80,
  };
  return {
    terms,
    range,
    wfTrain,
    wfTest,
    n,
  };
}
