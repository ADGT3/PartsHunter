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

  window.PH = PH;
  PH.watch.load(); // populate the nav count on every page
})();
