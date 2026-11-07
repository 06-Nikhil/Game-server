
// ZANKI online duel server (HTTP + WebSocket on one port)
// Difficulty-aware matchmaking: players are matched by rounds + difficulty.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// Telegram bot configuration
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const BOT_USERNAME = (process.env.BOT_USERNAME || '').replace('@', '');
const APP_NAME = process.env.APP_NAME || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const WEBHOOK_SECRET = (process.env.WEBHOOK_SECRET || 'zanki-hook').replace(/[^A-Za-z0-9_-]/g, '') || 'zanki-hook';
const TG_API = process.env.TG_API || 'https://api.telegram.org';

const tg = (method, body) => fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));

const appLink = (param) =>
  `https://t.me/${BOT_USERNAME}${APP_NAME ? '/' + APP_NAME : ''}${param ? '?startapp=' + param : ''}`;

const rooms = new Map();
const quickQ = new Map(); // Queue key: rounds + difficulty

const clean = (s, n) =>
  String(s ?? '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, n);

const send = (ws, o) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(o));
};

const RELAY = new Set(['hello', 'st', 'act', 'hit', 'res', 'dead', 'rnd', 'rdy', 'rm']);

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(10000 + Math.floor(Math.random() * 90000));
    if (!rooms.has(c)) return c;
  }
  return null;
}

function validDifficulty(diff) {
  return ['easy', 'medium', 'hardcore'].includes(diff) ? diff : 'medium';
}

function startRoom(code) {
  const room = rooms.get(code);
  if (!room || room.players.length < 2) return;

  const [a, b] = room.players;
  const rounds = room.rounds === 5 ? 5 : 3;
  const diff = validDifficulty(room.diff);

  a.side = 0;
  b.side = 1;

  send(a, { t: 'start', opp: b.name, side: 0, rounds, diff });
  send(b, { t: 'start', opp: a.name, side: 1, rounds, diff });
}

function leave(ws) {
  if (ws.qr && quickQ.get(ws.qr) === ws) {
    quickQ.delete(ws.qr);
  }

  ws.qr = null;

  const code = ws.room;
  if (!code) return;

  ws.room = null;

  const room = rooms.get(code);
  if (!room) return;

  rooms.delete(code);

  room.players.forEach(p => {
    if (p !== ws) {
      p.room = null;
      send(p, { t: 'left' });
    }
  });
}

// Telegram inline bot
async function handleUpdate(u) {
  if (!BOT_TOKEN || !BOT_USERNAME) return;

  if (u.inline_query) {
    const q = u.inline_query;
    const query = (q.query || '').trim();

    let code = /^\d{5}$/.test(query) ? query : null;

    if (!code) {
      do {
        code = String(10000 + Math.floor(Math.random() * 90000));
      } while (rooms.has(code));
    }

    const who = clean(q.from && q.from.first_name, 20) || 'A ronin';

    const results = [
      {
        type: 'article',
        id: 'duel-' + code,
        title: '⚔️ Challenge to a ZANKI duel',
        description: 'Send a duel invite - the first two to tap Fight play each other',
        input_message_content: {
          message_text: `⚔️ ${who} challenges you to a ZANKI duel!\nTap Fight to enter the arena. Pick your rounds and take the match.`
        },
        reply_markup: {
          inline_keyboard: [[
            { text: '⚔️ Fight!', url: appLink(code) }
          ]]
        }
      },
      {
        type: 'article',
        id: 'open',
        title: '🎮 Open ZANKI',
        description: 'Send a button that simply opens the game',
        input_message_content: {
          message_text: '🗡 ZANKI - Blood Moon Ronin\nTap Play to open the game.'
        },
        reply_markup: {
          inline_keyboard: [[
            { text: '▶️ Play', url: appLink('') }
          ]]
        }
      },
      {
        type: 'article',
        id: 'quick-' + Date.now(),
        title: '🌸 Quick Match invite',
        description: 'Send a button that opens the game and finds a random opponent',
        input_message_content: {
          message_text: '🌸 ZANKI - Blood Moon Ronin\nTap Quick Match to fight a real player right away.'
        },
        reply_markup: {
          inline_keyboard: [[
            { text: '🌸 Quick Match', url: appLink('quick') }
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
      reply_markup: {
        inline_keyboard: [[
          { text: '▶️ Play', url: appLink('') }
        ]]
      }
    });
  }
}

// HTTP server
const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && pathname === '/tg') {
    let body = '';

    req.on('data', c => {
      body += c;
      if (body.length > 100000) req.destroy();
    });

    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');

      if (req.headers['x-telegram-bot-api-secret-token'] !== WEBHOOK_SECRET) return;

      try {
        handleUpdate(JSON.parse(body)).catch(e => console.log('tg error', e));
      } catch {}
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    return res.end();
  }

  res.writeHead(200, headers);

  res.end(req.method === 'HEAD' ? undefined : JSON.stringify({
    status: 'ok',
    game: 'ZANKI',
    rooms: rooms.size,
    players: wss.clients.size,
    uptime: Math.round(process.uptime())
  }));
});

const wss = new WebSocketServer({
  server,
  maxPayload: 2048
});

// WebSocket connections
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.room = null;
  ws.name = 'Ronin';
  ws.tokens = 100;
  ws.refill = Date.now();

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    const now = Date.now();

    // Rate limit
    ws.tokens = Math.min(100, ws.tokens + (now - ws.refill) * 0.08);
    ws.refill = now;

    if (ws.tokens < 1) return;
    ws.tokens -= 1;

    let d;

    try {
      d = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!d || typeof d !== 'object' || typeof d.t !== 'string') return;

    // Relay gameplay messages
    if (RELAY.has(d.t)) {
      if (!ws.room) return;

      if (d.t === 'rnd' && ws.side !== 0) return;

      if (d.t === 'act' || d.t === 'hit') {
        const k = d.t === 'hit' && d.k === 's' ? 'hs' : d.t;

        if (now - (ws['last_' + k] || 0) < 110) return;

        ws['last_' + k] = now;
      }

      const room = rooms.get(ws.room);

      if (!room || room.players.length < 2) return;

      const other = room.players.find(p => p !== ws);

      if (other && other.readyState === 1) {
        other.send(raw.toString());
      }

      return;
    }

    // Create private room
    if (d.t === 'create') {
      if (ws.room) leave(ws);

      ws.name = clean(d.name, 16) || 'Ronin';

      const code = newCode();

      if (!code) {
        return send(ws, { t: 'err', m: 'Server busy, try again' });
      }

      rooms.set(code, {
        players: [ws],
        rounds: d.rounds === 5 ? 5 : 3,
        diff: validDifficulty(d.diff)
      });

      ws.room = code;

      return send(ws, { t: 'created', room: code });
    }

    // Join private room
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

    // Enter room from Telegram deep link
    if (d.t === 'enter') {
      if (ws.room) leave(ws);

      ws.name = clean(d.name, 16) || 'Ronin';

      const code = String(d.room || '').replace(/\D/g, '');

      if (code.length !== 5) return send(ws, { t: 'nf' });

      const room = rooms.get(code);

      if (!room) {
        rooms.set(code, {
          players: [ws],
          rounds: d.rounds === 5 ? 5 : 3,
          diff: validDifficulty(d.diff)
        });

        ws.room = code;

        return send(ws, { t: 'created', room: code });
      }

      if (room.players.length >= 2) return send(ws, { t: 'full' });

      room.players.push(ws);
      ws.room = code;

      return startRoom(code);
    }

    // Quick matchmaking: match only same rounds + difficulty
    if (d.t === 'quick') {
      if (ws.room) leave(ws);

      ws.name = clean(d.name, 16) || 'Ronin';

      const rounds = d.rounds === 5 ? 5 : 3;
      const diff = validDifficulty(d.diff);
      const queueKey = rounds + ':' + diff;

      const other = quickQ.get(queueKey);

      if (other && other !== ws && other.readyState === 1) {
        quickQ.delete(queueKey);
        other.qr = null;
        ws.qr = null;

        const code = newCode();

        if (!code) {
          return send(ws, { t: 'err', m: 'Server busy, try again' });
        }

        rooms.set(code, {
          players: [other, ws],
          rounds,
          diff
        });

        other.room = code;
        ws.room = code;

        return startRoom(code);
      }

      quickQ.set(queueKey, ws);
      ws.qr = queueKey;

      return send(ws, { t: 'wait', quick: 1 });
    }

    // Cancel matchmaking
    if (d.t === 'cancel') {
      return leave(ws);
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

// Heartbeat
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
    const r = await tg('setWebhook', {
      url: PUBLIC_URL + '/tg',
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['inline_query', 'message']
    });

    console.log(
      'Telegram webhook:',
      r.ok ? 'registered ' + PUBLIC_URL + '/tg' : JSON.stringify(r)
    );
  } else {
    console.log('Telegram inline mode off (set BOT_TOKEN, BOT_USERNAME and PUBLIC_URL to enable)');
  }
});
