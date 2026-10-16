// Otoyol Sürücüsü - mevcut ham WebSocket 1v1 yarış sunucusu + arkadaş sistemi + admin paneli
// Ek bağımlılık gerekmez. Node.js 16+.
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const PORT = +process.env.PORT || 8080, GOAL = +process.env.GOAL || 4000, MAX_CLIENTS = 400, MAX_MATCH_MS = 10 * 60 * 1000;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let queue = [], matches = 0, played = 0, clients = 0, nextClientId = 1;
const live = new Set();

// Admin oturumları: rastgele, HttpOnly cookie; parola yalnızca sunucu ortam değişkenlerinde tutulur.
const sessions = new Map(), loginAttempts = new Map();
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const friendsByNick = new Map(), onlineByNick = new Map(), bannedNicknames = new Set();
let announcement = '';
const cleanNick = v => String(v || '').replace(/[<>\u0000-\u001f]/g, '').trim().replace(/\s+/g, ' ').slice(0, 18);
const keyNick = v => cleanNick(v).toLocaleLowerCase('tr-TR');
const safeEqual = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// ---- EKONOMİ / KALICILIK / STATİK DOSYALAR ----
const zlib_=zlib, DATA_FILE=process.env.DATA_FILE||path.join(__dirname,'data.json'), MAXMONEY=1e9, FIRST_CAP=2e6, gLogin={count:0,until:0};
const accounts=new Map(); let prices=[0,5000,20000,70000,160000,450000], saveT=null;
const clampM=v=>Math.max(0,Math.min(MAXMONEY,Math.floor(+v)||0)), nameOf=c=>(c.friendRecord&&c.friendRecord.nickname)||(c.info&&c.info.n)||'';
try{const d=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));if(Array.isArray(d.prices)&&d.prices.length===6)prices=d.prices.map(clampM);for(const a of d.accounts||[])accounts.set(keyNick(a.nickname),{nickname:cleanNick(a.nickname),money:clampM(a.money),updatedAt:+a.updatedAt||0,lock:0,rep:Date.now()});for(const n of d.banned||[])bannedNicknames.add(keyNick(n))}catch(_){}
function persist(){if(saveT)return;saveT=setTimeout(()=>{saveT=null;try{fs.writeFileSync(DATA_FILE+'.tmp',JSON.stringify({prices,accounts:[...accounts.values()].map(a=>({nickname:a.nickname,money:a.money,updatedAt:a.updatedAt})),banned:[...bannedNicknames]}));fs.renameSync(DATA_FILE+'.tmp',DATA_FILE)}catch(e){console.warn('Kayıt yazılamadı:',e.message)}},2000)}
function pushEcon(a){const r=friendsByNick.get(keyNick(a.nickname));if(r)for(const c of r.sockets)if(c.open)send(c,{t:'economy:state',money:a.money,prices})}
function applyReport(a,v,burst){const now=Date.now();if(now<a.lock)return;const dt=Math.max(0,(now-(a.rep||now))/1000),nv=Math.min(clampM(v),a.money+Math.min(burst,dt*2500+15000));a.rep=now;if(nv!==a.money){a.money=nv;a.updatedAt=now;persist()}return nv===clampM(v)}
function econIdentify(c,nick,money){const k=keyNick(nick);let a=accounts.get(k);if(!a){a={nickname:cleanNick(nick),money:clampM(Math.min(+money||0,FIRST_CAP)),updatedAt:Date.now(),lock:0,rep:Date.now()};accounts.set(k,a);persist()}else applyReport(a,money,5e5);send(c,{t:'economy:state',money:a.money,prices})}
function econReport(c,m){const r=c.friendRecord;if(!r)return;const a=accounts.get(keyNick(r.nickname));if(a&&applyReport(a,m.money,15000)===false)pushEcon(a)}
function pubAcct(a){const r=friendsByNick.get(keyNick(a.nickname)),on=r?[...r.sockets].filter(c=>c.open):[];return{id:on[0]?String(on[0].id):'',nickname:a.nickname,online:on.length>0,money:a.money,onlineCount:on.length,updatedAt:a.updatedAt?new Date(a.updatedAt).toISOString():''}}
function adminState(){const list=[...accounts.values()].map(pubAcct),seen=new Set(list.map(p=>keyNick(p.nickname)));for(const c of live){const n=nameOf(c),k=keyNick(n);if(n&&!seen.has(k)){seen.add(k);list.push({id:String(c.id),nickname:n,online:true,money:0,onlineCount:1,updatedAt:''})}}list.sort((a,b)=>b.online-a.online||b.money-a.money);return{clients,players:list,queue:queue.length,matches,played,announcement,prices,banned:[...bannedNicknames]}}
function adminAct(p,b,res){const n=cleanNick(b.nickname),k=keyNick(n);
 if(p==='/api/admin/economy'){const amt=Math.floor(+b.amount);if(n.length<2)return json(res,400,{error:'Takma ad gerekli.'});if(!(amt>=0&&amt<=MAXMONEY))return json(res,400,{error:'Geçersiz miktar.'});if(!['add','subtract','set'].includes(b.mode))return json(res,400,{error:'Geçersiz işlem.'});let a=accounts.get(k);if(!a){a={nickname:n,money:0,updatedAt:0,lock:0,rep:Date.now()};accounts.set(k,a)}a.money=b.mode==='add'?clampM(a.money+amt):b.mode==='subtract'?clampM(a.money-amt):amt;a.updatedAt=Date.now();a.lock=Date.now()+4000;persist();pushEcon(a);return json(res,200,{ok:true,player:pubAcct(a)})}
 if(p==='/api/admin/prices'){const a=b.prices;if(!Array.isArray(a)||a.length!==6||a.some(x=>!Number.isFinite(+x)||+x<0||+x>MAXMONEY))return json(res,400,{error:'6 araç için geçerli fiyat gerekli.'});prices=a.map(x=>Math.floor(+x));persist();for(const c of live)send(c,{t:'economy:prices',prices});return json(res,200,{ok:true,prices})}
 if(p==='/api/admin/ban'||p==='/api/admin/unban'){if(n.length<2)return json(res,400,{error:'Takma ad gerekli.'});if(p.endsWith('/unban'))bannedNicknames.delete(k);else{bannedNicknames.add(k);for(const c of [...live])if(keyNick(nameOf(c))===k){send(c,{t:'admin:kick',message:'Takma ad engellendi.'});drop(c)}}persist();return json(res,200,{ok:true})}
 if(p==='/api/admin/kick'){let hit=0;for(const c of [...live])if((b.id&&String(c.id)===String(b.id))||(k&&keyNick(nameOf(c))===k)){send(c,{t:'admin:kick',message:'Yönetici tarafından bağlantın kesildi.'});drop(c);hit++}return hit?json(res,200,{ok:true}):json(res,404,{error:'Oyuncu bulunamadı.'})}}
const MODEL='public, max-age=604800', STATIC={'/':['oyun.html','text/html; charset=utf-8','no-cache',1],'/index.html':['oyun.html','text/html; charset=utf-8','no-cache',1],'/dogan.bin':['dogan.bin','application/octet-stream',MODEL],'/egea.bin':['egea.bin','application/octet-stream',MODEL],'/civic.bin':['civic.bin','application/octet-stream',MODEL]}, scache=new Map();
function staticFile(req,res,p){const e=STATIC[p];if(!e)return false;const f=path.join(__dirname,e[0]);let st;try{st=fs.statSync(f)}catch(_){res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Dosya bulunamadı: '+e[0]);return true}
 let c=scache.get(f);if(!c||c.m!==st.mtimeMs){const raw=fs.readFileSync(f);c={m:st.mtimeMs,raw,gz:e[3]?zlib_.gzipSync(raw,{level:9}):null,etag:'"'+st.mtimeMs.toString(36)+'-'+st.size.toString(36)+'"'};scache.set(f,c)}
 const h={'content-type':e[1],'cache-control':e[2],etag:c.etag,'x-content-type-options':'nosniff'};if(req.headers['if-none-match']===c.etag){res.writeHead(304,h);res.end();return true}
 const gz=c.gz&&/\bgzip\b/.test(req.headers['accept-encoding']||'');if(gz){h['content-encoding']='gzip';h.vary='accept-encoding'}res.writeHead(200,h);res.end(gz?c.gz:c.raw);return true}
function extra(req,res){const p=new URL(req.url,'http://localhost').pathname;
 if(req.method==='GET'&&p==='/api/economy/prices'){json(res,200,{prices});return true}
 if(req.method==='GET'&&p==='/api/admin/state'){if(adminOnly(req,res))json(res,200,adminState());return true}
 if(req.method==='POST'&&['/api/admin/economy','/api/admin/prices','/api/admin/unban','/api/admin/ban','/api/admin/kick'].includes(p)){req._res=res;readBody(req,body=>{if(adminOnly(req,res))adminAct(p,body,res)});return true}
 return req.method==='GET'?staticFile(req,res,p):false}

function json(res, status, data, headers={}) { const body=JSON.stringify(data); res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}); res.end(body); }
function readBody(req, cb) { let data=''; req.on('data',chunk=>{data+=chunk;if(data.length>20000){req.destroy();}}); req.on('end',()=>{try{cb(JSON.parse(data||'{}'))}catch(_){json(req._res,400,{error:'Geçersiz JSON.'})}}); }
function cookieValue(req, name) { const cookies=String(req.headers.cookie||'').split(';'); for(const item of cookies){const i=item.indexOf('=');if(i>=0&&item.slice(0,i).trim()===name)return decodeURIComponent(item.slice(i+1).trim())} return ''; }
function adminOk(req) { const token=cookieValue(req,'otoyol_admin'); const exp=sessions.get(token); if(!token||!exp||exp<Date.now()){sessions.delete(token);return false} return true; }
function adminOnly(req,res) { if(adminOk(req))return true; json(res,401,{error:'Yönetici girişi gerekli.'}); return false; }
function adminLogin(req,res,body) {
 const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',').pop().trim(), now=Date.now(), a=loginAttempts.get(ip)||{count:0,until:0};
 if(a.until>now||gLogin.until>now)return json(res,429,{error:'Çok fazla deneme. 10 dakika sonra tekrar dene.'});
 if(!ADMIN_USERNAME||ADMIN_PASSWORD.length<16||SESSION_SECRET.length<32||!safeEqual(body.username,ADMIN_USERNAME)||!safeEqual(body.password,ADMIN_PASSWORD)){
  a.count++;if(a.count>=5){a.count=0;a.until=now+10*60*1000}if(++gLogin.count>=40){gLogin.count=0;gLogin.until=now+6e5}a.t=now;loginAttempts.set(ip,a);return json(res,401,{error:'Kullanıcı adı veya parola yanlış. Sunucu ayarlarını da kontrol et.'});
 }
 loginAttempts.delete(ip);const token=crypto.randomBytes(32).toString('hex');sessions.set(token,now+2*60*60*1000);
 const secure=(req.headers['x-forwarded-proto']==='https'||req.socket.encrypted)?'; Secure':'';
 json(res,200,{ok:true},{'set-cookie':`otoyol_admin=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200${secure}`});
}
function handleHttp(req,res) {
 const url=new URL(req.url,'http://localhost');
 if(req.method==='GET'&&url.pathname==='/health'){return json(res,200,{queue:queue.length,matches,played,clients});}
 if(req.method==='GET'&&(url.pathname==='/admin'||url.pathname==='/admin.html')){return fs.readFile(path.join(__dirname,'admin.html'),(e,d)=>{if(e){res.writeHead(500);return res.end('Admin sayfası bulunamadı.')}res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-frame-options':'DENY','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});res.end(d)});}
 if(req.method==='GET'&&url.pathname==='/api/admin/state'){if(!adminOnly(req,res))return;return json(res,200,{players:[...live].map(c=>({id:String(c.id),nickname:(c.info&&c.info.n)||(c.friendRecord&&c.friendRecord.nickname)||'Bağlı oyuncu',joinedAt:new Date(c.connectedAt).toISOString()})),queue:queue.length,matches,announcement});}
 if(req.method==='POST'&&url.pathname.startsWith('/api/admin/')){
  req._res=res;return readBody(req,body=>{
   if(url.pathname==='/api/admin/login')return adminLogin(req,res,body);
   if(url.pathname==='/api/admin/logout'){const token=cookieValue(req,'otoyol_admin');sessions.delete(token);return json(res,200,{ok:true},{'set-cookie':'otoyol_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'});}
   if(!adminOnly(req,res))return;
   if(url.pathname==='/api/admin/state')return json(res,200,{players:[...live].map(c=>({id:String(c.id),nickname:(c.info&&c.info.n)||(c.friendRecord&&c.friendRecord.nickname)||'Bağlı oyuncu',joinedAt:new Date(c.connectedAt).toISOString()})),queue:queue.length,matches,announcement});
   if(url.pathname==='/api/admin/kick'){const c=[...live].find(x=>String(x.id)===String(body.id||''));if(!c)return json(res,404,{error:'Oyuncu bulunamadı.'});send(c,{t:'admin:kick',message:'Yönetici tarafından bağlantın kesildi.'});drop(c);return json(res,200,{ok:true});}
   if(url.pathname==='/api/admin/ban'){const n=cleanNick(body.nickname),k=keyNick(n);if(n.length<2)return json(res,400,{error:'Takma ad gerekli.'});bannedNicknames.add(k);for(const c of [...live])if(keyNick((c.info&&c.info.n)||(c.friendRecord&&c.friendRecord.nickname)||'')===k)drop(c);return json(res,200,{ok:true,note:'Bu ilk sürümde engel sunucu yeniden başlayınca sıfırlanır.'});}
   if(url.pathname==='/api/admin/announcement'){announcement=String(body.message||'').trim().slice(0,240);for(const c of live)send(c,{t:'server:announcement',message:announcement});return json(res,200,{ok:true});}
   return json(res,404,{error:'Adres bulunamadı.'});
  });
 }
 if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html'))return fs.readFile(path.join(__dirname,'oyun.html'),(err,data)=>{if(!err){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache'});return res.end(data)}res.writeHead(500);res.end('oyun.html bulunamadı')});
 res.writeHead(404,{'content-type':'text/plain; charset=utf-8'});res.end('Bulunamadı. Oyun: /  Admin: /admin');
}
const server = http.createServer((req,res)=>{try{if(!extra(req,res))handleHttp(req,res)}catch(e){try{res.writeHead(500);res.end('Sunucu hatası')}catch(_){}}});
function frame(str) { const b=Buffer.from(str); if(b.length<126)return Buffer.concat([Buffer.from([0x81,b.length]),b]); if(b.length<65536){const h=Buffer.alloc(4);h[0]=0x81;h[1]=126;h.writeUInt16BE(b.length,2);return Buffer.concat([h,b])} return Buffer.alloc(0); }
function raw(c,buf){if(c.open)try{c.sock.write(buf)}catch(_){}}
function send(c,obj){raw(c,frame(JSON.stringify(obj)))}
function sendFriendState(r){const state={t:'friend:state',incoming:[...r.incoming],friends:[...r.friends],outgoing:[...r.outgoing]};for(const c of r.sockets)if(c.open)send(c,state)}
function notice(c,message){if(c&&c.open)send(c,{t:'friend:notice',message})}
function friendError(c,message){send(c,{t:'friend:error',message})}
function findOnlineNick(n){return onlineByNick.get(keyNick(n))||null}
function identifyFriend(c,nick){nick=cleanNick(nick);const k=keyNick(nick);if(nick.length<2)return friendError(c,'Takma ad en az 2 karakter olmalı.');if(bannedNicknames.has(k))return friendError(c,'Bu takma ad engellendi.');if(c.friendRecord&&keyNick(c.friendRecord.nickname)!==k){const previous=c.friendRecord;previous.sockets.delete(c);if(!previous.sockets.size&&onlineByNick.get(keyNick(previous.nickname))===previous)onlineByNick.delete(keyNick(previous.nickname));c.friendRecord=null;}let r=friendsByNick.get(k);const current=onlineByNick.get(k);if(current&&current!==r)return friendError(c,'Bu takma ad şu anda kullanımda.');if(!r){r={nickname:nick,friends:new Set(),incoming:new Set(),outgoing:new Set(),sockets:new Set()};friendsByNick.set(k,r)}r.sockets.add(c);r.lastSeen=Date.now();c.friendRecord=r;onlineByNick.set(k,r);sendFriendState(r);if(announcement)send(c,{t:'server:announcement',message:announcement});}
function friendMessage(c,m){const me=c.friendRecord;if(m.t==='friend:identify'){identifyFriend(c,m.n);if(c.friendRecord&&keyNick(c.friendRecord.nickname)===keyNick(m.n))econIdentify(c,c.friendRecord.nickname,m.money);return}if(!me)return friendError(c,'Önce takma adını kaydet.');const n=cleanNick(m.n),k=keyNick(n),target=findOnlineNick(n);
 if(m.t==='friend:request'){if(!target)return friendError(c,'Bu takma ad çevrimiçi değil veya bulunamadı.');if(target===me)return friendError(c,'Kendine istek gönderemezsin.');if(me.friends.has(target.nickname))return friendError(c,'Zaten arkadaşsınız.');if(me.outgoing.has(target.nickname))return friendError(c,'Bu istek zaten gönderildi.');me.outgoing.add(target.nickname);target.incoming.add(me.nickname);sendFriendState(me);sendFriendState(target);notice(c,'Arkadaşlık isteği gönderildi.');for(const s of target.sockets)notice(s,me.nickname+' sana arkadaşlık isteği gönderdi.');return;}
 if(m.t==='friend:accept'){if(!target||!me.incoming.has(target.nickname))return friendError(c,'Gelen istek bulunamadı.');me.incoming.delete(target.nickname);target.outgoing.delete(me.nickname);me.friends.add(target.nickname);target.friends.add(me.nickname);sendFriendState(me);sendFriendState(target);return notice(c,'Arkadaş eklendi.');}
 if(m.t==='friend:decline'){me.incoming.delete(n);if(target)target.outgoing.delete(me.nickname);sendFriendState(me);if(target)sendFriendState(target);return;}
 if(m.t==='friend:remove'){me.friends.delete(n);if(target){target.friends.delete(me.nickname);sendFriendState(target)}sendFriendState(me);return;}
}
function endMatch(m,winnerSlot,why){if(!m||m.done)return;m.done=true;matches--;played++;clearInterval(m.timer);clearTimeout(m.limit);const ms=m.t0?Date.now()-m.t0:0;for(const c of m.p)if(c&&c.open)send(c,{t:'end',w:winnerSlot,ms,why});for(const c of m.p)if(c)c.match=null;}
function leave(c){queue=queue.filter(x=>x!==c);const m=c.match;if(m&&!m.done){const other=m.p[1-c.slot];endMatch(m,other?other.slot:-1,'left')}}
function drop(c){if(!c.open)return;c.open=false;live.delete(c);clients--;leave(c);if(c.friendRecord){const r=c.friendRecord;r.sockets.delete(c);if(!r.sockets.size){if(onlineByNick.get(keyNick(r.nickname))===r)onlineByNick.delete(keyNick(r.nickname));r.lastSeen=Date.now()}c.friendRecord=null}try{c.sock.destroy()}catch(_){}}
function clean(d){const n=(x,a,b)=>Math.max(a,Math.min(b,Number.isFinite(+x)?+x:0));return {n:cleanNick(d.n||'Oyuncu').slice(0,14)||'Oyuncu',c:n(d.c,0,9)|0,col:n(d.col,0,0xffffff)|0}}
function startMatch(a,b){const m={p:[a,b],state:'cd',done:false,t0:0,last:[0,0]};matches++;a.match=m;b.match=m;a.slot=0;b.slot=1;send(a,{t:'m',slot:0,opp:b.info,goal:GOAL});send(b,{t:'m',slot:1,opp:a.info,goal:GOAL});let n=5;const tick=()=>{if(m.done)return;if(n>0){for(const c of m.p)send(c,{t:'cd',n});n--;return}m.state='race';m.t0=Date.now();for(const c of m.p)send(c,{t:'go'});clearInterval(m.timer)};m.timer=setInterval(tick,1000);tick();m.limit=setTimeout(()=>endMatch(m,m.last[0]>=m.last[1]?0:1,'time'),MAX_MATCH_MS);console.log('eşleşme:',a.info.n,'vs',b.info.n)}
function onMsg(c,txt){let m;try{m=JSON.parse(txt)}catch(_){return}if(!m||typeof m!=='object')return;
 if(m.t==='economy:balance')return econReport(c,m);
 if(typeof m.t==='string'&&m.t.startsWith('friend:'))return friendMessage(c,m);
 if(m.t==='ping'){send(c,{t:'pong'});return}
 if(m.t==='find'){leave(c);c.info=clean(m);if(bannedNicknames.has(keyNick(c.info.n))){send(c,{t:'admin:kick',message:'Takma ad engellendi.'});return drop(c)}const other=queue.shift();if(other&&other.open&&other!==c)startMatch(other,c);else{queue=[c];send(c,{t:'q'})}}
 else if(m.t==='s'&&c.match&&!c.match.done){const d=m.d;if(!Array.isArray(d)||d.length!==6)return;const x=Math.max(-50,Math.min(50,+d[0]||0)),z0=Math.max(0,Math.min(1e6,+d[1]||0)),s=Math.max(0,Math.min(200,+d[2]||0)),nt=Date.now(),pv=c.match.last[c.slot],z=Math.max(pv,Math.min(z0,pv+130*Math.max(Math.min(2,(nt-(c.lastS||nt))/1000),.05)+8));c.lastS=nt;c.match.last[c.slot]=z;const other=c.match.p[1-c.slot];if(other)send(other,{t:'o',d:[x,z,s,Math.max(-1,Math.min(1,+d[3]||0)),Math.max(-1,Math.min(1,+d[4]||0)),d[5]?1:0]})}
 else if(m.t==='fin'&&c.match&&c.match.state==='race'&&!c.match.done){if(c.match.last[c.slot]>=GOAL-80)endMatch(c.match,c.slot,'finish')}
 else if(m.t==='cancel')leave(c);
}
function pump(c){while(c.open&&c.buf.length>=2){const b=c.buf,fin=b[0]&128,op=b[0]&15,masked=b[1]&128;let len=b[1]&127,off=2;if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4}else if(len===127)return drop(c);if(!masked||!fin||len>1024)return drop(c);if(b.length<off+4+len)return;const mask=b.subarray(off,off+4),pl=Buffer.from(b.subarray(off+4,off+4+len));for(let i=0;i<len;i++)pl[i]^=mask[i&3];c.buf=b.subarray(off+4+len);const now=Date.now();if(now-c.mt>1000){c.mt=now;c.k=0}if(++c.k>50)return drop(c);if(op===1)onMsg(c,pl.toString('utf8'));else if(op===8)return drop(c);else if(op===9)raw(c,Buffer.concat([Buffer.from([0x8a,len]),pl]));}}
server.on('upgrade',(req,sock)=>{const key=req.headers['sec-websocket-key'];if(!key||String(req.headers.upgrade||'').toLowerCase()!=='websocket'||clients>=MAX_CLIENTS)return sock.destroy();const accept=crypto.createHash('sha1').update(key+GUID).digest('base64');sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');const c={id:nextClientId++,sock,buf:Buffer.alloc(0),open:true,mt:Date.now(),k:0,match:null,slot:0,info:null,seen:Date.now(),connectedAt:Date.now()};clients++;live.add(c);sock.setNoDelay(true);sock.setKeepAlive(true,15000);sock.on('data',ch=>{c.seen=Date.now();c.buf=Buffer.concat([c.buf,ch]);if(c.buf.length>4096)return drop(c);pump(c)});sock.on('close',()=>drop(c));sock.on('error',()=>drop(c));});
setInterval(()=>{const now=Date.now();for(const c of [...live])if(now-c.seen>15000)drop(c);for(const [t,e] of sessions)if(e<now)sessions.delete(t);for(const [k,x] of loginAttempts)if(now-(x.t||0)>36e5)loginAttempts.delete(k)},5000);
if(require.main===module)server.listen(PORT,()=>{console.log('Sunucu hazır: port '+PORT+', hedef '+GOAL+' m');if(!ADMIN_USERNAME||ADMIN_PASSWORD.length<16||SESSION_SECRET.length<32)console.warn('Admin paneli için Render Environment Variables: ADMIN_USERNAME, en az 16 karakter ADMIN_PASSWORD, en az 32 karakter SESSION_SECRET ayarla.')});
module.exports=server;
