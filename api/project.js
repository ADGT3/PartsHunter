<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Parts Sniper — Project</title>
<link rel="icon" href="/assets/mark.png">
<link rel="stylesheet" href="/assets/app.css?v=20">
<script src="/assets/app.js?v=20" defer></script>
</head>
<body>
<header class="hero">
  <div class="wrap">
    <div class="hero-top">
      <a class="brand" href="/index.html">
        <img class="logo-full" src="/assets/logo.png" alt="Parts Sniper">
      </a>
      <button class="cart-btn" id="cartBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg> Cart <span class="cart-count">0</span></button>
    </div>
    <div class="crumb"><a href="/index.html">&#8592; All projects</a></div>
  </div>
</header>

<div class="wrap">
  <h1 class="page" id="pName">Loading…</h1>
  <div class="muted" id="pGoal"></div>

  <div class="toolbar">
    <button class="btn" id="runBtn">Re-run search now</button>
    <button class="btn grey" id="refineToggle" aria-expanded="false">⚙ Refine search</button>
    <span id="runMsg" class="muted"></span>
  </div>

  <div class="cfg" id="cfg" hidden>
    <h4>Categories</h4>
    <div class="hint">The section headings your results are grouped under (one per line). These only <b>organise</b> the page — they don't change what's searched.</div>
    <textarea id="cCats"></textarea>
    <h4>Search queries</h4>
    <div class="hint">The exact phrases searched on the web — this is what <b>finds</b> listings (one per line).</div>
    <textarea id="cQueries"></textarea>
    <h4>Rules</h4>
    <div class="hint">The filters the AI must obey when deciding what to <b>keep</b> (one per line).</div>
    <textarea id="cRules"></textarea>
    <div class="hint" style="margin-top:12px">In short: <b>queries find</b> → <b>rules filter</b> → <b>categories sort</b>.</div>
    <div class="row" style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <button class="btn grey" id="saveCfg">Save changes</button>
      <span class="muted" style="align-self:center">Also saved automatically when you re-run.</span>
    </div>
  </div>

  <div id="results"></div>
</div>

<script>
document.addEventListener('DOMContentLoaded', async function () {
  const id = PH.qs('id');
  if (!id) { document.getElementById('pName').textContent = 'Missing project id'; return; }
  PH.mountCart(id);
  document.getElementById('cartBtn').addEventListener('click', () => PH._openCart());
  PH.updateCartCount(id);

  const refineBtn = document.getElementById('refineToggle');
  const cfgPanel = document.getElementById('cfg');
  refineBtn.addEventListener('click', () => {
    const opening = cfgPanel.hasAttribute('hidden');
    if (opening) { cfgPanel.removeAttribute('hidden'); refineBtn.textContent = '⚙ Hide refine'; refineBtn.setAttribute('aria-expanded', 'true'); }
    else { cfgPanel.setAttribute('hidden', ''); refineBtn.textContent = '⚙ Refine search'; refineBtn.setAttribute('aria-expanded', 'false'); }
  });

  let state = { project: null, listings: [], feedback: {} };

  function fbMap(arr) { const m = {}; (arr || []).forEach((f) => (m[f.listing_url] = f.vote)); return m; }
  const linesToArr = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

  async function load() {
    try {
      const data = await PH.api('/api/project?id=' + encodeURIComponent(id));
      state.project = data.project;
      state.listings = data.listings || [];
      state.feedback = fbMap(data.feedback);
      render();
    } catch (e) {
      document.getElementById('results').innerHTML = '<div class="banner err">Could not load: ' + PH.esc(e.message) + '</div>';
    }
  }

  function render() {
    const p = state.project;
    document.getElementById('pName').textContent = p.name;
    document.getElementById('pGoal').textContent = p.goal;
    const cfg = p.config || {};
    document.getElementById('cCats').value = (cfg.categories || []).join('\n');
    document.getElementById('cQueries').value = (cfg.queries || []).join('\n');
    document.getElementById('cRules').value = (cfg.rules || []).join('\n');

    // Always show ALL sections that have listings (ignore empty config categories)
    const bySec = {};
    state.listings.forEach((l) => {
      const sec = l.section || 'Results';
      (bySec[sec] = bySec[sec] || []).push(l);
    });

    const sections = Object.keys(bySec).sort();

    const out = document.getElementById('results');
    if (!state.listings.length) {
      out.innerHTML = '<div class="banner">No listings yet. Hit <b>Re-run search now</b> to fetch some.</div>';
      return;
    }

    let html = '';
    sections.forEach((sec) => {
      const items = bySec[sec];
      html += '<div class="section-title">' + PH.esc(sec) + ' <span class="tag">' + items.length + '</span></div><div class="grid">';
      items.forEach((l) => { html += cardHtml(l); });
      html += '</div>';
    });
    out.innerHTML = html;
    wireCards();
  }

  function cardHtml(l) {
    const v = state.feedback[l.url] || 0;
    const inCart = PH.cart.has(id, l.url);
    const badges = (l.badges || []).map((b) => '<span class="badge">' + PH.esc(b) + '</span>').join('');
    const img = l.image ? '<img src="' + PH.esc(l.image) + '" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">' : '<span class="ph">no image</span>';
    
    const source = l.source || 'unknown';
    const sourceBadge = `<span class="source-badge ${source}">${source.toUpperCase()}</span>`;

    return '<div class="card" data-url="' + PH.esc(l.url) + '">' +
      '<div class="thumb' + (l.image ? '' : ' noimg') + '">' + img + sourceBadge +
        '<div class="vote"><button class="up' + (v > 0 ? ' active' : '') + '" title="Good match">👍</button>' +
        '<button class="down' + (v < 0 ? ' active' : '') + '" title="Poor match">👎</button></div></div>' +
      '<div class="body"><div class="ptitle">' + PH.esc(l.title) + '</div>' +
      '<div class="desc">' + PH.esc(l.description || '') + '</div>' +
      '<div class="badges">' + badges + '</div>' +
      '<div class="foot"><div><div class="price">' + PH.esc(PH.fmtPrice(l.price)) + '</div><div class="src">' + PH.esc(l.seller || '') + '</div></div>' +
      '<div class="foot-actions"><button class="cart-add' + (inCart ? ' in' : '') + '">' + (inCart ? '✓ In list' : 'Add') + '</button>' +
      '<a class="btn" href="' + PH.esc(l.url) + '" target="_blank" rel="noopener">View</a></div></div></div></div>';
  }

  function wireCards() {
    document.querySelectorAll('.card').forEach((card) => {
      const url = card.dataset.url;
      const l = state.listings.find((x) => x.url === url);
      if (!l) return;
      card.querySelector('.up').addEventListener('click', () => vote(l, state.feedback[url] > 0 ? 0 : 1));
      card.querySelector('.down').addEventListener('click', () => vote(l, state.feedback[url] < 0 ? 0 : -1));
      card.querySelector('.cart-add').addEventListener('click', (e) => {
        PH.cart.toggle(id, { url: l.url, title: l.title, price: l.price, seller: l.seller, image: l.image, section: l.section });
        const inCart = PH.cart.has(id, url);
        e.target.classList.toggle('in', inCart); e.target.textContent = inCart ? '✓ In list' : 'Add';
        PH.updateCartCount(id);
      });
    });
  }

  async function vote(l, value) {
    try {
      await PH.api('/api/feedback', { method: 'POST', body: { projectId: id, url: l.url, title: l.title, seller: l.seller, vote: value } });
      if (value === 0) delete state.feedback[l.url]; else state.feedback[l.url] = value;
      render();
      PH.toast(value === 0 ? 'Feedback cleared' : (value > 0 ? 'Marked good' : 'Marked poor'));
    } catch (e) { PH.toast('Vote failed: ' + e.message); }
  }

  document.getElementById('saveCfg').addEventListener('click', async () => {
    const config = {
      categories: linesToArr(document.getElementById('cCats').value),
      queries: linesToArr(document.getElementById('cQueries').value),
      rules: linesToArr(document.getElementById('cRules').value)
    };
    try {
      const { project } = await PH.api('/api/project?id=' + encodeURIComponent(id), { method: 'PATCH', body: { config } });
      state.project = project; PH.toast('Config saved');
    } catch (e) { PH.toast('Save failed: ' + e.message); }
  });

  document.getElementById('runBtn').addEventListener('click', async () => {
    const btn = document.getElementById('runBtn');
    const msg = document.getElementById('runMsg');
    btn.disabled = true;
    msg.innerHTML = '<span class="spinner"></span> Searching the web with AI… this can take a couple of minutes.';
    try {
      const config = {
        categories: linesToArr(document.getElementById('cCats').value),
        queries: linesToArr(document.getElementById('cQueries').value),
        rules: linesToArr(document.getElementById('cRules').value)
      };
      await PH.api('/api/project?id=' + encodeURIComponent(id), { method: 'PATCH', body: { config } });
      const r = await PH.api('/api/run', { method: 'POST', body: { projectId: id } });
      state.listings = r.listings || [];
      render();
      msg.textContent = 'Done — ' + r.count + ' listings.';
    } catch (e) {
      msg.innerHTML = '<span style="color:#f0a1a1">' + PH.esc(e.message) + '</span>';
    } finally { btn.disabled = false; }
  });

  load();
});
</script>
</body>
</html>
