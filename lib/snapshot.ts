// token-radar v6 — compact snapshot encoder.
//
// The browser re-derives the board from this snapshot (dashboard/derive.js
// is the mirror decoder). The two files must agree on every field width:
//
//   rows:   20 chars per ranked row, rank order —
//           logTVL x1000 (5, "07606" = 7.606) + age days (4, 9999 = undated)
//           + (change_7d + 100) x10 (5, null = 01000 i.e. 0.0)
//           + category index (2) + gas cents (4).
//           Age 0 is a real age (listed today), so undated is 9999, not 0000.
//   comps:  9 chars per fit comp — logTVL x1000 (5)
//           + (logMultiple + 3) x1000 (4, 3 decimals; range -3..+7).
//           (Design said 10 B; 3 decimals on logMultiple is plenty — the
//           refit averages 109 comps — and 9 B saves 109 bytes.)
//   ledger: 758 group codes, 4 bits each (11 groups need 4 bits, not 3),
//           packed MSB-first into a base64url bitstream (506 chars).
//   cat:    53 category offsets, (offset + 4) x1000, 4 chars each.
//   watch / sib: 192-bit masks, base64url (32 chars each).
//   coef:   logistic [intercept, age, tvl, growth], 4 decimals.
//   dec:    decile calibration "pred,actual,n;..." (precomputed, 3 decimals).
//
// Everything is plain ASCII; the whole snapshot.js stays near 6 KB, inside
// the dossier's 65,536-byte text cap together with the dashboard source.

export interface DeriveRow {
  logTvl: number;
  ageDays: number | null; // odds-style age (floor), null when undated
  change7d: number | null; // percent, null when missing
  catIdx: number; // index into the sorted category list
  gasCents: number; // cheapest-chain gas in cents
}

export interface DeriveComp {
  logTvl: number;
  logMult: number; // log10(mcap / tvl)
}

export interface DecileRow {
  pred: number;
  actual: number;
  n: number;
}

export interface DeriveData {
  rows: DeriveRow[]; // rank order
  comps: DeriveComp[];
  ledgerCodes: number[]; // per protocol, snapshot order, 0..10
  catOffsets: number[]; // parallel to the sorted category list
  coef: number[]; // [intercept, age, tvl, growth]
  deciles: DecileRow[];
  watch: boolean[]; // rank order
  sibling: boolean[]; // rank order
  medianAgeDays: number;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function pad(n: number, w: number): string {
  const v = Math.max(0, Math.min(Math.round(n), 10 ** w - 1));
  return String(v).padStart(w, '0');
}

export function encodeRows(rows: DeriveRow[]): string {
  return rows
    .map(
      (r) =>
        pad(r.logTvl * 1000, 5) +
        pad(r.ageDays === null ? 9999 : r.ageDays, 4) +
        pad(((r.change7d ?? 0) + 100) * 10, 5) +
        pad(r.catIdx, 2) +
        pad(r.gasCents, 4),
    )
    .join('');
}

export function encodeComps(comps: DeriveComp[]): string {
  return comps
    .map((c) => pad(c.logTvl * 1000, 5) + pad((c.logMult + 3) * 1000, 4))
    .join('');
}

// Pack fixed-width values MSB-first into a base64url bitstream (no padding).
function pack(values: number[], width: number): string {
  let bits = 0;
  let nbits = 0;
  let out = '';
  for (const v of values) {
    bits = (bits << width) | (v & ((1 << width) - 1));
    nbits += width;
    while (nbits >= 6) {
      nbits -= 6;
      out += B64[(bits >> nbits) & 63];
    }
    bits &= (1 << nbits) - 1;
  }
  if (nbits > 0) out += B64[(bits << (6 - nbits)) & 63];
  return out;
}

export function encodeLedger(codes: number[]): string {
  return pack(codes, 4);
}

export function encodeMask(flags: boolean[]): string {
  return pack(flags.map((f) => (f ? 1 : 0)), 1);
}

export function encodeCatOffsets(offsets: number[]): string {
  // Offsets live in (-4, 4): mean residual x shrink x 4. Shifted +4, 3 decimals.
  return offsets.map((o) => pad((o + 4) * 1000, 4)).join('');
}

export function buildSnapshotJs(d: DeriveData): string {
  const dec = d.deciles
    .map((x) => `${x.pred.toFixed(2)},${x.actual.toFixed(2)},${x.n}`)
    .join(';');
  const coef = `[${d.coef.map((c) => Number(c.toFixed(4))).join(',')}]`;
  return (
    `window.SNAP={rows:"${encodeRows(d.rows)}",comps:"${encodeComps(d.comps)}",` +
    `ledger:"${encodeLedger(d.ledgerCodes)}",cat:"${encodeCatOffsets(d.catOffsets)}",` +
    `coef:${coef},dec:"${dec}",watch:"${encodeMask(d.watch)}",sib:"${encodeMask(d.sibling)}",` +
    `age:${d.medianAgeDays}};\n`
  );
}
