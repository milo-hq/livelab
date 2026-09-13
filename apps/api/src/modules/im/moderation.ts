import type { ModState } from '@livelab/protocol';
import type { Db } from '../../db.js';

export type PostDenial = { ok: false; code: 'muted' | 'slow_mode' | 'rate_limited'; message: string; retryAfterMs?: number };
export type PostVerdict = { ok: true } | PostDenial;

/** Persisted per room in `mod_state.json`. */
interface Persisted {
  muted: Record<string, number>;
  banned: string[];
  keywords: string[];
  slowModeSec: number;
}

const RATE_LIMIT = { max: 5, windowMs: 10_000 };
export const DEFAULT_MUTE_SEC = 600;
const FOREVER = Number.MAX_SAFE_INTEGER;

/**
 * Room moderation: bans, timed mutes, slow mode, per-user rate limit and keyword filtering.
 * Durable bits (`mod_state` table, one JSON row per room) survive restarts; the "last post time"
 * used by slow mode / rate limiting is in memory — losing it on restart only lets a user post once.
 */
export class Moderation {
  private readonly cache = new Map<string, Persisted>();
  /** room → userId → timestamps of accepted posts (only the last `RATE_LIMIT.max` are kept). */
  private readonly posts = new Map<string, Map<string, number[]>>();

  constructor(private readonly db: Db, private readonly now: () => number = Date.now) {}

  // ---- queries --------------------------------------------------------------------------------

  isMuted(room: string, userId: string, now = this.now()): boolean {
    const s = this.load(room);
    return s.banned.includes(userId) || (s.muted[userId] ?? 0) > now;
  }

  isBanned(room: string, userId: string): boolean {
    return this.load(room).banned.includes(userId);
  }

  slowModeSec(room: string): number {
    return this.load(room).slowModeSec;
  }

  state(room: string): ModState {
    const s = this.load(room);
    const now = this.now();
    return {
      muted: Object.entries(s.muted).filter(([, until]) => until > now).map(([userId, until]) => ({ userId, until })),
      banned: [...s.banned],
      keywords: [...s.keywords],
      slowModeSec: s.slowModeSec,
    };
  }

  // ---- mutations ------------------------------------------------------------------------------

  mute(room: string, userId: string, sec = DEFAULT_MUTE_SEC): number {
    const s = this.load(room);
    const until = sec > 0 ? this.now() + sec * 1000 : FOREVER;
    s.muted[userId] = until;
    this.save(room, s);
    return until;
  }

  /** Lifts both a mute and a ban (there is no separate `unban` action in `ModAction`). */
  unmute(room: string, userId: string): void {
    const s = this.load(room);
    delete s.muted[userId];
    s.banned = s.banned.filter((u) => u !== userId);
    this.save(room, s);
  }

  ban(room: string, userId: string): void {
    const s = this.load(room);
    if (!s.banned.includes(userId)) s.banned.push(userId);
    this.save(room, s);
  }

  slowMode(room: string, sec: number): void {
    const s = this.load(room);
    s.slowModeSec = Math.max(0, sec);
    this.save(room, s);
  }

  addKeyword(room: string, kw: string): void {
    const s = this.load(room);
    const k = kw.trim().toLowerCase();
    if (k && !s.keywords.includes(k)) s.keywords.push(k);
    this.save(room, s);
  }

  removeKeyword(room: string, kw: string): void {
    const s = this.load(room);
    const k = kw.trim().toLowerCase();
    s.keywords = s.keywords.filter((x) => x !== k);
    this.save(room, s);
  }

  // ---- posting --------------------------------------------------------------------------------

  /**
   * Gate a chat post and, when allowed, record it (so the slow-mode / rate-limit clocks start).
   * Order: ban → mute → slow mode → rate limit. `privileged` (host/admin) skips the last two.
   */
  canPost(room: string, userId: string, now = this.now(), opts: { privileged?: boolean } = {}): PostVerdict {
    const s = this.load(room);
    if (s.banned.includes(userId)) return { ok: false, code: 'muted', message: 'you are banned from this room' };
    const mutedUntil = s.muted[userId] ?? 0;
    if (mutedUntil > now) {
      const forever = mutedUntil === FOREVER;
      return { ok: false, code: 'muted', message: forever ? 'you are muted' : 'you are muted for a while', ...(forever ? {} : { retryAfterMs: mutedUntil - now }) };
    }
    const times = this.userPosts(room, userId);
    if (!opts.privileged) {
      const last = times[times.length - 1];
      if (s.slowModeSec > 0 && last !== undefined && now - last < s.slowModeSec * 1000) {
        return { ok: false, code: 'slow_mode', message: `slow mode: one message every ${s.slowModeSec}s`, retryAfterMs: s.slowModeSec * 1000 - (now - last) };
      }
      const recent = times.filter((t) => now - t < RATE_LIMIT.windowMs);
      if (recent.length >= RATE_LIMIT.max) {
        return { ok: false, code: 'rate_limited', message: `at most ${RATE_LIMIT.max} messages per ${RATE_LIMIT.windowMs / 1000}s`, retryAfterMs: RATE_LIMIT.windowMs - (now - (recent[0] ?? now)) };
      }
    }
    times.push(now);
    if (times.length > RATE_LIMIT.max) times.splice(0, times.length - RATE_LIMIT.max);
    return { ok: true };
  }

  /**
   * Replace every (case-insensitive) keyword occurrence with `***`. Returns null when the whole
   * message is a keyword — nothing meaningful would be left to show.
   */
  filter(room: string, text: string): string | null {
    const { keywords } = this.load(room);
    if (keywords.length === 0) return text;
    const trimmed = text.trim().toLowerCase();
    if (keywords.includes(trimmed)) return null;
    let out = text;
    for (const kw of keywords) {
      out = out.replace(new RegExp(escapeRegExp(kw), 'gi'), '***');
    }
    return out;
  }

  // ---- persistence ----------------------------------------------------------------------------

  private load(room: string): Persisted {
    let s = this.cache.get(room);
    if (s) return s;
    const row = this.db.prepare('SELECT json FROM mod_state WHERE room_id = ?').get(room) as { json: string } | undefined;
    s = { muted: {}, banned: [], keywords: [], slowModeSec: 0, ...(row ? (JSON.parse(row.json) as Partial<Persisted>) : {}) };
    this.cache.set(room, s);
    return s;
  }

  private save(room: string, s: Persisted): void {
    this.cache.set(room, s);
    this.db.prepare('INSERT OR REPLACE INTO mod_state (room_id, json) VALUES (?, ?)').run(room, JSON.stringify(s));
  }

  private userPosts(room: string, userId: string): number[] {
    let users = this.posts.get(room);
    if (!users) this.posts.set(room, (users = new Map()));
    let times = users.get(userId);
    if (!times) users.set(userId, (times = []));
    return times;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
