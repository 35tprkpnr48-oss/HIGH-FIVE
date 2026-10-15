
 // Otoyol Sürücüsü - WebSocket yarış sunucusu + arkadaş sistemi + yönetici paneli
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 8080;
const GOAL = Number(process.env.GOAL) || 4000;
const MAX_CLIENTS = 400;
const MAX_MATCH_MS = 10 * 60 * 1000;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let queue = [];
let matches = 0;
let played = 0;
let clients = 0;
let nextClientId = 1;
const live = new Set();

const sessions = new Map();
const loginAttempts = new Map();
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";

const friendsByNick = new Map();
const onlineByNick = new Map();
const bannedNicknames = new Set();
const DATA_FILE = path.join(__dirname, "otoyol-data.json");
const DEFAULT_PRICES = [0, 5000, 20000, 70000, 160000, 450000];

let dataStore = {
  players: {},
  prices: DEFAULT_PRICES.slice(),
  banned: [],
  announcement: ""
};

try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (loaded && typeof loaded === "object") {
    dataStore = { ...dataStore, ...loaded };
  }
} catch (_) {}

if (!Array.isArray(dataStore.prices) ||
    dataStore.prices.length !== DEFAULT_PRICES.length) {
  dataStore.prices = DEFAULT_PRICES.slice();
}
if (!dataStore.players || typeof dataStore.players !== "object") {
  dataStore.players = {};
}
if (!Array.isArray(dataStore.banned)) dataStore.banned = [];

const persistData = () => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(dataStore, null, 2));
  } catch (e) {
    console.warn("Veri kaydedilemedi:", e.message);
  }
};

for (const n of dataStore.banned) bannedNicknames.add(String(n));
let announcement = String(dataStore.announcement || "");

const cleanNick = v =>
  String(v || "")
    .replace(/[<>\u0000-\u001f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 18);

const keyNick = v => cleanNick(v).toLocaleLowerCase("tr-TR");

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

function readBody(req, cb) {
  let data = "";
  req.on("data", chunk => {
    data += chunk;
    if (data.length > 20000) req.destroy();
  });
  req.on("end", () => {
    try {
      cb(JSON.parse(data || "{}"));
    } catch (_) {
      if (req._res) json(req._res, 400, { error: "Geçersiz JSON." });
    }
  });
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const item of cookies) {
    const i = item.indexOf("=");
    if (i >= 0 && item.slice(0, i).trim() === name) {
      return decodeURIComponent(item.slice(i + 1).trim());
    }
  }
  return "";
}

function adminOk(req) {
  const token = cookieValue(req, "otoyol_admin");
  const exp = sessions.get(token);
  if (!token || !exp || exp < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function adminOnly(req, res) {
  if (adminOk(req)) return true;
  json(res, 401, { error: "Yönetici girişi gerekli." });
  return false;
}

function adminLogin(req, res, body) {
  const ip = String(
    req.headers["x-forwarded-for"] ||
    req.socket.remoteAddress ||
    "unknown"
  ).split(",")[0].trim();

  const now = Date.now();
  const a = loginAttempts.get(ip) || { count: 0, until: 0 };

  if (a.until > now) {
    return json(res, 429, {
      error: "Çok fazla deneme. 10 dakika sonra tekrar dene."
    });
  }

  if (
    !ADMIN_USERNAME ||
    ADMIN_PASSWORD.length < 16 ||
    SESSION_SECRET.length < 32 ||
    !safeEqual(body.username, ADMIN_USERNAME) ||
    !safeEqual(body.password, ADMIN_PASSWORD)
  ) {
    a.count++;
    if (a.count >= 5) {
      a.count = 0;
      a.until = now + 10 * 60 * 1000;
    }
    loginAttempts.set(ip, a);
    return json(res, 401, {
      error: "Kullanıcı adı veya parola yanlış. Sunucu ayarlarını kontrol et."
    });
  }

  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, now + 2 * 60 * 60 * 1000);

  const secure =
    req.headers["x-forwarded-proto"] === "https" ||
    req.socket.encrypted
      ? "; Secure"
      : "";

  json(res, 200, { ok: true }, {
    "set-cookie":
      `otoyol_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200${secure}`
  });
}

function accountFor(nickname, initialMoney) {
  const nicknameClean = cleanNick(nickname);
  const k = keyNick(nicknameClean);

  if (!dataStore.players[k]) {
    dataStore.players[k] = {
      nickname: nicknameClean,
      money: Math.max(
        0,
        Math.min(1000000000, Math.floor(Number(initialMoney) || 0))
      ),
      updatedAt: new Date().toISOString()
    };
  } else if (
    nicknameClean &&
    dataStore.players[k].nickname !== nicknameClean
  ) {
    dataStore.players[k].nickname = nicknameClean;
  }

  return dataStore.players[k];
}

function socketsForNick(nickname) {
  const r = onlineByNick.get(keyNick(nickname));
  return r ? [...r.sockets].filter(c => c.open) : [];
}

function setPlayerMoney(nickname, amount) {
  const a = accountFor(nickname, 0);
  a.money = Math.max(
    0,
    Math.min(1000000000, Math.floor(Number(amount) || 0))
  );
  a.updatedAt = new Date().toISOString();
  persistData();

  for (const c of socketsForNick(a.nickname)) {
    send(c, {
      t: "economy:balance",
      money: a.money,
      nickname: a.nickname
    });
  }
  return a;
}

function adminState() {
  const online = new Map();

  for (const c of live) {
    const n = (c.info && c.info.n) ||
      (c.friendRecord && c.friendRecord.nickname) || "";
    if (!n) continue;
    const k = keyNick(n);
    if (!online.has(k)) online.set(k, []);
    online.get(k).push(c);
  }

  const players = Object.entries(dataStore.players).map(([k, a]) => {
    const ss = online.get(k) || [];
    return {
      nickname: a.nickname,
      money: Number(a.money) || 0,
      online: ss.length > 0,
      onlineCount: ss.length,
      id: ss.length ? String(ss[0].id) : "",
      joinedAt: ss.length
        ? new Date(ss[0].connectedAt).toISOString()
        : "",
      updatedAt: a.updatedAt || ""
    };
  });

  for (const [k, ss] of online) {
    if (!dataStore.players[k]) {
      const n = (ss[0].info && ss[0].info.n) ||
        (ss[0].friendRecord && ss[0].friendRecord.nickname) ||
        "Oyuncu";
      const a = accountFor(n, 0);
      players.push({
        nickname: a.nickname,
        money: a.money,
        online: true,
        onlineCount: ss.length,
        id: String(ss[0].id),
        joinedAt: new Date(ss[0].connectedAt).toISOString(),
        updatedAt: a.updatedAt || ""
      });
    }
  }

  return {
    players,
    queue: queue.length,
    matches,
    played,
    clients,
    announcement,
    prices: dataStore.prices.slice(),
    banned: dataStore.banned.slice()
  };
}

function handleHttp(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { queue: queue.length, matches, played, clients });
  }

  if (req.method === "GET" && url.pathname === "/api/economy/prices") {
    return json(res, 200, { prices: dataStore.prices.slice() });
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/admin" || url.pathname === "/admin.html")
  ) {
    return fs.readFile(path.join(__dirname, "admin.html"), (e, d) => {
      if (e) {
        res.writeHead(500);
        return res.end("Admin sayfası bulunamadı.");
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(d);
    });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/state") {
    if (!adminOnly(req, res)) return;
    return json(res, 200, adminState());
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/admin/")) {
    req._res = res;
    return readBody(req, body => {
      if (url.pathname === "/api/admin/login") {
        return adminLogin(req, res, body);
      }

      if (url.pathname === "/api/admin/logout") {
        const token = cookieValue(req, "otoyol_admin");
        sessions.delete(token);
        return json(res, 200, { ok: true }, {
          "set-cookie":
            "otoyol_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
        });
      }

      if (!adminOnly(req, res)) return;

      if (url.pathname === "/api/admin/state") {
        return json(res, 200, adminState());
      }

      if (url.pathname === "/api/admin/economy") {
        const nickname = cleanNick(body.nickname);
        if (nickname.length < 2) {
          return json(res, 400, { error: "Oyuncu takma adını yaz." });
        }

        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || Math.abs(amount) > 1000000000) {
          return json(res, 400, {
            error: "Geçerli bir miktar yaz (en fazla 1.000.000.000)."
          });
        }

        const a = accountFor(nickname, 0);
        let next = Math.floor(amount);
        if (body.mode === "add") next = a.money + next;
        else if (body.mode === "subtract") next = a.money - next;

        const updated = setPlayerMoney(nickname, next);
        return json(res, 200, { ok: true, player: updated });
      }

      if (url.pathname === "/api/admin/prices") {
        if (
          !Array.isArray(body.prices) ||
          body.prices.length !== DEFAULT_PRICES.length
        ) {
          return json(res, 400, {
            error: "Altı araç için fiyat girilmeli."
          });
        }

        const prices = body.prices.map(Number);
        if (
          prices.some(v =>
            !Number.isFinite(v) || v < 0 || v > 1000000000
          )
        ) {
          return json(res, 400, {
            error: "Fiyatlar 0 ile 1.000.000.000 arasında olmalı."
          });
        }

        dataStore.prices = prices.map(Math.floor);
        persistData();

        for (const c of live) {
          if (c.friendRecord) {
            send(c, { t: "economy:prices", prices: dataStore.prices });
          }
        }
        return json(res, 200, { ok: true, prices: dataStore.prices });
      }

      if (url.pathname === "/api/admin/kick") {
        const nickname = cleanNick(body.nickname || "");
        const k = keyNick(nickname);
        const targets = body.nickname
          ? [...live].filter(x =>
              keyNick(
                (x.info && x.info.n) ||
                (x.friendRecord && x.friendRecord.nickname) || ""
              ) === k
            )
          : [...live].filter(x => String(x.id) === String(body.id || ""));

        if (!targets.length) {
          return json(res, 404, {
            error: "Oyuncu bulunamadı veya çevrimdışı."
          });
        }

        for (const c of targets) {
          send(c, {
            t: "admin:kick",
            message: "Yönetici tarafından bağlantın kesildi."
          });
          drop(c);
        }
        return json(res, 200, { ok: true, count: targets.length });
      }

      if (url.pathname === "/api/admin/ban") {
        const n = cleanNick(body.nickname);
        const k = keyNick(n);
        if (n.length < 2) {
          return json(res, 400, { error: "Takma ad gerekli." });
        }

        bannedNicknames.add(k);
        if (!dataStore.banned.includes(k)) dataStore.banned.push(k);
        persistData();

        for (const c of [...live]) {
          if (
            keyNick(
              (c.info && c.info.n) ||
              (c.friendRecord && c.friendRecord.nickname) || ""
            ) === k
          ) drop(c);
        }

        return json(res, 200, {
          ok: true,
          note: "Engel listesi kaydedildi."
        });
      }

      if (url.pathname === "/api/admin/unban") {
        const n = cleanNick(body.nickname);
        const k = keyNick(n);
        bannedNicknames.delete(k);
        dataStore.banned = dataStore.banned.filter(x => x !== k);
        persistData();
        return json(res, 200, { ok: true });
      }

      if (url.pathname === "/api/admin/announcement") {
        announcement = String(body.message || "").trim().slice(0, 240);
        dataStore.announcement = announcement;
        persistData();

        for (const c of live) {
          send(c, { t: "server:announcement", message: announcement });
        }
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: "Adres bulunamadı." });
    });
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/" || url.pathname === "/index.html")
  ) {
    return fs.readFile(path.join(__dirname, "oyun.html"), (err, data) => {
      if (!err) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-cache"
        });
        return res.end(data);
      }
      res.writeHead(500);
      res.end("oyun.html bulunamadı");
    });
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Bulunamadı. Oyun: / Admin: /admin");
}

const server = http.createServer(handleHttp);

function frame(str) {
  const b = Buffer.from(str);
  if (b.length < 126) {
    return Buffer.concat([Buffer.from([0x81, b.length]), b]);
  }
  if (b.length < 65536) {
    const h = Buffer.alloc(4);
    h[0] = 0x81;
    h[1] = 126;
    h.writeUInt16BE(b.length, 2);
    return Buffer.concat([h, b]);
  }
  return Buffer.alloc(0);
}

function raw(c, buf) {
  if (c.open) {
    try { c.sock.write(buf); } catch (_) {}
  }
}

function send(c, obj) {
  raw(c, frame(JSON.stringify(obj)));
}

function sendFriendState(r) {
  const state = {
    t: "friend:state",
    incoming: [...r.incoming],
    friends: [...r.friends],
    outgoing: [...r.outgoing]
  };
  for (const c of r.sockets) if (c.open) send(c, state);
}

function notice(c, message) {
  if (c && c.open) send(c, { t: "friend:notice", message });
}

function friendError(c, message) {
  send(c, { t: "friend:error", message });
}

function findOnlineNick(n) {
  return onlineByNick.get(keyNick(n)) || null;
}

function identifyFriend(c, nick, initialMoney) {
  nick = cleanNick(nick);
  const k = keyNick(nick);

  if (nick.length < 2) {
    return friendError(c, "Takma ad en az 2 karakter olmalı.");
  }
  if (bannedNicknames.has(k)) {
    return friendError(c, "Bu takma ad engellendi.");
  }

  if (c.friendRecord && keyNick(c.friendRecord.nickname) !== k) {
    const previous = c.friendRecord;
    previous.sockets.delete(c);
    if (
      !previous.sockets.size &&
      onlineByNick.get(keyNick(previous.nickname)) === previous
    ) onlineByNick.delete(keyNick(previous.nickname));
    c.friendRecord = null;
  }

  let r = friendsByNick.get(k);
  const current = onlineByNick.get(k);
  if (current && current !== r) {
    return friendError(c, "Bu takma ad şu anda kullanımda.");
  }

  if (!r) {
    r = {
      nickname: nick,
      friends: new Set(),
      incoming: new Set(),
      outgoing: new Set(),
      sockets: new Set()
    };
    friendsByNick.set(k, r);
  }

  r.sockets.add(c);
  r.lastSeen = Date.now();
  c.friendRecord = r;
  onlineByNick.set(k, r);

  const acct = accountFor(nick, initialMoney);
  persistData();

  sendFriendState(r);
  send(c, {
    t: "economy:state",
    nickname: acct.nickname,
    money: acct.money,
    prices: dataStore.prices
  });

  if (announcement) {
    send(c, { t: "server:announcement", message: announcement });
  }
}

function friendMessage(c, m) {
  const me = c.friendRecord;

  if (m.t === "friend:identify") {
    return identifyFriend(c, m.n, m.money);
  }
  if (!me) return friendError(c, "Önce takma adını kaydet.");

  if (m.t === "economy:balance") {
    const v = Number(m.money);
    if (!Number.isFinite(v)) return;
    const a = accountFor(me.nickname, 0);
    a.money = Math.max(0, Math.min(1000000000, Math.floor(v)));
    a.updatedAt = new Date().toISOString();
    persistData();
    return;
  }

  const n = cleanNick(m.n);
  const target = findOnlineNick(n);

  if (m.t === "friend:request") {
    if (!target) {
      return friendError(c, "Bu takma ad çevrimiçi değil veya bulunamadı.");
    }
    if (target === me) {
      return friendError(c, "Kendine istek gönderemezsin.");
    }
    if (me.friends.has(target.nickname)) {
      return friendError(c, "Zaten arkadaşsınız.");
    }
    if (me.outgoing.has(target.nickname)) {
      return friendError(c, "Bu istek zaten gönderildi.");
    }

    me.outgoing.add(target.nickname);
    target.incoming.add(me.nickname);
    sendFriendState(me);
    sendFriendState(target);
    notice(c, "Arkadaşlık isteği gönderildi.");

    for (const s of target.sockets) {
      notice(s, me.nickname + " sana arkadaşlık isteği gönderdi.");
    }
    return;
  }

  if (m.t === "friend:accept") {
    if (!target || !me.incoming.has(target.nickname)) {
      return friendError(c, "Gelen istek bulunamadı.");
    }
    me.incoming.delete(target.nickname);
    target.outgoing.delete(me.nickname);
    me.friends.add(target.nickname);
    target.friends.add(me.nickname);
    sendFriendState(me);
    sendFriendState(target);
    return notice(c, "Arkadaş eklendi.");
  }

  if (m.t === "friend:decline") {
    me.incoming.delete(n);
    if (target) target.outgoing.delete(me.nickname);
    sendFriendState(me);
    if (target) sendFriendState(target);
    return;
  }

  if (m.t === "friend:remove") {
    me.friends.delete(n);
    if (target) {
      target.friends.delete(me.nickname);
      sendFriendState(target);
    }
    sendFriendState(me);
  }
}

function endMatch(m, winnerSlot, why) {
  if (!m || m.done) return;
  m.done = true;
  matches--;
  played++;
  clearInterval(m.timer);
  clearTimeout(m.limit);

  const ms = m.t0 ? Date.now() - m.t0 : 0;
  for (const c of m.p) {
    if (c && c.open) send(c, { t: "end", w: winnerSlot, ms, why });
  }
  for (const c of m.p) if (c) c.match = null;
}

function leave(c) {
  queue = queue.filter(x => x !== c);
  const m = c.match;
  if (m && !m.done) {
    const other = m.p[1 - c.slot];
    endMatch(m, other ? other.slot : -1, "left");
  }
}

function drop(c) {
  if (!c.open) return;
  c.open = false;
  live.delete(c);
  clients--;
  leave(c);

  if (c.friendRecord) {
    const r = c.friendRecord;
    r.sockets.delete(c);
    if (!r.sockets.size) {
      if (onlineByNick.get(keyNick(r.nickname)) === r) {
        onlineByNick.delete(keyNick(r.nickname));
      }
      r.lastSeen = Date.now();
    }
    c.friendRecord = null;
  }

  try { c.sock.destroy(); } catch (_) {}
}

function clean(d) {
  const n = (x, a, b) =>
    Math.max(a, Math.min(b, Number.isFinite(+x) ? +x : 0));

  return {
    n: cleanNick(d.n || "Oyuncu").slice(0, 14) || "Oyuncu",
    c: n(d.c, 0, 9) | 0,
    col: n(d.col, 0, 0xffffff) | 0
  };
}

function startMatch(a, b) {
  const m = {
    p: [a, b],
    state: "cd",
    done: false,
    t0: 0,
    last: [0, 0]
  };

  matches++;
  a.match = m;
  b.match = m;
  a.slot = 0;
  b.slot = 1;

  send(a, { t: "m", slot: 0, opp: b.info, goal: GOAL });
  send(b, { t: "m", slot: 1, opp: a.info, goal: GOAL });

  let n = 5;
  const tick = () => {
    if (m.done) return;
    if (n > 0) {
      for (const c of m.p) send(c, { t: "cd", n });
      n--;
      return;
    }

    m.state = "race";
    m.t0 = Date.now();
    for (const c of m.p) send(c, { t: "go" });
    clearInterval(m.timer);
  };

  m.timer = setInterval(tick, 1000);
  tick();

  m.limit = setTimeout(() => {
    endMatch(m, m.last[0] >= m.last[1] ? 0 : 1, "time");
  }, MAX_MATCH_MS);

  console.log("eşleşme:", a.info.n, "vs", b.info.n);
}

function onMsg(c, txt) {
  let m;
  try { m = JSON.parse(txt); } catch (_) { return; }
  if (!m || typeof m !== "object") return;

  if (
    typeof m.t === "string" &&
    (m.t.startsWith("friend:") || m.t.startsWith("economy:"))
  ) return friendMessage(c, m);

  if (m.t === "ping") {
    send(c, { t: "pong" });
    return;
  }

  if (m.t === "find") {
    leave(c);
    c.info = clean(m);

    if (bannedNicknames.has(keyNick(c.info.n))) {
      send(c, { t: "admin:kick", message: "Takma ad engellendi." });
      return drop(c);
    }

    const other = queue.shift();
    if (other && other.open && other !== c) {
      startMatch(other, c);
    } else {
      queue = [c];
      send(c, { t: "q" });
    }
  } else if (m.t === "s" && c.match && !c.match.done) {
    const d = m.d;
    if (!Array.isArray(d) || d.length !== 6) return;

    const x = Math.max(-50, Math.min(50, +d[0] || 0));
    const z = Math.max(-1e6, Math.min(1e6, +d[1] || 0));
    const s = Math.max(0, Math.min(200, +d[2] || 0));
    c.match.last[c.slot] = z;

    const other = c.match.p[1 - c.slot];
    if (other) {
      send(other, {
        t: "o",
        d: [
          x, z, s,
          Math.max(-1, Math.min(1, +d[3] || 0)),
          Math.max(-1, Math.min(1, +d[4] || 0)),
          d[5] ? 1 : 0
        ]
      });
    }
  } else if (
    m.t === "fin" &&
    c.match &&
    c.match.state === "race" &&
    !c.match.done
  ) {
    if (c.match.last[c.slot] >= GOAL - 80) {
      endMatch(c.match, c.slot, "finish");
    }
  } else if (m.t === "cancel") {
    leave(c);
  }
}

function pump(c) {
  while (c.open && c.buf.length >= 2) {
    const b = c.buf;
    const fin = b[0] & 128;
    const op = b[0] & 15;
    const masked = b[1] & 128;
    let len = b[1] & 127;
    let off = 2;

    if (len === 126) {
      if (b.length < 4) return;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      return drop(c);
    }

    if (!masked || !fin || len > 1024) return drop(c);
    if (b.length < off + 4 + len) return;

    const mask = b.subarray(off, off + 4);
    const pl = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) pl[i] ^= mask[i & 3];

    c.buf = b.subarray(off + 4 + len);

    const now = Date.now();
    if (now - c.mt > 1000) {
      c.mt = now;
      c.k = 0;
    }
    if (++c.k > 50) return drop(c);

    if (op === 1) onMsg(c, pl.toString("utf8"));
    else if (op === 8) return drop(c);
    else if (op === 9) {
      raw(c, Buffer.concat([Buffer.from([0x8a, len]), pl]));
    }
  }
}

server.on("upgrade", (req, sock) => {
  const key = req.headers["sec-websocket-key"];

  if (
    !key ||
    String(req.headers.upgrade || "").toLowerCase() !== "websocket" ||
    clients >= MAX_CLIENTS
  ) return sock.destroy();

  const accept = crypto
    .createHash("sha1")
    .update(key + GUID)
    .digest("base64");

  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );

  const c = {
    id: nextClientId++,
    sock,
    buf: Buffer.alloc(0),
    open: true,
    mt: Date.now(),
    k: 0,
    match: null,
    slot: 0,
    info: null,
    seen: Date.now(),
    connectedAt: Date.now()
  };

  clients++;
  live.add(c);
  sock.setNoDelay(true);
  sock.setKeepAlive(true, 15000);

  sock.on("data", ch => {
    c.seen = Date.now();
    c.buf = Buffer.concat([c.buf, ch]);
    if (c.buf.length > 4096) return drop(c);
    pump(c);
  });

  sock.on("close", () => drop(c));
  sock.on("error", () => drop(c));
});

setInterval(() => {
  const now = Date.now();
  for (const c of [...live]) {
    if (now - c.seen > 15000) drop(c);
  }
  for (const [t, e] of sessions) {
    if (e < now) sessions.delete(t);
  }
}, 5000);

if (require.main === module) {
  server.listen(PORT, () => {
    console.log("Sunucu hazır: port " + PORT + ", hedef " + GOAL + " m");
    if (
      !ADMIN_USERNAME ||
      ADMIN_PASSWORD.length < 16 ||
      SESSION_SECRET.length < 32
    ) {
      console.warn(
        "Admin paneli için Render Environment Variables: " +
        "ADMIN_USERNAME, en az 16 karakter ADMIN_PASSWORD, " +
        "en az 32 karakter SESSION_SECRET ayarla."
      );
    }
  });
}

module.exports = server;
