const socket = io();
const chat = document.querySelector('#chat');
const statuses = document.querySelector('#statuses');
let filter = 'all';
let lastConfig = null;
let userDisconnected = false;
const visibleMessageIds = new Set();
let kickBrowser = null;
const $ = id => document.getElementById(id);
const twitchAuthBox = document.querySelector('.auth-box');
if (twitchAuthBox) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Mit Twitch verbinden';
  const logoutButton = document.createElement('button'); logoutButton.type = 'button'; logoutButton.textContent = 'Login löschen'; logoutButton.className = 'secondary';
  const info = document.createElement('div'); info.className = 'auth-text';
  twitchAuthBox.append(button, logoutButton, info);
  fetch('/api/twitch/status').then(r => r.json()).then(s => { info.textContent = s.connected ? `Angemeldet als ${s.username}.` : 'Optional: Für Login und spätere Schreibfunktionen.'; });
  button.onclick = async () => { const r = await fetch('/api/twitch/login', { method: 'POST' }), d = await r.json(); if (!r.ok) { info.textContent = d.error || 'Login fehlgeschlagen.'; return; } info.innerHTML = `Öffne <a target="_blank" href="${d.verification_uri}">Twitch</a> und gib Code <b>${d.user_code}</b> ein.`; window.open(d.verification_uri, '_blank'); };
  logoutButton.onclick = async () => { const r = await fetch('/api/twitch/logout', { method: 'POST' }); if (r.ok) info.textContent = 'Gespeicherten Twitch-Login gelöscht.'; };
  socket.on('twitch:login', d => { info.textContent = `Angemeldet als ${d.username}. Deine gespeicherten Chats werden automatisch verbunden.`; });
  socket.on('twitch:logout', () => { info.textContent = 'Twitch-Login gelöscht.'; });
}

let saved = {};
try { saved = JSON.parse(localStorage.getItem('multichat-config-v2') || localStorage.getItem('multichat-config') || '{}'); } catch { saved = {}; }
for (const p of ['twitch', 'youtube', 'kick', 'tiktok']) {
  if (saved[p]?.channel && $(`${p}Channel`)) $(`${p}Channel`).value = saved[p].channel;
  if (typeof saved[p]?.enabled === 'boolean' && $(`${p}Enabled`)) $(`${p}Enabled`).checked = saved[p].enabled;
}
if (typeof saved.demo === 'boolean') $('demoMode').checked = saved.demo;

function statusText(s) {
  if (s.error) return 'Fehler';
  if (s.connected) return 'verbunden';
  if (s.pending) return 'warte';
  return 'offline';
}

function renderPlatformStatus(s) {
  let el = document.querySelector(`[data-status="${s.platform}"]`);
  if (!el) {
    el = document.createElement('span');
    el.className = 'status';
    el.dataset.status = s.platform;
    statuses.appendChild(el);
  }
  el.classList.toggle('error', Boolean(s.error));
  el.classList.toggle('connected', Boolean(s.connected));
  el.textContent = `${s.platform}: ${statusText(s)}${s.detail ? ' — ' + s.detail : ''}`;
}

function showCapabilities(capabilities = {}) {
  const twitch = capabilities.twitch;
  if (twitch?.ready && twitch?.anonymous) renderPlatformStatus({ platform: 'twitch', connected: false, detail: 'bereit für öffentlichen Chat ohne Login' });
  const youtube = capabilities.youtube;
  if (youtube && !youtube.ready) renderPlatformStatus({ platform: 'youtube', connected: false, detail: `Backend nicht eingerichtet (${(youtube.needs || []).join(', ') || 'Einrichtung erforderlich'})` });
  const kick = capabilities.kick;
  if (kick?.ready) renderPlatformStatus({ platform: 'kick', connected: false, detail: 'Beta — Browser-Modus für öffentliche Chats' });
  const tiktok = capabilities.tiktok;
  if (tiktok?.ready) renderPlatformStatus({ platform: 'tiktok', connected: false, detail: 'Beta — öffentlicher LIVE-Chat ohne Login' });
}

function buildConfig() {
  return {
    demo: $('demoMode').checked,
    platforms: ['twitch', 'youtube', 'kick', 'tiktok'].map(platform => ({
      platform,
      enabled: $(`${platform}Enabled`).checked,
      channel: $(`${platform}Channel`).value.trim()
    }))
  };
}

// Bereits gespeicherte Kanäle werden beim Öffnen des OBS-Docks automatisch
// verbunden. Nach einem Neustart ist kein Klick auf „Chats verbinden“ nötig.
const hasSavedConnection = ['twitch', 'youtube', 'kick', 'tiktok']
  .some(platform => Boolean(saved[platform]?.enabled && saved[platform]?.channel));
if (hasSavedConnection) lastConfig = buildConfig();

function saveConfig(config) {
  const data = { demo: config.demo };
  for (const item of config.platforms) data[item.platform] = item;
  localStorage.setItem('multichat-config-v2', JSON.stringify(data));
}

function connectChats({ preserveStatuses = false } = {}) {
  const config = buildConfig();
  lastConfig = config;
  userDisconnected = false;
  saveConfig(config);
  if (!preserveStatuses) statuses.innerHTML = '';
  socket.emit('chat:connect', config);
}

socket.on('connect', () => {
  $('serverStatus').textContent = '● Server verbunden';
  $('serverStatus').classList.add('online');
  if (lastConfig && !userDisconnected) {
    statuses.innerHTML = '';
    socket.emit('chat:connect', lastConfig);
  }
});

socket.on('disconnect', () => {
  $('serverStatus').textContent = '● Server getrennt — verbinde neu …';
  $('serverStatus').classList.remove('online');
});

socket.on('server:ready', info => {
  const version = document.getElementById('version');
  if (version) version.textContent = `v${info.version}`;
  showCapabilities(info.capabilities);
});

socket.on('kick:browser-connect', ({ channel }) => {
  if (kickBrowser) { kickBrowser.disconnect(); kickBrowser = null; }
  if (!window.MultiChatKickBrowser) {
    socket.emit('kick:browser-status', { channel, error: true, detail: 'Kick-Kompatibilitätsmodul wurde nicht geladen.' });
    return;
  }
  kickBrowser = new window.MultiChatKickBrowser(channel);
  kickBrowser.on('status', info => socket.emit('kick:browser-status', { channel, pending: true, detail: info.detail || 'Preparando chat da Kick…' }));
  kickBrowser.on('connected', ({ chatroomId }) => socket.emit('kick:browser-status', {
    channel, connected: true,
    detail: `Öffentlicher Chat kick.com/${channel} im Browser verbunden (nur Lesezugriff). Chatraum ${chatroomId}.`
  }));
  kickBrowser.on('message', raw => socket.emit('kick:browser-message', { channel, chatroomId: kickBrowser?.chatroomId || null, message: raw }));
  kickBrowser.on('error', info => socket.emit('kick:browser-status', {
    channel, error: true,
    detail: `${info.message} Bei CORS/Cloudflare wird automatisch ein weiterer Login-freier Versuch unternommen.`
  }));
  kickBrowser.connect();
});

socket.on('platform:status', renderPlatformStatus);

socket.on('chat:message', m => {
  const uniqueId = `${m.platform}:${m.id}`;
  if (visibleMessageIds.has(uniqueId)) return;
  visibleMessageIds.add(uniqueId);
  if (visibleMessageIds.size > 1000) visibleMessageIds.delete(visibleMessageIds.values().next().value);

  document.querySelector('.empty')?.remove();
  const el = document.createElement('article');
  el.className = 'msg';
  el.dataset.platform = m.platform;
  el.innerHTML = '<div class="msg-head"><span class="avatar-slot"></span><span class="dot"></span><span class="name"></span><span class="badges"></span><span class="platform-name"></span><span class="time"></span></div><div class="text"></div>';
  const avatar = window.MultiChatVisuals?.makeAvatar(m);
  if (avatar) el.querySelector('.avatar-slot').appendChild(avatar); else el.querySelector('.avatar-slot').remove();
  el.querySelector('.name').textContent = m.displayName;
  const badgeBox = el.querySelector('.badges');
  window.MultiChatVisuals?.appendBadges(badgeBox, m.badges || []);
  const platform = el.querySelector('.platform-name');
  if (m.platform === 'twitch' || m.platform === 'tiktok') {
    const logo = m.platform === 'twitch' ? 'twitch.png' : 'tiktok.png';
    platform.innerHTML = `<img src="/assets/${logo}" alt="${m.platform}"> ${m.platform === 'twitch' ? 'Twitch' : 'TikTok'}`;
    Object.assign(platform.style, { display: 'inline-flex', alignItems: 'center', gap: '4px', fontWeight: '700', color: m.platform === 'twitch' ? '#a970ff' : '#4ee9e1' });
    platform.querySelector('img').style.cssText = 'width:14px;height:14px;object-fit:contain';
  } else platform.textContent = m.platform.toUpperCase();
  el.querySelector('.time').textContent = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const textBox = el.querySelector('.text');
  window.MultiChatVisuals?.appendText(textBox, m.message);
  chat.appendChild(el);
  while (chat.children.length > 150) chat.firstChild.remove();
  el.style.display = filter === 'all' || filter === m.platform ? '' : 'none';
  el.style.scrollMarginBottom = '100px';
  el.scrollIntoView({ block: 'end' });
});

$('connectBtn').onclick = () => connectChats();
$('disconnectBtn').onclick = () => {
  userDisconnected = true;
  if (kickBrowser) { kickBrowser.disconnect(); kickBrowser = null; }
  socket.emit('chat:disconnect');
};
socket.on('chat:disconnected', () => { statuses.innerHTML = '<span class="status">Chats getrennt</span>'; });
$('clearBtn').onclick = () => {
  chat.innerHTML = '<div class="empty">Chat geleert. Warte auf neue Nachrichten …</div>';
  visibleMessageIds.clear();
};

document.querySelectorAll('.platform input, #demoMode').forEach(el => {
  el.addEventListener('change', () => saveConfig(buildConfig()));
  if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('input', () => saveConfig(buildConfig()));
});

document.querySelectorAll('#filters button').forEach(b => b.onclick = () => {
  filter = b.dataset.filter;
  document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('.msg').forEach(x => { x.style.display = filter === 'all' || x.dataset.platform === filter ? '' : 'none'; });
});


const copyDockBtn = $('copyDockBtn');
if (copyDockBtn) copyDockBtn.onclick = async () => {
  const url = $('dockUrl')?.textContent?.trim() || `${location.origin}/dock`;
  const feedback = $('copyFeedback');
  try {
    await navigator.clipboard.writeText(url);
    if (feedback) feedback.textContent = 'Adresse kopiert.';
  } catch {
    const area = document.createElement('textarea');
    area.value = url; area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.appendChild(area); area.select();
    document.execCommand('copy'); area.remove();
    if (feedback) feedback.textContent = 'Adresse kopiert.';
  }
  setTimeout(() => { if (feedback) feedback.textContent = ''; }, 2200);
};

window.addEventListener('beforeunload', () => { if (kickBrowser) kickBrowser.disconnect(); });

const viewerBar = document.createElement('div');
viewerBar.className = 'viewer-bar';
viewerBar.innerHTML = '<span>🟣 Twitch: <b id="twitchViewers">—</b> Zuschauer</span><span>♪ TikTok: <b id="tiktokViewers">—</b> Zuschauer</span>';
Object.assign(viewerBar.style, { position: 'fixed', left: '10px', right: '10px', bottom: '8px', zIndex: '999', display: 'flex', justifyContent: 'space-between', gap: '10px', padding: '10px 12px', background: '#151a24', border: '1px solid #252c3a', borderRadius: '10px', fontSize: '12px' });
document.body.append(viewerBar);
const viewerToggle = document.createElement('button');
viewerToggle.type = 'button';
viewerToggle.className = 'viewer-toggle';
document.querySelector('#setup')?.insertAdjacentElement('afterend', viewerToggle);
let showViewers = localStorage.getItem('twitch-chat-by-adin-viewers') !== 'off';
function applyViewerVisibility() {
  viewerBar.style.display = showViewers ? 'flex' : 'none';
  chat.style.paddingBottom = showViewers ? '92px' : '0';
  viewerToggle.textContent = showViewers ? 'Zuschauer ausblenden' : 'Zuschauer anzeigen';
}
viewerToggle.onclick = () => {
  showViewers = !showViewers;
  localStorage.setItem('twitch-chat-by-adin-viewers', showViewers ? 'on' : 'off');
  applyViewerVisibility();
};
applyViewerVisibility();
socket.on('viewer:count', data => { const el = document.getElementById(`${data.platform}Viewers`); if (el) el.textContent = Number(data.count || 0).toLocaleString('de-DE'); });
