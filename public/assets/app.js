/* Parts Sniper — shared frontend helpers, API client, and per-project cart. */
(function () {
  'use strict';
  const PH = {};

  /* ---------- helpers ---------- */
  PH.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  PH.qs = (k) => new URLSearchParams(location.search).get(k);
  PH.parsePrice = (s) => { if (!s) return null; const m = String(s).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/); return m ? parseFloat(m[1]) : null; };
  PH.money = (n) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  PH.toast = (msg) => {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(PH._tt); PH._tt = setTimeout(() => t.classList.remove('show'), 1800);
  };

  /* ---------- API ---------- */
  PH.api = async function (path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: { 'content-type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  };

  /* ---------- per-project cart (localStorage) ---------- */
  function cartKey(pid) { return 'ph_cart_' + pid; }
  PH.cart = {
    load(pid) { try { return JSON.parse(localStorage.getItem(cartKey(pid))) || []; } catch (e) { return []; } },
    save(pid, items) { localStorage.setItem(cartKey(pid), JSON.stringify(items)); },
    has(pid, url) { return this.load(pid).some((i) => i.url === url); },
    toggle(pid, item) {
      let items = this.load(pid);
      if (items.some((i) => i.url === item.url)) items = items.filter((i) => i.url !== item.url);
      else items.push(item);
      this.save(pid, items);
      return items;
    },
    remove(pid, url) { this.save(pid, this.load(pid).filter((i) => i.url !== url)); }
  };

  /* ---------- cart drawer (built on demand) ---------- */
  PH.mountCart = function (pid) {
    let overlay = document.createElement('div'); overlay.className = 'ph-overlay';
    let drawer = document.createElement('aside'); drawer.className = 'ph-drawer';
    drawer.innerHTML =
      '<div class="dh"><h2>&#128722; Shopping List</h2><button class="ph-close">&times;</button></div>' +
      '<div class="ph-items"></div>' +
      '<div class="ph-foot"><div class="ph-total"><span>Subtotal</span><span class="tv">$0</span></div>' +
      '<div class="ph-note"></div><div class="ph-actions"><button class="ph-copy">Copy list</button><button class="ph-clear">Clear</button></div></div>';
    document.body.appendChild(overlay); document.body.appendChild(drawer);
    const itemsEl = drawer.querySelector('.ph-items');
    const totalEl = drawer.querySelector('.tv');
    const noteEl = drawer.querySelector('.ph-note');
    const close = () => { overlay.classList.remove('open'); drawer.classList.remove('open'); };
    overlay.addEventListener('click', close);
    drawer.querySelector('.ph-close').addEventListener('click', close);
    drawer.querySelector('.ph-clear').addEventListener('click', () => { if (confirm('Clear the shopping list?')) { PH.cart.save(pid, []); render(); PH.updateCartCount(pid); } });
    drawer.querySelector('.ph-copy').addEventListener('click', copyList);
    itemsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.rm'); if (!b) return;
      PH.cart.remove(pid, b.dataset.url); render(); PH.updateCartCount(pid);
    });

    function render() {
      const items = PH.cart.load(pid);
      if (!items.length) { itemsEl.innerHTML = '<div class="ph-empty">Empty. Add parts with the &ldquo;Add&rdquo; button.</div>'; totalEl.textContent = '$0'; noteEl.textContent = ''; return; }
      const groups = {}; items.forEach((i) => (groups[i.seller] = groups[i.seller] || []).push(i));
      let html = '', total = 0, enq = 0;
      Object.keys(groups).forEach((seller) => {
        html += '<div class="ph-group">' + PH.esc(seller) + '</div>';
        groups[seller].forEach((i) => {
          const p = PH.parsePrice(i.price); if (p != null) total += p; else enq++;
          html += '<div class="ph-item">' + (i.image ? '<img src="' + PH.esc(i.image) + '" referrerpolicy="no-referrer" onerror="this.style.visibility=\'hidden\'">' : '<img style="visibility:hidden">') +
            '<div class="b"><div class="t">' + PH.esc(i.title) + '</div><div class="m">' + PH.esc(i.section || '') + '</div><div class="p">' + PH.esc(i.price || 'Enquire') + '</div>' +
            '<a href="' + PH.esc(i.url) + '" target="_blank" rel="noopener">View &rarr;</a><br><button class="rm" data-url="' + PH.esc(i.url) + '">Remove</button></div></div>';
        });
      });
      itemsEl.innerHTML = html; totalEl.textContent = PH.money(total);
      noteEl.textContent = (enq ? enq + ' price-on-enquiry item(s) excluded. ' : '') + 'Items ship from different sellers — no single checkout.';
    }
    function copyList() {
      const items = PH.cart.load(pid); if (!items.length) return;
      const groups = {}; items.forEach((i) => (groups[i.seller] = groups[i.seller] || []).push(i));
      const lines = ['PARTS SNIPER — shopping list', ''];
      Object.keys(groups).forEach((s) => { lines.push('== ' + s + ' =='); groups[s].forEach((i) => lines.push('- ' + i.title + '  [' + (i.price || 'Enquire') + ']  ' + i.url)); lines.push(''); });
      const text = lines.join('\n');
      (navigator.clipboard?.writeText(text) || Promise.reject()).then(() => PH.toast('Copied!'), () => PH.toast('Copy failed'));
    }
    PH._openCart = () => { render(); overlay.classList.add('open'); drawer.classList.add('open'); };
    render();
  };

  PH.updateCartCount = function (pid) {
    const n = PH.cart.load(pid).length;
    document.querySelectorAll('.cart-count').forEach((el) => (el.textContent = n));
  };

  window.PH = PH;
})();
