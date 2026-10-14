const BaseAdapter = require('./baseAdapter');

class TikTokAdapter extends BaseAdapter {
  constructor({ retryIntervalMs = 60000 } = {}) {
    super('tiktok');
    this.retryIntervalMs = Math.max(30000, Number(retryIntervalMs) || 60000);
    this.connection = null;
    this.retryTimer = null;
    this.stopped = true;
    this.uniqueId = '';
    this.likeTotal = 0;
    this.likeBursts = new Map();
    this.joinCount = 0;
    this.joinTimer = null;
  }

  cleanUser(value) {
    return String(value || '').trim().replace(/^https?:\/\/(www\.)?tiktok\.com\/@/i, '').replace(/\/live.*$/i, '').replace(/^@/, '').trim();
  }

  scheduleRetry(detail) {
    if (this.stopped) return;
    this.connected = false;
    const seconds = Math.round(this.retryIntervalMs / 1000);
    this.emit('status', {
      ...this.status(), pending: true, live: false,
      detail: `${detail} Automatischer neuer Versuch in ${seconds} Sekunden.`
    });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.tryConnect(), this.retryIntervalMs);
  }

  async tryConnect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      if (this.connection) {
        try { await this.connection.disconnect(); } catch {}
        this.connection = null;
      }
      const mod = await import('tiktok-live-connector');
      const TikTokLiveConnection = mod.TikTokLiveConnection;
      if (!TikTokLiveConnection) throw new Error('TikTokLiveConnection ist im installierten Paket nicht verfügbar.');

      const conn = new TikTokLiveConnection(this.uniqueId, {
        processInitialData: false,
        fetchRoomInfoOnConnect: true,
        enableExtendedGiftInfo: false
      });
      this.connection = conn;

      conn.on('chat', data => {
        if (this.stopped || conn !== this.connection) return;

        // The v2.4.x connector uses the modern nested user shape, but some
        // TikTok payloads/fallback paths can still expose legacy flat fields.
        // Read both formats and never publish an empty chat row.
        const user = data?.user || {};
        const common = data?.common || {};
        const textCandidates = [
          data?.comment,
          data?.text,
          data?.content,
          data?.message,
          data?.chatText,
          data?.commentText,
          data?.chatMessage?.comment
        ];
        const comment = textCandidates.find(v => typeof v === 'string' && v.trim())?.trim() || '';

        if (!comment) {
          // Keep one concise diagnostic in the CMD so a future TikTok payload
          // change is visible without polluting the MultiChat UI.
          const keys = data && typeof data === 'object' ? Object.keys(data).slice(0, 30).join(',') : typeof data;
          console.warn(`[TikTok] Evento chat sem texto ignorado. Campos: ${keys}`);
          return;
        }

        const rawId = common?.msgId || common?.messageId || data?.msgId || data?.messageId || data?.id;
        const create = Number(common?.createTime || data?.createTime || data?.timestamp || 0);
        const username = user.uniqueId || user.displayId || data?.uniqueId || data?.displayId || data?.userId || user.userId || 'unknown';
        const displayName = user.nickname || user.nickName || data?.nickname || data?.nickName || username || 'TikTok user';
        const avatar = user.profilePicture?.urls?.[0] || user.avatarThumb?.urlList?.[0] || data?.profilePictureUrl || data?.userDetails?.profilePictureUrls?.[0] || '';
        const rawBadges = user.badges || user.userBadges || data?.userBadges || [];
        const badges = Array.isArray(rawBadges) ? rawBadges.map((b, index) => ({
          id: String(b?.type || b?.name || `tiktok-${index}`),
          label: String(b?.name || b?.title || b?.type || '').trim(),
          image: b?.image?.urlList?.[0] || b?.image?.urls?.[0] || b?.url || ''
        })).filter(b => b.label || b.image) : [];
        if (data?.isModerator || user?.isModerator) badges.push({ id: 'moderator', label: 'Mod' });
        if (data?.isSubscriber || user?.isSubscriber) badges.push({ id: 'subscriber', label: 'Sub' });

        this.emit('message', {
          id: rawId ? String(rawId) : `tt-${this.uniqueId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          platform: 'tiktok', channel: this.uniqueId,
          username,
          displayName,
          avatar,
          message: comment,
          timestamp: create > 1e12 ? create : create > 0 ? create * 1000 : Date.now(),
          badges, emotes: [],
          metadata: {
            userId: user.userId || data?.userId || null,
            secUid: user.secUid || data?.secUid || null,
            anonymousReader: true
          }
        });
      });
      const activity = (data, text, kind) => {
        if (this.stopped || conn !== this.connection) return;
        const user = data?.user || {};
        const username = user.uniqueId || user.displayId || data?.uniqueId || 'TikTok';
        const avatar = user.profilePicture?.urls?.[0] || user.profilePicture?.urlList?.[0] || user.avatarThumb?.urlList?.[0] || user.avatarThumb?.urls?.[0] || data?.profilePictureUrl || data?.avatarUrl || '';
        this.emit('message', { id: `tt-${kind}-${data?.common?.msgId || data?.msgId || Date.now()}-${Math.random().toString(36).slice(2)}`, platform: 'tiktok', channel: this.uniqueId, username, displayName: user.nickname || user.nickName || username, avatar, message: text, timestamp: Date.now(), badges: [{ id: kind, label: kind }], emotes: [], metadata: { activity: kind } });
      };
      conn.on('like', data => {
        const user = data?.user || {};
        const username = user.uniqueId || user.displayId || data?.uniqueId || 'TikTok-Nutzer';
        const count = Math.max(1, Number(data?.likeCount || data?.count || 1));
        this.likeTotal += count;
        const burst = this.likeBursts.get(username) || { count: 0, timer: null, data };
        clearTimeout(burst.timer);
        burst.count += count; burst.data = data;
        burst.timer = setTimeout(() => {
          activity(burst.data, `hat ${burst.count} Likes gegeben · Insgesamt ${this.likeTotal} Likes`, 'Likes');
          this.likeBursts.delete(username);
        // Erst nach fünf Sekunden ohne weitere Likes wird eine gemeinsame
        // Meldung erzeugt. So bleibt der Chat auch bei vielen Likes lesbar.
        }, 5000);
        this.likeBursts.set(username, burst);
      });
      conn.on('follow', data => activity(data, 'folgt dir jetzt', 'Follow'));
      conn.on('share', data => activity(data, 'hat deinen LIVE geteilt', 'Share'));
      conn.on('gift', data => {
        if (data?.repeatEnd === false) return;
        const gift = data?.extendedGiftInfo?.name || data?.giftDetails?.giftName || 'ein Geschenk';
        const count = data?.repeatCount || 1;
        activity(data, `hat ${gift}${count > 1 ? ` × ${count}` : ''} gesendet`, 'Geschenk');
      });
      conn.on('member', () => {
        this.joinCount += 1;
        if (this.joinTimer) return;
        this.joinTimer = setTimeout(() => {
          if (this.joinCount) activity({ user: { uniqueId: 'TikTok LIVE', nickname: 'TikTok LIVE' } }, `${this.joinCount} neue Zuschauer sind dem LIVE beigetreten`, 'Zuschauer');
          this.joinCount = 0; this.joinTimer = null;
        }, 10000);
      });
      conn.on('roomUser', data => {
        const viewers = Number(data?.viewerCount || data?.userCount || data?.total || 0);
        if (viewers > 0) this.emit('viewers', { platform: 'tiktok', count: viewers });
      });
      conn.on('disconnected', info => {
        if (this.stopped || conn !== this.connection) return;
        this.scheduleRetry(`TikTok-LIVE getrennt${info?.reason ? ` (${info.reason})` : ''}.`);
      });
      conn.on('streamEnd', () => {
        if (this.stopped || conn !== this.connection) return;
        this.scheduleRetry(`@${this.uniqueId}: LIVE beendet. Warte auf die nächste Übertragung.`);
      });
      conn.on('error', err => {
        if (this.stopped || conn !== this.connection) return;
        this.emit('status', { ...this.status(), connected: false, pending: true, detail: `TikTok-Verbindung fehlgeschlagen: ${err?.message || 'Unbekannter Verbindungsfehler'}` });
      });

      const state = await conn.connect();
      if (this.stopped || conn !== this.connection) return;
      this.connected = true;
      this.emit('status', {
        ...this.status(), live: true, pending: false,
        detail: `LIVE @${this.uniqueId} verbunden (nur Lesezugriff). Raum ${state?.roomId || 'erkannt'}.`
      });
    } catch (err) {
      if (this.stopped) return;
      const msg = String(err?.message || err || 'Unbekannter Fehler');
      const offline = /offline|not live|isn't live|is not live|UserOffline/i.test(`${err?.name || ''} ${msg}`);
      if (offline) this.scheduleRetry(`@${this.uniqueId}: Kein aktiver LIVE gefunden.`);
      else this.scheduleRetry(`TikTok @${this.uniqueId} konnte nicht verbunden werden: ${msg}`);
    }
  }

  async connect(channel) {
    await this.disconnect();
    const uniqueId = this.cleanUser(channel);
    if (!uniqueId) throw new Error('Bitte den TikTok-Benutzernamen mit @ eingeben.');
    this.uniqueId = uniqueId;
    this.likeTotal = 0;
    this.likeBursts = new Map();
    this.joinCount = 0;
    clearTimeout(this.joinTimer); this.joinTimer = null;
    this.channel = `@${uniqueId}`;
    this.stopped = false;
    this.emit('status', { ...this.status(), connected: false, pending: true, detail: `Suche öffentliche LIVE von @${uniqueId}…` });
    await this.tryConnect();
  }

  async disconnect() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const conn = this.connection;
    this.connection = null;
    if (conn) { try { await conn.disconnect(); } catch {} }
    this.uniqueId = '';
    await super.disconnect();
  }
}

module.exports = TikTokAdapter;
