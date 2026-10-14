const WebSocket = require('ws');
const BaseAdapter = require('./baseAdapter');

function parseTags(raw = '') {
  const tags = {};
  for (const entry of raw.split(';')) {
    const i = entry.indexOf('=');
    if (i === -1) continue;
    const key = entry.slice(0, i);
    const value = entry.slice(i + 1)
      .replace(/\\s/g, ' ')
      .replace(/\\:/g, ';')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\\\/g, '\\');
    tags[key] = value;
  }
  return tags;
}

const TWITCH_ALLOWED_BADGES = new Set([
  'broadcaster',
  'moderator',
  'subscriber',
  'vip',
  'founder',
  'premium',
  'staff',
  'partner',
  'verified',
  'artist',
  'bits'
]);

function parseBadges(value = '') {
  if (!value) return [];
  // A Twitch pode enviar IDs técnicos ou badges específicos do canal que não
  // fazem sentido como texto no MultiChat. Mantemos apenas badges conhecidos
  // e úteis para leitura rápida; todo identificador desconhecido é descartado.
  return value
    .split(',')
    .map(x => x.split('/')[0].trim().toLowerCase())
    .filter(id => id && TWITCH_ALLOWED_BADGES.has(id));
}

function parseEmotes(value = '', text = '') {
  if (!value) return [];
  const chars = Array.from(text);
  const out = [];
  for (const group of value.split('/')) {
    const [id, ranges = ''] = group.split(':');
    if (!id || !ranges) continue;
    for (const range of ranges.split(',')) {
      const [startRaw, endRaw] = range.split('-');
      const start = Number(startRaw), end = Number(endRaw);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) continue;
      const name = chars.slice(start, end + 1).join('');
      out.push({ id, start, end, name });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function makeAnonymousNick() {
  // Formato tradicional aceito pelo chat público da Twitch para clientes somente leitura.
  return `justinfan${Math.floor(10000 + Math.random() * 89999)}`;
}

class TwitchAdapter extends BaseAdapter {
  constructor(auth = null) {
    super('twitch');
    this.ws = null;
    this.manualClose = false;
    this.nick = '';
    this.reconnectTimer = null;
    this.auth = auth;
    this.viewerTimer = null;
    this.avatarCache = new Map();
  }

  async connect(channel) {
    const cleanChannel = String(channel || '').trim().replace(/^@/, '').toLowerCase();
    if (!cleanChannel) throw new Error('Bitte den Namen des Twitch-Kanals eingeben.');

    await this.disconnect();
    this.channel = cleanChannel;
    this.manualClose = false;
    this.nick = this.auth?.username || makeAnonymousNick();

    await this.#openSocket(cleanChannel);
  }

  async #openSocket(cleanChannel) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
      this.ws = ws;

      const finishError = (err) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      const timeout = setTimeout(() => {
        finishError(new Error('Zeitüberschreitung beim Verbinden mit dem öffentlichen Twitch-Chat.'));
        try { ws.close(); } catch {}
      }, 12000);

      ws.on('open', () => {
        // Conexão anônima, somente leitura: nenhuma conta/token do usuário é enviado.
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands\r\n');
        ws.send(`PASS ${this.auth?.token || 'SCHMOOPIIE'}\r\n`);
        ws.send(`NICK ${this.nick}\r\n`);
        ws.send(`JOIN #${cleanChannel}\r\n`);
      });

      ws.on('message', data => {
        const payload = data.toString('utf8');
        for (const lineRaw of payload.split(/\r?\n/)) {
          const line = lineRaw.trim();
          if (!line) continue;

          if (line.startsWith('PING ')) {
            if (ws.readyState === WebSocket.OPEN) ws.send(`PONG ${line.slice(5)}\r\n`);
            continue;
          }

          if (/Login authentication failed|Improperly formatted auth/i.test(line)) {
            clearTimeout(timeout);
            finishError(new Error('Twitch hat die anonyme Leseverbindung abgelehnt.'));
            try { ws.close(); } catch {}
            continue;
          }

          if (line.includes(` 366 ${this.nick} #${cleanChannel} `) ||
              line.includes(`ROOMSTATE #${cleanChannel}`) ||
              line.includes(`:${this.nick}!${this.nick}@${this.nick}.tmi.twitch.tv JOIN #${cleanChannel}`)) {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              this.connected = true;
              this.emit('status', {
                ...this.status(),
                live: null,
                readOnly: true,
                anonymous: true,
                detail: `Öffentlicher Chat #${cleanChannel} verbunden (nur Lesezugriff).`
              });
              this.updateViewers();
              clearInterval(this.viewerTimer);
              this.viewerTimer = setInterval(() => this.updateViewers(), 30000);
              resolve();
            }
          }

          const match = line.match(/^@([^ ]+) :([^!]+)![^ ]+ PRIVMSG #([^ ]+) :(.*)$/);
          if (!match) continue;
          const [, tagRaw, login, room, text] = match;
          if (room.toLowerCase() !== cleanChannel) continue;
          const tags = parseTags(tagRaw);

          this.fetchAvatar(login, tags['user-id']).then(avatar => this.emit('message', {
            id: tags.id,
            platform: 'twitch',
            channel: cleanChannel,
            username: login,
            displayName: tags['display-name'] || login,
            avatar,
            message: text,
            timestamp: Number(tags['tmi-sent-ts']) || Date.now(),
            badges: parseBadges(tags.badges),
            emotes: parseEmotes(tags.emotes, text),
            metadata: {
              color: tags.color || '',
              subscriber: tags.subscriber === '1',
              mod: tags.mod === '1',
              firstMessage: tags['first-msg'] === '1',
              anonymousReader: true
            }
          }));
        }
      });

      ws.on('error', err => {
        clearTimeout(timeout);
        if (!settled) finishError(err);
        else this.emit('error', new Error(`Twitch IRC: ${err.message}`));
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        const wasConnected = this.connected;
        this.connected = false;
        if (!settled) finishError(new Error('Twitch hat die Verbindung geschlossen, bevor der Chat betreten wurde.'));
        if (!this.manualClose && wasConnected) {
          this.emit('status', {
            ...this.status(), connected: false,
            detail: 'Twitch-Verbindung unterbrochen. Automatische Neuverbindung…'
          });
          this.reconnectTimer = setTimeout(() => {
            this.#openSocket(cleanChannel).catch(err => {
              this.emit('error', new Error(`Twitch-Neuverbindung fehlgeschlagen: ${err.message}`));
            });
          }, 3000);
        }
      });
    });
  }

  async disconnect() {
    this.manualClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    clearInterval(this.viewerTimer); this.viewerTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN && this.channel) ws.send(`PART #${this.channel}\r\n`);
        ws.close();
      } catch {}
    }
    await super.disconnect();
  }

  async updateViewers() {
    if (!this.auth?.clientId || !this.auth?.token || !this.channel) return;
    try {
      const response = await fetch(`https://api.twitch.tv/helix/streams?user_login=${encodeURIComponent(this.channel)}`, { headers: { 'Client-Id': this.auth.clientId, Authorization: `Bearer ${this.auth.token.replace(/^oauth:/, '')}` } });
      const data = await response.json();
      this.emit('viewers', { platform: 'twitch', count: Number(data?.data?.[0]?.viewer_count || 0) });
    } catch {}
  }

  // Der Chat kann bereits als Gast verbunden sein, bevor sich der Benutzer im
  // Dock anmeldet. Das nachträgliche Login muss trotzdem sofort für Avatare
  // und Zuschauerzahlen gelten; ein kompletter Neuaufbau des Docks wäre sonst
  // nötig.
  setAuth(auth) {
    this.auth = auth || null;
    this.avatarCache.clear();
    this.updateViewers();
  }

  async fetchAvatar(login, userId = '') {
    const key = String(userId || login || '').toLowerCase();
    if (this.avatarCache.has(key)) return this.avatarCache.get(key);
    let avatar = '';
    if (this.auth?.clientId && this.auth?.token) try {
      const query = userId ? `id=${encodeURIComponent(userId)}` : `login=${encodeURIComponent(login)}`;
      const r = await fetch(`https://api.twitch.tv/helix/users?${query}`, { headers: { 'Client-Id': this.auth.clientId, Authorization: `Bearer ${this.auth.token.replace(/^oauth:/, '')}` } });
      if (r.ok) avatar = (await r.json())?.data?.[0]?.profile_image_url || '';
    } catch {}
    this.avatarCache.set(key, avatar); return avatar;
  }
}

module.exports = TwitchAdapter;
