// token-radar v6 dashboard. Renders window.RADAR (data.js); the integrity
// strip runs the re-derivation proofs from derive.js on the snapshot.
(function () {
  const R = window.RADAR;
  if (!R || !R.rows) {
    document.body.insertAdjacentHTML('afterbegin', '<p style="padding:20px">No radar data loaded.</p>');
    return;
  }
  const rows = R.rows;
  const $ = (id) => document.getElementById(id);

  function fmtMoney(x) {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    const sign = x < 0 ? '-$' : '$';
    const v = Math.abs(x);
    if (v >= 1e9) return sign + (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return sign + (v / 1e6).toFixed(1) + 'M';
    if (v >= 1000) return sign + (v / 1000).toFixed(1) + 'K';
    if (v >= 10) return sign + v.toFixed(0);
    return sign + v.toFixed(2);
  }
  function fmtPct(x, digits) {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    return (x * 100).toFixed(digits === undefined ? 0 : digits) + '%';
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderStats() {
    $('kpiRanked').textContent = rows.length;
    const w = rows.filter((r) => r.watchlist).length;
    $('kpiWatch').textContent = w + ' / 40';
    $('kpiBrier').textContent = R.odds.brier.toFixed(3);
    $('kpiBrierSub').textContent = 'vs base rate ' + R.odds.baseBrier.toFixed(3) + ', ' + R.odds.peers + ' peers';
    $('kpiRange').textContent = fmtPct(R.evidence.range.cover50) + ' / ' + fmtPct(R.evidence.range.cover80);
    $('kpiFarm').textContent = R.verdictCounts.FARM + ' FARM';
    $('kpiLedger').textContent = R.ledger.total + ' / 758';
  }

  let sortKey = 'rank';
  let sortDir = 1;
  function filtered() {
    const q = ($('q').value || '').trim().toLowerCase();
    const v = $('verdict').value;
    const wo = $('watchOnly').checked;
    const eo = $('earlyOnly').checked;
    let out = rows.filter((r) => {
      if (q && !(r.name.toLowerCase().includes(q) || r.slug.includes(q) || r.category.toLowerCase().includes(q))) return false;
      if (v && r.verdict !== v) return false;
      if (wo && !r.watchlist) return false;
      if (eo && !r.early) return false;
      return true;
    });
    out.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === 'string') return sortDir * av.localeCompare(bv);
      return sortDir * ((av === null || av === undefined ? -Infinity : av) - (bv === null || bv === undefined ? -Infinity : bv));
    });
    return out;
  }
  function bandBar(r) {
    return '<span class="band">' + fmtMoney(r.bandLo) + '–' + fmtMoney(r.bandHi) + '</span>';
  }
  function oddsCell(r) {
    const pct = Math.round(r.odds * 100);
    return '<div class="odds-cell"><span class="odds-num">' + pct + '%</span>' +
      '<div class="odds-bar"><div class="odds-fill" style="width:' + pct + '%"></div></div></div>';
  }
  function renderBoard() {
    const list = filtered();
    $('boardBody').innerHTML = list.map((r) => {
      const pills = (r.watchlist ? '<span class="pill watch">WATCH</span>' : '') +
        (r.early ? '<span class="pill early">NEW</span>' : '') +
        (r.sibling ? '<span class="pill sib">SIBLING &times;&frac12;</span>' : '');
      const chg = r.change7dPct === null ? '—' :
        '<span class="' + (r.change7dPct >= 0 ? 'pos' : 'neg') + '">' + (r.change7dPct >= 0 ? '+' : '') + r.change7dPct.toFixed(1) + '%</span>';
      const net = r.net1k === null ? '—' :
        '<span class="' + (r.net1k >= 0 ? 'pos' : 'neg') + '">' + fmtMoney(r.net1k) + '</span>';
      const dep = r.deposit25 === null ? '—' : fmtMoney(r.deposit25);
      return '<tr data-slug="' + esc(r.slug) + '">' +
        '<td class="rank-cell">' + r.rank + '</td>' +
        '<td class="name-cell"><strong>' + esc(r.name) + '</strong>' + pills +
        '<div class="slug">' + esc(r.slug) + ' · ' + esc(r.category) + '</div></td>' +
        '<td class="num"><strong>' + fmtMoney(r.implied_value_usd) + '</strong></td>' +
        '<td class="num">' + fmtMoney(r.valueIfLaunches) + '</td>' +
        '<td>' + oddsCell(r) + '</td>' +
        '<td class="num">' + bandBar(r) + '</td>' +
        '<td class="num">' + fmtMoney(r.tvl) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num">' + net + '</td>' +
        '<td class="num">' + dep + '</td>' +
        '<td><span class="verdict ' + r.verdict + '">' + r.verdict + '</span></td>' +
        '</tr>';
    }).join('');
    $('rowCount').textContent = list.length + ' of ' + rows.length + ' rows';
    const farm = R.verdictCounts;
    $('boardFootnote').textContent = 'Verdicts at a $10,000 ticket, 90-day hold, 4% T-bill forgone: ' +
      farm.FARM + ' FARM (net > $0 and > $25/hour) · ' + farm.THIN + ' THIN (net > $0, hour under $25) · ' + farm.SKIP + ' SKIP (net ≤ $0). ' +
      'Deposit to farm is the minimum ticket paying $25/hour (— if no ticket does). ' +
      'Click a row for its farm plan, odds breakdown and sensitivity. Total implied value ' + fmtMoney(R.totalImplied) + '.';
  }

  function renderLedger() {
    const groups = R.ledger.groups;
    const total = R.ledger.total;
    const cls = { ranked: 'ranked', trades: 'trades', token: 'token', out: 'out' };
    const groupCls = (key) => key.startsWith('ranked') ? 'ranked' : key.startsWith('trades') ? 'trades' : key.startsWith('token') ? 'token' : 'out';
    $('ledgerBar').innerHTML = groups.map((g) => {
      const w = total ? (g.n / total * 100) : 0;
      return w > 0 ? '<div class="ledger-seg ' + groupCls(g.key) + '" style="width:' + w + '%" title="' + esc(g.label) + ': ' + g.n + '"></div>' : '';
    }).join('');
    $('ledgerList').innerHTML = groups.map((g) =>
      '<div class="ledger-row"><span>' + esc(g.label) + '</span><span class="n">' + g.n + '</span></div>',
    ).join('') + '<div class="ledger-row total"><span>Total</span><span class="n">' + total + ' / 758</span></div>';
  }

  function renderIntegrity() {
    const labels = { rows: 'Rows recomputed', ranks: 'Ranks 1–N in order', values: 'Values never rise', watch: 'Watchlist', ledger: 'Ledger', checksum: 'Checksum (FNV-1a)' };
    const item = (label, ok, value) =>
      '<div class="integrity-item"><div class="label">' + label + '</div><div class="value"><span class="' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓ ' : '✗ ') + '</span>' + value + '</div></div>';
    if (!window.DERIVE || !window.SNAP) {
      $('integrityGrid').innerHTML = item('Re-derivation', false, 'snapshot.js missing — the page cannot recompute');
      return;
    }
    const P = window.DERIVE.runProofs(R, window.SNAP).proofs;
    $('integrityGrid').innerHTML = P.map((p) => item(labels[p.key], p.ok, p.text)).join('');
  }

  function renderEvidence() {
    $('evidenceBody').innerHTML = R.evidence.terms.map((t) => {
      const cls = t.verdict === 'kept' ? 'kept' : t.verdict === 'baseline' ? 'baseline' : '';
      const vCls = t.verdict === 'kept' ? 'v-kept' : 'v-not';
      const note = t.note ? '<span class="term-note">' + esc(t.note) + '</span>' : '';
      return '<tr class="' + cls + '"><td>' + esc(t.label) + note + '</td>' +
        '<td class="num">' + t.loo.toFixed(2) + '×</td>' +
        '<td class="num">' + t.wf.toFixed(2) + '×</td>' +
        '<td><span class="' + vCls + '">' + t.verdict + '</span></td></tr>';
    }).join('');
    $('oddsBody').innerHTML = R.odds.buckets.map((b) =>
      '<tr><td>' + esc(b.label) + '</td><td class="num">' + b.n + '</td><td class="num">' + fmtPct(b.share) + '</td></tr>',
    ).join('');
    $('oddsFootnote').textContent = 'Logistic regression, leave-one-out: Brier ' + R.odds.brier.toFixed(3) +
      ' vs base rate ' + R.odds.baseBrier.toFixed(3) + ' · ' + fmtPct(R.odds.shareRight) + ' of peers called right · ' +
      R.odds.labelled + ' of ' + R.odds.peers + ' peers have a token.';
  }

  function renderCalibration() {
    const S = window.SNAP;
    if (!S || !S.dec) return;
    const dec = S.dec.split(';').map((d) => {
      const p = d.split(',');
      return { pred: +p[0], actual: +p[1], n: +p[2] };
    });
    $('calibBody').innerHTML = dec.map((d, i) =>
      '<tr><td>' + (i + 1) + '</td><td class="num">' + fmtPct(d.pred, 1) + '</td><td class="num">' + fmtPct(d.actual, 1) + '</td><td class="num">' + d.n + '</td></tr>',
    ).join('');
    $('calibFootnote').textContent = 'Leave-one-out predicted odds (deciles of ' + R.odds.peers + ' peers) vs the share that actually recorded a token. Brier ' + R.odds.brier.toFixed(3) + ' vs base rate ' + R.odds.baseBrier.toFixed(3) + '. Precomputed by main.ts from the LOO refits — the browser renders, not refits, this table.';
  }

  function drawPeersChart() {
    const cv = $('peersChart');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, padL = 44, padB = 34, padT = 14, padR = 10;
    ctx.clearRect(0, 0, W, H);
    ctx.font = '11px system-ui, sans-serif';
    const buckets = R.odds.buckets;
    const bw = (W - padL - padR) / buckets.length;
    ctx.strokeStyle = '#e3dac8';
    ctx.fillStyle = '#6b6259';
    ctx.textAlign = 'right';
    for (const g of [0, 0.25, 0.5, 0.75, 1]) {
      const y = padT + (1 - g) * (H - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(Math.round(g * 100) + '%', padL - 6, y + 4);
    }
    ctx.textAlign = 'center';
    buckets.forEach((b, i) => {
      const x = padL + i * bw + bw * 0.15;
      const w = bw * 0.7;
      const h = b.share * (H - padT - padB);
      ctx.fillStyle = '#b7791f';
      ctx.fillRect(x, padT + (H - padT - padB) - h, w, h);
      ctx.fillStyle = '#1c1917';
      ctx.fillText(fmtPct(b.share), x + w / 2, padT + (H - padT - padB) - h - 5);
      ctx.fillStyle = '#6b6259';
      ctx.fillText(b.label, x + w / 2, H - 18);
      ctx.fillText('n=' + b.n, x + w / 2, H - 5);
    });
  }

  function renderPricing() {
    const f = R.fit, o = R.oos;
    $('curveText').innerHTML = 'log market cap = <strong>' + f.alpha.toFixed(3) + ' + ' + f.beta.toFixed(3) +
      ' &times; log TVL</strong> (R&sup2; ' + f.r2.toFixed(3) + ', ' + f.n + ' comps, ' + f.nDropped +
      ' dropped). Leave-one-out miss <strong>' + o.looTmf.toFixed(2) + '&times;</strong> vs a flat multiple of ' +
      o.looFlatTmf.toFixed(2) + '&times;; walk-forward <strong>' + o.timeTmf.toFixed(2) + '&times;</strong> vs ' +
      o.timeFlatTmf.toFixed(2) + '&times; (' + o.timeTrain + ' train / ' + o.timeTest + ' test).';
    const od = R.odds;
    $('oddsText').innerHTML = 'Logistic regression on <strong>' + od.peers + '</strong> peers (' + od.labelled +
      ' with a token). Leave-one-out Brier <strong>' + od.brier.toFixed(3) + '</strong> vs base rate ' +
      od.baseBrier.toFixed(3) + '; <strong>' + fmtPct(od.shareRight) + '</strong> of peers called right. ' +
      'Coefficients (intercept, age, TVL, growth): ' + od.coefficients.map((c) => c.toFixed(2)).join(', ') + '.';
    const rg = R.evidence.range;
    $('rangeText').innerHTML = 'Bands from the curve\'s leave-one-out residuals: half-width ' +
      rg.half50.toFixed(3) + ' dex (P25&ndash;P75) holds <strong>' + fmtPct(rg.cover50) + '</strong> of comps; ' +
      rg.half80.toFixed(3) + ' dex (P10&ndash;P90) holds <strong>' + fmtPct(rg.cover80) + '</strong>. ' +
      'A band is a statement about the model, not about the protocol.';
  }

  function drawScatter() {
    const cv = $('scatter');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, pad = 44;
    ctx.clearRect(0, 0, W, H);
    const xs = R.trades.map((t) => Math.log10(t.tvl));
    const ys = R.trades.map((t) => Math.log10(t.mcap));
    const x0 = Math.floor(Math.min(...xs)) - 0.2, x1 = Math.ceil(Math.max(...xs)) + 0.2;
    const y0 = Math.floor(Math.min(...ys)) - 0.2, y1 = Math.ceil(Math.max(...ys)) + 0.2;
    const X = (v) => pad + ((v - x0) / (x1 - x0)) * (W - pad * 2);
    const Y = (v) => H - pad - ((v - y0) / (y1 - y0)) * (H - pad * 2);
    ctx.strokeStyle = '#e3dac8';
    ctx.fillStyle = '#6b6259';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (let gx = Math.ceil(x0); gx <= x1; gx++) {
      ctx.beginPath(); ctx.moveTo(X(gx), pad); ctx.lineTo(X(gx), H - pad); ctx.stroke();
      ctx.fillText('10^' + gx, X(gx), H - pad + 16);
    }
    ctx.textAlign = 'right';
    for (let gy = Math.ceil(y0); gy <= y1; gy++) {
      ctx.beginPath(); ctx.moveTo(pad, Y(gy)); ctx.lineTo(W - pad, Y(gy)); ctx.stroke();
      ctx.fillText('10^' + gy, pad - 6, Y(gy) + 4);
    }
    ctx.fillStyle = '#1c1917';
    ctx.textAlign = 'center';
    ctx.fillText('TVL (log scale)', W / 2, H - 8);
    ctx.save();
    ctx.translate(14, H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Market cap (log scale)', 0, 0);
    ctx.restore();
    const f = R.fit;
    ctx.strokeStyle = '#b7791f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(X(x0), Y(f.alpha + f.beta * x0));
    ctx.lineTo(X(x1), Y(f.alpha + f.beta * x1));
    ctx.stroke();
    ctx.lineWidth = 1;
    for (const t of R.trades) {
      const px = X(Math.log10(t.tvl)), py = Y(Math.log10(t.mcap));
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      if (t.inFit) {
        ctx.fillStyle = '#1c1917';
        ctx.fill();
      } else {
        ctx.strokeStyle = '#b3261e';
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#1c1917';
    ctx.textAlign = 'left';
    ctx.fillText('● in the fit (' + R.fit.n + ')', pad + 8, pad + 4);
    ctx.fillStyle = '#b3261e';
    ctx.fillText('○ trimmed (' + R.fit.nDropped + ')', pad + 130, pad + 4);
    ctx.fillStyle = '#b7791f';
    ctx.fillText('— fitted curve', pad + 250, pad + 4);
  }

  function renderTrades() {
    $('tradesBody').innerHTML = R.trades.map((t) =>
      '<tr><td><strong>' + esc(t.name) + '</strong><div class="slug">' + esc(t.slug) + '</div></td>' +
      '<td>' + esc(t.category) + '</td>' +
      '<td class="num">' + fmtMoney(t.tvl) + '</td>' +
      '<td class="num">' + fmtMoney(t.mcap) + '</td>' +
      '<td class="num">' + t.multiple.toFixed(2) + '×</td>' +
      '<td>' + (t.inFit ? '<span class="pos">Yes</span>' : '<span class="neg">No — trimmed</span>') + '</td></tr>',
    ).join('');
    $('heatmapBody').innerHTML = R.heatmap.map((h) =>
      '<tr><td>' + esc(h.category) + '</td><td>' + esc(h.tier) + '</td>' +
      '<td class="num ' + (h.medianResidual >= 0 ? 'pos' : 'neg') + '">' + (h.medianResidual >= 0 ? '+' : '') + h.medianResidual.toFixed(2) + ' dex</td>' +
      '<td class="num">' + h.n + '</td></tr>',
    ).join('');
  }
  function renderSetAside() {
    $('setAsideBody').innerHTML = R.setAside.map((s) =>
      '<tr><td><strong>' + esc(s.name) + '</strong><div class="slug">' + esc(s.slug) + '</div></td><td>' + esc(s.reason) + '</td></tr>',
    ).join('');
  }

  function showDetail(slug) {
    const r = rows.find((x) => x.slug === slug);
    if (!r) return;
    const t = r.oddsTerms;
    const logit = t.intercept + t.age + t.tvl + t.growth + t.category;
    const stat = (label, value, sub) =>
      '<div class="detail-stat"><div class="label">' + label + '</div><div class="value">' + value + '</div><div class="sub2">' + (sub || '') + '</div></div>';
    $('detailBody').innerHTML =
      '<div class="detail-card">' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">' + esc(r.slug) + ' · ' + esc(r.category) + ' · rank ' + r.rank + ' of ' + rows.length +
      (r.watchlist ? ' · <span class="pill watch">WATCHLIST</span>' : '') +
      (r.sibling ? ' · <span class="pill sib">SIBLING — VALUE HALVED</span>' : '') + '</p>' +
      '<div class="detail-stats">' +
      stat('Implied value', fmtMoney(r.implied_value_usd), 'curve × odds') +
      stat('If it launches', fmtMoney(r.valueIfLaunches), 'size curve' + (r.sibling ? ', halved (sibling)' : '')) +
      stat('Token odds', fmtPct(r.odds), 'peers\' record, not a prediction') +
      stat('P10–P90 range', fmtMoney(r.bandLo) + '–' + fmtMoney(r.bandHi), 'from LOO residuals') +
      stat('TVL', fmtMoney(r.tvl), r.change7dPct === null ? '7d change n/a' : '7d ' + (r.change7dPct >= 0 ? '+' : '') + r.change7dPct.toFixed(1) + '%') +
      stat('Net at $1K', '<span class="' + (r.net1k >= 0 ? 'pos' : 'neg') + '">' + fmtMoney(r.net1k) + '</span>', 'slice ' + fmtMoney(r.slice1k) + ' − fees ' + fmtMoney(r.fees)) +
      stat('Per hour', r.perHour === null ? '—' : fmtMoney(r.perHour) + '/h', 'at a $10,000 ticket (net ' + fmtMoney(r.net10k) + '), ' + r.workMin + ' min of work') +
      stat('Deposit to farm', r.deposit25 === null ? '—' : fmtMoney(r.deposit25), r.deposit25 === null ? 'no ticket pays $25/hour' : 'minimum ticket paying $25/hour') +
      stat('Rank range', '#' + r.rankLo + '–#' + r.rankHi, 'top-20 rate ' + fmtPct(r.top20Rate) + ' over 200 refits') +
      '</div>' +
      '<h3>How the odds are built</h3>' +
      '<p>The logistic model reads four things about this protocol, plus a category offset. Each row is a logit contribution — they add to ' + logit.toFixed(2) + ', which the sigmoid turns into ' + fmtPct(r.odds) + '.</p>' +
      '<table class="odds-terms"><thead><tr><th>Term</th><th>Logit</th><th>What it says</th></tr></thead><tbody>' +
      '<tr><td>Intercept</td><td>' + t.intercept.toFixed(2) + '</td><td>base rate of the peers</td></tr>' +
      '<tr><td>Age listed</td><td>' + (t.age >= 0 ? '+' : '') + t.age.toFixed(2) + '</td><td>' + (r.ageDays === null ? 'undated — median peer age used' : r.ageDays + ' days listed') + '</td></tr>' +
      '<tr><td>TVL</td><td>' + (t.tvl >= 0 ? '+' : '') + t.tvl.toFixed(2) + '</td><td>' + fmtMoney(r.tvl) + ' locked</td></tr>' +
      '<tr><td>7-day growth</td><td>' + (t.growth >= 0 ? '+' : '') + t.growth.toFixed(2) + '</td><td>' + (r.change7dPct === null ? 'no 7-day change in the snapshot' : (r.change7dPct >= 0 ? '+' : '') + r.change7dPct.toFixed(1) + '% in 7 days') + '</td></tr>' +
      '<tr><td>Category (' + esc(r.category) + ')</td><td>' + (t.category >= 0 ? '+' : '') + t.category.toFixed(2) + '</td><td>shrunk offset from the peers in this category</td></tr>' +
      '</tbody></table>' +
      '<h3>Farm plan — ' + esc(r.farmChain) + ', ' + esc(r.play) + '</h3>' +
      '<p>Fees ' + fmtMoney(r.fees) + ' · work ' + r.workMin + ' minutes · hold ' + r.holdDays + ' days. ' +
      'Break-even ticket: ' + (r.paysFrom === null ? 'never at any ticket up to $1B' : fmtMoney(r.paysFrom)) + '.</p>' +
      '<ol class="steps">' + r.steps.map((s) =>
        '<li>' + esc(s.text) + '<div class="step-meta">cost ' + fmtMoney(s.cost) + ' · ' + s.minutes + ' min</div></li>',
      ).join('') + '</ol>' +
      '<h3>Sensitivity — net if TVL grows while you farm</h3>' +
      '<p>Dilution is the main risk: new deposits shrink your slice. Rows are TVL growth during the hold; columns are ticket size.</p>' +
      '<table class="sens-table"><thead><tr><th>TVL growth</th><th>$1,000</th><th>$10,000</th><th>$100,000</th></tr></thead><tbody>' +
      [0.05, 0.1, 0.2].map((d, i) =>
        '<tr><td>+' + Math.round(d * 100) + '%</td>' + r.sensitivity[i].map((v) =>
          '<td class="' + (v >= 0 ? 'pos' : 'neg') + '">' + fmtMoney(v) + '</td>',
        ).join('') + '</tr>',
      ).join('') + '</tbody></table>' +
      '<h3>Nearest traded peers</h3>' +
      '<p>Three traded tokens nearest in size and growth — what "like this one" actually traded at.</p>' +
      '<ul class="peers-list">' + r.peers.map((p) =>
        '<li><span><strong>' + esc(p.name) + '</strong> <span class="slug">' + esc(p.slug) + '</span></span><span>TVL ' + fmtMoney(p.tvl) + ' · mcap ' + fmtMoney(p.mcap) + '</span></li>',
      ).join('') + '</ul>' +
      '</div>';
    $('detail').classList.remove('hidden');
    window.location.hash = 'detail-' + slug;
  }
  function hideDetail() {
    $('detail').classList.add('hidden');
    if (window.location.hash.startsWith('#detail-')) history.replaceState(null, '', '#board');
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function exportCSV() {
    const header = 'rank,slug,name,category,implied_value_usd,value_if_launches,token_odds,band_lo,band_hi,tvl_usd,change_7d_pct,net_1k,deposit_25h,verdict,per_hour,rank_lo,rank_hi';
    const lines = filtered().map((r) => [
      r.rank, r.slug, '"' + r.name.replace(/"/g, '""') + '"', '"' + r.category.replace(/"/g, '""') + '"',
      r.implied_value_usd, Math.round(r.valueIfLaunches), r.odds.toFixed(4), r.bandLo, r.bandHi,
      r.tvl, r.change7dPct === null ? '' : r.change7dPct, r.net1k.toFixed(2),
      r.deposit25 === null ? '' : r.deposit25.toFixed(0), r.verdict,
      r.perHour === null ? '' : r.perHour.toFixed(2), r.rankLo, r.rankHi,
    ].join(','));
    download('token-radar.csv', header + '\n' + lines.join('\n'), 'text/csv');
  }
  function exportJSON() {
    download('token-radar.json', JSON.stringify({ generated: R.generated, rows: filtered() }, null, 2), 'application/json');
  }

  function show(tab) {
    $('detail').classList.add('hidden');
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + tab));
  }
  function init() {
    renderStats();
    renderBoard();
    renderLedger();
    renderIntegrity();
    renderEvidence();
    renderCalibration();
    renderPricing();
    drawPeersChart();
    drawScatter();
    renderTrades();
    renderSetAside();
    $('q').addEventListener('input', renderBoard);
    $('verdict').addEventListener('change', renderBoard);
    $('watchOnly').addEventListener('change', renderBoard);
    $('earlyOnly').addEventListener('change', renderBoard);
    $('csvBtn').addEventListener('click', exportCSV);
    $('jsonBtn').addEventListener('click', exportJSON);
    document.querySelectorAll('#boardTable th.sortable').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.dataset.sort;
        if (sortKey === k) sortDir = -sortDir;
        else { sortKey = k; sortDir = 1; }
        document.querySelectorAll('#boardTable th.sortable').forEach((t) => t.classList.remove('sorted-asc', 'sorted-desc'));
        th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
        renderBoard();
      });
    });
    $('boardBody').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-slug]');
      if (tr) showDetail(tr.dataset.slug);
    });
    $('detailClose').addEventListener('click', hideDetail);
    $('detail').addEventListener('click', (e) => { if (e.target === $('detail')) hideDetail(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideDetail(); });
    document.querySelectorAll('.tab').forEach((t) => {
      t.addEventListener('click', (e) => { e.preventDefault(); show(t.dataset.tab); history.replaceState(null, '', '#' + t.dataset.tab); });
    });
    window.addEventListener('hashchange', () => {
      const h = window.location.hash.slice(1);
      if (h.startsWith('detail-')) showDetail(h.slice(7));
      else if (['board', 'trades', 'setaside', 'method'].includes(h)) show(h);
    });
    const h0 = window.location.hash.slice(1);
    if (h0.startsWith('detail-')) showDetail(h0.slice(7));
    else if (['board', 'trades', 'setaside', 'method'].includes(h0)) show(h0);
  }
  init();
})();
