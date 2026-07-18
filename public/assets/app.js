/* Parts Sniper — shared frontend helpers, API client, and cross-project watchlist. */
(function () {
  'use strict';
  const PH = {};

  /* ---------- helpers ---------- */
  PH.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  PH.qs = (k) => new URLSearchParams(location.search).get(k);
  PH.parsePrice = (s) => { if (s == null) return null; const m = String(s).replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/); return m ? parseFloat(m[1]) : null; };
  PH.money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  PH.fmtPrice = function (p) {
    if (p == null) return 'Enquire';
    const s = String(p).trim();
    if (!s) return 'Enquire';
    const cleaned = s.replace(/,/g, '');
    if (/^\d+(\.\d+)?$/.test(cleaned)) return '$' + parseFloat(cleaned).toLocaleString('en-US', { maximumFractionDigits: 0 });
    return s;
  };
  PH.ago = function (t) {
    if (!t) return '';
    const d = (Date.now() - new Date(t).getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return Math.max(1, Math.round(d / 60)) + 'm ago';
    if (d < 86400) return Math.round(d / 3600) + 'h ago';
    return Math.round(d / 86400) + 'd ago';
  };
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

  /* ---------- Watchlist (cross-project, localStorage) — replaces the old cart ---------- */
  const WKEY = 'ps_watch';
  PH.watch = {
    list() { try { return JSON.parse(localStorage.getItem(WKEY)) || []; } catch (e) { return []; } },
    save(items) { localStorage.setItem(WKEY, JSON.stringify(items)); },
    has(url) { return this.list().some((i) => i.url === url); },
    get(url) { return this.list().find((i) => i.url === url) || null; },
    toggle(item) {
      let items = this.list();
      if (items.some((i) => i.url === item.url)) items = items.filter((i) => i.url !== item.url);
      else items.unshift(Object.assign({ savedAt: Date.now() }, item));
      this.save(items);
      return items;
    },
    remove(url) { this.save(this.list().filter((i) => i.url !== url)); },
    count() { return this.list().length; }
  };

  PH.updateWatchCount = function () {
    const n = PH.watch.count();
    document.querySelectorAll('#navSaved, .watch-count').forEach((el) => { el.textContent = n ? String(n) : ''; });
  };

  window.PH = PH;
})();
