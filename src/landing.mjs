/**
 * The public face of the service.
 *
 * The root used to 302 to /catalog, which is application/json. That is fine for
 * an agent and useless to every crawler that builds a directory entry from a
 * page title and an icon: the GoPlausible facilitator renders a merchant with
 * no crawlable title as a truncated wallet address, which is what this service
 * looked like on the Global x402 Challenge leaderboard for a month.
 *
 * So the root answers HTML. TITLE is the string that becomes the public label.
 * Everything priced is read from the compiled catalog, never typed twice, and
 * the tape panel is queried live, so neither can drift from what is true.
 */

export const TITLE =
  'AgentFeed — forced-liquidation tape for AI agents, paid per call in USDC on Algorand';

export const DESCRIPTION =
  'Every forced liquidation across 700+ USDT perpetuals on Binance, Bybit and OKX, ' +
  'sold per call in USDC over x402 on Algorand mainnet. No API key, no account, no subscription. ' +
  'Every response says whether the number was measured, genuinely absent, or unmeasured, and unmeasured is never billed.';

/** 180x180 PNG. Inlined so the whole surface ships as one file. */
export const ICON_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAADBUlEQVR42u3cvU3DQBiAYceKFFFEWSMFomAAKqagZDBKpqBiAApEkU2idBRIFCgx/rlzfPc9b4lOEJlH350hzmq73TXSuVqXQHAIDsEhOHTN1rP9pM3mxuVO1el0LB4HEDNc2HxQ1kxUAyW5kjUTlGQ/kJKxzE3nypMDi8X6mDhCWjKMkPSTA4vqR0hLhhGSEgcZQXy0ZPCRBgcZoXy0ZPAxFQcZAX34l72m4TA2Yg6Plgw+bCtKva0YG5GHR0sGH7YV5blbERz2FDuLySHbirLgsKfYWUwO2VYEh7LjcOBw7DA5ZFsRHIJDcAgOwSE4BIfgEBwSHIJDcAgOwSE4BIfgEByCQ4JDcAgOwaErtHYJJvb18tC94Pb53eQgY/waOCLKKNoHHNlllOsDDsEhOASH4BAcgkNwCA7BITgkOASH4BAcgkNwCA7BITgUr/KeW6n4ORGTI6+MpuTnRODIK4OPiDgiPCcCh+AQHIJDcEhwCA7BITgEh+DQ4ov7UZMfT4/dC+5f30wOMsavgSOiDD4i4hj6+47sw4FUcMjdirsnk8PdExxkXNUHHO6e4BAcgkN13cp6xtXkGCmj8YxaTByecYUjze+bDwdSwSE4BIfgkOAQHIJDcAgOwSE4BIfgEByCQ4JDcAgOwSE4FBHH0EeVLq1P9X2GfsrFpfVLez2lTo7+17F7Zarv0//6dq9c2uspdVvpcx3nXNPnKvdZs7TXk7bVdrv786XN5sZ2G7PT6ehAKncrgkNwaAE4/pxKFPM0anKoq+wf+7Tf37nK+TocPp05tJgDqWOHA4fJoa7O/Pn8J39ENznaQasVR4ZtRe5WlByHnSXynvL/5OAjrAzbiqadOQyPmGOj7+TgI6AM24pS4DA8oo2NYZODj1AyBm8rfMSRMebMwUcQGSMPpHxEkDH+boWP6mU0U95D+vPzvO2jShaTJocRUr2MJsm7z42Q+likmRxGSK0ymrTPrfy+JlOkaBNZcFBSh4m8OM6+blCKADEfDoeSovMve8EhOASH5ugbGQkA/QAL/L0AAAAASUVORK5CYII=',
  'base64',
);

/**
 * One aggregate read, so the page can prove the tape is alive without giving
 * away liquidation_universe, which is the per-symbol breakdown and is priced.
 *
 * The store never throws; it returns { rows, failure }. A failure renders as
 * unmeasured rather than as zeros, because the same rule that governs a paid
 * response governs the shop window: a number we could not read is not a zero.
 */
const TAPE_SQL =
  'SELECT COUNT(*) AS n, COUNT(DISTINCT symbol) AS symbols, ' +
  'COUNT(DISTINCT exchange) AS venues, MAX(ts) AS latest, SUM(usd) AS usd ' +
  'FROM liquidations WHERE ts >= ?';

const CACHE_MS = 60_000;
let cache = { at: 0, value: null };

export function tapeSnapshot(store, { now = Date.now, ttl = CACHE_MS } = {}) {
  const t = now();
  if (cache.value && t - cache.at < ttl) return cache.value;

  let value;
  try {
    const { rows, failure } = store.query(TAPE_SQL, [t - 24 * 3600 * 1000]);
    const row = rows?.[0];
    value =
      failure || !row || row.n == null
        ? { status: 'unmeasured', detail: failure ?? 'the tape returned no aggregate row' }
        : {
            status: 'measured',
            events: Number(row.n),
            symbols: Number(row.symbols ?? 0),
            venues: Number(row.venues ?? 0),
            usd: Number(row.usd ?? 0),
            lagMinutes: row.latest ? Math.max(0, Math.round((t - Number(row.latest)) / 60000)) : null,
          };
  } catch (err) {
    value = { status: 'unmeasured', detail: err?.message ?? String(err) };
  }

  cache = { at: t, value };
  return value;
}

/** Test seam. The cache is process wide and would otherwise leak between cases. */
export function resetTapeCache() {
  cache = { at: 0, value: null };
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Display only. 0.2 on a public price list reads as unfinished; 0.20 does not. */
const usd = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : String(v ?? ''));

const compact = (n) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);

const money = (n) =>
  n >= 1_000_000_000
    ? '$' + (n / 1_000_000_000).toFixed(2) + 'B'
    : n >= 1_000_000
      ? '$' + (n / 1_000_000).toFixed(1) + 'M'
      : '$' + Math.round(n).toLocaleString('en-US');

function tapePanel(snap) {
  if (snap.status !== 'measured') {
    return `      <div class="panel">
        <div class="phead"><span class="dot u"></span> tape &#183; <b class="u">unmeasured</b></div>
        <p class="pnote">Our own read of the tape failed, so this panel shows nothing rather than zeros. A number we could not read is not a zero, and the paid routes apply the same rule: they answer 503 and are never billed.</p>
        <code class="pcode">${esc(snap.detail ?? '')}</code>
      </div>`;
  }
  const lag =
    snap.lagMinutes == null
      ? 'unknown'
      : snap.lagMinutes < 1
        ? 'seconds ago'
        : snap.lagMinutes + ' min ago';
  return `      <div class="panel">
        <div class="phead"><span class="dot m"></span> tape &#183; last 24 hours &#183; <b class="m">measured</b></div>
        <div class="pgrid">
          <div><b>${esc(compact(snap.events))}</b><small>liquidations recorded</small></div>
          <div><b>${esc(money(snap.usd))}</b><small>notional flushed</small></div>
          <div><b>${esc(String(snap.symbols))}</b><small>symbols with activity</small></div>
          <div><b>${esc(String(snap.venues))}</b><small>venues reporting</small></div>
        </div>
        <p class="pnote">Most recent liquidation written ${esc(lag)}. No exchange publishes this history, so it can only be recorded, never bought back.</p>
      </div>`;
}

export function landingHtml(cfg, compiled, { sweep, tape } = {}) {
  const snap = tape ?? { status: 'unmeasured', detail: 'no tape snapshot supplied' };

  const rows = compiled
    .map(
      (r) => `        <tr>
          <td class="p">${esc(r.path)}</td>
          <td class="d">${esc(r.description)}</td>
          <td class="q">${esc(r.query ?? '')}</td>
          <td class="c">$${esc(usd(r.price))}</td>
        </tr>`,
    )
    .join('\n');

  const cheapest = compiled.reduce((a, b) => (Number(a.price) <= Number(b.price) ? a : b));
  const sample = compiled.find((r) => r.input) ?? compiled[0];
  const qs = sample.input
    ? '?' + Object.entries(sample.input).map(([k, v]) => `${k}=${v}`).join('&')
    : '';
  const base = cfg.baseUrl ?? '';
  const curl = `curl -si '${base}${sample.path}${qs}'`;
  const payTo = cfg.payTo ?? '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<meta name="description" content="${esc(DESCRIPTION)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(TITLE)}">
<meta property="og:description" content="${esc(DESCRIPTION)}">
<meta property="og:site_name" content="AgentFeed on Algorand">
<meta property="og:url" content="${esc(base)}/">
<meta name="twitter:card" content="summary">
<link rel="icon" type="image/png" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="canonical" href="${esc(base)}/">
<style>
  :root{
    --bg:#0a0a0c; --panel:#131317; --panel2:#17171d; --line:#26262e; --line2:#33333e;
    --ink:#f4f2f0; --dim:#9b98a4; --faint:#6d6a76;
    --long:#e8b256; --short:#e26e5c; --live:#5fd39a; --alg:#9182ee;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:ui-sans-serif,-apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);
       -webkit-font-smoothing:antialiased;line-height:1.5;overflow-x:hidden}
  body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
    background:radial-gradient(1100px 520px at 8% -14%,rgba(232,178,86,.16),transparent 62%),
               radial-gradient(820px 460px at 96% -6%,rgba(145,130,238,.15),transparent 64%),
               radial-gradient(700px 500px at 60% 108%,rgba(226,110,92,.08),transparent 60%)}
  .wrap{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:26px 28px 76px}

  nav{display:flex;align-items:center;gap:26px;flex-wrap:wrap;
      padding-bottom:22px;border-bottom:1px solid var(--line)}
  .brand{font-weight:700;letter-spacing:-.022em;font-size:18px;margin-right:auto}
  .brand i{font-style:normal;color:var(--long)}
  .brand span{color:var(--faint);font-weight:500}
  nav a{color:var(--dim);text-decoration:none;font-size:13.5px;font-family:var(--mono)}
  nav a:hover{color:var(--ink)}
  .chip{font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase;
        color:var(--dim);border:1px solid var(--line2);border-radius:999px;padding:5px 12px;
        background:rgba(95,211,154,.05)}
  .chip b{color:var(--live);font-weight:600}

  .hero{display:grid;grid-template-columns:1.02fr .98fr;gap:52px;align-items:center;
        padding:56px 0 8px}
  .eyebrow{font-family:var(--mono);font-size:11.5px;letter-spacing:.16em;text-transform:uppercase;
           color:var(--long);margin:0 0 16px}
  h1{font-size:clamp(33px,4vw,50px);line-height:1.04;letter-spacing:-.036em;margin:0;font-weight:700}
  h1 span{background:linear-gradient(96deg,var(--long) 10%,var(--short) 90%);
          -webkit-background-clip:text;background-clip:text;color:transparent}
  .lede{color:var(--dim);margin:19px 0 0;font-size:16.5px;max-width:52ch}
  .cta{display:flex;gap:10px;flex-wrap:wrap;margin:28px 0 0}
  .btn{display:inline-flex;align-items:center;gap:8px;border-radius:10px;padding:11px 17px;
       font-size:14px;font-weight:600;text-decoration:none;border:1px solid var(--line2);
       color:var(--ink);background:var(--panel);cursor:pointer;font-family:inherit}
  .btn:hover{border-color:var(--faint)}
  .btn.hi{background:linear-gradient(96deg,var(--long),#e0975a);color:#17130b;border-color:transparent}

  .panel{background:linear-gradient(180deg,var(--panel2),var(--panel));
         border:1px solid var(--line2);border-radius:18px;padding:20px 22px 18px}
  .phead{font-family:var(--mono);font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;
         color:var(--dim);display:flex;align-items:center;gap:8px}
  .dot{width:7px;height:7px;border-radius:50%;display:inline-block}
  .dot.m{background:var(--live);box-shadow:0 0 0 3px rgba(95,211,154,.16)}
  .dot.u{background:var(--short);box-shadow:0 0 0 3px rgba(226,110,92,.16)}
  .m{color:var(--live)} .a{color:var(--long)} .u{color:var(--short)}
  .pgrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0 0}
  .pgrid div{border-left:2px solid var(--line2);padding-left:13px}
  .pgrid b{display:block;font-size:26px;letter-spacing:-.028em;line-height:1.15}
  .pgrid small{color:var(--faint);font-family:var(--mono);font-size:10.5px;
               text-transform:uppercase;letter-spacing:.06em}
  .pnote{color:var(--faint);font-size:12.5px;margin:18px 0 0;line-height:1.55}
  .pcode{display:block;font-family:var(--mono);font-size:11.5px;color:var(--short);
         margin-top:12px;word-break:break-word}

  .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line);
         border:1px solid var(--line);border-radius:14px;overflow:hidden;margin:46px 0 0}
  .stats div{background:var(--panel);padding:17px 18px}
  .stats b{display:block;font-size:23px;letter-spacing:-.025em}
  .stats small{color:var(--faint);font-family:var(--mono);font-size:10.5px;
               text-transform:uppercase;letter-spacing:.06em}

  h2{font-size:12px;font-family:var(--mono);text-transform:uppercase;letter-spacing:.14em;
     color:var(--long);margin:60px 0 15px;font-weight:600}
  table{width:100%;border-collapse:collapse;font-size:14px;
        border:1px solid var(--line);border-radius:14px;overflow:hidden}
  th{text-align:left;font-family:var(--mono);font-size:10.5px;text-transform:uppercase;
     letter-spacing:.08em;color:var(--faint);font-weight:500;padding:12px 15px;background:var(--panel)}
  th:last-child,td.c{text-align:right}
  td{padding:14px 15px;border-top:1px solid var(--line);vertical-align:top}
  tr:hover td{background:rgba(255,255,255,.014)}
  td.p{font-family:var(--mono);color:var(--long);white-space:nowrap}
  td.d{max-width:46ch}
  td.q{font-family:var(--mono);color:var(--faint);font-size:12px;white-space:nowrap}
  td.c{font-family:var(--mono);white-space:nowrap;color:var(--live)}
  .free{font-family:var(--mono);font-size:12.5px;color:var(--faint);margin-top:13px}
  .free a{color:var(--alg);text-decoration:none;border-bottom:1px solid rgba(145,130,238,.35)}

  .two{display:grid;grid-template-columns:1.25fr 1fr;gap:22px;align-items:start}
  .codebox{position:relative;background:var(--panel);border:1px solid var(--line2);
           border-radius:13px;padding:16px 17px}
  .codebox code{font-family:var(--mono);font-size:12.5px;color:var(--ink);
                display:block;overflow-x:auto;white-space:pre;padding-right:70px}
  .copy{position:absolute;top:11px;right:11px;font-family:var(--mono);font-size:10.5px;
        letter-spacing:.06em;text-transform:uppercase;color:var(--dim);background:var(--panel2);
        border:1px solid var(--line2);border-radius:7px;padding:6px 10px;cursor:pointer}
  .copy:hover{color:var(--ink);border-color:var(--faint)}
  .side{color:var(--dim);font-size:13.5px;margin:0}

  .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px 19px}
  .card h3{margin:0 0 8px;font-size:13.5px;letter-spacing:-.01em;font-family:var(--mono);
           text-transform:lowercase}
  .card p{margin:0;color:var(--dim);font-size:13.5px}

  footer{margin-top:64px;padding-top:26px;border-top:1px solid var(--line)}
  .fgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:26px}
  .fgrid h4{margin:0 0 11px;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;
            text-transform:uppercase;color:var(--faint);font-weight:500}
  .fgrid a,.fgrid span{display:block;color:var(--dim);text-decoration:none;font-size:13px;
                       margin-bottom:7px;word-break:break-word}
  .fgrid a:hover{color:var(--ink)}
  .fgrid code{font-family:var(--mono);font-size:11.5px;color:var(--faint)}
  .rule{margin-top:26px;padding-top:18px;border-top:1px solid var(--line);
        color:var(--faint);font-size:12px;font-family:var(--mono)}

  @media(max-width:900px){
    .hero{grid-template-columns:1fr;gap:34px;padding-top:38px}
    .stats{grid-template-columns:1fr 1fr}
    .two,.grid3{grid-template-columns:1fr}
    .wrap{padding:22px 20px 56px}
  }
</style>
</head>
<body>
<div class="wrap">

  <nav>
    <div class="brand">AgentFeed<i>.</i> <span>on Algorand</span></div>
    <a href="#sold">Routes</a>
    <a href="#call">Quick start</a>
    <a href="/catalog">Catalog</a>
    <a href="/.well-known/x402">Manifest</a>
    <a href="https://github.com/seekdaseek/agentfeed-algo">Source</a>
    <span class="chip"><b>&#9679;</b> mainnet &#183; usdc</span>
  </nav>

  <section class="hero">
    <div>
      <p class="eyebrow">pay-per-request market data</p>
      <h1>Every forced liquidation, <span>priced per call</span>.</h1>
      <p class="lede">${esc(DESCRIPTION)}</p>
      <div class="cta">
        <a class="btn hi" href="#call">Make a paid call</a>
        <a class="btn" href="/catalog">Read the catalog</a>
        <a class="btn" href="https://github.com/seekdaseek/agentfeed-algo">Source</a>
      </div>
    </div>
${tapePanel(snap)}
  </section>

  <div class="stats">
    <div><b>${compiled.length}</b><small>paid routes</small></div>
    <div><b>$${esc(usd(cheapest.price))}</b><small>cheapest call</small></div>
    <div><b>$${esc(usd(sweep))}</b><small>all ${compiled.length} routes together</small></div>
    <div><b>0</b><small>accounts to create</small></div>
  </div>

  <h2 id="sold">What is sold</h2>
  <table>
    <thead><tr><th>Route</th><th>What the payment unlocks</th><th>Query</th><th>USDC</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>
  <p class="free">Free, no payment: <a href="/catalog">/catalog</a> &#183; <a href="/health">/health</a> &#183; <a href="/.well-known/x402">/.well-known/x402</a></p>

  <h2 id="call">Quick start</h2>
  <div class="two">
    <div class="codebox">
      <button class="copy" id="cp" type="button">copy</button>
      <code id="cmd">${esc(curl)}</code>
    </div>
    <p class="side">A 402 comes back with the payment challenge in a base64 <code>PAYMENT-REQUIRED</code> header, not in the body, which is empty. Any x402 client on Algorand settles it. The facilitator sponsors the gas, so a caller spends USDC and nothing else.</p>
  </div>

  <h2>Every answer says what it is</h2>
  <div class="grid3">
    <div class="card"><h3 class="m">measured</h3><p>We asked and got an answer. Billed.</p></div>
    <div class="card"><h3 class="a">absent</h3><p>The market genuinely had none in the window. That is a finding, and it is billed.</p></div>
    <div class="card"><h3 class="u">unmeasured</h3><p>Our own lookup broke. Returns 503 and is <strong>never billed</strong>, because charging for a zero we invented would make every other number worthless.</p></div>
  </div>

  <footer>
    <div class="fgrid">
      <div>
        <h4>Endpoint</h4>
        <a href="/catalog">Catalog</a>
        <a href="/health">Health</a>
        <a href="/.well-known/x402">x402 manifest</a>
      </div>
      <div>
        <h4>Install</h4>
        <a href="https://www.npmjs.com/package/@seekdaseek/agentfeed-algo">npm package</a>
        <a href="https://github.com/seekdaseek/agentfeed-algo">Source, MIT</a>
        <span><code>io.github.seekdaseek/agentfeed-algo</code></span>
      </div>
      <div>
        <h4>Settlement</h4>
        <span>Algorand mainnet</span>
        <span>USDC, ASA ${esc(String(cfg.usdcAsaId ?? ''))}</span>
        <span><code>${esc(payTo.slice(0, 8))}&#8230;${esc(payTo.slice(-6))}</code></span>
      </div>
      <div>
        <h4>Built by</h4>
        <a href="https://ochinimus.app">ochinimus</a>
        <a href="https://x402.ochinimus.app">AgentFeed on Solana and Base</a>
        <a href="https://x.com/ochinimus">@ochinimus</a>
      </div>
    </div>
    <div class="rule">No API key. No account. No subscription. Unmeasured is never billed.</div>
  </footer>
</div>
<script>
  document.getElementById('cp').addEventListener('click', async function () {
    try {
      await navigator.clipboard.writeText(document.getElementById('cmd').textContent);
      this.textContent = 'copied';
      setTimeout(() => { this.textContent = 'copy'; }, 1400);
    } catch (e) {
      this.textContent = 'select it';
    }
  });
</script>
</body>
</html>
`;
}
