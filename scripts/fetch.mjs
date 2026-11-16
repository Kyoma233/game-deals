// 游戏打折监控 —— 数据抓取脚本 (Node 20+, 零外部依赖).
// 每 4 小时由 GitHub Actions 运行一次, 汇总 5 个来源的折扣数据,
// 写入 data/deals.json, 并把每日最低价快照追加到 data/history.json。
//
// 来源:
//   1. Steam 国区官方接口 (featuredcategories, CNY, 含截止时间)
//   2. CheapShark 公开 API (8 家海外正版店, USD)
//   3. 杉果首页内嵌 SSR 数据 (window.__REDUX_STATE__, CNY)
//   4. steamPY 官方插件公开报价接口 (plugIn/getGame, CNY; 需先取 Steam 包 ID)
//   5. 小黑盒商城列表 (Web 签名, 无登录, CNY; 见 heybox-signer.mjs)
// 热门度: Steam 官方当前在线人数 Top 100。
//
// 失败处理: 单个来源失败时保留该来源的上轮数据, 并在 meta.sources 中
// 记录失败状态, 页面会显示横幅, 绝不静默失败, 也绝不编造数据补位。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signWebRequest, cleanPath } from './heybox-signer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(ROOT, 'data');
const DEALS_PATH = join(DATA_DIR, 'deals.json');
const HISTORY_PATH = join(DATA_DIR, 'history.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const todayKey = () => new Date().toISOString().slice(0, 10);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

async function fetchText(url, { headers = {}, timeout = 30000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function fetchJson(url, opts) {
  return JSON.parse(await fetchText(url, opts));
}

// ---------------------------------------------------------------------------
// 分组 key: 有 appid 用 appid, 否则用归一化标题。跨店比价靠它聚合。
// ---------------------------------------------------------------------------
function groupKey(appid, title) {
  if (appid) return `app:${appid}`;
  const norm = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  return `t:${norm || 'unknown'}`;
}

function makeDeal({ appid, title, store, storeName, currency, original, price, url, image = null, endTime = null, isLowest = false }) {
  const discount =
    original && original > 0 && price < original
      ? Math.round((1 - price / original) * 100)
      : 0;
  return {
    key: groupKey(appid, title),
    appid: appid || null,
    title,
    store,
    storeName,
    currency,
    original: round2(original),
    price: round2(price),
    discount,
    url,
    image,
    endTime,
    isLowest: Boolean(isLowest),
    rank: null,
    players: null,
  };
}

// ---------------------------------------------------------------------------
// 1. Steam 国区
// ---------------------------------------------------------------------------
async function fetchSteam() {
  const data = await fetchJson(
    'https://store.steampowered.com/api/featuredcategories?cc=CN&l=schinese',
    { headers: { Accept: 'application/json' } },
  );
  const byId = new Map();
  for (const section of Object.values(data)) {
    if (!section || !Array.isArray(section.items)) continue;
    for (const item of section.items) {
      if (!item.discounted || !item.id || byId.has(item.id)) continue;
      const original = item.original_price / 100;
      const price = item.final_price / 100;
      if (!(original > 0) || !(price >= 0) || price >= original) continue;
      const isPackage = item.type !== 0;
      byId.set(
        item.id,
        makeDeal({
          appid: isPackage ? null : item.id,
          title: item.name,
          store: 'steam',
          storeName: 'Steam 国区',
          currency: 'CNY',
          original,
          price,
          url: isPackage
            ? `https://store.steampowered.com/sub/${item.id}/`
            : `https://store.steampowered.com/app/${item.id}/`,
          image: item.header_image || item.large_capsule_image || null,
          endTime: item.discount_expiration
            ? new Date(item.discount_expiration * 1000).toISOString()
            : null,
        }),
      );
    }
  }
  return [...byId.values()];
}

// Steam appdetails 批量查价 (给 steamPY 候选游戏用; 只取价格, 名字从商店页提取)
async function fetchSteamPrices(appids) {
  const out = new Map();
  const qs = appids.join(',');
  const data = await fetchJson(
    `https://store.steampowered.com/api/appdetails?appids=${qs}&cc=CN&filters=price_overview`,
    { headers: { Accept: 'application/json' } },
  );
  for (const [id, entry] of Object.entries(data)) {
    if (!entry?.success || !entry.data?.price_overview) continue;
    const po = entry.data.price_overview;
    out.set(Number(id), {
      original: po.initial / 100,
      final: po.final / 100,
      discount: po.discount_percent,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 热门度: Steam 官方当前在线 Top 100
// ---------------------------------------------------------------------------
async function fetchPopularity() {
  const data = await fetchJson(
    'https://api.steampowered.com/ISteamChartsService/GetGamesByConcurrentPlayers/v1/',
    { headers: { Accept: 'application/json' } },
  );
  const ranks = data?.response?.ranks;
  if (!Array.isArray(ranks) || !ranks.length) throw new Error('empty ranks');
  return new Map(ranks.map((r) => [r.appid, { rank: r.rank, players: r.concurrent_in_game }]));
}

// ---------------------------------------------------------------------------
// 2. CheapShark (8 家海外店)
// ---------------------------------------------------------------------------
const CHEAPSHARK_STORES = [
  { id: 1, store: 'steam-us', name: 'Steam（美区）' },
  { id: 7, store: 'gog', name: 'GOG' },
  { id: 11, store: 'humble', name: 'Humble Bundle' },
  { id: 15, store: 'fanatical', name: 'Fanatical' },
  { id: 3, store: 'gmg', name: 'GreenManGaming' },
  { id: 25, store: 'epic', name: 'Epic' },
  { id: 27, store: 'gamesplanet', name: 'Gamesplanet' },
  { id: 30, store: 'indiegala', name: 'IndieGala' },
];

async function fetchCheapShark() {
  const deals = [];
  for (const s of CHEAPSHARK_STORES) {
    const list = await fetchJson(
      `https://www.cheapshark.com/api/1.0/deals?storeID=${s.id}&pageSize=60&pageNumber=0&sortBy=DealRating&onSale=1`,
      { headers: { Accept: 'application/json' } },
    );
    for (const d of list) {
      const normal = Number(d.normalPrice);
      const sale = Number(d.salePrice);
      if (!(normal > 0) || !(sale >= 0) || sale >= normal) continue;
      const appid = d.steamAppID ? Number(d.steamAppID) : null;
      deals.push(
        makeDeal({
          appid,
          title: d.title,
          store: s.store,
          storeName: s.name,
          currency: 'USD',
          original: normal,
          price: sale,
          url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`,
          image: d.thumb || null,
        }),
      );
    }
    await sleep(500);
  }
  return deals;
}

// ---------------------------------------------------------------------------
// 3. 杉果: 首页内嵌 window.__REDUX_STATE__ 中的 skus 数组
// ---------------------------------------------------------------------------
function extractReduxState(html) {
  const marker = 'window.__REDUX_STATE__';
  const i = html.indexOf(marker);
  if (i < 0) throw new Error('REDUX state not found');
  const end = html.indexOf('</script>', i);
  const block = html.slice(i, end < 0 ? undefined : end);
  const start = block.indexOf('{');
  let depth = 0;
  let inStr = false;
  let esc = false;
  let endIdx = -1;
  for (let j = start; j < block.length; j++) {
    const c = block[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else {
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          endIdx = j;
          break;
        }
      }
    }
  }
  if (endIdx < 0) throw new Error('REDUX JSON unbalanced');
  return JSON.parse(block.slice(start, endIdx + 1));
}

function collectSkus(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) collectSkus(v, out);
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'skus' && Array.isArray(v)) {
      for (const s of v) out.push(s);
    } else {
      collectSkus(v, out);
    }
  }
}

async function fetchSonkwo() {
  const html = await fetchText('https://www.sonkwo.cn/', {
    headers: { Accept: 'text/html,application/xhtml+xml' },
  });
  const state = extractReduxState(html);
  const skus = [];
  collectSkus(state?.customJavaReducer?.layouts, skus);
  if (!skus.length) throw new Error('no skus in page data');
  const seen = new Set();
  const deals = [];
  for (const s of skus) {
    if (!s || seen.has(s.id) || s.status !== 'sale') continue;
    seen.add(s.id);
    const original = Number(s.listPrice);
    const price = s.discount > 0 && s.discountPrice != null ? Number(s.discountPrice) : Number(s.salePrice);
    if (!(original > 0) || !(price >= 0) || price >= original) continue;
    deals.push(
      makeDeal({
        appid: null,
        title: s.skuNames?.chs || s.skuNames?.default || s.aliasName || `杉果商品 ${s.id}`,
        store: 'sonkwo',
        storeName: '杉果',
        currency: 'CNY',
        original,
        price,
        url: `https://www.sonkwo.hk/sku/${s.id}`,
        image: s.skuCovers?.chs || s.skuCovers?.default || null,
      }),
    );
  }
  return deals;
}

// ---------------------------------------------------------------------------
// 4. steamPY: 官方插件公开报价接口 getGame (无登录)
//    需要 Steam 包 ID (subId): 从各游戏的 Steam 商店页提取。
// ---------------------------------------------------------------------------
async function fetchSteamSubId(appid) {
  const html = await fetchText(`https://store.steampowered.com/app/${appid}/?cc=CN&l=schinese`, {
    headers: {
      Accept: 'text/html',
      Cookie: 'birthtime=631152001; mature_content=1; lastagecheckage=1-January-1990',
    },
    timeout: 45000,
    retries: 0,
  });
  const m = html.match(/name="subid" value="(\d+)"/);
  const nameMatch =
    html.match(/id="appHubAppName"[^>]*>([^<]+)</) ||
    html.match(/<title>([^<]+?)\s+on Steam<\/title>/);
  const name = nameMatch ? nameMatch[1].trim() : null;
  return { subId: m ? m[1] : null, name };
}

async function fetchSteampyQuote(appid, subId) {
  const data = await fetchJson(
    `https://steampy.com/xboot/common/plugIn/getGame?subId=${subId}&appId=${appid}&type=subid`,
    { headers: { Accept: 'application/json', Referer: 'https://store.steampowered.com/' }, retries: 0 },
  );
  if (data?.code !== 200 || !data.result) return null;
  return data.result; // { keyPrice, marketPrice, daiPrice, id }
}

async function fetchSteampy(steamDeals, popularity) {
  // 候选: 本轮 Steam 折扣游戏 + 在线人数前 20 (补 CDK 比 Steam 原价便宜的情况)
  const candidates = new Map(); // appid -> { name, original, final }
  for (const d of steamDeals) {
    if (d.appid) candidates.set(d.appid, { name: d.title, original: d.original, final: d.price });
  }
  const topAppids = [...(popularity?.keys?.() || [])]
    .sort((a, b) => (popularity.get(a)?.rank ?? 999) - (popularity.get(b)?.rank ?? 999))
    .slice(0, 20)
    .filter((id) => !candidates.has(id));
  if (topAppids.length) {
    try {
      const prices = await fetchSteamPrices(topAppids);
      for (const [id, p] of prices) {
        candidates.set(id, { name: null, original: p.original, final: p.final });
      }
    } catch (err) {
      console.warn('steampy: appdetails batch failed:', err.message);
    }
  }
  const ids = [...candidates.keys()].slice(0, 60);
  const deals = [];
  let pageFailures = 0;
  let quoteCalls = 0;
  for (const appid of ids) {
    const cand = candidates.get(appid);
    let subId = null;
    try {
      const page = await fetchSteamSubId(appid);
      subId = page.subId;
      if (!cand.name && page.name) cand.name = page.name;
    } catch (err) {
      pageFailures++;
    }
    await sleep(600);
    if (!subId) continue;
    let quote = null;
    try {
      quote = await fetchSteampyQuote(appid, subId);
      quoteCalls++;
    } catch (err) {
      // 单个报价失败不影响整体
    }
    await sleep(400);
    if (!quote) continue;
    const keyPrice = Number(quote.keyPrice);
    const marketPrice = Number(quote.marketPrice);
    // 剔除 0.1 元/1 元抽奖式挂牌: CDK 报价需达到同条目市场价的 20%
    // 才视为可购买价格 (实测正常报价为市场价的 35%~93%, 抽奖挂牌低于 5%)
    if (marketPrice > 0 && keyPrice < marketPrice * 0.2) continue;
    // 只有 CDK 报价比当前 Steam 售价便宜时才算一条 deal
    if (!(keyPrice > 0) || keyPrice >= cand.final) continue;
    deals.push(
      makeDeal({
        appid,
        title: cand.name || `Steam 游戏 ${appid}`,
        store: 'steampy',
        storeName: 'steamPY',
        currency: 'CNY',
        original: cand.original,
        price: keyPrice,
        url: 'https://steampy.com/',
        image: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
      }),
    );
  }
  // 商店页大面积失败时视为来源失败, 保留上轮数据
  if (ids.length > 0 && pageFailures / ids.length > 0.5 && quoteCalls === 0) {
    throw new Error(`steam store pages failed (${pageFailures}/${ids.length})`);
  }
  return deals;
}

// ---------------------------------------------------------------------------
// 5. 小黑盒商城列表 (Web 签名, 无登录)
//    卡片价 = 商城列表价 (final_price); 需登录领取的优惠券价不计入。
// ---------------------------------------------------------------------------
const HEYBOX_API = 'https://api.xiaoheihe.cn';
const HEYBOX_UA = UA;

async function heyboxGet(path, params = {}) {
  const clean = cleanPath(path);
  const q = new URLSearchParams({
    os_type: 'web',
    app: 'heybox',
    x_client_type: 'weboutapp',
    x_client_version: '',
    x_os_type: 'Windows',
    x_app: 'heybox',
    heybox_id: '0',
    ...signWebRequest(clean),
  });
  for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  const res = await fetch(`${HEYBOX_API}${clean}?${q}`, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://www.xiaoheihe.cn/',
      Origin: 'https://www.xiaoheihe.cn',
      'User-Agent': HEYBOX_UA,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`HeyBox HTTP ${res.status}`);
  const data = await res.json();
  if (data.status === 'show_captcha') throw new Error('HeyBox captcha triggered');
  if (data.status === 'login') throw new Error('HeyBox requires login');
  if (data.status !== 'ok' && data.status !== 'success') {
    throw new Error(`HeyBox status=${data.status} msg=${data.msg || ''}`);
  }
  return data.result;
}

async function fetchHeybox() {
  const deals = [];
  const seen = new Set();
  for (let page = 0; page < 4; page++) {
    const result = await heyboxGet('/mall/list', {
      offset: page * 100,
      limit: 100,
      sort_type: 'discount_asc',
    });
    const items = result?.items;
    if (!Array.isArray(items) || !items.length) break;
    for (const it of items) {
      if (!it || seen.has(it.sku_id)) continue;
      seen.add(it.sku_id);
      const appid = it.game_info?.appid ? Number(it.game_info.appid) : null;
      if (!appid) continue;
      const p = it.price;
      if (!p) continue;
      const original = p.initial_price / 1000;
      const price = p.final_price / 1000;
      if (!(original > 0) || !(price >= 0) || price >= original) continue;
      deals.push(
        makeDeal({
          appid,
          title: it.name,
          store: 'heybox',
          storeName: '小黑盒',
          currency: 'CNY',
          original,
          price,
          url: `https://www.xiaoheihe.cn/app/topic/game/pc/${appid}`,
          image: it.head_img || it.head_image || null,
          isLowest: p.is_lowest === 1 || p.new_lowest === true,
        }),
      );
    }
    if (page < 3) await sleep(1200);
  }
  if (!deals.length) throw new Error('HeyBox mall list returned no discounted games');
  return deals;
}

// ---------------------------------------------------------------------------
// 主流程: 抓取 -> 合并 (失败来源保留上轮数据) -> 写盘 -> 更新历史
// ---------------------------------------------------------------------------
const SOURCE_STORES = {
  steam: ['steam'],
  cheapshark: ['steam-us', 'gog', 'humble', 'fanatical', 'gmg', 'epic', 'gamesplanet', 'indiegala'],
  sonkwo: ['sonkwo'],
  steampy: ['steampy'],
  heybox: ['heybox'],
};

async function loadJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await rename(tmp, path);
}

async function main() {
  const startedAt = new Date().toISOString();
  const prev = await loadJson(DEALS_PATH);
  const prevDeals = Array.isArray(prev?.deals) ? prev.deals : [];
  const prevMeta = prev?.meta?.sources || {};

  const fresh = new Map(); // source -> deals[]
  const status = {};
  const runSource = async (name, fn) => {
    try {
      const deals = await fn();
      fresh.set(name, deals);
      status[name] = { ok: true, count: deals.length, fetchedAt: new Date().toISOString(), error: null };
      console.log(`[${name}] ok: ${deals.length} deals`);
    } catch (err) {
      status[name] = { ok: false, count: 0, fetchedAt: prevMeta[name]?.fetchedAt || null, error: String(err.message || err) };
      console.log(`[${name}] FAILED: ${err.message}`);
    }
  };

  // 热门度先抓 (steamPY 候选要用)
  let popularity = null;
  try {
    popularity = await fetchPopularity();
    status.popularity = { ok: true, count: popularity.size, fetchedAt: new Date().toISOString(), error: null };
    console.log(`[popularity] ok: ${popularity.size} ranks`);
  } catch (err) {
    status.popularity = { ok: false, count: 0, fetchedAt: prevMeta.popularity?.fetchedAt || null, error: String(err.message || err) };
    console.log(`[popularity] FAILED: ${err.message}`);
  }

  await runSource('steam', fetchSteam);
  await runSource('cheapshark', fetchCheapShark);
  await runSource('sonkwo', fetchSonkwo);
  await runSource('heybox', fetchHeybox);
  // steamPY 依赖 Steam 列表; Steam 失败时用上轮 Steam appid 列表
  const steamForPy = fresh.get('steam') || prevDeals.filter((d) => d.store === 'steam');
  await runSource('steampy', () => fetchSteampy(steamForPy, popularity));

  // 合并: 新数据优先, 失败来源用上轮数据
  const merged = [];
  const freshStores = new Set();
  for (const [source, deals] of fresh) {
    for (const s of SOURCE_STORES[source]) freshStores.add(s);
    merged.push(...deals);
  }
  let carried = 0;
  for (const d of prevDeals) {
    if (!freshStores.has(d.store)) {
      merged.push({ ...d, rank: null, players: null });
      carried++;
    }
  }
  if (carried) console.log(`carried over ${carried} deals from previous run (failed sources)`);

  // 附加热门度 (新旧数据都刷新排名)
  if (popularity) {
    for (const d of merged) {
      const r = d.appid ? popularity.get(d.appid) : null;
      if (r) {
        d.rank = r.rank;
        d.players = r.players;
      }
    }
  } else if (prev) {
    // 热门度失败时沿用上轮排名
    const prevRank = new Map(prevDeals.filter((d) => d.rank).map((d) => [d.appid, { rank: d.rank, players: d.players }]));
    for (const d of merged) {
      const r = d.appid ? prevRank.get(d.appid) : null;
      if (r) {
        d.rank = r.rank;
        d.players = r.players;
      }
    }
  }

  // 失败来源的 count 记为保留下来的条数
  for (const [name, st] of Object.entries(status)) {
    if (!st.ok && SOURCE_STORES[name]) {
      st.count = merged.filter((d) => SOURCE_STORES[name].includes(d.store)).length;
      st.stale = true;
    }
  }

  const output = {
    meta: {
      generatedAt: startedAt,
      total: merged.length,
      sources: status,
    },
    deals: merged,
  };

  if (!merged.length) {
    console.error('No deals at all — refusing to write an empty data file.');
    process.exit(1);
  }

  await writeJsonAtomic(DEALS_PATH, output);
  console.log(`wrote ${DEALS_PATH}: ${merged.length} deals`);

  // 历史: 只记录本轮新抓到的数据, 每天每 key 每币种记最低价, 保留 90 天
  const history = (await loadJson(HISTORY_PATH)) || { version: 1, updated: null, series: {} };
  history.version = 1;
  history.updated = startedAt;
  history.series = history.series || {};
  const day = todayKey();
  const cutoff = new Date(Date.now() - 90 * 86400 * 1000).toISOString().slice(0, 10);
  const freshDeals = merged.filter((d) => freshStores.has(d.store));
  const dayMin = new Map(); // key -> { title, cny, usd }
  for (const d of freshDeals) {
    let e = dayMin.get(d.key);
    if (!e) {
      e = { title: d.title, cny: null, usd: null };
      dayMin.set(d.key, e);
    }
    if (d.currency === 'CNY') e.cny = e.cny == null ? d.price : Math.min(e.cny, d.price);
    if (d.currency === 'USD') e.usd = e.usd == null ? d.price : Math.min(e.usd, d.price);
  }
  for (const [key, e] of dayMin) {
    const s = (history.series[key] = history.series[key] || { title: e.title, days: {} });
    s.title = e.title;
    const prevDay = s.days[day] || {};
    s.days[day] = {
      cny: e.cny == null ? (prevDay.cny ?? null) : prevDay.cny == null ? e.cny : Math.min(prevDay.cny, e.cny),
      usd: e.usd == null ? (prevDay.usd ?? null) : prevDay.usd == null ? e.usd : Math.min(prevDay.usd, e.usd),
    };
    for (const dk of Object.keys(s.days)) {
      if (dk < cutoff) delete s.days[dk];
    }
    if (!Object.keys(s.days).length) delete history.series[key];
  }
  await writeJsonAtomic(HISTORY_PATH, history);
  console.log(`wrote ${HISTORY_PATH}: ${Object.keys(history.series).length} keys`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
