// ZANKI online duel server (HTTP + WebSocket on one port)
// - Every HTTP path/method answers 200, so UptimeRobot never sees a 404.
// - Pure relay: clients simulate their own fighter, the server only pairs players and forwards messages.
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
// ---- Telegram bot (inline mode). All optional: set these as Render environment variables ----
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace('@', '');
const APP_NAME = process.env.APP_NAME || '';                       // Mini App short name from BotFather /newapp
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || 'zanki-hook').replace(/[^A-Za-z0-9_-]/g, '') || 'zanki-hook';
const TG_API = process.env.TG_API || 'https://api.telegram.org';

const tg = (method, body) => fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
const appLink = (param) => `https://t.me/${BOT_USERNAME}${APP_NAME ? '/' + APP_NAME : ''}${param ? '?startapp=' + param : ''}`;

const rooms = new Map();   // code -> { players: [ws, ws?] }
let quickWaiting = null;   // ws waiting for a quick match

async function handleUpdate(u) {
  if (!BOT_TOKEN || !BOT_USERNAME) return;
  if (u.inline_query) {
 
if (u.inline_query) {
  const q = u.inline_query;
  const text = (q.query || '').trim();

  let code = /^\d{5}$/.test(text) ? text : null;

  if (!code) {
    do {
      code = String(10000 + Math.floor(Math.random() * 90000));
    } while (rooms.has(code));
  }

  const who = clean(q.from && q.from.first_name, 20) || 'A ronin';

  const results = [
    {
      type: 'article',
      id: 'zanki-main',
      title: '⚔️ ZANKI: Blood Moon Ronin',
      description: 'The moon is red. Your legend begins now.',
      input_message_content: {
        message_text:
          '⚔️ ZANKI: BLOOD MOON RONIN\n\n' +
          'The moon is red. The blade is hungry.\n\n' +
          'Step into the world of the ronin, face deadly enemies and fight your way through the darkness.\n\n' +
          'Think you can survive the Blood Moon?\n\n' +
          'Sharpen your blade. Your legend begins now. 🩸'
      },
      reply_markup: {
        inline_keyboard: [[
          { text: '⚔️ PLAY NOW', url: appLink('') }
        ]]
      }
    },
    {
      type: 'article',
      id: 'duel-' + code,
      title: '⚔️ Challenge a friend',
      description: 'Challenge someone to a ZANKI duel.',
      input_message_content: {
        message_text:
          `⚔️ ${who} challenges you to a ZANKI duel!\n\n` +
          'Tap Fight to enter the arena. First to win 2 rounds takes the match.'
      },
      reply_markup: {
        inline_keyboard: [[
          { text: '⚔️ FIGHT!', url: appLink(code) }
        ]]
      }
    },
    {
      type: 'article',
      id: 'quick-' + Date.now(),
      title: '🌸 Quick Match',
      description: 'Find a random opponent.',
      input_message_content: {
        message_text:
          '🌸 ZANKI: BLOOD MOON RONIN\n\n' +
          'Ready for a fight? Find a random opponent and enter the arena.'
      },
      reply_markup: {
        inline_keyboard: [[
          { text: '🌸 QUICK MATCH', url: appLink('quick') }
        ]]
      }
    }
  ];

  await tg('answerInlineQuery', {
    inline_query_id: q.id,
    results,
    cache_time: 0,
    is_personal: true
  });

  return;
}

  const m = u.message;
  if (m && m.chat && typeof m.text === 'string' && m.text.startsWith('/start')) {
    await tg('sendMessage', {
      chat_id: m.chat.id,
      text: '🗡 ZANKI - Blood Moon Ronin\nTap Play to fight. To challenge a friend, type @' + BOT_USERNAME + ' in any chat and pick "Challenge to a duel".',
      reply_markup: { inline_keyboard: [[{ text: '▶️ Play', url: appLink('') }]] },
    });
  }
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (req.method === 'POST' && pathname === '/tg') {            // Telegram webhook (always answers 200)
    let body = '';
    req.on('data', c => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok');
      if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return;
      try { handleUpdate(JSON.parse(body)).catch(e => console.log('tg error', e)); } catch {}
    });
    return;
  }
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
    status: 'ok', game: 'ZANKI', rooms: rooms.size, players: wss.clients.size, uptime: Math.round(process.uptime()),
  }));
});

const wss = new WebSocketServer({ server, maxPayload: 2048 });

const clean = (s, n) => String(s ?? '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, n);
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
// message types that are simply forwarded to the other player in the room
const RELAY = new Set(['hello', 'st', 'act', 'hit', 'res', 'dead', 'rnd', 'rdy', 'rm']);

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(10000 + Math.floor(Math.random() * 90000));
    if (!rooms.has(c)) return c;
  }
  return null;
}

function startRoom(code) {
  const room = rooms.get(code);
  const [a, b] = room.players;
  a.side = 0; b.side = 1;
  send(a, { t: 'start', opp: b.name, side: 0 });
  send(b, { t: 'start', opp: a.name, side: 1 });
}

function leave(ws) {
  if (quickWaiting === ws) quickWaiting = null;
  const code = ws.room;
  if (!code) return;
  ws.room = null;
  const room = rooms.get(code);
  if (!room) return;
  rooms.delete(code);
  room.players.forEach(p => {
    if (p !== ws) { p.room = null; send(p, { t: 'left' }); }
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.name = 'Ronin';
  ws.tokens = 100; ws.refill = Date.now();
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    // rate limit: ~80 messages/second sustained
    const now = Date.now();
    ws.tokens = Math.min(100, ws.tokens + (now - ws.refill) * 0.08);
    ws.refill = now;
    if (ws.tokens < 1) return;
    ws.tokens -= 1;

    let d;
    try { d = JSON.parse(raw.toString()); } catch { return; }
    if (!d || typeof d !== 'object' || typeof d.t !== 'string') return;

    if (RELAY.has(d.t)) {
      if (!ws.room) return;
      if (d.t === 'rnd' && ws.side !== 0) return;       // only the host decides round results
      const room = rooms.get(ws.room);
      if (!room || room.players.length < 2) return;
      const other = room.players.find(p => p !== ws);
      if (other && other.readyState === 1) other.send(raw.toString());
      return;
    }

    if (d.t === 'create') {
      if (ws.room) leave(ws);
      ws.name = clean(d.name, 16) || 'Ronin';
      const code = newCode();
      if (!code) return send(ws, { t: 'err', m: 'Server busy, try again' });
      rooms.set(code, { players: [ws] });
      ws.room = code;
      return send(ws, { t: 'created', room: code });
    }

    if (d.t === 'join') {
      if (ws.room) leave(ws);
      ws.name = clean(d.name, 16) || 'Ronin';
      const code = String(d.room || '').replace(/\D/g, '').slice(0, 5);
      const room = rooms.get(code);
      if (!room) return send(ws, { t: 'nf' });
      if (room.players.length >= 2) return send(ws, { t: 'full' });
      room.players.push(ws);
      ws.room = code;
      return startRoom(code);
    }

    if (d.t === 'enter') {
      if (ws.room) leave(ws);
      ws.name = clean(d.name, 16) || 'Ronin';
      const code = String(d.room || '').replace(/\D/g, '');
      if (code.length !== 5) return send(ws, { t: 'nf' });
      const room = rooms.get(code);
      if (!room) { rooms.set(code, { players: [ws] }); ws.room = code; return send(ws, { t: 'created', room: code }); }
      if (room.players.length >= 2) return send(ws, { t: 'full' });
      room.players.push(ws); ws.room = code;
      return startRoom(code);
    }

    if (d.t === 'quick') {
      if (ws.room) leave(ws);
      ws.name = clean(d.name, 16) || 'Ronin';
      if (quickWaiting && quickWaiting !== ws && quickWaiting.readyState === 1) {
        const other = quickWaiting; quickWaiting = null;
        const code = newCode();
        rooms.set(code, { players: [other, ws] });
        other.room = code; ws.room = code;
        return startRoom(code);
      }
      quickWaiting = ws;
      return send(ws, { t: 'wait', quick: 1 });
    }

    if (d.t === 'cancel') return leave(ws);
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// heartbeat keeps proxies from closing idle sockets and drops dead ones
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.listen(PORT, '0.0.0.0', async () => {
  console.log('ZANKI duel server listening on ' + PORT);
  if (BOT_TOKEN && BOT_USERNAME && PUBLIC_URL) {
    const r = await tg('setWebhook', { url: PUBLIC_URL + '/tg', secret_token: WEBHOOK_SECRET, allowed_updates: ['inline_query', 'message'] });
    console.log('Telegram webhook:', r.ok ? 'registered ' + PUBLIC_URL + '/tg' : JSON.stringify(r));
  } else console.log('Telegram inline mode off (set BOT_TOKEN, BOT_USERNAME and PUBLIC_URL to enable)');
});
