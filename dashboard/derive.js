// v6 derive: re-derives the board from the compact snapshot (snapshot.js)
// and proves it against data.js. Pure functions, no DOM — runs under Node
// too. Encoding mirrors lib/snapshot.ts; tolerance 0.5% ($1 at the floor).
(function () {
  'use strict';
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  var TOL = 0.005;
  function fnv1a(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  function unpack(s, w, n) {
    var o = [], a = 0, nb = 0, k = 0;
    for (var i = 0; i < s.length && k < n; i++) {
      a = (a << 6) | B64.indexOf(s[i]); nb += 6;
      while (nb >= w && k < n) { nb -= w; o.push((a >> nb) & ((1 << w) - 1)); k++; }
      a &= (1 << nb) - 1;
    }
    return o;
  }
  function parseRows(s) {
    var o = [];
    for (var i = 0; i + 20 <= s.length; i += 20) {
      var r = s.slice(i, i + 20);
      o.push([parseInt(r.slice(0, 5), 10) / 1000, parseInt(r.slice(5, 9), 10),
        parseInt(r.slice(9, 14), 10) / 10 - 100, parseInt(r.slice(14, 16), 10), parseInt(r.slice(16, 20), 10) / 100]);
    }
    return o;
  }
  function parseComps(s) {
    var o = [];
    for (var i = 0; i + 9 <= s.length; i += 9) {
      var c = s.slice(i, i + 9);
      o.push([parseInt(c.slice(0, 5), 10) / 1000, parseInt(c.slice(5, 9), 10) / 1000 - 3]);
    }
    return o;
  }
  function ols(xs, ys) {
    var n = xs.length, mx = 0, my = 0, sxy = 0, sxx = 0, i;
    for (i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    for (i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    var b = sxx === 0 ? 0 : sxy / sxx;
    return { a: my - b * mx, b: b };
  }
  function sig(z) { return z > 30 ? 1 : z < -30 ? 0 : 1 / (1 + Math.exp(-z)); }
  function perHour(c, tvl, imp, fees) {
    var k = 0.04 * 90 / 365;
    return (((c / (tvl + c)) * 0.1 * imp - fees - k * c) / 220) * 60;
  }
  function deposit(tvl, imp, fees) {
    var k = 0.04 * 90 / 365, need = 25 * 220 / 60, A = 0.1 * imp;
    var B = A - k * tvl - fees - need, disc = B * B - 4 * k * (fees + need) * tvl;
    if (!(B > 0) || !(disc >= 0)) return null;
    return (B - Math.sqrt(disc)) / (2 * k);
  }
  function deriveAll(R, S) {
    var rows = parseRows(S.rows), comps = parseComps(S.comps);
    var fit = ols(comps.map(function (c) { return c[0]; }), comps.map(function (c) { return c[0] + c[1]; }));
    var offs = [];
    for (var i = 0; i + 4 <= S.cat.length; i += 4) offs.push(parseInt(S.cat.slice(i, i + 4), 10) / 1000 - 4);
    var sib = unpack(S.sib, 1, rows.length), w = S.coef;
    var out = rows.map(function (r, i) {
      var val = Math.pow(10, fit.a + fit.b * r[0]) * (sib[i] ? 0.5 : 1);
      var age = r[1] === 9999 ? S.age : r[1];
      var z = w[0] + w[1] * Math.log10(age / 365 + 1) + w[2] * (r[0] - 8) + w[3] * (r[2] / 100) + (offs[r[3]] || 0);
      var imp = Math.max(1, Math.round(val * sig(z)));
      var tvl = Math.pow(10, r[0]), fees = 20 * r[4];
      return { imp: imp, dep: deposit(tvl, imp, fees), tvl: tvl, fees: fees };
    });
    return { fit: fit, rows: out, ledger: unpack(S.ledger, 4, 758), watch: unpack(S.watch, 1, rows.length) };
  }
  function runProofs(R, S) {
    var D = deriveAll(R, S), rows = R.rows, P = [], bad = 0, mx = 0, dB = 0, dM = 0, i;
    for (i = 0; i < rows.length; i++) {
      var d = Math.abs(D.rows[i].imp - rows[i].implied_value_usd);
      if (d > Math.max(1, TOL * rows[i].implied_value_usd)) bad++;
      if (rows[i].implied_value_usd >= 1000) mx = Math.max(mx, d / rows[i].implied_value_usd);
      var dd = D.rows[i].dep, rd = rows[i].deposit25;
      if ((dd === null) !== (rd === null)) dM++;
      else if (dd !== null && !(perHour(dd, D.rows[i].tvl, D.rows[i].imp, D.rows[i].fees) >= 25 - 1e-9 &&
        perHour(dd / 2, D.rows[i].tvl, D.rows[i].imp, D.rows[i].fees) < 25)) dB++;
    }
    P.push({ key: 'rows', ok: bad === 0 && dM === 0 && dB === 0,
      text: (rows.length - bad) + '/' + rows.length + ' within 0.5% (max ' + (mx * 100).toFixed(2) + '%)' +
        (dM || dB ? '; deposits: ' + dM + ' flips, ' + dB + ' bracket fails' : '; deposits bracketed') });
    var rise = 0;
    for (i = 1; i < D.rows.length; i++) if (D.rows[i].imp > D.rows[i - 1].imp * (1 + TOL)) rise++;
    P.push({ key: 'ranks', ok: rise === 0, text: rise === 0 ? 'recomputed values never rise past 0.5%' : rise + ' rises past tolerance' });
    var vb = 0;
    for (i = 1; i < rows.length; i++) if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) vb++;
    P.push({ key: 'values', ok: vb === 0, text: vb === 0 ? 'implied value falls with rank' : 'SORT BROKEN at ' + vb + ' rows' });
    var wc = 0, wm = 0;
    for (i = 0; i < rows.length; i++) { if (D.watch[i]) wc++; if (!!D.watch[i] !== !!rows[i].watchlist) wm++; }
    P.push({ key: 'watch', ok: wc === 40 && wm === 0, text: wc + ' / 40 on the board' + (wm ? ' (' + wm + ' mismatches)' : '') });
    var counts = {}, lok = D.ledger.length === 758;
    for (i = 0; i < D.ledger.length; i++) counts[D.ledger[i]] = (counts[D.ledger[i]] || 0) + 1;
    for (var j = 0; j < R.ledger.groups.length; j++) if ((counts[j] || 0) !== R.ledger.groups[j].n) lok = false;
    P.push({ key: 'ledger', ok: lok, text: D.ledger.length + ' / 758 accounted for' + (lok ? '' : ' — group counts differ') });
    var canon = rows.map(function (r) { return r.slug + ':' + r.rank + ':' + r.implied_value_usd; }).join('|');
    var ck = fnv1a(canon) === R.checksum;
    P.push({ key: 'checksum', ok: ck, text: ck ? R.checksum + ' — matches board.json' : 'MISMATCH: page ' + fnv1a(canon) + ' vs board ' + R.checksum });
    return { proofs: P, fit: D.fit, rows: D.rows };
  }
  window.DERIVE = { deriveAll: deriveAll, runProofs: runProofs };
})();
