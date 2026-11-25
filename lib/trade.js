'use strict';
// PoE 國際服 Trade API：限流、詞綴對應、查價
const fs = require('fs');
const path = require('path');
const { UA } = require('./pob');

const BASE = 'https://www.pathofexile.com';
// 打包成 exe 時，快取放在 exe 旁邊
const IS_SEA = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const DATA_DIR = IS_SEA ? path.join(path.dirname(process.execPath), 'data') : path.join(__dirname, '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 限流
// 每條規則（例如 10 秒 5 次、5 分鐘 30 次、6 小時 600 次）各自計數，
// 不可共用一份紀錄，否則長窗口的累計次數會讓短窗口誤以為已用完
class Limiter {
  constructor(name, rules, minIntervalMs = 0) {
    this.name = name;
    this.rules = rules; // [[max, periodSec], ...]
    this.minInterval = minIntervalMs; // 兩次請求之間的最小間隔，平均分散查詢、不連發
    this.last = 0;
    this.hists = new Map(); // periodSec → 時間戳陣列
    this.blockedUntil = 0;
    this.chain = Promise.resolve();
  }
  histOf(period) {
    if (!this.hists.has(period)) this.hists.set(period, []);
    return this.hists.get(period);
  }
  acquire(onWait) {
    const p = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        let wait = Math.max(this.blockedUntil - now, this.last + this.minInterval - now);
        for (const [max, period] of this.rules) {
          const recent = this.histOf(period).filter((t) => t > now - period * 1000);
          // 長窗口（≥60 秒）保留 1 次餘裕，避免與其他程式共用 IP 時觸發 30 分鐘懲罰
          const cap = period >= 60 && max > 2 ? max - 1 : max;
          if (recent.length >= cap) wait = Math.max(wait, recent[recent.length - cap] + period * 1000 - now + 500);
        }
        if (wait <= 0) break;
        if (onWait && wait > 5000) onWait(wait, this.name); // 幾秒內的固定間隔不用特別提示
        // 分段等待，查價工作被取消時立即放棄（不佔住佇列）
        const until = Date.now() + wait;
        while (Date.now() < until) {
          if (onWait && onWait.isCancelled && onWait.isCancelled()) throw new Error('已取消');
          await sleep(Math.min(1000, until - Date.now()));
        }
      }
      const t = Date.now();
      this.last = t;
      for (const [, period] of this.rules) {
        const h = this.histOf(period).filter((x) => x > t - period * 1000);
        h.push(t);
        this.hists.set(period, h);
      }
    });
    this.chain = p.catch(() => {});
    return p;
  }
  update(headers) {
    const ruleNames = (headers.get('x-rate-limit-rules') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const rules = [];
    const now = Date.now();
    for (const rn of ruleNames) {
      const def = headers.get(`x-rate-limit-${rn.toLowerCase()}`);
      const st = headers.get(`x-rate-limit-${rn.toLowerCase()}-state`);
      if (!def) continue;
      const defs = def.split(',').map((x) => x.split(':').map(Number));
      const states = (st || '').split(',').map((x) => x.split(':').map(Number));
      defs.forEach(([max, period], i) => {
        rules.push([max, period]);
        const s = states[i];
        if (!s) return;
        const [hits, , restricted] = s;
        // 與伺服器狀態同步（只補到這條規則自己的紀錄）
        const h = this.histOf(period);
        const local = h.filter((t) => t > now - period * 1000).length;
        for (let k = local; k < hits; k++) h.push(now);
        if (restricted > 0) this.blockedUntil = Math.max(this.blockedUntil, now + restricted * 1000);
      });
    }
    if (rules.length) this.rules = rules;
  }
}

const limiters = {
  // 最小間隔：搜尋預設 2 秒（使用者可在網頁調整，最短 2 秒）、匯率 3 秒、取明細 0.5 秒
  search: new Limiter('search', [[5, 10], [15, 60], [30, 300]], 2000),
  fetch: new Limiter('fetch', [[12, 4], [16, 12]], 500),
  exchange: new Limiter('exchange', [[5, 15], [10, 90], [30, 300]], 3000),
  data: new Limiter('data', [[5, 5]], 1000),
};

async function api(kind, url, body, onWait) {
  const lim = limiters[kind];
  for (let attempt = 0; attempt < 4; attempt++) {
    await lim.acquire(onWait);
    const res = await fetch(BASE + url, {
      method: body ? 'POST' : 'GET',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    lim.update(res.headers);
    if (res.status === 429) {
      const ra = +(res.headers.get('retry-after') || 60);
      lim.blockedUntil = Math.max(lim.blockedUntil, Date.now() + ra * 1000);
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Trade API 回應非 JSON（HTTP ${res.status}），可能被 Cloudflare 擋下`);
    }
    if (!res.ok || json.error) {
      const msg = json.error ? json.error.message : `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  throw new Error('Trade API 限流重試次數過多');
}

// ---------------------------------------------------------------- 聯盟 / 資料
async function getLeagues() {
  const j = await api('data', '/api/trade/data/leagues');
  const pc = j.result.filter((l) => l.realm === 'pc');
  const fixed = /^(Standard|Hardcore|Ruthless|Hardcore Ruthless)$/;
  const isChallenge = (l) => !fixed.test(l.id);
  const isSoftcore = (l) => !/Hardcore|HC|Ruthless|SSF/i.test(l.id);
  const def = pc.find((l) => isChallenge(l) && isSoftcore(l)) || pc[0];
  return { leagues: pc.map((l) => l.id), default: def && def.id };
}

async function cachedData(name, url, maxAgeH = 24) {
  const file = path.join(DATA_DIR, `${name}.json`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < maxAgeH * 3600e3) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const j = await api('data', url);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j));
  return j;
}

// 把詞綴文字正規化成模板：數字 → #，去掉 +/- 號
const norm = (s) =>
  s
    .replace(/[+-]?\d+(?:\.\d+)?/g, '#')
    .replace(/[+-]#/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

let statIndex = null;
async function getStatIndex() {
  if (statIndex) return statIndex;
  const j = await cachedData('stats', '/api/trade/data/stats');
  const idx = new Map();
  const add = (key, v) => {
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(v);
  };
  for (const g of j.result) {
    for (const e of g.entries) {
      const local = /\(Local\)\s*$/.test(e.text);
      const text = e.text.replace(/\s*\(Local\)\s*$/, '');
      add(`${e.type}|${norm(text)}`, { id: e.id, local, hasValue: text.includes('#') });
      if (e.option && e.option.options) {
        for (const o of e.option.options) {
          const t = text.replace('#', o.text);
          add(`${e.type}|${norm(t)}`, { id: e.id, local, option: o.id, hasValue: false });
        }
      }
    }
  }
  statIndex = idx;
  return idx;
}

// 回傳最佳 stat；同文字若有多個 id（例：Suppress 有兩個 id）一併回傳在 alts
function lookup(idx, types, text, preferLocal) {
  for (const t of types) {
    const list = idx.get(`${t}|${norm(text)}`);
    if (list && list.length) {
      const hit = list.find((x) => x.local === preferLocal) || list[0];
      const alts = list.filter((x) => x !== hit && x.local === hit.local && x.option === hit.option && x.id !== hit.id).map((x) => x.id);
      return { ...hit, type: t, alts: [...new Set(alts)] };
    }
  }
  return null;
}

const nums = (s) => (s.match(/[+-]?\d+(?:\.\d+)?/g) || []).map(Number);

// 把一條詞綴轉成 trade stat filter
function matchMod(idx, mod, section, preferLocal, pct) {
  let types;
  if (mod.tags.includes('crucible')) return null;
  if (section === 'implicit') types = mod.tags.includes('crafted') || mod.tags.includes('enchant') ? ['enchant', 'implicit'] : ['implicit', 'enchant'];
  else if (mod.tags.includes('enchant')) types = ['enchant'];
  else if (mod.tags.includes('fractured')) types = ['fractured', 'explicit'];
  else if (mod.tags.includes('crafted')) types = ['crafted'];
  else if (mod.tags.includes('scourge')) types = ['scourge'];
  else types = ['explicit'];

  let text = mod.text;
  let sign = 1;
  let hit = lookup(idx, types, text, preferLocal);
  if (!hit && /\b(reduced|less)\b/.test(text)) {
    hit = lookup(idx, types, text.replace(/\breduced\b/, 'increased').replace(/\bless\b/, 'more'), preferLocal);
    if (hit) sign = -1;
  }
  if (!hit && section === 'explicit') hit = lookup(idx, ['pseudo'], text, false); // 例：物品稀有度只有 pseudo
  if (!hit) return null;
  const filter = { id: hit.id };
  if (hit.option != null) filter.value = { option: hit.option };
  else if (hit.hasValue) {
    const ns = nums(text);
    if (ns.length) {
      const v = (sign * ns.reduce((a, b) => a + b, 0)) / ns.length;
      const x = v * pct;
      // 小數值保留一位小數（例如 1.5% 回復），大數值取整數
      if (v >= 0) filter.value = { min: Math.abs(v) >= 10 ? Math.floor(x) : Math.floor(x * 10) / 10 };
      else filter.value = { max: Math.abs(v) >= 10 ? Math.ceil(x) : Math.ceil(x * 10) / 10 };
    }
  }
  return { filter, alts: hit.alts, type: hit.type, text: mod.text, negated: sign === -1 };
}

// 一條詞綴 → and 群組用的 filters；有多個 id 時拆成獨立的「count ≥1」群組（= OR）
function splitForAnd(ms) {
  const plain = [];
  const orGroups = [];
  for (const m of ms) {
    if (m.alts && m.alts.length) {
      orGroups.push({ type: 'count', value: { min: 1 }, filters: [m.filter, ...m.alts.map((id) => ({ ...m.filter, id }))] });
    } else plain.push(m.filter);
  }
  return [{ type: 'and', filters: plain }, ...orGroups];
}
// count 群組：把所有替代 id 一起放進去（同一件物品只會符合其中一個）
const expandForCount = (ms) => ms.flatMap((m) => [m.filter, ...(m.alts || []).map((id) => ({ ...m.filter, id }))]);

// ---------------------------------------------------------------- 分類
// 魔法物品名稱 → 官方基底名稱（取名稱中包含的最長基底，例：Alchemist's Gold Flask of Craft → Gold Flask）
let baseTypes = null;
async function resolveMagicBase(name) {
  if (!baseTypes) {
    const j = await cachedData('items', '/api/trade/data/items', 72);
    const set = new Set();
    for (const g of j.result) for (const e of g.entries) if (!(e.flags && e.flags.unique) && e.type) set.add(e.type);
    baseTypes = [...set].sort((a, b) => b.length - a.length);
  }
  return baseTypes.find((t) => name === t || new RegExp(`(^|\\s)${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(name)) || null;
}

function categoryFor(item) {
  const s = item.slot || '';
  const b = item.base || '';
  if (/Cluster Jewel/.test(b)) return { category: 'jewel.cluster' };
  if (/Eye Jewel/.test(b)) return { category: 'jewel.abyss' };
  if (/Jewel/.test(b) || s === 'Jewel') return { category: 'jewel.base' };
  if (/^Flask/.test(s) || /Flask/.test(b)) return { category: 'flask' };
  if (s === 'Helmet') return { category: 'armour.helmet' };
  if (s === 'Body Armour') return { category: 'armour.chest' };
  if (s === 'Gloves') return { category: 'armour.gloves' };
  if (s === 'Boots') return { category: 'armour.boots' };
  if (s === 'Amulet') return { category: 'accessory.amulet' };
  if (/^Ring/.test(s)) return { category: 'accessory.ring' };
  if (s === 'Belt') return { category: 'accessory.belt' };
  if (/Quiver/.test(b)) return { category: 'armour.quiver' };
  return { type: b }; // 武器 / 盾：直接用基底
}

const CATEGORY_ZH = {
  'jewel.cluster': '星團珠寶', 'jewel.abyss': '深淵珠寶', 'jewel.base': '珠寶', flask: '藥劑',
  'armour.helmet': '頭盔', 'armour.chest': '胸甲', 'armour.gloves': '手套', 'armour.boots': '鞋子', 'armour.quiver': '箭袋',
  'accessory.amulet': '項鍊', 'accessory.ring': '戒指', 'accessory.belt': '腰帶',
};

// 「W-B-B-W-G-G」→ 6；「G-W-G-G W-W」→ 4（空白分隔不同連線組）
function linkCount(sockets) {
  if (!sockets) return 0;
  return Math.max(0, ...sockets.trim().split(/\s+/).map((g) => g.split('-').length));
}

const isLocalSlot = (item) => /^(Weapon|Helmet|Body Armour|Gloves|Boots)/.test(item.slot || '');

// ---------------------------------------------------------------- 建立查詢
async function buildQueries(item, opts) {
  const status = { option: opts.status || 'online' };
  const pct = opts.pct || 0.85;
  const isUnique = item.rarity === 'UNIQUE' || item.rarity === 'RELIC';
  const isMagic = item.rarity === 'MAGIC';
  if (!isUnique && !isMagic && item.rarity !== 'RARE') return null; // 普通物品不估價

  const idx = await getStatIndex();
  const preferLocal = isLocalSlot(item);
  const matched = [];
  const unmatched = [];
  for (const [section, list] of [['implicit', item.implicits], ['explicit', item.explicits]]) {
    for (let i = 0; i < list.length; i++) {
      let r = matchMod(idx, list[i], section, preferLocal, pct);
      // 多行詞綴：與下一行（或兩行）合併再試
      for (let k = 1; !r && k <= 2 && i + k < list.length; k++) {
        const joined = { ...list[i], text: list.slice(i, i + k + 1).map((m) => m.text).join('\n') };
        r = matchMod(idx, joined, section, preferLocal, pct);
        if (r) i += k;
      }
      if (r) matched.push({ ...r, section });
      else unmatched.push(list[i].text);
    }
  }

  // 共用條件：汙染狀態、連線數（5 連以上價格差很多）
  const misc = {};
  const conds = []; // 顯示給使用者看的條件
  if (item.corrupted) { misc.corrupted = { option: 'true' }; conds.push('已汙染'); }
  else misc.corrupted = { option: 'false' };
  const links = linkCount(item.meta && item.meta.Sockets);
  const socketFilters = links >= 5 && isLocalSlot(item) ? { links: { min: links } } : null;
  if (socketFilters) conds.push(`${links} 連線`);
  const withMisc = (q) => {
    q.filters = { ...(q.filters || {}), misc_filters: { filters: misc } };
    if (socketFilters) q.filters.socket_filters = { filters: socketFilters };
    return q;
  };

  if (isUnique) {
    const q = withMisc({ status, name: item.name, type: item.base });
    // 傳奇的價格取決於：汙染／固有詞綴、隨機詞綴的數值（例如物理傷害 %），珠寶還取決於詞綴種類
    const ench = []; // 附魔（塗油、品質詞綴…）
    const imp = []; // 固有詞綴（含汙染、昇華、伊塔／伊格）
    const em = []; // 隨機詞綴
    for (const m of matched) {
      if (/Watcher's Eye/.test(item.name) && /^\d+% increased maximum (Energy Shield|Life|Mana)$/.test(m.text)) continue;
      const x = { filter: { ...m.filter }, alts: m.alts, text: m.text, seeded: false };
      if (/pseudo_timeless_jewel/.test(x.filter.id)) {
        const seed = nums(m.text)[0];
        x.filter.value = { min: seed, max: seed };
        x.seeded = true;
      }
      if (m.type === 'enchant') ench.push(x);
      else if (m.section === 'implicit') imp.push(x);
      else em.push(x);
    }
    // 去掉數值，只要求「有這條詞綴」（保留選項型與種子）
    const noVal = (list, dropSeed) =>
      list.map((x) => {
        const v = x.filter.value;
        const keep = v && (v.option != null || (x.seeded && !dropSeed));
        return { ...x, filter: keep ? x.filter : { id: x.filter.id } };
      });
    const hasNum = [...imp, ...em].some((x) => x.filter.value && x.filter.value.option == null && !x.seeded);
    const attempts = [];
    const withStats = (list, label, loose) => ({ label, loose, query: { ...q, stats: splitForAnd(list).filter((g) => g.filters.length) } });
    const p = Math.round(pct * 100);
    if (ench.length) attempts.push(withStats([...ench, ...imp, ...em], `詞綴相同、數值 ${p}% 以上（含附魔）`));
    if (imp.length || em.length) attempts.push(withStats([...imp, ...em], `詞綴相同、數值 ${p}% 以上`));
    if (hasNum) attempts.push(withStats(noVal([...imp, ...em]), '詞綴相同（數值不限）', true));
    if (em.some((x) => x.seeded)) attempts.push(withStats(noVal([...imp, ...em], true), '同類型（種子號碼不同）', true));
    const n = em.length;
    if (/Jewel/.test(item.base) && n >= 3) {
      attempts.push({ label: `${n} 條詞綴中 ${n - 1} 條相同`, loose: true, query: { ...q, stats: [...splitForAnd(noVal(imp)), { type: 'count', value: { min: n - 1 }, filters: expandForCount(noVal(em)) }].filter((g) => g.filters.length) } });
    }
    // 汙染／固有詞綴通常決定價格（例：汙染的 +1 寶石等級），找不到完全相同時至少保留它們
    if (imp.length && em.length) attempts.push(withStats(imp, item.corrupted ? '汙染詞綴相同（其他詞綴不限）' : '固有詞綴相同（其他詞綴不限）', true));
    const any = ench.length + imp.length + em.length > 0;
    attempts.push({ label: any ? '只比對名稱（找不到詞綴相同的）' : '同名傳奇', loose: any, query: q });
    return { mode: '傳奇', attempts, matched: [...conds, ...[...ench, ...imp, ...em].map((x) => x.text)], unmatched };
  }

  // 魔法物品（藥劑等）：名稱 = 前綴 + 基底 + 後綴，先拆出真正的基底，再比對前後綴詞綴的數值
  if (isMagic) {
    const baseType = await resolveMagicBase(item.base);
    if (!baseType) return null;
    const q = withMisc({ status, type: baseType, filters: { type_filters: { filters: { rarity: { option: 'nonunique' } } } } });
    const ench = matched.filter((m) => m.type === 'enchant' || m.section === 'implicit');
    const em = matched.filter((m) => !ench.includes(m));
    const p = Math.round(pct * 100);
    const withStats = (list, label, loose) => ({ label, loose, query: { ...q, stats: splitForAnd(list).filter((g) => g.filters.length) } });
    const attempts = [];
    if (ench.length && em.length) attempts.push(withStats([...ench, ...em], `詞綴相同、數值 ${p}% 以上（含附魔）`));
    if (em.length) {
      attempts.push(withStats(em, `詞綴相同、數值 ${p}% 以上`));
      attempts.push(withStats(em.map((m) => ({ ...m, filter: { id: m.filter.id } })), '詞綴相同（數值不限）', true));
    }
    attempts.push({ label: em.length ? '只比對基底（找不到詞綴相同的）' : '同基底', loose: em.length > 0, query: q });
    return { mode: '魔法', attempts, matched: [...conds, ...matched.map((m) => m.text)], unmatched };
  }

  // 稀有：抗性 / 生命合併成 pseudo 總和（比逐條比對更接近實際交易習慣）
  let ele = 0;
  let chaosRes = 0;
  let life = 0;
  const pseudoTexts = [];
  for (let i = matched.length - 1; i >= 0; i--) {
    const m = matched[i];
    if (m.type === 'enchant') continue;
    const t = m.text;
    let r;
    if ((r = t.match(/^\+?(\d+)% to (all Elemental|Fire|Cold|Lightning|Chaos|Fire and Cold|Fire and Lightning|Cold and Lightning|Fire and Chaos|Cold and Chaos|Lightning and Chaos) Resistances?$/))) {
      const v = +r[1];
      const kinds = r[2] === 'all Elemental' ? ['Fire', 'Cold', 'Lightning'] : r[2].split(' and ');
      for (const k of kinds) k === 'Chaos' ? (chaosRes += v) : (ele += v);
    } else if ((r = t.match(/^\+?(\d+) to maximum Life$/))) {
      life += +r[1];
    } else continue;
    pseudoTexts.unshift(t);
    matched.splice(i, 1);
  }
  const pseudo = [];
  if (life) pseudo.push({ filter: { id: 'pseudo.pseudo_total_life', value: { min: Math.floor(life * pct) } }, type: 'pseudo', section: 'explicit', text: `生命合計 ${life}` });
  if (ele) pseudo.push({ filter: { id: 'pseudo.pseudo_total_elemental_resistance', value: { min: Math.floor(ele * pct) } }, type: 'pseudo', section: 'explicit', text: `元素抗性合計 ${ele}%` });
  if (chaosRes) pseudo.push({ filter: { id: 'pseudo.pseudo_total_chaos_resistance', value: { min: Math.floor(chaosRes * pct) } }, type: 'pseudo', section: 'explicit', text: `混沌抗性合計 ${chaosRes}%` });
  matched.push(...pseudo);
  for (const m of matched) {
    // 星團珠寶天賦數量要完全相同
    if (m.filter.id === 'enchant.stat_3086156145') {
      const v = nums(m.text)[0];
      m.filter.value = { min: v, max: v };
    }
  }
  const cat = categoryFor(item);
  const cluster = cat.category === 'jewel.cluster';
  const typeFilters = {};
  if (cat.category) typeFilters.category = { option: cat.category };
  const base = withMisc({ status, filters: { type_filters: { filters: typeFilters } } });
  if (cat.type) base.type = cat.type;

  // 星團珠寶：附魔（天賦數、小天賦類型）必須符合，核心是「1 Added Passive Skill is X」大天賦
  // 其他物品：附魔（塗油等）與基底固有詞綴只在第一輪嚴格比對使用
  const isCore = (m) =>
    m.section === 'explicit' && m.type !== 'enchant' && (!cluster || /Added Passive Skill is/.test(m.text));
  const must = matched.filter((m) => cluster && m.type === 'enchant');
  const extra = matched.filter((m) => !must.includes(m) && !isCore(m));
  const core = matched.filter(isCore);
  const n = core.length;
  const p = Math.round(pct * 100);
  const mk = (label, groups, loose) => ({ label, loose, query: { ...base, stats: groups.filter((g) => g.filters.length) } });
  const attempts = [];
  if (extra.length) attempts.push(mk('所有詞綴都相近', splitForAnd([...must, ...extra, ...core])));
  attempts.push(mk(cluster ? '天賦相同' : '主要詞綴都相近', splitForAnd([...must, ...core])));
  // 逐步放寬：n-1、n-2（n-2 或剩 1 條時標示為寬鬆）
  for (const k of [n - 1, n - 2]) {
    if (k < 1 || (k === n - 2 && n < 4)) continue;
    const loose = k < n - 1 || k === 1;
    attempts.push(mk(`${n} 條詞綴中 ${k} 條相近`, [...splitForAnd(must), { type: 'count', value: { min: k }, filters: expandForCount(core) }], loose));
  }
  return { mode: `稀有：${cat.category ? CATEGORY_ZH[cat.category] || cat.category : '同基底'}`, attempts, matched: [...conds, ...matched.map((m) => m.text)], unmatched };
}

// ---------------------------------------------------------------- 匯率
async function getDivineRate(league, onWait) {
  const body = { query: { status: { option: 'online' }, have: ['chaos'], want: ['divine'] }, sort: { have: 'asc' }, engine: 'new' };
  const j = await api('exchange', `/api/trade/exchange/${encodeURIComponent(league)}`, body, onWait);
  const ratios = Object.values(j.result || {})
    .map((r) => r.listing && r.listing.offers && r.listing.offers[0])
    .filter((o) => o && o.item.stock >= 5)
    .map((o) => o.exchange.amount / o.item.amount)
    .slice(0, 10)
    .sort((a, b) => a - b);
  if (!ratios.length) return null;
  return ratios[Math.floor(ratios.length / 2)];
}

// 其他通貨（mirror、exalted…）換算成 chaos：先問「用 divine 買」，再問「用 chaos 買」
const rateCache = new Map();
async function currencyToChaos(league, cur, divine, onWait) {
  if (cur === 'chaos') return 1;
  if (cur === 'divine') return divine;
  const key = `${league}|${cur}`;
  const c = rateCache.get(key);
  if (c && Date.now() - c.t < 30 * 60e3) return c.v;
  let v = null;
  for (const have of divine ? ['divine', 'chaos'] : ['chaos']) {
    try {
      const body = { query: { status: { option: 'online' }, have: [have], want: [cur] }, sort: { have: 'asc' }, engine: 'new' };
      const j = await api('exchange', `/api/trade/exchange/${encodeURIComponent(league)}`, body, onWait);
      const ratios = Object.values(j.result || {})
        .map((r) => r.listing && r.listing.offers && r.listing.offers[0])
        .filter(Boolean)
        .map((o) => o.exchange.amount / o.item.amount)
        .slice(0, 5)
        .sort((a, b) => a - b);
      if (ratios.length) {
        const mid = ratios[Math.floor(ratios.length / 2)];
        v = have === 'divine' ? mid * divine : mid;
        break;
      }
    } catch {}
  }
  // 沒人賣（如 mirror）：改看「用 divine 收購」的最高出價，作為近似值
  if (v == null && divine) {
    try {
      const body = { query: { status: { option: 'any' }, have: [cur], want: ['divine'] }, sort: { have: 'asc' }, engine: 'new' };
      const j = await api('exchange', `/api/trade/exchange/${encodeURIComponent(league)}`, body, onWait);
      const bids = Object.values(j.result || {})
        .map((r) => r.listing && r.listing.offers && r.listing.offers[0])
        .filter(Boolean)
        .map((o) => o.item.amount / o.exchange.amount);
      if (bids.length) v = Math.max(...bids) * divine;
    } catch {}
  }
  rateCache.set(key, { t: Date.now(), v });
  return v;
}

// ---------------------------------------------------------------- 查價
const cache = new Map();
const CACHE_MS = 15 * 60e3;

async function priceItem(item, opts, onWait) {
  const plan = await buildQueries(item, opts);
  if (!plan) return { skipped: '普通物品不估價' };
  const league = opts.league;
  let search = null;
  let used = null;
  for (const a of plan.attempts) {
    const body = { query: a.query, sort: { price: 'asc' } };
    const key = league + JSON.stringify(body);
    const c = cache.get(key);
    if (c && Date.now() - c.t < CACHE_MS) search = c.v;
    else {
      search = await api('search', `/api/trade/search/${encodeURIComponent(league)}`, body, onWait);
      cache.set(key, { t: Date.now(), v: search });
    }
    used = a;
    if (search.total > 0) break;
  }
  const url = `${BASE}/trade/search/${encodeURIComponent(league)}/${search.id}?lang=zh_TW`;
  const out = { mode: plan.mode, attempt: used.label, loose: !!used.loose, total: search.total, url, matched: plan.matched, unmatched: plan.unmatched, listings: [] };
  if (!search.result || !search.result.length) return out;

  const ids = search.result.slice(0, 10);
  const fkey = 'fetch:' + ids.join(',');
  let fj;
  const c = cache.get(fkey);
  if (c && Date.now() - c.t < CACHE_MS) fj = c.v;
  else {
    fj = await api('fetch', `/api/trade/fetch/${ids.join(',')}?query=${search.id}`, null, onWait);
    cache.set(fkey, { t: Date.now(), v: fj });
  }
  for (const r of fj.result || []) {
    if (!r || !r.listing || !r.listing.price) continue;
    const p = r.listing.price;
    const rate = await currencyToChaos(league, p.currency, opts.divine, onWait);
    const chaos = rate ? p.amount * rate : null;
    out.listings.push({ amount: p.amount, currency: p.currency, chaos, account: r.listing.account && r.listing.account.name });
  }
  const cs = out.listings.map((l) => l.chaos).filter((x) => x != null).sort((a, b) => a - b);
  if (cs.length) {
    out.minChaos = cs[0];
    out.medianChaos = cs[Math.floor((cs.length - 1) / 2)];
  }
  return out;
}

// ---------------------------------------------------------------- 繁體中文翻譯
// 物品名稱：Awakened PoE Trade 的繁中資料（每筆附英文 refName）
// 詞綴：台服官方 trade stats，與國際服共用 stat id
const APT_ITEMS = 'https://raw.githubusercontent.com/SnosMe/awakened-poe-trade/master/renderer/public/data/cmn-Hant/items.ndjson';
const TW_STATS = 'https://pathofexile.tw/api/trade/data/stats';

async function cachedExternal(name, url, transform, maxAgeH = 72) {
  const file = path.join(DATA_DIR, `${name}.json`);
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - fs.statSync(file).mtimeMs < maxAgeH * 3600e3) return old;
  } catch {}
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = transform(await res.text());
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
    return data;
  } catch (e) {
    if (old) return old; // 更新失敗時沿用舊快取
    console.warn(`下載翻譯資料失敗（${name}）：${e.message}`);
    return null;
  }
}

let zh = null;
async function getZh() {
  if (zh) return zh;
  const [items, stats] = await Promise.all([
    cachedExternal('zh_items', APT_ITEMS, (text) => {
      const uniques = {};
      const bases = {};
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let o;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!o.refName || !o.name) continue;
        if (o.namespace === 'UNIQUE') uniques[o.refName] = o.name;
        else if (o.namespace === 'ITEM') bases[o.refName] = o.name;
      }
      return { uniques, bases };
    }),
    cachedExternal('zh_stats', TW_STATS, (text) => {
      const out = {};
      for (const g of JSON.parse(text).result) {
        for (const e of g.entries) {
          out[e.id] = { text: e.text };
          if (e.option && e.option.options) out[e.id].options = Object.fromEntries(e.option.options.map((o) => [o.id, o.text]));
        }
      }
      return out;
    }),
  ]);
  zh = { uniques: (items && items.uniques) || {}, bases: (items && items.bases) || {}, stats: stats || {} };
  // 以台服官方名稱為準（APT 部分譯名較舊），對不上的才用 APT
  try {
    const official = await getOfficialNames(zh);
    Object.assign(zh.uniques, official.uniques);
    Object.assign(zh.bases, official.bases);
  } catch (e) {
    console.warn('台服物品名稱對齊失敗，改用 APT 譯名：', e.message);
  }
  return zh;
}

// 國際服與台服的 trade 物品清單順序相同、只差少數幾筆：
// 用序列對齊（Needleman-Wunsch），APT 譯名相同的項目當錨點，得到官方繁中名稱
async function getOfficialNames(apt) {
  const file = path.join(DATA_DIR, 'zh_official.json');
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < 72 * 3600e3) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const en = await cachedData('items', '/api/trade/data/items', 72);
  const tw = await cachedExternal('tw_items', 'https://pathofexile.tw/api/trade/data/items', (t) => JSON.parse(t));
  if (!tw) throw new Error('無法下載台服物品清單');
  const out = { uniques: {}, bases: {} };
  for (const g of en.result) {
    const tg = tw.result.find((x) => x.id === g.id);
    if (!tg) continue;
    const A = g.entries;
    const B = tg.entries;
    const n = A.length;
    const m = B.length;
    const isU = (e) => !!(e.flags && e.flags.unique);
    const score = (a, b) => {
      if (isU(a) !== isU(b)) return -3;
      const az = isU(a) ? apt.uniques[a.name] : apt.bases[a.type];
      const bz = isU(b) ? b.name : b.type;
      if (az && az === bz) return 4;
      if (isU(a) && apt.bases[a.type] && apt.bases[a.type] === b.type) return 2;
      return 0;
    };
    const GAP = -1;
    const W = m + 1;
    const dp = new Float64Array((n + 1) * W);
    const bt = new Uint8Array((n + 1) * W); // 0 對角 1 上 2 左
    for (let i = 1; i <= n; i++) { dp[i * W] = i * GAP; bt[i * W] = 1; }
    for (let j = 1; j <= m; j++) { dp[j] = j * GAP; bt[j] = 2; }
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        const d = dp[(i - 1) * W + j - 1] + score(A[i - 1], B[j - 1]);
        const u = dp[(i - 1) * W + j] + GAP;
        const l = dp[i * W + j - 1] + GAP;
        if (d >= u && d >= l) { dp[i * W + j] = d; bt[i * W + j] = 0; }
        else if (u >= l) { dp[i * W + j] = u; bt[i * W + j] = 1; }
        else { dp[i * W + j] = l; bt[i * W + j] = 2; }
      }
    }
    let i = n;
    let j = m;
    while (i > 0 && j > 0) {
      const b = bt[i * W + j];
      if (b === 0) {
        const a = A[i - 1];
        const t = B[j - 1];
        if (isU(a) === isU(t)) {
          if (isU(a)) {
            if (a.name && t.name) out.uniques[a.name] = t.name;
            if (a.type && t.type && !out.bases[a.type]) out.bases[a.type] = t.type;
          } else if (a.type && t.type) out.bases[a.type] = t.type;
        }
        i--;
        j--;
      } else if (b === 1) i--;
      else j--;
    }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

function zhBase(z, base) {
  if (!base) return '';
  if (z.bases[base]) return z.bases[base];
  // 魔法物品：名稱含前後綴，只翻譯其中的基底
  let best = '';
  for (const k of Object.keys(z.bases)) if (k.length > best.length && base.includes(k)) best = k;
  return best ? z.bases[best] : base;
}

// 把中文模板的 # 依序填入英文詞綴裡的數值
function fillZh(z, hit, enText) {
  const s = z.stats[hit.filter.id];
  if (!s) return null;
  let t = s.text.replace(/\s*\((部分|局部|Local)\)\s*$/, '');
  const opt = hit.filter.value && hit.filter.value.option;
  if (opt != null && s.options && s.options[opt] != null) return t.replace('#', s.options[opt]);
  const vals = nums(enText);
  let i = 0;
  // 模板有正負號時沿用實際數值的正負（例：-15 總魔力消耗）
  t = t.replace(/([+-]?)#/g, (m, sign) => {
    if (i >= vals.length) return m;
    const v = vals[i++];
    if (sign) return (v < 0 ? '-' : '+') + Math.abs(v);
    return String(Math.abs(v));
  });
  // 英文是 reduced / less、對應到 increased / more 的 stat 時，中文改回減少 / 較少
  if (hit.negated) t = t.replace('增加', '減少').replace('更多', '更少');
  return t.replace(/ {2,}/g, ' ');
}

// 回傳物品的中文名稱、基底與每條詞綴的中文
async function translateItem(item) {
  const z = await getZh();
  const idx = await getStatIndex();
  const preferLocal = isLocalSlot(item);
  const tr = (list, section) => {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      let r = matchMod(idx, list[i], section, preferLocal, 1);
      let text = list[i].text;
      for (let k = 1; !r && k <= 2 && i + k < list.length; k++) {
        const joined = list.slice(i, i + k + 1).map((m) => m.text).join('\n');
        r = matchMod(idx, { ...list[i], text: joined }, section, preferLocal, 1);
        if (r) {
          text = joined;
          i += k;
        }
      }
      const zhText = r ? fillZh(z, r, text) : null;
      out.push({ en: text, zh: zhText || text, tags: list[i].tags });
    }
    return out;
  };
  return {
    nameZh: item.name ? z.uniques[item.name] || item.name : '',
    baseZh: zhBase(z, item.base),
    implicitsZh: tr(item.implicits || [], 'implicit'),
    explicitsZh: tr(item.explicits || [], 'explicit'),
  };
}

// 使用者自訂搜尋間隔（秒）。官方：10 秒 5 次、60 秒 15 次、300 秒 30 次；
// 最短 2 秒（= 10 秒 5 次的平均），不論設多少，Limiter 仍會遵守上述三條上限
const SEARCH_INTERVAL_MIN = 2;
const SEARCH_INTERVAL_MAX = 60;
function setSearchInterval(sec) {
  const s = Math.min(SEARCH_INTERVAL_MAX, Math.max(SEARCH_INTERVAL_MIN, Number(sec) || 4));
  limiters.search.minInterval = s * 1000;
  return s;
}

module.exports = { getLeagues, getDivineRate, priceItem, buildQueries, getStatIndex, translateItem, setSearchInterval };
