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

  /* ---------- Watchlist (server-side; persists across deploys & devices) ----------
   * Sync API (has/list/toggle/remove/count) is backed by an in-memory cache that is loaded
   * from /api/watchlist once per page (await PH.watch.load()). Writes are optimistic + write-through. */
  const WKEY = 'ps_watch'; // legacy localStorage — migrated into the DB on first load
  PH.watch = {
    _items: [],
    _loaded: false,
    _loadPromise: null,
    load() {
      if (this._loadPromise) return this._loadPromise;
      const self = this;
      this._loadPromise = (async () => {
        try { const d = await PH.api('/api/watchlist'); self._items = Array.isArray(d.items) ? d.items : []; }
        catch (e) { self._items = []; }
        // one-time migration of any legacy localStorage items into the DB
        try {
          const legacy = JSON.parse(localStorage.getItem(WKEY) || '[]');
          if (Array.isArray(legacy) && legacy.length) {
            for (const it of legacy) {
              if (it && it.url && !self._items.some((i) => i.url === it.url)) {
                self._items.unshift(it);
                PH.api('/api/watchlist', { method: 'POST', body: { item: it, set: true } }).catch(() => {});
              }
            }
            localStorage.removeItem(WKEY);
          }
        } catch (e) {}
        self._loaded = true;
        PH.updateWatchCount();
        return self._items;
      })();
      return this._loadPromise;
    },
    list() { return this._items; },
    has(url) { return this._items.some((i) => i.url === url); },
    get(url) { return this._items.find((i) => i.url === url) || null; },
    toggle(item) {
      const had = this.has(item.url);
      if (had) this._items = this._items.filter((i) => i.url !== item.url);
      else this._items.unshift(Object.assign({ savedAt: Date.now() }, item));
      PH.api('/api/watchlist', { method: 'POST', body: { item: item, set: !had } }).catch(() => {});
      return this._items;
    },
    remove(url) {
      this._items = this._items.filter((i) => i.url !== url);
      PH.api('/api/watchlist', { method: 'DELETE', body: { url: url } }).catch(() => {});
    },
    count() { return this._items.length; }
  };

  PH.updateWatchCount = function () {
    const n = PH.watch.count();
    document.querySelectorAll('#navSaved, .watch-count').forEach((el) => { el.textContent = n ? String(n) : ''; });
  };

  /* ---------- Countries (source-country filter) ----------
   * Keep this list + ccTLDs in sync with /api/_geo.js. "Source country" = where the
   * part is sold from (seller's own domain), not where it ships to. None selected = all. */
  PH.COUNTRIES = [
    { code: 'gb', label: 'United Kingdom' },
    { code: 'ie', label: 'Ireland' },
    { code: 'in', label: 'India' },
    { code: 'jp', label: 'Japan' },
    { code: 'my', label: 'Malaysia' },
    { code: 'sg', label: 'Singapore' },
    { code: 'au', label: 'Australia' },
    { code: 'nz', label: 'New Zealand' }
  ];
  PH._ccTLDs = { gb: ['.co.uk', '.uk'], ie: ['.ie'], in: ['.in'], jp: ['.jp', '.co.jp'], my: ['.com.my', '.my'], sg: ['.com.sg', '.sg'], au: ['.com.au', '.au'], nz: ['.co.nz', '.nz'] };
  PH.countryLabel = (code) => { const c = PH.COUNTRIES.find((x) => x.code === code); return c ? c.label : code; };

  // Read filters into a clean array of codes (array shape + legacy string; [] = all).
  PH.normCountries = function (filters) {
    if (!filters) return [];
    let raw = (filters.countries != null) ? filters.countries : filters.country;
    if (typeof raw === 'string') raw = [raw];
    if (!Array.isArray(raw)) return [];
    const valid = PH.COUNTRIES.map((c) => c.code);
    const out = [];
    raw.forEach((v) => { v = String(v == null ? '' : v).toLowerCase().trim(); if (v && v !== 'all' && valid.indexOf(v) !== -1 && out.indexOf(v) === -1) out.push(v); });
    return out;
  };

  // Does a URL's host sit on one of the selected countries' domains? No codes => true.
  PH.hostInCountries = function (url, codes) {
    if (!codes || !codes.length) return true;
    let host = '';
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return false; }
    if (!host) return false;
    const tlds = [];
    codes.forEach((code) => (PH._ccTLDs[code] || []).forEach((t) => { if (tlds.indexOf(t) === -1) tlds.push(t); }));
    return tlds.some((t) => host.slice(-t.length) === t);
  };

  /* Tick-box dropdown for the search forms. `state` is a plain object code->bool
   * (mutated in place). Returns { refresh, selected }. onChange(codes[]) fires on toggle. */
  PH.countryPicker = function (container, state, onChange) {
    const el = (typeof container === 'string') ? document.getElementById(container) : container;
    if (!el) return null;
    const selected = () => PH.COUNTRIES.filter((c) => state[c.code]).map((c) => c.code);
    const summary = () => {
      const sel = PH.COUNTRIES.filter((c) => state[c.code]);
      if (!sel.length || sel.length === PH.COUNTRIES.length) return 'All countries';
      if (sel.length <= 2) return sel.map((c) => c.label).join(', ');
      return sel.length + ' countries selected';
    };
    el.style.position = 'relative';
    el.innerHTML =
      '<div class="cpk-btn" style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;box-sizing:border-box;padding:12px 14px;background:#0f1113;border:1px solid #2a2e34;border-radius:9px;color:#e9ebed;font-size:15px;cursor:pointer">' +
        '<span class="cpk-sum">' + PH.esc(summary()) + '</span><span style="color:#8b9096;font-size:11px">&#9662;</span></div>' +
      '<div class="cpk-menu" style="display:none;position:absolute;z-index:40;left:0;right:0;margin-top:6px;max-height:280px;overflow:auto;background:#14171a;border:1px solid #2a2e34;border-radius:10px;padding:6px;box-shadow:0 12px 34px rgba(0,0,0,.55)"></div>';
    const btn = el.querySelector('.cpk-btn'), menu = el.querySelector('.cpk-menu'), sum = el.querySelector('.cpk-sum');
    function drawMenu() {
      menu.innerHTML = PH.COUNTRIES.map((c) => {
        const on = !!state[c.code];
        const box = 'width:16px;height:16px;border-radius:4px;flex-shrink:0;border:1px solid ' + (on ? '#ff5a2c' : '#3a4046') + ';background:' + (on ? '#ff5a2c' : 'transparent') + ';display:flex;align-items:center;justify-content:center;color:#0d0e10;font-size:11px;font-weight:700';
        return '<div class="cpk-opt" data-k="' + c.code + '" style="display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:7px;cursor:pointer;font-size:14px;color:#e9ebed">' +
          '<span style="' + box + '">' + (on ? '&#10003;' : '') + '</span>' + PH.esc(c.label) + '</div>';
      }).join('');
      menu.querySelectorAll('.cpk-opt').forEach((o) => {
        o.addEventListener('click', (e) => { e.stopPropagation(); state[o.dataset.k] = !state[o.dataset.k]; drawMenu(); sum.textContent = summary(); if (onChange) onChange(selected()); });
        o.addEventListener('mouseenter', () => { o.style.background = '#1c2024'; });
        o.addEventListener('mouseleave', () => { o.style.background = 'transparent'; });
      });
    }
    const onDoc = () => close();
    function close() { menu.style.display = 'none'; document.removeEventListener('click', onDoc); }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.style.display === 'block') { close(); return; }
      drawMenu(); menu.style.display = 'block';
      setTimeout(() => document.addEventListener('click', onDoc), 0);
    });
    return { refresh: () => { sum.textContent = summary(); }, selected };
  };

  window.PH = PH;
  PH.watch.load(); // populate the nav count on every page
})();
