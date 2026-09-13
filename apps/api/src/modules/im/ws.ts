import type { FastifyInstance } from 'fastify';
import type { RawData } from 'ws';
import { ClientFrame, type ServerFrame, type UserRef } from '@livelab/protocol';
import type { AppContext } from '../../context.js';
import { newId } from '../../lib/ids.js';
import type { Conn } from './hub.js';
import { Likes } from './likes.js';

/** Application close codes (4000–4999 are reserved for applications by RFC 6455). */
export const CLOSE = {
  /** protocol violation: no `hello` in time or hello for another room */
  BAD_HELLO: 4400,
  UNAUTHORIZED: 4401,
  ROOM_NOT_FOUND: 4404,
  /** heartbeat timeout */
  IDLE: 4408,
} as const;

export const HELLO_TIMEOUT_MS = 5_000;
/**
 * Clients ping every 25s (docs/research/03 §1.4 pattern 6: "客户端 25–30s ping，服务端 2 倍超时踢出");
 * 60s leaves room for one lost ping before the server declares the connection dead.
 */
export const IDLE_TIMEOUT_MS = 60_000;

/**
 * `GET /ws?room=<id>&token=<jwt>` — the WebSocket gateway.
 *
 * Handshake: auth from the query (browsers cannot set headers on WebSocket upgrades) → client
 * sends `hello{room, lastSeq?}` within 5s → server answers `welcome{seq, state, history}`.
 * Afterwards: `ping`→`pong`, `chat`→moderation→broadcast (echoed back in a `batch` with the
 * client's `cid` so the optimistic copy can be reconciled), `like`→1s aggregation, `vote`→poll.
 */
export async function imRoutes(app: FastifyInstance, ctx: AppContext) {
  const { hub, moderation } = ctx;
  const likes = new Likes(hub);
  app.addHook('onClose', async () => likes.close());

  app.get<{ Querystring: { room?: string; token?: string } }>('/ws', { websocket: true }, (socket, req) => {
    const send = (frame: ServerFrame) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };
    const fail = (code: number, frame: ServerFrame) => {
      send(frame);
      socket.close(code, frame.t === 'error' ? frame.code : 'bye');
    };

    const roomId = req.query.room ?? '';
    let user: UserRef | null = null;
    let conn: Conn | null = null;
    let helloTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    // Frames that arrive while the token is still being verified are held back, never dropped.
    let pending: RawData[] | null = [];

    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => socket.close(CLOSE.IDLE, 'idle'), IDLE_TIMEOUT_MS);
    };

    const cleanup = () => {
      if (helloTimer) clearTimeout(helloTimer);
      if (idleTimer) clearTimeout(idleTimer);
      helloTimer = idleTimer = null;
      if (conn) hub.leave(roomId, conn);
      conn = null;
    };

    const onFrame = async (raw: RawData) => {
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString()); } catch { return send({ t: 'error', code: 'bad_frame', message: 'invalid json' }); }
      const r = ClientFrame.safeParse(parsed);
      if (!r.success) return send({ t: 'error', code: 'bad_frame', message: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
      const frame = r.data;
      if (!user) return; // cannot happen: frames are buffered until auth completes

      if (frame.t === 'hello') {
        if (conn) return send({ t: 'error', code: 'bad_frame', message: 'already joined' });
        if (frame.room !== roomId) return fail(CLOSE.BAD_HELLO, { t: 'error', code: 'bad_frame', message: 'hello.room does not match ?room=' });
        if (helloTimer) clearTimeout(helloTimer);
        helloTimer = null;
        const c: Conn = { id: newId('c'), user, send };
        conn = c;
        armIdle();
        await hub.join(roomId, c, frame.lastSeq);
        return;
      }
      if (!conn) return fail(CLOSE.BAD_HELLO, { t: 'error', code: 'bad_frame', message: 'send hello first' });

      switch (frame.t) {
        case 'ping':
          armIdle();
          return send({ t: 'pong', ts: frame.ts, serverTs: Date.now() });
        case 'chat': {
          const verdict = moderation.canPost(roomId, user.id, Date.now(), { privileged: user.role !== 'viewer' });
          if (!verdict.ok) return send({ t: 'error', code: verdict.code, message: verdict.message, cid: frame.cid, ...(verdict.retryAfterMs !== undefined ? { retryAfterMs: verdict.retryAfterMs } : {}) });
          const text = moderation.filter(roomId, frame.text);
          if (text === null) return send({ t: 'error', code: 'filtered', message: 'message blocked by keyword filter', cid: frame.cid });
          await hub.broadcast(roomId, { t: 'chat', lane: 'chat', room: roomId, id: newId('m'), cid: frame.cid, user, text });
          return;
        }
        case 'like':
          return likes.add(roomId, frame.n);
        case 'vote': {
          const res = hub.vote(roomId, frame.pollId, frame.option, user.id);
          if (res !== 'ok') return send({ t: 'error', code: 'bad_frame', message: `vote rejected: ${res}` });
          return;
        }
      }
    };

    socket.on('message', (raw: RawData) => {
      if (pending) return void pending.push(raw);
      onFrame(raw).catch((e) => {
        req.log.error(e, 'ws frame handling failed');
        send({ t: 'error', code: 'bad_frame', message: 'internal error' });
      });
    });
    socket.on('close', cleanup);
    socket.on('error', cleanup);

    void (async () => {
      const token = req.query.token ?? '';
      user = token ? await app.verifyToken(token) : null;
      if (!user) return fail(CLOSE.UNAUTHORIZED, { t: 'error', code: 'unauthorized', message: 'missing or invalid token' });
      if (!roomId || !ctx.rooms.get(roomId)) return fail(CLOSE.ROOM_NOT_FOUND, { t: 'error', code: 'room_closed', message: 'room not found' });
      helloTimer = setTimeout(() => {
        if (!conn) fail(CLOSE.BAD_HELLO, { t: 'error', code: 'bad_frame', message: `no hello within ${HELLO_TIMEOUT_MS}ms` });
      }, HELLO_TIMEOUT_MS);
      const queued = pending ?? [];
      pending = null;
      for (const raw of queued) await onFrame(raw);
    })().catch((e) => {
      req.log.error(e, 'ws setup failed');
      socket.close(1011, 'internal');
    });
  });
}
