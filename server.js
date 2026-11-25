'use strict';
// PoE Build 裝備查價工具 — 本機伺服器
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { loadBuild } = require('./lib/pob');
const trade = require('./lib/trade');

// 打包成 exe 時網頁從內嵌資源讀取，否則讀 public/index.html
function readIndexHtml() {
  try {
    const sea = require('node:sea');
    if (sea.isSea()) return sea.getAsset('index.html', 'utf8');
  } catch {}
  return fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
}

const jobs = new Map();
let jobSeq = 0;
let currentJob = null;

async function runJob(job, { league, status, pct, items, interval }) {
  const send = (o) => job.events.push(o);
  trade.setSearchInterval(interval);
  const onWait = (ms, kind) => send({ type: 'wait', seconds: Math.ceil(ms / 1000), kind });
  onWait.isCancelled = () => job.cancelled;
  try {
    let divine = null;
    try {
      divine = await trade.getDivineRate(league, onWait);
    } catch (e) {
      if (job.cancelled) throw e;
      send({ type: 'warn', message: `取得神聖石匯率失敗：${e.message}` });
    }
    send({ type: 'rate', divine });
    for (const it of items || []) {
      if (job.cancelled) break;
      send({ type: 'start', key: it.key });
      try {
        const r = await trade.priceItem(it, { league, status, pct, divine }, onWait);
        send({ type: 'item', key: it.key, result: r });
      } catch (e) {
        if (job.cancelled) break;
        send({ type: 'item', key: it.key, result: { error: e.message } });
      }
    }
  } catch (e) {
    if (!job.cancelled) send({ type: 'warn', message: e.message });
  }
  send({ type: job.cancelled ? 'stopped' : 'done' });
  job.done = true;
  // 舊工作 30 分鐘後清掉
  setTimeout(() => jobs.delete(job.id), 30 * 60e3);
}

const PORT = +(process.env.PORT || 5577);
const HOST = '127.0.0.1';

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(readIndexHtml());
    }
    // 新開的程式要取代舊的時使用（自訂標頭讓一般網頁無法跨站呼叫）
    if (req.method === 'POST' && req.url === '/api/shutdown' && req.headers['x-shutdown'] === '1') {
      sendJson(res, 200, { ok: true });
      console.log('\n  已改用新開啟的查價視窗，這個舊視窗會自動關閉。');
      setTimeout(() => process.exit(0), 200);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/leagues') {
      return sendJson(res, 200, await trade.getLeagues());
    }
    if (req.method === 'POST' && req.url === '/api/parse') {
      const { input } = await readBody(req);
      const b = await loadBuild(input);
      for (const it of b.items) {
        try {
          Object.assign(it, await trade.translateItem(it));
        } catch (e) {
          console.warn('翻譯失敗：', e.message);
        }
      }
      return sendJson(res, 200, b);
    }
    // 查價改成背景工作 + 前端輪詢：限流等待可能長達數分鐘，長時間閒置的串流連線容易被中斷
    if (req.method === 'POST' && req.url === '/api/price') {
      const body = await readBody(req);
      if (currentJob) currentJob.cancelled = true; // 同時只跑一個，避免重複消耗官方額度
      const job = { id: String(++jobSeq), events: [], cancelled: false, done: false };
      currentJob = job;
      jobs.set(job.id, job);
      runJob(job, body);
      return sendJson(res, 200, { id: job.id });
    }
    let m;
    if (req.method === 'GET' && (m = req.url.match(/^\/api\/job\/(\d+)\?from=(\d+)$/))) {
      const job = jobs.get(m[1]);
      if (!job) return sendJson(res, 404, { error: '查價工作不存在（程式可能已重新啟動），請重新查價' });
      return sendJson(res, 200, { events: job.events.slice(+m[2]), done: job.done });
    }
    if (req.method === 'POST' && (m = req.url.match(/^\/api\/job\/(\d+)\/stop$/))) {
      const job = jobs.get(m[1]);
      if (job) job.cancelled = true;
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let retries = 0;
const IS_EXE = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
process.title = 'PoE 裝備查價（查價期間請勿關閉此視窗）';

// 發生無法繼續的錯誤：顯示中文說明，exe 版停住等使用者看完（bat 版有 pause）
function fatal(lines) {
  console.error('\n  ========================================');
  for (const l of [].concat(lines)) console.error('  ' + l);
  console.error('  ========================================\n');
  process.exitCode = 1;
  if (IS_EXE) {
    console.error('  按 Enter 關閉此視窗…');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  }
}
process.on('uncaughtException', (e) => fatal(['程式發生未預期的錯誤：', e && e.message, '請重新開啟程式；若一直發生，請把這個畫面截圖給提供工具的人。']));
process.on('unhandledRejection', (e) => console.error('[警告]', e && e.message));

// 埠被占用：若是舊的查價程式（例如沒關掉的視窗）就自動關掉並取代；其他程式則提示
server.on('error', async (e) => {
  if (e.code !== 'EADDRINUSE') return fatal(['無法啟動：' + e.message]);
  if (retries >= 3) return fatal(['無法啟動：已經有另一個查價視窗在執行。', '請關閉其他「PoE 裝備查價」黑色視窗後再開一次。']);
  retries++;
  const base = `http://127.0.0.1:${PORT}`;
  const isOurs = await fetch(base + '/', { signal: AbortSignal.timeout(3000) })
    .then((r) => r.text())
    .then((t) => t.includes('PoE Build 裝備查價') || t.includes('PoE 裝備查價'))
    .catch(() => false);
  if (!isOurs) {
    return fatal([`無法啟動：電腦上有其他程式占用了 ${PORT} 埠。`, '請重新開機後再試；或請提供工具的人協助更換埠號（PORT）。']);
  }
  console.log('  偵測到舊的查價視窗仍在執行，自動關閉並改用這個新視窗…');
  await fetch(base + '/api/shutdown', { method: 'POST', headers: { 'X-Shutdown': '1' }, signal: AbortSignal.timeout(3000) }).catch(() => {});
  await sleep(800);
  // 舊版沒有 shutdown 指令：找出占用此埠的 PID 結束它（已確認是本工具）
  try {
    const out = require('child_process').execSync('netstat -ano -p tcp', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      const m = line.trim().split(/\s+/);
      if (m[1] === `${HOST}:${PORT}` && /LISTEN/i.test(m[3]) && +m[4] !== process.pid) {
        require('child_process').execSync(`taskkill /PID ${m[4]} /F`, { stdio: 'ignore' });
      }
    }
  } catch {}
  await sleep(800);
  server.listen(PORT, HOST);
});

server.on('listening', () => {
  const url = `http://localhost:${PORT}/`;
  console.log('');
  console.log('  ========================================');
  console.log('     PoE 裝備查價  已啟動');
  console.log('  ========================================');
  console.log('');
  console.log('  瀏覽器會自動開啟查價網頁。');
  console.log(`  如果沒有開啟，請手動在瀏覽器輸入：${url}`);
  console.log('');
  console.log('  ※ 查價期間請不要關閉這個黑色視窗（可以縮小）。');
  console.log('  ※ 用完直接關閉這個視窗即可。');
  console.log('');
  if (!process.env.NO_OPEN) exec(`start "" "${url}"`);
});

server.listen(PORT, HOST);
