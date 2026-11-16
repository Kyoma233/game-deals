// 游戏打折监控 —— 纯静态前端, 数据来自 ./data/deals.json 与 ./data/history.json。
// 关注列表存在浏览器 localStorage, 不上传任何数据。
(function () {
  'use strict';

  var PAGE_SIZE = 60;
  var WATCH_KEY = 'game-deals-watchlist-v1';

  var SOURCE_NAMES = {
    steam: 'Steam 国区',
    cheapshark: 'CheapShark 8 店',
    sonkwo: '杉果',
    steampy: 'steamPY',
    heybox: '小黑盒',
    popularity: '热门榜',
  };

  var state = {
    deals: [],
    meta: null,
    history: {},
    groups: new Map(), // key -> deals[]
    stores: [], // {store, storeName, count}
    selectedStores: new Set(),
    currency: '',
    minDiscount: 0,
    query: '',
    sort: 'popularity',
    multiOnly: false,
    watchOnly: false,
    visible: PAGE_SIZE,
    watchlist: loadWatchlist(),
  };

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtPrice(currency, price) {
    if (price == null) return '—';
    var symbol = currency === 'USD' ? '$' : '¥';
    return symbol + Number(price).toFixed(2).replace(/\.00$/, '');
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function fmtEndTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var left = d - Date.now();
    var text = '截止 ' + d.toLocaleString('zh-CN', {
      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    if (left > 0) {
      var days = left / 86400000;
      text += days >= 1 ? '（还剩 ' + Math.ceil(days) + ' 天）' : '（今天截止）';
    } else {
      text += '（已过期）';
    }
    return text;
  }

  function loadWatchlist() {
    try {
      var raw = localStorage.getItem(WATCH_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function saveWatchlist() {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(state.watchlist)); } catch (e) {}
  }
  function isWatched(key) { return state.watchlist.some(function (w) { return w.key === key; }); }
  function watchEntry(key) {
    return state.watchlist.find(function (w) { return w.key === key; }) || null;
  }

  // 历史最低价: series[key].days -> {cny, usd}
  function historyLowest(key) {
    var series = state.history[key];
    if (!series || !series.days) return { cny: null, usd: null, days: 0 };
    var cny = null, usd = null, days = 0;
    Object.keys(series.days).forEach(function (d) {
      var e = series.days[d];
      if (!e) return;
      days++;
      if (e.cny != null) cny = cny == null ? e.cny : Math.min(cny, e.cny);
      if (e.usd != null) usd = usd == null ? e.usd : Math.min(usd, e.usd);
    });
    return { cny: cny, usd: usd, days: days };
  }

  // 当前各币种最低价
  function currentBest(key) {
    var group = state.groups.get(key) || [];
    var best = { CNY: null, USD: null };
    group.forEach(function (d) {
      var slot = best[d.currency];
      if (slot == null || d.price < slot.price) best[d.currency] = d;
    });
    return best;
  }

  function groupTitle(key) {
    var group = state.groups.get(key) || [];
    if (!group.length) return '';
    var steam = group.find(function (d) { return d.store === 'steam'; });
    var pick = steam || group[0];
    return pick.title;
  }

  // ------------------------- 数据加载 -------------------------

  async function loadData() {
    var res = await fetch('./data/deals.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var data = await res.json();
    if (!Array.isArray(data.deals)) throw new Error('bad schema');
    state.deals = data.deals;
    state.meta = data.meta || null;

    try {
      var hres = await fetch('./data/history.json', { cache: 'no-cache' });
      if (hres.ok) {
        var h = await hres.json();
        state.history = (h && h.series) || {};
      }
    } catch (e) { /* 历史文件缺失不影响主列表 */ }

    state.groups = new Map();
    state.deals.forEach(function (d) {
      if (!state.groups.has(d.key)) state.groups.set(d.key, []);
      state.groups.get(d.key).push(d);
    });

    var storeMap = new Map();
    state.deals.forEach(function (d) {
      var s = storeMap.get(d.store) || { store: d.store, storeName: d.storeName, count: 0 };
      s.count++;
      storeMap.set(d.store, s);
    });
    state.stores = Array.from(storeMap.values()).sort(function (a, b) { return b.count - a.count; });
  }

  // ------------------------- 筛选与排序 -------------------------

  function filteredDeals() {
    var q = state.query.trim().toLowerCase();
    var out = state.deals.filter(function (d) {
      if (state.selectedStores.size && !state.selectedStores.has(d.store)) return false;
      if (state.currency && d.currency !== state.currency) return false;
      if (d.discount < state.minDiscount) return false;
      if (q && d.title.toLowerCase().indexOf(q) < 0) return false;
      if (state.multiOnly && (state.groups.get(d.key) || []).length < 2) return false;
      if (state.watchOnly && !isWatched(d.key)) return false;
      return true;
    });
    var sorters = {
      popularity: function (a, b) {
        var ra = a.rank == null ? 1e9 : a.rank;
        var rb = b.rank == null ? 1e9 : b.rank;
        if (ra !== rb) return ra - rb;
        return b.discount - a.discount;
      },
      discount: function (a, b) { return b.discount - a.discount || a.price - b.price; },
      price: function (a, b) { return a.price - b.price || b.discount - a.discount; },
      savings: function (a, b) {
        return (b.original - b.price) - (a.original - a.price) || b.discount - a.discount;
      },
      deadline: function (a, b) {
        var ta = a.endTime ? Date.parse(a.endTime) : Infinity;
        var tb = b.endTime ? Date.parse(b.endTime) : Infinity;
        if (ta !== tb) return ta - tb;
        return b.discount - a.discount;
      },
    };
    out.sort(sorters[state.sort] || sorters.popularity);
    return out;
  }

  // ------------------------- 渲染 -------------------------

  function renderMeta() {
    var meta = state.meta;
    var gen = meta && meta.generatedAt ? fmtTime(meta.generatedAt) : '未知';
    $('meta-refresh').textContent = '最后刷新：' + gen + '（每 4 小时自动刷新）';
    $('meta-total').textContent = '共 ' + state.deals.length + ' 条折扣';

    var statusEl = $('source-status');
    statusEl.innerHTML = '';
    var failed = [];
    if (meta && meta.sources) {
      Object.keys(SOURCE_NAMES).forEach(function (key) {
        var s = meta.sources[key];
        if (!s) return;
        var chip = document.createElement('span');
        chip.className = 'status-chip' + (s.ok ? '' : ' failed');
        var label = SOURCE_NAMES[key] + ' ' + s.count + ' 条' + (s.ok ? ' ✓' : ' ⚠ 失败');
        if (!s.ok && s.fetchedAt) label += '（上次数据 ' + fmtTime(s.fetchedAt) + '）';
        chip.textContent = label;
        statusEl.appendChild(chip);
        if (!s.ok) failed.push(SOURCE_NAMES[key]);
      });
    }
    var banner = $('source-banner');
    if (failed.length) {
      banner.classList.remove('hidden');
      banner.textContent = '⚠ 本轮刷新中以下来源抓取失败，显示的是该来源上次成功抓到的数据：' + failed.join('、') + '。下一轮（4 小时后）会自动重试。';
    } else {
      banner.classList.add('hidden');
    }
  }

  function renderStoreChips() {
    var wrap = $('store-chips');
    wrap.innerHTML = '';
    var all = document.createElement('button');
    all.type = 'button';
    all.className = 'chip' + (state.selectedStores.size === 0 ? ' active' : '');
    all.textContent = '全部商店';
    all.addEventListener('click', function () {
      state.selectedStores.clear();
      state.visible = PAGE_SIZE;
      renderStoreChips();
      renderGrid();
    });
    wrap.appendChild(all);
    state.stores.forEach(function (s) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (state.selectedStores.has(s.store) ? ' active' : '');
      chip.textContent = s.storeName + ' ' + s.count;
      chip.addEventListener('click', function () {
        if (state.selectedStores.has(s.store)) state.selectedStores.delete(s.store);
        else state.selectedStores.add(s.store);
        state.visible = PAGE_SIZE;
        renderStoreChips();
        renderGrid();
      });
      wrap.appendChild(chip);
    });
  }

  function cardHtml(d) {
    var group = state.groups.get(d.key) || [];
    var siblings = group.length;
    var lowestLine = '';
    if (siblings > 1) {
      var best = currentBest(d.key);
      var parts = [];
      if (best.CNY) parts.push('最低 ' + fmtPrice('CNY', best.CNY.price) + '（' + esc(best.CNY.storeName) + '）');
      if (best.USD) parts.push('最低 ' + fmtPrice('USD', best.USD.price) + '（' + esc(best.USD.storeName) + '）');
      lowestLine = '<div class="muted">' + siblings + ' 家在售 · ' + parts.join(' · ') + '</div>';
    }
    var badges = '<span class="store-badge">' + esc(d.storeName) + '</span>';
    if (d.rank != null) {
      badges += '<span class="rank-badge">🔥 热门 #' + d.rank +
        (d.players != null ? ' · ' + Number(d.players).toLocaleString('en-US') + ' 在玩' : '') + '</span>';
    }
    if (d.isLowest) badges += '<span class="lowest-badge">史低</span>';
    var end = d.endTime ? '<div class="end-time">' + esc(fmtEndTime(d.endTime)) + '</div>' : '';
    var img = d.image
      ? '<img class="card-img" src="' + esc(d.image) + '" alt="" loading="lazy" onerror="this.classList.add(\'broken\')">'
      : '';
    var starred = isWatched(d.key);
    return '<article class="card" data-key="' + esc(d.key) + '">' +
      img +
      '<div class="card-body">' +
      '<div class="card-title"><a href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer">' + esc(d.title) + '</a></div>' +
      '<div class="badges">' + badges + '</div>' +
      '<div class="price-row"><span class="sale-price">' + fmtPrice(d.currency, d.price) + '</span>' +
      '<span class="orig-price">' + fmtPrice(d.currency, d.original) + '</span>' +
      '<span class="discount">-' + d.discount + '%</span></div>' +
      end + lowestLine +
      '<div class="card-actions">' +
      '<a class="btn" href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer">去商店</a>' +
      (siblings > 1 ? '<button type="button" class="btn compare-btn">比价 ' + siblings + ' 家</button>' : '') +
      '<button type="button" class="btn watch-btn' + (starred ? ' starred' : '') + '">' + (starred ? '★ 已关注' : '☆ 关注') + '</button>' +
      '</div>' +
      '<div class="compare-panel hidden"></div>' +
      '</div></article>';
  }

  function renderGrid() {
    var list = filteredDeals();
    $('result-count').textContent = '共 ' + list.length + ' 条';
    var grid = $('grid');
    var shown = list.slice(0, state.visible);
    grid.innerHTML = shown.map(cardHtml).join('');
    if (!list.length) {
      grid.innerHTML = '<p class="muted" style="grid-column:1/-1;text-align:center;padding:30px 0;">没有符合条件的折扣，试试放宽筛选条件。</p>';
    }
    var more = $('load-more');
    if (list.length > state.visible) {
      more.classList.remove('hidden');
      more.textContent = '加载更多（还剩 ' + (list.length - state.visible) + ' 条）';
    } else {
      more.classList.add('hidden');
    }

    grid.querySelectorAll('.watch-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('.card');
        toggleWatch(card.getAttribute('data-key'));
      });
    });
    grid.querySelectorAll('.compare-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var card = btn.closest('.card');
        var key = card.getAttribute('data-key');
        var panel = card.querySelector('.compare-panel');
        if (!panel.classList.contains('hidden')) {
          panel.classList.add('hidden');
          panel.innerHTML = '';
          return;
        }
        var rows = (state.groups.get(key) || []).slice().sort(function (a, b) {
          if (a.currency !== b.currency) return a.currency < b.currency ? -1 : 1;
          return a.price - b.price;
        });
        panel.innerHTML = rows.map(function (d) {
          return '<div class="compare-row"><span>' + esc(d.storeName) + '</span>' +
            '<span><a href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer">' +
            fmtPrice(d.currency, d.price) + ' · -' + d.discount + '%</a></span></div>';
        }).join('');
        panel.classList.remove('hidden');
      });
    });
  }

  // ------------------------- 关注列表 -------------------------

  function toggleWatch(key, title) {
    var idx = state.watchlist.findIndex(function (w) { return w.key === key; });
    if (idx >= 0) {
      state.watchlist.splice(idx, 1);
    } else {
      state.watchlist.push({
        key: key,
        title: title || groupTitle(key),
        targetPrice: null,
        targetCurrency: 'CNY',
        addedAt: new Date().toISOString(),
      });
    }
    saveWatchlist();
    renderWatchlist();
    renderGrid();
  }

  function renderWatchlist() {
    var section = $('watchlist');
    section.classList.remove('hidden');
    $('watch-count').textContent = state.watchlist.length ? '（' + state.watchlist.length + ' 款）' : '';
    var wrap = $('watch-items');
    if (!state.watchlist.length) {
      wrap.innerHTML = '<p class="muted">还没有关注的游戏。在卡片上点「☆ 关注」，或在上方搜索框里搜索后加入。</p>';
      return;
    }
    wrap.innerHTML = '';
    state.watchlist.forEach(function (w) {
      var best = currentBest(w.key);
      var low = historyLowest(w.key);
      var row = document.createElement('div');
      row.className = 'watch-item';
      var currentParts = [];
      if (best.CNY) currentParts.push('当前最低 ' + fmtPrice('CNY', best.CNY.price) + '（' + esc(best.CNY.storeName) + '）');
      if (best.USD) currentParts.push('当前最低 ' + fmtPrice('USD', best.USD.price) + '（' + esc(best.USD.storeName) + '）');
      var histParts = [];
      if (low.cny != null) histParts.push('历史最低 ' + fmtPrice('CNY', low.cny));
      if (low.usd != null) histParts.push('历史最低 ' + fmtPrice('USD', low.usd));
      var hit = false;
      if (w.targetPrice != null && w.targetPrice !== '') {
        var b = best[w.targetCurrency || 'CNY'];
        if (b && b.price <= Number(w.targetPrice)) hit = true;
      }
      row.innerHTML =
        '<span class="w-title">' + esc(w.title || groupTitle(w.key)) + '</span>' +
        '<span>' + (currentParts.join(' · ') || '本轮暂无在售折扣') + '</span>' +
        (histParts.length ? '<span class="muted">' + histParts.join(' · ') + '（' + low.days + ' 天记录）</span>' : '') +
        (hit ? '<span class="badge-hit">🎯 已达目标价</span>' : '') +
        '<span class="target">目标价 <input type="number" min="0" step="0.01" placeholder="价格" value="' +
        (w.targetPrice == null ? '' : esc(w.targetPrice)) + '">' +
        '<select><option value="CNY"' + ((w.targetCurrency || 'CNY') === 'CNY' ? ' selected' : '') + '>¥</option>' +
        '<option value="USD"' + (w.targetCurrency === 'USD' ? ' selected' : '') + '>$</option></select></span>' +
        '<button type="button" class="btn danger">取消关注</button>';
      var input = row.querySelector('input[type="number"]');
      input.addEventListener('change', function () {
        var v = input.value.trim();
        w.targetPrice = v === '' ? null : Number(v);
        saveWatchlist();
        renderWatchlist();
      });
      var sel = row.querySelector('select');
      sel.addEventListener('change', function () {
        w.targetCurrency = sel.value;
        saveWatchlist();
        renderWatchlist();
      });
      row.querySelector('.btn.danger').addEventListener('click', function () { toggleWatch(w.key); });
      wrap.appendChild(row);
    });
  }

  function renderWatchSearch(q) {
    var box = $('watch-search-results');
    q = (q || '').trim().toLowerCase();
    if (q.length < 2) { box.innerHTML = ''; return; }
    var seen = new Set();
    var rows = [];
    for (var i = 0; i < state.deals.length && rows.length < 8; i++) {
      var d = state.deals[i];
      if (seen.has(d.key)) continue;
      if (d.title.toLowerCase().indexOf(q) < 0) continue;
      seen.add(d.key);
      rows.push(d);
    }
    box.innerHTML = rows.map(function (d) {
      var best = currentBest(d.key);
      var price = best.CNY ? fmtPrice('CNY', best.CNY.price) : (best.USD ? fmtPrice('USD', best.USD.price) : '');
      return '<div class="watch-search-row"><span>' + esc(groupTitle(d.key)) +
        (price ? ' <span class="muted">' + price + ' 起</span>' : '') + '</span>' +
        '<button type="button" class="btn" data-add-key="' + esc(d.key) + '">' +
        (isWatched(d.key) ? '已关注' : '＋ 关注') + '</button></div>';
    }).join('');
    box.querySelectorAll('[data-add-key]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-add-key');
        if (!isWatched(key)) toggleWatch(key);
        renderWatchSearch($('watch-search').value);
      });
    });
  }

  // ------------------------- 启动 -------------------------

  function bindControls() {
    $('search').addEventListener('input', function (e) {
      state.query = e.target.value;
      state.visible = PAGE_SIZE;
      renderGrid();
    });
    $('sort').addEventListener('change', function (e) {
      state.sort = e.target.value;
      state.visible = PAGE_SIZE;
      renderGrid();
    });
    $('currency').addEventListener('change', function (e) {
      state.currency = e.target.value;
      state.visible = PAGE_SIZE;
      renderGrid();
    });
    $('min-discount').addEventListener('change', function (e) {
      state.minDiscount = Number(e.target.value);
      state.visible = PAGE_SIZE;
      renderGrid();
    });
    $('multi-only').addEventListener('change', function (e) {
      state.multiOnly = e.target.checked;
      state.visible = PAGE_SIZE;
      renderGrid();
    });
    $('watch-only').addEventListener('change', function (e) {
      state.watchOnly = e.target.checked;
      state.visible = PAGE_SIZE;
      renderGrid();
    });
    $('load-more').addEventListener('click', function () {
      state.visible += PAGE_SIZE;
      renderGrid();
    });
    $('watch-search').addEventListener('input', function (e) { renderWatchSearch(e.target.value); });
  }

  async function init() {
    try {
      await loadData();
    } catch (e) {
      $('empty-state').classList.remove('hidden');
      $('meta-refresh').textContent = '数据文件未找到（data/deals.json），定时刷新任务可能还未成功运行。';
      return;
    }
    $('controls').classList.remove('hidden');
    renderMeta();
    renderStoreChips();
    bindControls();
    renderWatchlist();
    renderGrid();
  }

  init();
})();
