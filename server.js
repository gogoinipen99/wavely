// Wavely: random video chat. Zero dependencies. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, BAN_AT = 3;
const clients = new Map();   // id -> client
const reports = new Map();   // reported ip -> Set of distinct reporter ips
let queue = [];

const send = (c, type, data = {}) => c && !c.res.writableEnded && c.res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
const banned = ip => (reports.get(ip)?.size || 0) >= BAN_AT;

function leave(c, notify = true) {
  queue = queue.filter(x => x !== c);
  const p = c.partner; c.partner = null;
  if (p && p.partner === c) { p.partner = null; if (notify) send(p, 'partner-left'); }
}

function match(c) {
  queue = queue.filter(x => x !== c);
  const ok = o => o !== c.last && o.last !== c;
  let i = c.tag ? queue.findIndex(o => o.tag === c.tag && ok(o)) : -1;          // same interest first
  if (i < 0) i = queue.findIndex(o => (!c.tag || !o.tag) && ok(o));              // then anyone open
  if (i < 0) { queue.push(c); return send(c, 'waiting'); }
  const o = queue.splice(i, 1)[0];
  c.partner = o; o.partner = c; c.last = o; o.last = c;
  send(o, 'matched', { initiator: true });
  send(c, 'matched', { initiator: false });
}

function handle(c, b) {
  switch (b.type) {
    case 'join': leave(c); c.tag = String(b.tag || '').toLowerCase().trim().slice(0, 20); match(c); break;
    case 'next': leave(c); match(c); break;
    case 'stop': leave(c); break;
    case 'signal': c.partner && send(c.partner, 'signal', { data: b.data }); break;
    case 'chat': {
      const text = String(b.text || '').slice(0, 500);
      if (text && c.partner) send(c.partner, 'chat', { text });
      break;
    }
    case 'report': {
      const p = c.partner; if (!p) break;
      if (!reports.has(p.ip)) reports.set(p.ip, new Set());
      reports.get(p.ip).add(c.ip);
      leave(c, false);
      if (banned(p.ip)) { send(p, 'banned'); p.res.end(); } else send(p, 'partner-left');
      match(c);
      break;
    }
  }
}

http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.url === '/events') {
    if (banned(ip)) { res.writeHead(403); return res.end('Banned after multiple reports.'); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const c = { id: crypto.randomUUID(), ip, res, partner: null, tag: '', last: null };
    clients.set(c.id, c);
    send(c, 'hello', { id: c.id });
    const beat = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(beat); leave(c); clients.delete(c.id); });
  } else if (req.url === '/api' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body), c = clients.get(b.id);
        if (!c) { res.writeHead(404); return res.end(); }
        handle(c, b); res.writeHead(204); res.end();
      } catch { res.writeHead(400); res.end(); }
    });
  } else if (req.url === '/ice') {
    let ice = null;
    try { ice = JSON.parse(process.env.ICE_SERVERS); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(ice || [{ urls: 'stun:stun.l.google.com:19302' }]));
  } else {
    fs.readFile(path.join(__dirname, 'index.html'), (e, d) => {
      if (e) { res.writeHead(500); return res.end('index.html missing'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  }
}).listen(PORT, () => console.log(`Wavely running at http://localhost:${PORT}`));
