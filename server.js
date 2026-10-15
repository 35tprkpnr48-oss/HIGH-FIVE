// Otoyol Sürücüsü - otomatik eşleşmeli 1v1 yarış sunucusu
// Bağımlılık yok: sadece Node.js 16+ gerekir.   Çalıştır:  node server.js
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const PORT = +process.env.PORT || 8080, GOAL = +process.env.GOAL || 4000, MAX_CLIENTS = 400, MAX_MATCH_MS = 10 * 60 * 1000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let queue = [], matches = 0, played = 0, clients = 0;
const live = new Set();

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ queue: queue.length, matches, played, clients })); }
  fs.readFile(path.join(__dirname, 'oyun.html'), (err, data) => {   // oyun.html aynı klasördeyse telefonlar oyunu buradan açar
    if (!err && (req.url === '/' || req.url.startsWith('/?'))) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(data); }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Otoyol Surucusu sunucusu calisiyor. Bekleyen: ' + queue.length + ', aktif mac: ' + matches);
  });
});

function frame(str) {
  const b = Buffer.from(str);
  const h = b.length < 126 ? Buffer.from([0x81, b.length]) : Buffer.from([0x81, 126, b.length >> 8, b.length & 255]);
  return Buffer.concat([h, b]);
}
function raw(c, buf) { if (c.open) try { c.sock.write(buf); } catch (_) {} }
function send(c, obj) { raw(c, frame(JSON.stringify(obj))); }

function endMatch(m, winnerSlot, why) {
  if (!m || m.done) return;
  m.done = true; matches--; played++;
  clearInterval(m.timer); clearTimeout(m.limit);
  const ms = m.t0 ? Date.now() - m.t0 : 0;
  for (const c of m.p) if (c && c.open) send(c, { t: 'end', w: winnerSlot, ms, why });
  for (const c of m.p) if (c) c.match = null;
}
function leave(c) {
  queue = queue.filter(x => x !== c);
  const m = c.match;
  if (m && !m.done) { const other = m.p[1 - c.slot]; endMatch(m, other ? other.slot : -1, 'left'); }
}
function drop(c) {
  if (!c.open) return;
  c.open = false; live.delete(c); clients--;
  leave(c);
  try { c.sock.destroy(); } catch (_) {}
}
function clean(d) {
  const n = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(+x) ? +x : 0));
  return {
    n: String(d.n || 'Oyuncu').replace(/[\u0000-\u001f<>&"']/g, '').slice(0, 14) || 'Oyuncu',
    c: n(d.c, 0, 9) | 0, col: (n(d.col, 0, 0xffffff)) | 0
  };
}
function startMatch(a, b) {
  const m = { p: [a, b], state: 'cd', done: false, t0: 0, last: [0, 0] };
  matches++; a.match = m; b.match = m; a.slot = 0; b.slot = 1;
  send(a, { t: 'm', slot: 0, opp: b.info, goal: GOAL });
  send(b, { t: 'm', slot: 1, opp: a.info, goal: GOAL });
  let n = 5;
  const tick = () => {
    if (m.done) return;
    if (n > 0) { for (const c of m.p) send(c, { t: 'cd', n }); n--; return; }
    m.state = 'race'; m.t0 = Date.now(); for (const c of m.p) send(c, { t: 'go' });
    clearInterval(m.timer);
  };
  m.timer = setInterval(tick, 1000); tick();
  m.limit = setTimeout(() => endMatch(m, m.last[0] >= m.last[1] ? 0 : 1, 'time'), MAX_MATCH_MS);
  console.log('esleşme:', a.info.n, 'vs', b.info.n);
}
function onMsg(c, txt) {
  let m; try { m = JSON.parse(txt); } catch (_) { return; }
  if (m.t === 'find') {
    leave(c); c.info = clean(m);
    const other = queue.shift();
    if (other && other.open && other !== c) startMatch(other, c);
    else { queue = [c]; send(c, { t: 'q' }); }
  } else if (m.t === 's' && c.match && !c.match.done) {
    const d = m.d; if (!Array.isArray(d) || d.length !== 6) return;
    const x = Math.max(-50, Math.min(50, +d[0] || 0)), z = Math.max(-1e6, Math.min(1e6, +d[1] || 0)), s = Math.max(0, Math.min(200, +d[2] || 0));
    c.match.last[c.slot] = z;
    const other = c.match.p[1 - c.slot];
    if (other) send(other, { t: 'o', d: [x, z, s, Math.max(-1, Math.min(1, +d[3] || 0)), Math.max(-1, Math.min(1, +d[4] || 0)), d[5] ? 1 : 0] });
  } else if (m.t === 'fin' && c.match && c.match.state === 'race' && !c.match.done) {
    if (c.match.last[c.slot] >= GOAL - 80) endMatch(c.match, c.slot, 'finish');
  } else if (m.t === 'cancel') leave(c);
}
function pump(c) {
  while (c.open && c.buf.length >= 2) {
    const b = c.buf, fin = b[0] & 128, op = b[0] & 15, masked = b[1] & 128;
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) return drop(c);
    if (!masked || !fin || len > 1024) return drop(c);
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4), pl = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) pl[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    const now = Date.now(); if (now - c.mt > 1000) { c.mt = now; c.k = 0; } if (++c.k > 50) return drop(c);
    if (op === 1) onMsg(c, pl.toString('utf8'));
    else if (op === 8) return drop(c);
    else if (op === 9) raw(c, Buffer.concat([Buffer.from([0x8a, len]), pl]));
  }
}
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || clients >= MAX_CLIENTS) return sock.destroy();
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const c = { sock, buf: Buffer.alloc(0), open: true, mt: Date.now(), k: 0, match: null, slot: 0, info: null, seen: Date.now() };
  clients++; live.add(c); sock.setNoDelay(true); sock.setKeepAlive(true, 15000);
  sock.on('data', ch => { c.seen = Date.now(); c.buf = Buffer.concat([c.buf, ch]); if (c.buf.length > 4096) return drop(c); pump(c); });
  sock.on('close', () => drop(c)); sock.on('error', () => drop(c));
});
setInterval(() => { const now = Date.now(); for (const c of [...live]) if (now - c.seen > 15000) drop(c); }, 5000);   // 15 sn sessiz kalanı at
if (require.main === module) server.listen(PORT, () => console.log('Sunucu hazir: port ' + PORT + ', hedef ' + GOAL + ' m'));
module.exports = server;
