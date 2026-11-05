// ZANKI multiplayer relay server (HTTP + WebSocket on the same port)
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// --- HTTP: answers EVERY path and method with 200 so UptimeRobot never sees a 404 ---
const server = http.createServer((req, res) => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
  const body = JSON.stringify({
    status: 'ok',
    game: 'ZANKI',
    rooms: rooms.size,
    players: wss.clients.size,
    uptime: Math.round(process.uptime()),
  });
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body); // HEAD must not have a body
});

// --- WebSocket ---
const wss = new WebSocketServer({ server, maxPayload: 1024 }); // messages are tiny; reject big ones
const rooms = new Map(); // code -> [ws, ws]

const clean = (s, n) => String(s ?? '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, n);
const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function leaveRoom(ws) {
  const code = ws.room;
  if (!code) return;
  ws.room = null;
  const list = rooms.get(code);
  if (!list) return;
  const rest = list.filter(p => p !== ws);
  if (rest.length === 0) rooms.delete(code);
  else { rooms.set(code, rest); rest.forEach(p => send(p, { t: 'left' })); }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.lastState = 0;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let d;
    try { d = JSON.parse(raw.toString()); } catch { return; }
    if (!d || typeof d !== 'object') return;

    if (d.t === 'join') {
      if (ws.room) return; // already in a room
      const code = clean(d.room, 8).toUpperCase();
      if (!code) return;
      ws.name = clean(d.name, 16) || 'Ronin';
      const list = rooms.get(code) || [];
      if (list.length >= 2) return send(ws, { t: 'full' });
      list.push(ws);
      rooms.set(code, list);
      ws.room = code;
      if (list.length === 1) return send(ws, { t: 'wait' });
      const seed = Math.floor(Math.random() * 1e9);
      send(list[0], { t: 'start', opp: list[1].name, seed });
      send(list[1], { t: 'start', opp: list[0].name, seed });
      return;
    }

    if (d.t === 'state' && ws.room) {
      const now = Date.now();
      if (now - ws.lastState < 40) return; // max ~25 updates/sec per player
      ws.lastState = now;
      const list = rooms.get(ws.room) || [];
      const other = list.find(p => p !== ws);
      if (!other) return;
      const score = Number(d.score), hp = Number(d.hp);
      send(other, {
        t: 'state',
        score: Number.isFinite(score) ? Math.max(0, Math.min(1e9, Math.floor(score))) : 0,
        hp: Number.isFinite(hp) ? Math.max(0, Math.min(100, Math.floor(hp))) : 0,
        alive: !!d.alive,
      });
    }
  });

  ws.on('close', () => leaveRoom(ws));
  ws.on('error', () => leaveRoom(ws));
});

// Heartbeat: drop dead connections and keep proxies from closing idle sockets
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.keepAliveTimeout = 65000; // longer than Render's proxy timeout
server.headersTimeout = 66000;
server.listen(PORT, '0.0.0.0', () => console.log('ZANKI server listening on ' + PORT));
