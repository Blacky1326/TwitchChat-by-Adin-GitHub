require('dotenv').config();
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { normalizeMessage } = require('./services/chatNormalizer');
const YouTubeAdapter = require('./adapters/youtube');
const TwitchAdapter = require('./adapters/twitch');
const MockAdapter = require('./adapters/mock');
const TikTokAdapter = require('./adapters/tiktok');
const { version: VERSION } = require('../package.json');
const execFileAsync = promisify(execFile);
const UPDATE_REPOSITORY = 'Blacky1326/TwitchChat-by-Adin-GitHub';

function env(name, fallback = '') { return process.env[name] ?? fallback; }
function yes(value) { return Boolean(String(value || '').trim()); }
function cleanChannel(platform, channel = '') {
  const value = String(channel).trim();
  if (platform === 'twitch') return value.replace(/^@/, '').toLowerCase();
  if (platform === 'youtube') return value.toLowerCase();
  return value.toLowerCase();
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const PORT = Number(env('PORT', '8787'));
const PORTABLE_MODE = /^(1|true|yes)$/i.test(String(env('MULTICHAT_PORTABLE', '0')));
const PORTABLE_IDLE_MS = Math.max(5000, Number(env('MULTICHAT_IDLE_SHUTDOWN_MS', '20000')) || 20000);
let portableHadClient = false;
let portableIdleTimer = null;
let twitchAuth = null;
const USER_DATA_DIR = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming'), 'TwitchChatByAdin');
const TWITCH_AUTH_FILE = path.join(USER_DATA_DIR, 'twitch-login.dat');

// Windows DPAPI verschlüsselt die Datei mit dem aktuellen Windows-Konto. Selbst
// wenn sie kopiert wird, kann sie auf einem anderen Konto nicht entschlüsselt werden.
async function protectForWindowsUser(value) {
  const input = Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const script = `Add-Type -AssemblyName System.Security;$bytes=[Convert]::FromBase64String('${input}');$secure=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Convert]::ToBase64String($secure)`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  return stdout.trim();
}

async function unprotectForWindowsUser(encrypted) {
  const safe = String(encrypted || '').trim();
  if (!safe) return null;
  const script = `Add-Type -AssemblyName System.Security;$bytes=[Convert]::FromBase64String('${safe}');$plain=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Text.Encoding]::UTF8.GetString($plain)`;
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
  return JSON.parse(stdout.trim());
}

async function saveTwitchAuth(auth) {
  await fs.mkdir(USER_DATA_DIR, { recursive: true });
  await fs.writeFile(TWITCH_AUTH_FILE, await protectForWindowsUser(auth), { encoding: 'utf8', mode: 0o600 });
}

async function restoreTwitchAuth() {
  try {
    const saved = await unprotectForWindowsUser(await fs.readFile(TWITCH_AUTH_FILE, 'utf8'));
    if (!saved?.token || !saved?.clientId) return;
    const response = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${String(saved.token).replace(/^oauth:/, '')}` } });
    const me = await response.json();
    if (response.ok && me.login) twitchAuth = { username: me.login, token: saved.token, clientId: saved.clientId };
  } catch {
    // Abgelaufene oder nicht zu diesem Windows-Konto passende Daten werden ignoriert.
  }
}

async function deleteTwitchAuth() {
  twitchAuth = null;
  await fs.rm(TWITCH_AUTH_FILE, { force: true });
}

function schedulePortableShutdown() {
  if (!PORTABLE_MODE || !portableHadClient || io.engine.clientsCount > 0) return;
  clearTimeout(portableIdleTimer);
  portableIdleTimer = setTimeout(async () => {
    if (io.engine.clientsCount > 0) return;
    console.log('[Portable] Kein Dock/Browser verbunden. Twitch Chat by Adin wird beendet.');
    for (const entry of subscriptions.values()) {
      if (entry.adapter) await entry.adapter.disconnect().catch(() => {});
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }, PORTABLE_IDLE_MS);
}

app.use(express.json());
// Das Dock wird oft im OBS-Browser zwischengespeichert. Ohne Cache sieht man
// neue deutsche Texte und Versionsstände sofort nach einem Neustart.
app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: res => res.setHeader('Cache-Control', 'no-store') }));

function capabilities() {
  return {
    twitch: { ready: true, anonymous: true, readOnly: true, needs: [] },
    youtube: { ready: true, anonymous: true, readOnly: true, unofficialWebReader: true, needs: [] },
    kick: { ready: true, anonymous: true, readOnly: true, experimental: true, browserCompatibility: true, needs: [] },
    tiktok: { ready: true, anonymous: true, readOnly: true, experimental: true, needs: [] }
  };
}

app.get('/health', (_, res) => res.json({ ok: true, name: 'Twitch Chat by Adin', version: VERSION, subscriptions: subscriptions.size, capabilities: capabilities() }));
app.get('/api/capabilities', (_, res) => res.json({ version: VERSION, capabilities: capabilities() }));
app.get('/api/update', async (_, res) => {
  try {
    const response = await fetch(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Twitch-Chat-by-Adin' } });
    if (response.status === 404) return res.json({ available: false, message: 'Noch kein GitHub-Release veröffentlicht.' });
    if (!response.ok) throw new Error(`GitHub antwortet mit ${response.status}.`);
    const release = await response.json();
    const latest = String(release.tag_name || '').replace(/^v/i, '');
    const currentParts = VERSION.split('.').map(Number), latestParts = latest.split('.').map(Number);
    let newer = false;
    for (let index = 0; index < Math.max(currentParts.length, latestParts.length); index += 1) {
      const currentPart = currentParts[index] || 0, latestPart = latestParts[index] || 0;
      if (latestPart === currentPart) continue;
      newer = latestPart > currentPart;
      break;
    }
    const asset = (release.assets || []).find(item => /\.zip$/i.test(item.name));
    res.json({ available: newer, current: VERSION, latest: latest || 'unbekannt', url: asset?.browser_download_url || release.html_url, notes: release.body || '' });
  } catch (error) { res.status(502).json({ error: `Update-Prüfung fehlgeschlagen: ${error.message}` }); }
});
app.post('/api/update/open', (req, res) => {
  try {
    const url = new URL(String(req.body?.url || ''));
    const expectedPath = `/${UPDATE_REPOSITORY}/releases/`;
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !url.pathname.startsWith(expectedPath)) throw new Error('Ungültiger Update-Link.');
    // FileProtocolHandler verwendet den in Windows eingerichteten Standardbrowser
    // und funktioniert auch aus dem OBS-Browser-Dock heraus.
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', url.toString()], { windowsHide: true }, error => {
      if (error) console.warn('Update-Browser konnte nicht geöffnet werden:', error.message);
    });
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message || 'Browser konnte nicht geöffnet werden.' }); }
});
app.get('/overlay', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'overlay.html')));
app.get('/dock', (_, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get('/api/twitch/status', (_, res) => res.json({ connected: Boolean(twitchAuth), username: twitchAuth?.username || '' }));
app.post('/api/twitch/logout', async (_, res) => {
  try { await deleteTwitchAuth(); io.emit('twitch:logout'); res.json({ ok: true }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.post('/api/twitch/login', async (_, res) => {
  try {
    const clientId = 'vuquhzwfw1a4bfr95eveowmyft4dv0';
    const body = new URLSearchParams({ client_id: clientId, scopes: 'chat:read chat:edit' });
    const device = await (await fetch('https://id.twitch.tv/oauth2/device', { method: 'POST', body })).json();
    const timer = setInterval(async () => { try { const poll = new URLSearchParams({ client_id: clientId, device_code: device.device_code, scopes: 'chat:read chat:edit', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }); const response = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body: poll }); const token = await response.json(); if (response.ok && token.access_token) { clearInterval(timer); const me = await (await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token.access_token}` } })).json(); twitchAuth = { username: me.login, token: `oauth:${token.access_token}`, clientId }; await saveTwitchAuth(twitchAuth); for (const entry of subscriptions.values()) { if (entry.adapter?.platform === 'twitch') entry.adapter.setAuth(twitchAuth); } io.emit('twitch:login', { username: me.login }); } } catch {} }, Math.max(5, device.interval || 5) * 1000);
    res.json({ verification_uri: device.verification_uri, user_code: device.user_code });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

async function makeAdapter(platform, demo = false) {
  if (demo) return new MockAdapter(platform);
  if (platform === 'youtube') return new YouTubeAdapter();
  if (platform === 'twitch') return new TwitchAdapter(twitchAuth);
  if (platform === 'tiktok') return new TikTokAdapter();
  return null;
}

// Um único adapter por plataforma/canal é compartilhado entre o navegador,
// o Dock do OBS e qualquer outro cliente local. Isso evita mensagens duplicadas
// e evita polling duplicado nas plataformas.
const subscriptions = new Map();
const socketKeys = new Map();
const recentMessages = new Map();

function subscriptionKey(platform, channel, demo) {
  return `${demo ? 'demo' : 'live'}:${platform}:${cleanChannel(platform, channel)}`;
}

function rememberMessage(message) {
  const id = `${message.platform}:${message.id}`;
  const now = Date.now();
  const seenAt = recentMessages.get(id);
  if (seenAt && now - seenAt < 10 * 60 * 1000) return false;
  recentMessages.set(id, now);
  if (recentMessages.size > 6000) {
    for (const [key, when] of recentMessages) {
      if (now - when > 10 * 60 * 1000) recentMessages.delete(key);
      if (recentMessages.size <= 4000) break;
    }
  }
  return true;
}

function emitToSubscribers(entry, event, payload) {
  for (const socketId of entry.sockets) io.to(socketId).emit(event, payload);
}

async function acquire(socket, item, demo) {
  const key = subscriptionKey(item.platform, item.channel, demo);
  let entry = subscriptions.get(key);

  if (entry) {
    entry.sockets.add(socket.id);
    socketKeys.get(socket.id).add(key);
    if (entry.lastStatus) socket.emit('platform:status', entry.lastStatus);
    // Kick has one browser transport owner. If the previous owner disappeared
    // while other local clients (e.g. OBS Dock) kept the shared subscription alive,
    // immediately promote this socket instead of leaving a false "connected" state.
    if (entry.platform === 'kick' && !entry.kickOwnerSocketId) {
      entry.kickOwnerSocketId = socket.id;
      socket.emit('kick:browser-connect', { channel: entry.channel, reason: 'owner-recovery' });
    }
    return;
  }

  // Kick usa um transporte de compatibilidade no Browser Dock. O lookup público
  // do chatroom é feito pelo Chromium/OBS para evitar o HTTP 403 que a proteção
  // Cloudflare devolveu ao Node.js no teste real. As mensagens retornam ao ChatHub
  // pelo Socket.IO e continuam passando pela deduplicação global.
  if (item.platform === 'kick' && !demo) {
    entry = {
      key, adapter: null, sockets: new Set([socket.id]), lastStatus: null,
      platform: 'kick', channel: cleanChannel('kick', item.channel),
      kickOwnerSocketId: socket.id
    };
    subscriptions.set(key, entry);
    socketKeys.get(socket.id).add(key);
    socket.emit('kick:browser-connect', { channel: entry.channel, reason: 'initial-owner' });
    return;
  }

  const adapter = await makeAdapter(item.platform, demo);
  if (!adapter) {
    socket.emit('platform:status', {
      platform: item.platform, connected: false, pending: true,
      detail: 'Dieser Connector ist für eine kommende Version geplant.'
    });
    return;
  }

  entry = { key, adapter, sockets: new Set([socket.id]), lastStatus: null };
  subscriptions.set(key, entry);
  socketKeys.get(socket.id).add(key);

  adapter.on('message', raw => {
    const msg = normalizeMessage(raw);
    if (!msg.message) return;
    if (!rememberMessage(msg)) return;
    emitToSubscribers(entry, 'chat:message', msg);
  });
  adapter.on('status', status => {
    entry.lastStatus = status;
    emitToSubscribers(entry, 'platform:status', status);
  });
  adapter.on('viewers', data => emitToSubscribers(entry, 'viewer:count', data));
  adapter.on('error', err => {
    const status = {
      platform: item.platform, connected: false, error: true,
      detail: err.message
    };
    entry.lastStatus = status;
    emitToSubscribers(entry, 'platform:status', status);
  });

  try {
    await adapter.connect(item.channel);
  } catch (err) {
    const status = { platform: item.platform, connected: false, error: true, detail: err.message };
    entry.lastStatus = status;
    emitToSubscribers(entry, 'platform:status', status);
  }
}

async function releaseKey(socketId, key) {
  const entry = subscriptions.get(key);
  if (!entry) return;
  entry.sockets.delete(socketId);

  if (entry.platform === 'kick' && entry.kickOwnerSocketId === socketId) {
    entry.kickOwnerSocketId = null;
    // Browser/OBS clients can come and go independently. Promote another
    // subscribed socket so the upstream Kick WebSocket is never orphaned.
    const nextOwner = entry.sockets.values().next().value;
    if (nextOwner) {
      entry.kickOwnerSocketId = nextOwner;
      const takeoverStatus = {
        platform: 'kick', connected: false, pending: true,
        detail: 'Öffentlicher Kick-Chat wird nach einem Client-Wechsel neu verbunden…'
      };
      entry.lastStatus = takeoverStatus;
      emitToSubscribers(entry, 'platform:status', takeoverStatus);
      io.to(nextOwner).emit('kick:browser-connect', { channel: entry.channel, reason: 'owner-takeover' });
    }
  }

  if (entry.sockets.size === 0) {
    subscriptions.delete(key);
    if (entry.adapter) await entry.adapter.disconnect().catch(() => {});
  }
}

async function releaseSocket(socketId) {
  const keys = socketKeys.get(socketId);
  if (!keys) return;
  for (const key of [...keys]) await releaseKey(socketId, key);
  keys.clear();
}

io.on('connection', socket => {
  portableHadClient = true;
  clearTimeout(portableIdleTimer);
  socketKeys.set(socket.id, new Set());
  socket.emit('server:ready', { version: VERSION, capabilities: capabilities() });

  socket.on('chat:connect', async config => {
    await releaseSocket(socket.id);
    const selected = Array.isArray(config?.platforms) ? config.platforms : [];
    for (const item of selected) {
      if (!item?.enabled || !item?.channel) continue;
      await acquire(socket, item, Boolean(config.demo));
    }
  });


  socket.on('kick:browser-status', payload => {
    const channel = cleanChannel('kick', payload?.channel || '');
    const key = subscriptionKey('kick', channel, false);
    const entry = subscriptions.get(key);
    if (!entry || !entry.sockets.has(socket.id)) return;
    if (entry.kickOwnerSocketId && entry.kickOwnerSocketId !== socket.id) return;
    const status = {
      platform: 'kick',
      connected: Boolean(payload?.connected),
      pending: Boolean(payload?.pending),
      error: Boolean(payload?.error),
      detail: String(payload?.detail || '')
    };
    entry.lastStatus = status;
    emitToSubscribers(entry, 'platform:status', status);
  });

  socket.on('kick:browser-message', payload => {
    const channel = cleanChannel('kick', payload?.channel || '');
    const key = subscriptionKey('kick', channel, false);
    const entry = subscriptions.get(key);
    if (!entry || !entry.sockets.has(socket.id)) return;
    if (entry.kickOwnerSocketId && entry.kickOwnerSocketId !== socket.id) return;
    const raw = payload?.message || {};
    const sender = raw.sender || {};
    // Reutiliza exatamente a estratégia de badges da v0.6.3, que foi
    // validada em uso real: converte cada badge Kick para uma string simples.
    const badges = Array.isArray(sender.identity?.badges)
      ? sender.identity.badges
          .map(b => String(b?.type || b?.text || b?.name || '').trim().toLowerCase())
          .filter(Boolean)
      : [];
    // Text-first: tokens de emote da Kick não entram na mensagem exibida.
    const content = String(raw.content || '').replace(/\[emote:\d+:[^\]]+\]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
    const created = raw.created_at || raw.createdAt || Date.now();
    const parsedTime = Date.parse(created);
    const msg = normalizeMessage({
      id: raw.id || raw.message_id,
      platform: 'kick', channel,
      username: sender.slug || sender.username || `user-${sender.id || 'unknown'}`,
      displayName: sender.username || sender.slug || 'Kick user',
      avatar: sender.profile_picture || sender.profile_pic || sender.avatar || '',
      message: content,
      timestamp: Number.isFinite(parsedTime) ? parsedTime : Date.now(),
      badges, emotes: [],
      metadata: { color: sender.identity?.color || '', senderId: sender.id || null, chatroomId: payload?.chatroomId || null, anonymousReader: true }
    });
    if (!msg.message) return;
    if (!rememberMessage(msg)) return;
    emitToSubscribers(entry, 'chat:message', msg);
  });

  socket.on('chat:disconnect', async () => {
    await releaseSocket(socket.id);
    socket.emit('chat:disconnected');
  });

  socket.on('disconnect', async () => {
    await releaseSocket(socket.id);
    socketKeys.delete(socket.id);
    schedulePortableShutdown();
  });
});

restoreTwitchAuth().finally(() => server.listen(PORT, '127.0.0.1', () => console.log(`Twitch Chat by Adin v${VERSION}: http://127.0.0.1:${PORT}/dock`)));
