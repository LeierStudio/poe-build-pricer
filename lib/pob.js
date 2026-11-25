'use strict';
// 解析 Path of Building 匯出碼 / pobb.in 連結
const zlib = require('zlib');

const UA = 'poe-build-pricer/1.0';

// 依輸入取得 PoB 匯出碼（支援 pobb.in、pastebin、poe.ninja/pob、直接貼匯出碼）
async function fetchPobCode(input) {
  input = String(input || '').trim();
  if (!input) throw new Error('請輸入 pobb.in 網址或 PoB 匯出碼');
  let rawUrl = null;
  let m;
  if ((m = input.match(/pobb\.in\/(?:u\/[^/]+\/)?([A-Za-z0-9_-]+)/))) rawUrl = `https://pobb.in/${m[1]}/raw`;
  else if ((m = input.match(/pastebin\.com\/(?:raw\/)?([A-Za-z0-9]+)/))) rawUrl = `https://pastebin.com/raw/${m[1]}`;
  else if ((m = input.match(/poe\.ninja\/pob\/(?:raw\/)?([A-Za-z0-9_-]+)/))) rawUrl = `https://poe.ninja/pob/raw/${m[1]}`;
  else if (/^https?:\/\//.test(input)) throw new Error('不支援的網址，請使用 pobb.in / pastebin / poe.ninja/pob 或直接貼 PoB 匯出碼');
  if (!rawUrl) return input;
  const res = await fetch(rawUrl, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`讀取 ${rawUrl} 失敗：HTTP ${res.status}`);
  return (await res.text()).trim();
}

function decodePobCode(code) {
  const b64 = code.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(b64, 'base64');
  try {
    return zlib.inflateSync(buf).toString('utf8');
  } catch (e) {
    throw new Error('PoB 匯出碼解碼失敗（格式不正確）');
  }
}

function decodeEntities(s) {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, '&');
}

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
};

const FLAG_LINES = new Set(['Corrupted', 'Mirrored', 'Split', 'Fractured Item', 'Synthesised Item', 'Unidentified', 'Sanctified']);

// 解析單一物品文字
function parseItemText(raw) {
  const lines = decodeEntities(raw.replace(/<ModRange[^>]*\/>/g, ''))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const item = { rarity: 'NORMAL', name: '', base: '', meta: {}, flags: [], implicits: [], explicits: [] };
  let i = 0;
  const r = lines[0] && lines[0].match(/^Rarity:\s*(\w+)/i);
  if (r) {
    item.rarity = r[1].toUpperCase();
    i = 1;
  }
  if (item.rarity === 'RARE' || item.rarity === 'UNIQUE' || item.rarity === 'RELIC') {
    item.name = lines[i++] || '';
    item.base = lines[i++] || '';
  } else {
    item.base = lines[i++] || '';
  }
  let implicitCount = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const im = l.match(/^Implicits:\s*(\d+)/);
    if (im) {
      implicitCount = +im[1];
      i++;
      break;
    }
    const kv = l.match(/^([A-Za-z][A-Za-z ]*?):\s*(.*)$/);
    if (kv) item.meta[kv[1]] = kv[2];
    else if (/ Item$/.test(l)) item.flags.push(l); // Shaper Item / Searing Exarch Item ...
    else if (FLAG_LINES.has(l)) item.flags.push(l);
  }
  const selVariant = item.meta['Selected Variant'];
  const mods = [];
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (FLAG_LINES.has(l)) {
      item.flags.push(l);
      continue;
    }
    mods.push(l);
  }
  const parsed = mods.map(parseModLine).filter((m) => {
    if (!m.variants) return true;
    return selVariant ? m.variants.includes(selVariant) : true;
  });
  const n = implicitCount == null ? 0 : implicitCount;
  item.implicits = parsed.slice(0, n);
  item.explicits = parsed.slice(n);
  item.corrupted = item.flags.includes('Corrupted');
  return item;
}

function parseModLine(line) {
  const tags = [];
  let variants = null;
  let text = line;
  let m;
  while ((m = text.match(/^\{([^}]*)\}/))) {
    const t = m[1];
    const v = t.match(/^variant:([\d,]+)/);
    if (v) variants = v[1].split(',');
    else tags.push(t.split(':')[0]);
    text = text.slice(m[0].length);
  }
  return { text: text.trim(), tags, variants };
}

const SLOT_ORDER = [
  'Weapon 1', 'Weapon 2', 'Helmet', 'Body Armour', 'Gloves', 'Boots', 'Amulet', 'Ring 1', 'Ring 2', 'Ring 3', 'Belt',
  'Flask 1', 'Flask 2', 'Flask 3', 'Flask 4', 'Flask 5', 'Weapon 1 Swap', 'Weapon 2 Swap',
];
const SLOT_ZH = {
  'Weapon 1': '主手', 'Weapon 2': '副手', 'Weapon 1 Swap': '主手（切換）', 'Weapon 2 Swap': '副手（切換）',
  Helmet: '頭盔', 'Body Armour': '胸甲', Gloves: '手套', Boots: '鞋子', Amulet: '項鍊',
  'Ring 1': '戒指 1', 'Ring 2': '戒指 2', 'Ring 3': '戒指 3', Belt: '腰帶',
  'Flask 1': '藥劑 1', 'Flask 2': '藥劑 2', 'Flask 3': '藥劑 3', 'Flask 4': '藥劑 4', 'Flask 5': '藥劑 5',
};

// 解析整個 build，回傳要估價的物品列表
function parseBuild(xml) {
  const build = {};
  const bm = xml.match(/<Build\b[^>]*>/);
  if (bm) {
    build.className = attr(bm[0], 'className');
    build.ascendClassName = attr(bm[0], 'ascendClassName');
    build.level = attr(bm[0], 'level');
  }
  const items = {};
  const re = /<Item\b([^>]*)>([\s\S]*?)<\/Item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = attr(`<x ${m[1]}>`, 'id');
    items[id] = parseItemText(m[2]);
  }

  const itemsTag = (xml.match(/<Items\b[^>]*>/) || [''])[0];
  const activeSet = attr(itemsTag, 'activeItemSet') || '1';
  const setRe = /<ItemSet\b([^>]*)>([\s\S]*?)<\/ItemSet>/g;
  let setBody = null;
  let firstBody = null;
  while ((m = setRe.exec(xml))) {
    if (firstBody == null) firstBody = m[2];
    if (attr(`<x ${m[1]}>`, 'id') === activeSet) setBody = m[2];
  }
  // 舊版 PoB：Slot 直接在 <Items> 底下
  if (setBody == null) setBody = firstBody || xml.slice(xml.indexOf('<Items'), xml.indexOf('</Items>'));

  const out = [];
  const seen = new Set();
  const slotRe = /<Slot\b[^>]*\/>/g;
  const slots = [];
  while ((m = slotRe.exec(setBody))) {
    const name = attr(m[0], 'name');
    const itemId = attr(m[0], 'itemId');
    if (!itemId || itemId === '0' || !name) continue;
    if (/Abyssal Socket/.test(name)) {
      slots.push({ name, itemId, label: name.replace(/ Abyssal Socket (\d)/, ' 深淵插槽 $1') });
      continue;
    }
    if (!SLOT_ORDER.includes(name)) continue; // 例如 Graft / 其他聯盟欄位
    slots.push({ name, itemId, label: SLOT_ZH[name] || name });
  }
  slots.sort((a, b) => {
    const ia = SLOT_ORDER.indexOf(a.name.replace(/ Abyssal Socket \d/, ''));
    const ib = SLOT_ORDER.indexOf(b.name.replace(/ Abyssal Socket \d/, ''));
    return ia - ib;
  });
  for (const s of slots) {
    const it = items[s.itemId];
    if (!it) continue;
    seen.add(s.itemId);
    out.push({ key: `slot:${s.name}`, slot: s.name, slotLabel: s.label, ...it });
  }

  // 天賦樹上的珠寶（只取目前使用中的天賦配置）
  const treeTag = (xml.match(/<Tree\b[^>]*>/) || [''])[0];
  const activeSpec = +(attr(treeTag, 'activeSpec') || 1);
  const specRe = /<Spec\b[^>]*>([\s\S]*?)<\/Spec>/g;
  let idx = 0;
  let specBody = null;
  while ((m = specRe.exec(xml))) {
    idx++;
    if (idx === activeSpec) specBody = m[1];
  }
  if (specBody) {
    const sockRe = /<Socket\b[^>]*\/>/g;
    let n = 0;
    while ((m = sockRe.exec(specBody))) {
      const itemId = attr(m[0], 'itemId');
      if (!itemId || itemId === '0' || !items[itemId] || seen.has(itemId)) continue;
      seen.add(itemId);
      n++;
      out.push({ key: `tree:${attr(m[0], 'nodeId')}`, slot: 'Jewel', slotLabel: `天賦珠寶 ${n}`, ...items[itemId] });
    }
  }
  return { build, items: out };
}

async function loadBuild(input) {
  const code = await fetchPobCode(input);
  const xml = decodePobCode(code);
  return parseBuild(xml);
}

module.exports = { loadBuild, parseBuild, decodePobCode, parseItemText, UA };
