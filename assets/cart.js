/* Parts Hunter — per-project cart (browser localStorage).
   Scoped to this site, so it persists across the current week and every
   archived week automatically. Items are stored with a stable id so the
   same part added from different weekly reports won't duplicate. */
(function () {
  "use strict";
  var KEY = "partshunter_cart_v1";
  var WEEK = (document.body && document.body.dataset.week) || "";

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch (e) { return []; }
  }
  function save(items) { localStorage.setItem(KEY, JSON.stringify(items)); }
  function has(items, id) { return items.some(function (i) { return i.id === id; }); }

  function parsePrice(str) {
    if (!str) return null;
    var m = String(str).replace(/,/g, "").match(/([0-9]+(?:\.[0-9]+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  function money(n) {
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  /* ---------- drawer construction ---------- */
  var overlay, drawer, itemsEl, totalEl, noteEl, countEls;

  function buildDrawer() {
    overlay = document.createElement("div");
    overlay.className = "ph-overlay";
    drawer = document.createElement("aside");
    drawer.className = "ph-drawer";
    drawer.innerHTML =
      '<header><h2>&#128722; Shopping List</h2><button class="ph-close" aria-label="Close">&times;</button></header>' +
      '<div class="ph-items"></div>' +
      '<div class="ph-foot">' +
        '<div class="ph-total"><span>Subtotal</span><span class="ph-total-val">$0</span></div>' +
        '<div class="ph-note"></div>' +
        '<div class="ph-actions">' +
          '<button class="ph-copy">Copy list</button>' +
          '<button class="ph-clear">Clear</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.appendChild(drawer);
    itemsEl = drawer.querySelector(".ph-items");
    totalEl = drawer.querySelector(".ph-total-val");
    noteEl = drawer.querySelector(".ph-note");

    overlay.addEventListener("click", closeDrawer);
    drawer.querySelector(".ph-close").addEventListener("click", closeDrawer);
    drawer.querySelector(".ph-clear").addEventListener("click", function () {
      if (confirm("Remove all items from your shopping list?")) { save([]); refresh(); }
    });
    drawer.querySelector(".ph-copy").addEventListener("click", copyList);
    itemsEl.addEventListener("click", function (e) {
      var btn = e.target.closest(".it-remove");
      if (!btn) return;
      var items = load().filter(function (i) { return i.id !== btn.dataset.id; });
      save(items); refresh();
    });
  }

  function openDrawer() { renderDrawer(); overlay.classList.add("open"); drawer.classList.add("open"); }
  function closeDrawer() { overlay.classList.remove("open"); drawer.classList.remove("open"); }

  function renderDrawer() {
    var items = load();
    if (!items.length) {
      itemsEl.innerHTML = '<div class="ph-empty">Your shopping list is empty.<br>Add parts with the &ldquo;Add&rdquo; button on any listing.</div>';
      totalEl.textContent = "$0";
      noteEl.textContent = "";
      return;
    }
    // group by seller
    var groups = {};
    items.forEach(function (i) { (groups[i.seller] = groups[i.seller] || []).push(i); });
    var html = "", total = 0, enquire = 0;
    Object.keys(groups).forEach(function (seller) {
      html += '<div class="ph-group-h">' + esc(seller) + '</div>';
      groups[seller].forEach(function (i) {
        var p = parsePrice(i.price);
        if (p != null) total += p; else enquire++;
        html +=
          '<div class="ph-item">' +
            (i.image ? '<img src="' + esc(i.image) + '" alt="" referrerpolicy="no-referrer" onerror="this.style.visibility=\'hidden\'">' : '<img alt="" style="visibility:hidden">') +
            '<div class="it-body">' +
              '<div class="it-title">' + esc(i.title) + '</div>' +
              '<div class="it-meta">' + esc(i.section || "") + (i.week ? " &middot; " + esc(i.week) : "") + '</div>' +
              '<div class="it-price">' + esc(i.price || "Enquire") + '</div>' +
              '<a class="it-link" href="' + esc(i.url) + '" target="_blank" rel="noopener">View listing &rarr;</a><br>' +
              '<button class="it-remove" data-id="' + esc(i.id) + '">Remove</button>' +
            '</div>' +
          '</div>';
      });
    });
    itemsEl.innerHTML = html;
    totalEl.textContent = money(total);
    noteEl.textContent = enquire
      ? enquire + " item(s) are price-on-enquiry and not included in the subtotal. Items ship from different sellers — no single checkout."
      : "Items ship from different sellers — no single checkout.";
  }

  function copyList() {
    var items = load();
    if (!items.length) { return; }
    var groups = {};
    items.forEach(function (i) { (groups[i.seller] = groups[i.seller] || []).push(i); });
    var lines = ["PARTS HUNTER — Shopping list", ""];
    Object.keys(groups).forEach(function (seller) {
      lines.push("== " + seller + " ==");
      groups[seller].forEach(function (i) {
        lines.push("- " + i.title + "  [" + (i.price || "Enquire") + "]  " + i.url);
      });
      lines.push("");
    });
    var text = lines.join("\n");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { flash("Copied!"); }, function () { fallbackCopy(text); });
    } else { fallbackCopy(text); }
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
    ta.select(); try { document.execCommand("copy"); flash("Copied!"); } catch (e) {} document.body.removeChild(ta);
  }
  function flash(msg) {
    var b = drawer.querySelector(".ph-copy"); var t = b.textContent; b.textContent = msg;
    setTimeout(function () { b.textContent = t; }, 1200);
  }

  /* ---------- add buttons + counts ---------- */
  function refresh() {
    var items = load();
    var ids = {};
    items.forEach(function (i) { ids[i.id] = true; });
    document.querySelectorAll(".cart-add").forEach(function (btn) {
      var inCart = !!ids[btn.dataset.id];
      btn.classList.toggle("in-cart", inCart);
      btn.textContent = inCart ? "✓ In list" : "Add";
    });
    (countEls || []).forEach(function (el) { el.textContent = items.length; });
    if (drawer && drawer.classList.contains("open")) renderDrawer();
  }

  function wireAddButtons() {
    document.querySelectorAll(".cart-add").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var items = load();
        var id = btn.dataset.id;
        if (has(items, id)) {
          items = items.filter(function (i) { return i.id !== id; });
        } else {
          items.push({
            id: id,
            title: btn.dataset.title || "",
            price: btn.dataset.price || "",
            seller: btn.dataset.seller || "Other",
            url: btn.dataset.url || "#",
            image: btn.dataset.img || "",
            section: btn.dataset.section || "",
            week: WEEK,
            addedAt: Date.now()
          });
        }
        save(items); refresh();
      });
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    buildDrawer();
    countEls = Array.prototype.slice.call(document.querySelectorAll(".cart-count"));
    var openBtn = document.getElementById("phCartBtn");
    if (openBtn) openBtn.addEventListener("click", openDrawer);
    wireAddButtons();
    refresh();
    // keep multiple tabs in sync
    window.addEventListener("storage", function (e) { if (e.key === KEY) refresh(); });
  });
})();
