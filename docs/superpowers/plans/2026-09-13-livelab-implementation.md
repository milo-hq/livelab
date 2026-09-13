# LiveLab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable, production-shaped live-streaming web platform (player, danmaku/IM, host interaction, virtual-currency payments, ops tools, QoE telemetry) plus a Chinese tutorial, following `docs/superpowers/specs/2026-09-13-livelab-design.md`.

**Architecture:** pnpm/Turborepo monorepo. `packages/*` hold framework-agnostic cores (protocol schemas, player engines, danmaku renderer, telemetry SDK). `apps/api` is a Fastify 5 service (REST + WebSocket + payment mock + telemetry ingest + weak-network proxy) backed by `node:sqlite`, Redis (optional, in-memory fallback) and ClickHouse (optional, console fallback). `apps/web` is a React 19 SPA (viewer room, host console, admin, lab). `infra/` runs MediaMTX, SRS, Redis, ClickHouse, Grafana and an FFmpeg test pusher via Docker Compose.

**Tech Stack:** pnpm 10, turbo 2, TypeScript 5.9.3, React 19.3, Vite 8.3, Tailwind 4.3, react-router 8.3, Zustand 5, TanStack Query 5, hls.js 1.7.3, mpegts.js 1.8.2, media-chrome 4.19, web-vitals 6, Fastify 5.12, @fastify/websocket 11, ioredis 6, zod 4, jose 6, Vitest 5, Playwright 1.63, MediaMTX 1.21.0, SRS 6, ClickHouse 26.8, Grafana 13.2.

## Global Constraints

- Node ≥ 22.13 (uses `node:sqlite`); developer machine has Node 25.8, pnpm 10.25, Docker 29, FFmpeg 8.
- TypeScript pinned to `5.9.3` (do NOT use 7.x). `"strict": true`, `"verbatimModuleSyntax": true`, ESM everywhere (`"type": "module"`).
- Package scope `@livelab/*`. Ports: web 5173, api 8787, MediaMTX 1935/8888/8889/8890/9997(API), SRS 1936(RTMP)/8080(FLV)/1985(API), Redis 6379, ClickHouse 8123, Grafana 3000.
- All shared message/DTO types come from `@livelab/protocol` (zod 4). No duplicated hand-written types across apps.
- Every task ends with `pnpm -r typecheck` passing for touched packages and a commit. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Tutorial prose in Chinese; identifiers, comments and commit messages in English.
- Services must degrade gracefully: api runs without Redis/ClickHouse; web runs without api (shows error states).

---

## Phase P0 — Monorepo skeleton and infra

### Task 0.1: Monorepo bootstrap

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, `.gitignore`, `.npmrc`, `.editorconfig`, `README.md`
- Create: `packages/protocol/package.json`, `packages/protocol/tsconfig.json`, `packages/protocol/src/index.ts`

**Interfaces:**
- Produces: workspace scripts `pnpm dev`, `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm infra:up`, `pnpm infra:down`.

- [ ] **Step 1: Root files**

`package.json`:
```json
{
  "name": "livelab",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.25.0",
  "engines": { "node": ">=22.13" },
  "scripts": {
    "dev": "turbo run dev --parallel",
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "infra:up": "docker compose -f infra/docker-compose.yml up -d",
    "infra:down": "docker compose -f infra/docker-compose.yml down",
    "infra:flv": "docker compose -f infra/docker-compose.yml --profile flv up -d"
  },
  "devDependencies": { "turbo": "^2.10.12", "typescript": "5.9.3", "vitest": "^5.0.0" }
}
```
`pnpm-workspace.yaml`: `packages: ["apps/*", "packages/*"]`.
`turbo.json`: tasks `build` (dependsOn `^build`, outputs `dist/**`), `dev` (cache false, persistent), `test`, `typecheck` (dependsOn `^build`), `lint`.
`tsconfig.base.json`: `target ES2022`, `module ESNext`, `moduleResolution Bundler`, `strict`, `verbatimModuleSyntax`, `skipLibCheck`, `isolatedModules`, `noUncheckedIndexedAccess`.
`.npmrc`: `auto-install-peers=true`.

- [ ] **Step 2: protocol package shell** with `src/index.ts` exporting `export const PROTOCOL_VERSION = 1`.
- [ ] **Step 3: Run** `pnpm install && pnpm typecheck` → passes.
- [ ] **Step 4: Commit** `chore: bootstrap pnpm/turbo monorepo`.

### Task 0.2: Infra — Docker Compose with MediaMTX, test pusher, Redis, ClickHouse, Grafana, SRS profile

**Files:**
- Create: `infra/docker-compose.yml`, `infra/mediamtx.yml`, `infra/srs.conf`, `infra/clickhouse/init.sql`, `infra/grafana/provisioning/datasources/clickhouse.yml`, `infra/grafana/provisioning/dashboards/dashboards.yml`, `infra/pusher/push.sh`

**Interfaces:**
- Produces: LL-HLS at `http://localhost:8888/live/demo/index.m3u8`, WHEP at `http://localhost:8889/live/demo/whep`, HTTP-FLV (profile flv) at `http://localhost:8080/live/demo.flv`, MediaMTX API `http://localhost:9997/v3/paths/list`, ClickHouse table `qoe.events`, Grafana at `http://localhost:3000` (admin/admin).

- [ ] **Step 1: Fetch the real default `mediamtx.yml` for 1.21.0** (`curl -sL https://raw.githubusercontent.com/bluenviron/mediamtx/v1.21.0/mediamtx.yml`) and derive a minimal config: `api: yes`, `apiAddress: :9997`, `hls: yes`, `hlsVariant: lowLatency`, `hlsSegmentDuration: 1s`, `hlsPartDuration: 500ms`, `hlsSegmentCount: 7`, `hlsAllowOrigin: '*'`, `webrtc: yes`, `webrtcAllowOrigin: '*'`, `webrtcAdditionalHosts: [127.0.0.1, localhost]`, `rtmp: yes`, `srt: yes`, `paths: all_others: {}`. Verify each key exists in the fetched default file before using it.
- [ ] **Step 2: `push.sh`** — FFmpeg lavfi loop, no media file needed; pushes two renditions for ABR (`demo_720`, `demo_360`) plus a single `demo` path, with burned-in wall clock for glass-to-glass latency measurement:
```sh
#!/bin/sh
set -e
TARGET=${TARGET:-rtmp://mediamtx:1935/live}
exec ffmpeg -hide_banner -loglevel warning -re \
  -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -filter_complex "[0:v]drawtext=text='%{localtime\:%H\\\\\:%M\\\\\:%S.%3N} LiveLab':fontsize=48:fontcolor=white:box=1:boxcolor=black@0.6:x=40:y=40,split=3[v720][v360][vmain]; [v360]scale=640:360[v360s]" \
  -map "[vmain]" -map 1:a -c:v libx264 -preset veryfast -tune zerolatency -g 30 -keyint_min 30 -sc_threshold 0 -b:v 2500k -pix_fmt yuv420p -c:a aac -b:a 128k -f flv "$TARGET/demo" \
  -map "[v720]"  -map 1:a -c:v libx264 -preset veryfast -tune zerolatency -g 30 -keyint_min 30 -sc_threshold 0 -b:v 2500k -pix_fmt yuv420p -c:a aac -b:a 128k -f flv "$TARGET/demo_720" \
  -map "[v360s]" -map 1:a -c:v libx264 -preset veryfast -tune zerolatency -g 30 -keyint_min 30 -sc_threshold 0 -b:v 700k  -pix_fmt yuv420p -c:a aac -b:a 64k  -f flv "$TARGET/demo_360"
```
Verify the drawtext escaping by running the container and checking `docker logs`.
- [ ] **Step 3: `docker-compose.yml`** services: `mediamtx` (image `bluenviron/mediamtx:1.21.0`, ports 1935, 8888, 8889, 8890/udp, 8189/udp, 9997; volume `./mediamtx.yml:/mediamtx.yml`), `pusher` (image `linuxserver/ffmpeg:latest`, `entrypoint: /push.sh`, volume `./pusher/push.sh:/push.sh:ro`, `depends_on: mediamtx`, `restart: unless-stopped`), `srs` (profile `flv`, image `ossrs/srs:6`, ports `1936:1935`, `1985:1985`, `8080:8080`, volume `./srs.conf:/usr/local/srs/conf/docker.conf`, command `./objs/srs -c conf/docker.conf`), `pusher-srs` (profile `flv`, same image, `TARGET=rtmp://srs:1935/live`), `redis` (`redis:7-alpine`, 6379), `clickhouse` (`clickhouse/clickhouse-server:26.8`, 8123, 9000, volume `./clickhouse/init.sql:/docker-entrypoint-initdb.d/init.sql`, env `CLICKHOUSE_USER=default`, `CLICKHOUSE_PASSWORD=livelab`, `CLICKHOUSE_DB=qoe`), `grafana` (`grafana/grafana:13.2.1`, 3000, env `GF_INSTALL_PLUGINS=grafana-clickhouse-datasource`, `GF_SECURITY_ADMIN_PASSWORD=admin`, volume `./grafana/provisioning:/etc/grafana/provisioning`).
- [ ] **Step 4: `srs.conf`** minimal: listen 1935; http_api 1985; http_server 8080; vhost `__defaultVhost__` with `http_remux { enabled on; mount [vhost]/[app]/[stream].flv; }` and `hls { enabled off; }`.
- [ ] **Step 5: `clickhouse/init.sql`** — table from spec §4.4/research 04:
```sql
CREATE DATABASE IF NOT EXISTS qoe;
CREATE TABLE IF NOT EXISTS qoe.events (
  ts DateTime64(3), event LowCardinality(String),
  session_id String, view_id String, user_id String,
  room_id LowCardinality(String), protocol LowCardinality(String),
  player LowCardinality(String), player_ver LowCardinality(String),
  cdn LowCardinality(String), region LowCardinality(String), isp LowCardinality(String),
  os LowCardinality(String), browser LowCardinality(String), net_type LowCardinality(String),
  value_ms UInt32, bitrate_kbps UInt32, level Int16, buffer_ms UInt32, latency_ms UInt32,
  dropped_frames UInt32, total_frames UInt32,
  err_type LowCardinality(String), err_detail LowCardinality(String), fatal UInt8,
  attrs Map(LowCardinality(String), String)
) ENGINE = MergeTree PARTITION BY toDate(ts)
ORDER BY (room_id, event, ts, session_id) TTL toDateTime(ts) + INTERVAL 30 DAY;
```
- [ ] **Step 6: Grafana provisioning** datasource (type `grafana-clickhouse-datasource`, url `clickhouse`, port 8123, protocol http, defaultDatabase `qoe`, username default, secureJsonData password `livelab`) and a dashboards provider pointing at `/etc/grafana/provisioning/dashboards/json`. Dashboards JSON added in Task 5.4.
- [ ] **Step 7: Verify**: `pnpm infra:up`; `curl -s localhost:9997/v3/paths/list | jq` shows `demo`, `demo_720`, `demo_360` ready; `curl -s localhost:8888/live/demo/index.m3u8` returns a multivariant playlist; record the media playlist filename it references (needed by Task 1.6); `curl -s 'localhost:8123/?query=SELECT%201' -u default:livelab` returns `1`.
- [ ] **Step 8: Commit** `infra: docker compose for mediamtx, srs, redis, clickhouse, grafana with ffmpeg test pusher`.

### Task 0.3: `@livelab/protocol` schemas

**Files:**
- Create: `packages/protocol/src/im.ts`, `packages/protocol/src/rest.ts`, `packages/protocol/src/telemetry.ts`, `packages/protocol/src/index.ts`, `packages/protocol/src/im.test.ts`

**Interfaces (Produces):**
```ts
// im.ts
export const Lane = z.enum(['chat', 'gift', 'system']);
export const UserRef = z.object({ id: z.string(), name: z.string(), role: z.enum(['viewer','host','admin']) });
export const ClientFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), room: z.string(), lastSeq: z.number().int().nonnegative().optional() }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
  z.object({ t: z.literal('chat'), cid: z.string(), text: z.string().trim().min(1).max(200) }),
  z.object({ t: z.literal('like'), n: z.number().int().min(1).max(50) }),
]);
const Base = { seq: z.number().int(), room: z.string(), ts: z.number() };
export const ChatMsg = z.object({ ...Base, t: z.literal('chat'), lane: z.literal('chat'), id: z.string(), cid: z.string().optional(), user: UserRef, text: z.string() });
export const GiftMsg = z.object({ ...Base, t: z.literal('gift'), lane: z.literal('gift'), id: z.string(), user: UserRef, gift: z.object({ id: z.string(), name: z.string(), price: z.number(), animation: z.enum(['confetti','hearts','rocket']) }), count: z.number().int().min(1) });
export const LikeAgg = z.object({ ...Base, t: z.literal('like_agg'), lane: z.literal('system'), count: z.number().int(), total: z.number().int() });
export const SystemMsg = z.object({ ...Base, t: z.literal('system'), lane: z.literal('system'),
  kind: z.enum(['join','leave','announce','pin','unpin','poll','poll_end','mod','slow_mode','cohost','online']),
  payload: z.record(z.string(), z.unknown()) });
export const ServerMsg = z.discriminatedUnion('t', [ChatMsg, GiftMsg, LikeAgg, SystemMsg]);
export const RoomState = z.object({ online: z.number().int(), slowModeSec: z.number().int(), pinned: ChatMsg.nullable(), announce: z.string().nullable(),
  poll: z.object({ id: z.string(), question: z.string(), options: z.array(z.string()), votes: z.array(z.number().int()), endsAt: z.number() }).nullable() });
export const ServerFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), seq: z.number().int(), state: RoomState, history: z.array(ServerMsg) }),
  z.object({ t: z.literal('pong'), ts: z.number(), serverTs: z.number() }),
  z.object({ t: z.literal('batch'), msgs: z.array(ServerMsg) }),
  z.object({ t: z.literal('state'), state: RoomState.partial() }),
  z.object({ t: z.literal('error'), code: z.enum(['unauthorized','muted','slow_mode','rate_limited','bad_frame','room_closed']), message: z.string(), retryAfterMs: z.number().optional() }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>; // and all others
```
```ts
// rest.ts
export const Protocol = z.enum(['whep','llhls','hls','flv']);
export const Pathway = z.object({ protocol: Protocol, url: z.string(), cdn: z.string(), priority: z.number().int() });
export const PlayPolicy = z.object({ preferred: Protocol, targetLatencySec: z.number(), maxStartupMs: z.number(), stallLadder: z.array(z.enum(['nudge','downgrade','seek_live','switch_pathway','switch_protocol'])) });
export const PlayResponse = z.object({ roomId: z.string(), pathways: z.array(Pathway), policy: PlayPolicy });
export const Room = z.object({ id, title, hostId, hostName, status: z.enum(['live','offline']), mode: z.enum(['standard','interactive']), viewers: z.number().int(), coverUrl: z.string(), createdAt: z.number() });
export const RoomWithKey = Room.extend({ streamKey: z.string(), ingest: z.object({ rtmp: z.string(), whip: z.string(), srt: z.string() }) });
export const Gift = z.object({ id, name, price: z.number().int(), animation: z.enum(['confetti','hearts','rocket']), icon: z.string() });
export const Wallet = z.object({ userId: z.string(), balance: z.number().int() });
export const Order = z.object({ id, userId, coins: z.number().int(), priceCents: z.number().int(), status: z.enum(['created','paid','failed','expired']), createdAt: z.number(), paidAt: z.number().nullable() });
export const SendGiftRequest = z.object({ roomId: z.string(), giftId: z.string(), count: z.number().int().min(1).max(99) });
export const SendGiftResponse = z.object({ ok: z.literal(true), balance: z.number().int(), msgId: z.string() });
export const AuthRequest = z.object({ name: z.string().min(1).max(24), role: z.enum(['viewer','host','admin']).default('viewer') });
export const AuthResponse = z.object({ token: z.string(), user: UserRef });
export const ModAction = z.object({ action: z.enum(['mute','unmute','ban','pin','unpin','slow_mode','announce','poll_start','poll_end','keyword_add','keyword_remove']), targetUserId: z.string().optional(), msgId: z.string().optional(), seconds: z.number().int().optional(), text: z.string().optional(), question: z.string().optional(), options: z.array(z.string()).optional() });
export const StreamHealth = z.object({ ready: z.boolean(), bytesReceived: z.number(), readers: z.number(), tracks: z.array(z.string()), sourceType: z.string().nullable() });
export const AdminOverview = z.object({ rooms: z.array(Room.extend({ online: z.number().int(), msgRate: z.number() })), qoe: z.object({ ttffP50: z.number().nullable(), ttffP95: z.number().nullable(), stallPer100s: z.number().nullable(), failurePct: z.number().nullable(), sessions: z.number().int() }) });
```
```ts
// telemetry.ts
export const TelemetryEvent = z.object({ name: z.string(), ts: z.number(), viewId: z.string().optional(), roomId: z.string().optional(), attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}) });
export const TelemetryContext = z.object({ sessionId: z.string(), userId: z.string().optional(), player: z.string(), playerVer: z.string(), os: z.string(), browser: z.string(), netType: z.string(), region: z.string().default('local'), isp: z.string().default('local') });
export const TelemetryBatch = z.object({ ctx: TelemetryContext, events: z.array(TelemetryEvent).min(1).max(500) });
```
- [ ] **Step 1: Test** `im.test.ts`: `ClientFrame.parse({t:'chat',cid:'a',text:'  hi '})` yields text `'hi'`; text of 201 chars throws; `ServerFrame.parse` round-trips a batch with one chat and one gift; unknown `t` throws.
- [ ] **Step 2: Implement**, export everything plus `type` aliases from `index.ts`.
- [ ] **Step 3: Run** `pnpm --filter @livelab/protocol test` → pass. **Commit** `feat(protocol): zod schemas for IM frames, REST DTOs and telemetry`.

### Task 0.4: `apps/api` skeleton with auth, rooms, play pathways

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/server.ts`, `apps/api/src/config.ts`, `apps/api/src/db.ts`, `apps/api/src/plugins/auth.ts`, `apps/api/src/modules/rooms/routes.ts`, `apps/api/src/modules/rooms/service.ts`, `apps/api/src/modules/rooms/pathways.ts`, `apps/api/src/modules/rooms/pathways.test.ts`, `apps/api/.env.example`

**Interfaces (Produces):**
- `config`: `{ port, jwtSecret, mediaHost ('localhost'), mediamtxHls ('http://localhost:8888'), mediamtxWebrtc ('http://localhost:8889'), mediamtxApi ('http://localhost:9997'), srsFlv ('http://localhost:8080'), redisUrl?: string, clickhouseUrl?: string, clickhouseUser, clickhousePassword, webhookSecret }` from env with defaults.
- `db.ts`: `openDb(path = ':memory:' | file)` using `node:sqlite` `DatabaseSync`; runs migrations creating `users, rooms, wallets, orders, payment_events, ledger_entries, gift_orders, mod_state`.
- `buildPathways(room, cfg): Pathway[]` and `policyFor(room): PlayPolicy` — standard room: `[llhls(demo master via api /v1/rooms/:id/master.m3u8, cdn 'local-a', p1), llhls(direct mediamtx index.m3u8, cdn 'local-b', p2), flv(srs, cdn 'local-flv', p3), whep(p4)]`; interactive room: whep first, `targetLatencySec` 1.
- Routes: `POST /v1/auth/demo`, `GET /v1/rooms`, `GET /v1/rooms/:id`, `GET /v1/rooms/:id/play`, `GET /v1/rooms/:id/master.m3u8` (multivariant playlist referencing `demo_720`/`demo_360` media playlists; filename discovered in Task 0.2 step 7), `GET /healthz`.
- Auth plugin: `fastify.authenticate` preHandler verifying `Authorization: Bearer` JWT (jose HS256) → `request.user: UserRef`.
- Seed: rooms `demo` (standard, host `host-demo`) and `demo-rt` (interactive) both mapping to MediaMTX path `demo`.

- [ ] **Step 1: Test** `pathways.test.ts`: standard room yields llhls first with 4 entries sorted by priority; interactive yields whep first; master playlist string contains two `#EXT-X-STREAM-INF` lines with `BANDWIDTH=2500000` and `700000`.
- [ ] **Step 2: Implement** with `@fastify/cors` (origin true), `@fastify/websocket` registered (used later), `pino` logger. `master.m3u8` handler sets `content-type: application/vnd.apple.mpegurl` and `cache-control: no-store`.
- [ ] **Step 3: Run** `pnpm --filter @livelab/api dev` (tsx watch) → `curl localhost:8787/v1/rooms/demo/play | jq`. Test passes. **Commit** `feat(api): fastify skeleton, demo auth, rooms and play pathways`.

### Task 0.5: `apps/web` shell

**Files:**
- Create: `apps/web/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `src/main.tsx`, `src/app.tsx`, `src/styles.css`, `src/lib/api.ts`, `src/lib/auth.ts`, `src/stores/session.ts`, `src/routes/home.tsx`, `src/routes/room.tsx`, `src/routes/host.tsx`, `src/routes/admin.tsx`, `src/routes/lab.tsx`, `src/routes/pay-mock.tsx`, `src/components/layout.tsx`

**Interfaces (Produces):**
- `api.get<T>(path, schema)`, `api.post<T>(path, body, schema, {idempotencyKey?})` — attaches Bearer token from `useSession` store; parses response with zod schema.
- `useSession()` Zustand store: `{ user: UserRef | null, token, login(name, role), logout }` persisted in localStorage.
- Routes wired with `react-router` v8 declarative API (`BrowserRouter` from `react-router/dom`, `Routes`, `Route`). Vite proxy `/v1`, `/ws`, `/weaknet` → `http://localhost:8787`.
- Tailwind 4 via `@tailwindcss/vite`; dark theme base.

- [ ] **Step 1: Scaffold**, add `index.html` with `<link rel="preconnect" href="http://localhost:8888">` and `<link rel="preconnect" href="http://localhost:8889">`.
- [ ] **Step 2: Home** lists rooms via TanStack Query (`GET /v1/rooms`), login modal (name + role) calling `POST /v1/auth/demo`.
- [ ] **Step 3: Verify** `pnpm dev` shows room list. **Commit** `feat(web): vite/react shell, routing, session store, api client`.

---

## Phase P1 — Playback core

### Task 1.1: `@livelab/player-core` engine contract and capability detection

**Files:**
- Create: `packages/player-core/package.json`, `tsconfig.json`, `src/index.ts`, `src/types.ts`, `src/capabilities.ts`, `src/emitter.ts`, `src/capabilities.test.ts`

**Interfaces (Produces):**
```ts
export type EngineKind = 'hls' | 'flv' | 'whep' | 'native-hls';
export interface EngineStats { latencyMs: number | null; bufferMs: number; bitrateKbps: number | null; level: number | null; levels: number; droppedFrames: number; totalFrames: number; playbackRate: number }
export type EngineEventMap = {
  ready: { kind: EngineKind };
  playing: {};
  stall_start: {};
  stall_end: { durationMs: number };
  level_switch: { level: number; bitrateKbps: number | null; reason: 'abr' | 'manual' | 'recovery' };
  error: { type: string; detail: string; fatal: boolean; raw?: unknown };
  stats: EngineStats;
  log: { level: 'debug'|'info'|'warn'|'error'; msg: string };
};
export interface EngineOptions { targetLatencySec: number; startLevel?: number; bandwidthEstimate?: number; cmcd?: { sessionId: string; contentId: string }; workerUrl?: string; requestTransform?: (url: string) => string }
export interface PlayerEngine {
  readonly kind: EngineKind;
  load(video: HTMLVideoElement, src: string, opts: EngineOptions): Promise<void>;
  destroy(): void;
  getStats(): EngineStats;
  setLevel(level: number): void;      // -1 = auto
  seekToLive(): void;
  on<K extends keyof EngineEventMap>(ev: K, cb: (p: EngineEventMap[K]) => void): () => void;
}
export function detectCapabilities(): { mse: boolean; managedMse: boolean; nativeHls: boolean; webrtc: boolean; isIOS: boolean; isSafari: boolean }
export function createEmitter<M>(): { on, emit, clear }
```
- [ ] Test `capabilities.test.ts` with a fake `window`/`navigator` (jsdom): returns `nativeHls:true` when `canPlayType('application/vnd.apple.mpegurl')` returns 'maybe'; `mse:false` when `MediaSource` undefined.
- [ ] Implement, commit `feat(player-core): engine contract, emitter, capability detection`.

### Task 1.2: HlsEngine (hls.js 1.7, LL-HLS presets, CMCD v2, recovery)

**Files:** `src/engines/hls.ts`, `src/engines/hls-config.ts`, `src/engines/hls-config.test.ts`

**Interfaces:** `buildHlsConfig(opts: EngineOptions): Partial<HlsConfig>`; `class HlsEngine implements PlayerEngine`.

- [ ] Test `hls-config.test.ts`: `targetLatencySec: 2` → `liveSyncDuration: 2`, `liveMaxLatencyDuration: 6`, `maxLiveSyncPlaybackRate: 1.5`, `lowLatencyMode: true`, `backBufferLength: 30`; `bandwidthEstimate: 3e6` → `abrEwmaDefaultEstimate: 3e6`, `testBandwidth: false`; `cmcd` present → `cmcd.version: 2`, `cmcd.sessionId`; `requestTransform` → `xhrSetup`/`fetchSetup` provided.
- [ ] Implement: dynamic `import('hls.js')`; `enableWorker: true` with `workerPath: opts.workerUrl`; `startFragPrefetch: true`; map events: `MANIFEST_PARSED`→`ready`, `LEVEL_SWITCHED`→`level_switch`, `ERROR`→`error` (non-fatal `BUFFER_STALLED_ERROR` → `stall_start` from probe, not here); fatal NETWORK → `startLoad()` once then fatal; fatal MEDIA → `recoverMediaError()` once, then fatal. Stats every 1s from `hls.latency`, `hls.bandwidthEstimate`, `video.getVideoPlaybackQuality()`. Persist bandwidth estimate to `localStorage['livelab.bw']` on destroy. `seekToLive` sets `video.currentTime = hls.liveSyncPosition ?? end`.
- [ ] Commit `feat(player-core): HlsEngine with LL-HLS presets, CMCD v2 and error recovery`.

### Task 1.3: FlvEngine (mpegts.js) and NativeHlsEngine

**Files:** `src/engines/flv.ts`, `src/engines/native-hls.ts`

- [ ] FlvEngine: dynamic `import('mpegts.js')`; `createPlayer({type:'flv', isLive:true, url}, { enableWorker: true, liveBufferLatencyChasing: true, liveBufferLatencyMaxLatency: targetLatencySec, liveBufferLatencyMinRemain: 0.5, liveSync: true, liveSyncMaxLatency: targetLatencySec, autoCleanupSourceBuffer: true })`; `STATISTICS_INFO` → stats (`speed`, `droppedFrames`); `ERROR` → error with `fatal:true` for `NETWORK`/`MEDIA` types except `NETWORK_TIMEOUT` (retry once via `unload/load`).
- [ ] NativeHlsEngine: sets `video.src`; `latencyMs` computed from `video.buffered.end - currentTime` only (no PDT access); `ready` on `loadedmetadata`.
- [ ] Commit `feat(player-core): FlvEngine (mpegts.js) and native HLS engine`.

### Task 1.4: WhepEngine (hand-written WHEP client)

**Files:** `src/engines/whep.ts`, `src/engines/whep-client.ts`, `src/engines/whep-client.test.ts`

**Interfaces:** `class WhepClient { constructor(endpoint: string, opts?: { iceServers?: RTCIceServer[]; fetch?: typeof fetch }); connect(video): Promise<void>; close(): Promise<void>; pc: RTCPeerConnection; resourceUrl: string | null }`.

- [ ] Test with a fake `RTCPeerConnection` + fake `fetch`: connect POSTs `content-type: application/sdp` with the offer, sets remote description from 201 body, stores `Location` header (absolute or relative resolved against endpoint); `close()` issues `DELETE resourceUrl`; non-201 → throws `WhepError` with status.
- [ ] Implement: `addTransceiver('video',{direction:'recvonly'})`, `('audio',...)`, wait for ICE gathering complete (or 1s timeout) before POST; `ontrack` → `video.srcObject = stream`; `connectionstatechange` `failed` → `error{fatal:true, type:'webrtc', detail:'connection_failed'}`, `disconnected` → `stall_start`, back to `connected` → `stall_end`. Stats via `getStats()` inbound-rtp: `framesDropped`, `framesDecoded`, `jitterBufferDelay/jitterBufferEmittedCount` → latencyMs approximation.
- [ ] Commit `feat(player-core): WHEP engine with hand-written client`.

### Task 1.5: QoeProbe and PlayerController (fallback chain + stall recovery ladder)

**Files:** `src/qoe-probe.ts`, `src/qoe-probe.test.ts`, `src/controller.ts`, `src/controller.test.ts`, `src/index.ts`

**Interfaces (Produces):**
```ts
export type QoeEvent =
  | { name: 'play_attempt'; ts: number }
  | { name: 'first_frame'; ts: number; ttffMs: number; protocol: string }
  | { name: 'stall_start'; ts: number } | { name: 'stall_end'; ts: number; durationMs: number }
  | { name: 'level_switch'; ts: number; level: number; bitrateKbps: number | null }
  | { name: 'latency_sample'; ts: number; latencyMs: number; bufferMs: number }
  | { name: 'heartbeat'; ts: number; playingMs: number; stalledMs: number; droppedFrames: number; totalFrames: number; bitrateKbps: number | null; latencyMs: number | null }
  | { name: 'error'; ts: number; type: string; detail: string; fatal: boolean }
  | { name: 'recovery_action'; ts: number; action: string; from: string; to: string }
  | { name: 'end'; ts: number; watchMs: number; reason: 'user' | 'fatal' | 'unload' };
export function createQoeProbe(video: HTMLVideoElement, opts: { minStallMs?: number (200); heartbeatMs?: number (10000); now?: () => number }): { attachEngine(e: PlayerEngine): void; markPlayAttempt(): void; onEvent(cb: (e: QoeEvent) => void): () => void; end(reason): void; destroy(): void }
export interface ControllerOptions { pathways: Pathway[]; policy: PlayPolicy; caps?: ReturnType<typeof detectCapabilities>; forceProtocol?: Protocol; engineOptions: Omit<EngineOptions,'targetLatencySec'>; createEngine?: (kind: EngineKind) => PlayerEngine }
export function createPlayerController(video, opts): { start(): Promise<void>; stop(): void; current(): { pathway: Pathway; engine: PlayerEngine } | null; switchPathway(i: number): Promise<void>; probe: ReturnType<typeof createQoeProbe>; on(ev: 'pathway_change', cb) }
export function selectPathways(pathways, policy, caps, force?): Pathway[]  // pure: filters unsupported protocols (whep needs webrtc; flv needs mse or managedMse; llhls/hls need mse||managedMse||nativeHls), orders by force > preferred > priority
```
- [ ] Tests (jsdom, fake timers): probe — `waiting` then `playing` after 150ms emits no stall; after 400ms emits `stall_start`+`stall_end{durationMs:400}`; `waiting` before first `playing` is not a stall; `seeking` window excluded; `first_frame.ttffMs` measured from `markPlayAttempt()` to first `playing`; heartbeat fires every 10s with accumulated `playingMs`. Controller — `selectPathways` cases; with fake engines: first engine emitting fatal error → controller emits `recovery_action{action:'switch_pathway'}` and starts second; stall ladder: 1st stall ≥3s → `seek_live`, 2nd → `downgrade` (`setLevel(0)`), 3rd → `switch_pathway`; ladder resets after 60s stall-free.
- [ ] Implement; `index.ts` re-exports. Commit `feat(player-core): QoE probe and player controller with fallback ladder`.

### Task 1.6: Viewer room player UI (media-chrome) and Lab page

**Files:** `apps/web/src/components/player/live-player.tsx`, `apps/web/src/components/player/stats-overlay.tsx`, `apps/web/src/hooks/use-player.ts`, `apps/web/src/routes/room.tsx` (modify), `apps/web/src/routes/lab.tsx` (modify), `apps/web/src/lib/telemetry-client.ts` (stub until P5: console logger)

**Interfaces:** `usePlayer({ roomId, forceProtocol?, weaknet?: WeaknetParams })` → `{ videoRef, state: 'idle'|'loading'|'playing'|'stalled'|'error', stats, pathway, events: QoeEvent[] (last 200), controller }`. `WeaknetParams = { delayMs, lossPct, bandwidthKbps }` → `requestTransform` rewriting media URLs through `/weaknet?u=<encoded>&delay=&loss=&bw=` (server in Task 5.3; until then identity).

- [ ] `LivePlayer` renders `<MediaController>` from `media-chrome/react` with `<video slot="media" playsInline muted autoPlay>`, control bar (play, mute, volume, live button, PiP, fullscreen), a "LIVE"/latency badge, and `StatsOverlay` (toggle with `i` key) showing protocol, pathway/cdn, latency, buffer, bitrate, level, dropped frames, last 10 events. Engines loaded lazily; hls worker URL via `import workerUrl from 'hls.js/dist/hls.worker.js?url'`.
- [ ] Lab page: 3 players side by side (LL-HLS / FLV / WHEP), each with its own weaknet sliders and a TTFF/latency/stall readout; a "start all" button to compare startup; note that FLV needs `pnpm infra:flv`.
- [ ] Manual verification with `pnpm infra:up` + `pnpm dev`: `/room/demo` plays within 3s, overlay shows latency ≈ 2–4s; `/room/demo-rt` uses WHEP with < 1s.
- [ ] Commit `feat(web): live player with media-chrome UI, stats overlay and protocol lab`.

---

## Phase P2 — IM gateway and danmaku

### Task 2.1: `@livelab/danmaku` renderer

**Files:** `packages/danmaku/package.json`, `src/index.ts`, `src/lanes.ts`, `src/lanes.test.ts`, `src/renderer.ts`, `src/renderer.test.ts`, `src/worker.ts`

**Interfaces (Produces):**
```ts
export interface DanmakuItem { id: string; text: string; color?: string; size?: 'sm'|'md'|'lg'; priority?: 0|1|2; border?: boolean }
export interface LaneState { lastRight: number; lastSpeed: number; lastEnterAt: number }
export function pickLane(lanes: LaneState[], now: number, stageWidth: number, width: number, speed: number, durationMs: number): number  // returns lane index or -1
export interface DanmakuOptions { laneHeight?: number (32); speed?: number (px/s, 120); durationMs?: number (8000); maxPerSecond?: number (40); font?: string; opacity?: number; area?: 0.25|0.5|0.75|1 }
export function createDanmaku(canvas: HTMLCanvasElement, opts?: DanmakuOptions): { emit(item: DanmakuItem): boolean; pause(); resume(); resize(); clear(); setOptions(o: Partial<DanmakuOptions>); destroy(); readonly stats: { onScreen: number; dropped: number; emitted: number } }
```
- [ ] Test `lanes.test.ts`: empty lanes → 0; lane 0 busy (a wide fast item entered just now) → 1; all busy → -1; a slower new item behind a faster old one never collides (`(lastRight - stageWidth)/lastSpeed < width/speed` rule); after `durationMs` lane is free.
- [ ] Test `renderer.test.ts` (jsdom + fake `getContext` returning `measureText` stub; fake rAF): `emit` returns false beyond `maxPerSecond` unless `priority 2`; `pause` stops frames; `document.hidden` → items flushed.
- [ ] Implement with `devicePixelRatio` scaling, `dt`-based motion (`dt > 100ms` → drop backlog), pooling of measured widths cache (`Map<text,width>`), `visibilitychange` handling; `worker.ts` mirrors API over `OffscreenCanvas` (`createDanmakuWorker(canvas)` transfers control when supported).
- [ ] Commit `feat(danmaku): canvas danmaku renderer with lane allocation and rate limiting`.

### Task 2.2: IM gateway core (rooms, seq, history, batching, sampling)

**Files:** `apps/api/src/modules/im/hub.ts`, `hub.test.ts`, `apps/api/src/modules/im/bus.ts` (Redis pub/sub or in-memory), `apps/api/src/modules/im/history.ts` (Redis list or in-memory ring, 500 msgs/room), `apps/api/src/modules/im/sampling.ts`, `sampling.test.ts`

**Interfaces (Produces):**
```ts
export interface Bus { publish(room: string, msg: ServerMsg): Promise<void>; subscribe(room: string, cb: (m: ServerMsg) => void): () => void }
export function createMemoryBus(): Bus; export function createRedisBus(url: string): Bus
export interface History { append(room, msg): Promise<void>; since(room, seq): Promise<ServerMsg[]>; nextSeq(room): Promise<number> }
export function sampleRate(online: number): number  // 1 for <100, 0.5 for <1000, 0.2 for <10000, 0.05 otherwise (chat lane only)
export function shouldDeliver(msg: ServerMsg, online: number, rnd = Math.random): boolean // gift/system always true
export class RoomHub { constructor(deps: { bus; history; batchMs?: number (150) }); join(room, conn: Conn, lastSeq?): Promise<void>; leave(room, conn); broadcast(room, partial: Omit<ServerMsg,'seq'|'ts'>): Promise<ServerMsg>; online(room): number; state(room): RoomState; setState(room, patch) }
interface Conn { id: string; user: UserRef; send(frame: ServerFrame): void }
```
- [ ] Tests: `sampleRate` thresholds; `shouldDeliver` gift always; hub with memory bus: two conns join, broadcast chat → both receive one `batch` after 150ms (fake timers) containing msg with `seq 1`; a late joiner with `lastSeq 0` receives `welcome.history` with the message; `seq` strictly increasing; per-connection output queue drops chat when > 200 queued but keeps gift.
- [ ] Commit `feat(api): IM hub with sequencing, history, batching and sampling`.

### Task 2.3: WebSocket route, moderation, likes, protocol handling

**Files:** `apps/api/src/modules/im/ws.ts`, `apps/api/src/modules/im/moderation.ts`, `moderation.test.ts`, `apps/api/src/modules/im/likes.ts`, `apps/api/src/modules/interaction/routes.ts`

**Interfaces:** `GET /ws?room=<id>&token=<jwt>`; client must send `hello` within 5s; server heartbeat check: close if no `ping` for 60s. `Moderation { isMuted(room,userId); mute(room,userId,sec); ban; slowMode(room,sec); canPost(room,userId,now): {ok:true}|{ok:false,code:'muted'|'slow_mode'|'rate_limited', retryAfterMs}; keywords: add/remove/filter(text): text|null }`. Per-user rate limit 5 msgs / 10s. Likes aggregated per room every 1s into `like_agg`. `POST /v1/rooms/:id/mod` (host/admin only) applies `ModAction` and broadcasts `system{kind:'mod'|'pin'|...}` + `state` frame. `GET /v1/rooms/:id/state` returns `RoomState`.
- [ ] Tests for moderation (`slow_mode 10` → second post within 10s returns `slow_mode` with `retryAfterMs`; keyword filter replaces banned words with `***`; ban → `muted` forever).
- [ ] Integration test with real `ws` client against an in-process fastify instance: hello → welcome; chat → batch echo with same `cid`; ping → pong.
- [ ] Commit `feat(api): websocket gateway, moderation, likes aggregation and mod routes`.

### Task 2.4: Web IM client, chat panel, danmaku layer, likes burst

**Files:** `apps/web/src/lib/im-client.ts`, `im-client.test.ts`, `apps/web/src/stores/room.ts`, `apps/web/src/components/chat/chat-panel.tsx`, `chat-input.tsx`, `apps/web/src/components/danmaku-layer.tsx`, `apps/web/src/components/like-burst.tsx`, `apps/web/src/routes/room.tsx` (modify)

**Interfaces:** `createImClient({ url, room, token, onFrame, onStatus })` → `{ send(frame: ClientFrame), close() }`; reconnect with exponential backoff `min(20000, 1000*2^n) + jitter(0..500)`, resumes with `lastSeq`; ping every 25s; status `'connecting'|'open'|'reconnecting'|'closed'`. Store `useRoomStore`: `{ messages: ServerMsg[] (cap 300), state: RoomState, status, likes: number, pendingCids: Set }` with selectors; `batch` frames applied in one `set` call. Danmaku layer subscribes via `useRoomStore.subscribe` (not React render) and calls `emit` for chat/gift messages (gift → priority 2, colored, border).
- [ ] Test im-client with a fake WebSocket: backoff sequence 1s,2s,4s; `hello.lastSeq` equals highest seq seen; ping interval.
- [ ] UI: chat list virtualized by simple windowing (render last 100), auto-scroll with "new messages" pill when scrolled up; input with slow-mode countdown & error toasts; like button with click-burst hearts (client aggregates clicks, sends `like{n}` every 500ms) and shows `like_agg.total`.
- [ ] Commit `feat(web): IM client with resume, chat panel, danmaku layer and likes`.

---

## Phase P3 — Wallet, mock payment, gifts

### Task 3.1: Wallet + ledger + payment webhook idempotency

**Files:** `apps/api/src/modules/wallet/service.ts`, `service.test.ts`, `apps/api/src/modules/wallet/routes.ts`, `apps/api/src/modules/pay-mock/routes.ts`, `apps/api/src/modules/pay-mock/deliver.ts`

**Interfaces:**
```ts
class WalletService { constructor(db) ; get(userId): Wallet; createRecharge(userId, coins): Order (priceCents = coins*10, status 'created', expires 15 min); applyPaymentEvent(ev: { eventId: string; orderId: string; status: 'paid'|'failed'; signature: string }): 'applied'|'duplicate'|'invalid'  // verifies HMAC-SHA256(secret, `${eventId}.${orderId}.${status}`), inserts payment_events(eventId UNIQUE) inside a transaction, credits wallet + ledger (debit platform_cash, credit user_wallet); debit(userId, amount, ref, idemKey): { ok: true; balance } | { ok: false; reason: 'insufficient'|'duplicate' } }
```
Routes: `GET /v1/wallet`, `POST /v1/wallet/recharge {coins}` → `{ order, payUrl: '/pay/mock/'+id }`, `GET /v1/wallet/orders/:id`, `POST /v1/pay/mock/:orderId/complete {outcome:'paid'|'failed'}` (called by mock cashier page) → schedules delivery via `deliver.ts` which POSTs `/v1/pay/webhook` with random delay 0–3s and 30% chance of a duplicate delivery; `POST /v1/pay/webhook` verifies signature and applies.
- [ ] Tests: duplicate `eventId` → 'duplicate' and balance unchanged; bad signature → 'invalid'; debit twice with same `idemKey` → second returns duplicate without double charge; concurrent-like sequential debits cannot go below zero (`UPDATE wallets SET balance=balance-? WHERE user_id=? AND balance>=?` changes = 0 → insufficient).
- [ ] Commit `feat(api): wallet, double-entry ledger, mock payment with signed idempotent webhooks`.

### Task 3.2: Gift catalog and sending

**Files:** `apps/api/src/modules/gifts/routes.ts`, `gifts.test.ts`

**Interfaces:** `GET /v1/gifts` (catalog: `rose` 1/hearts, `rocket` 500/rocket, `confetti` 50/confetti, `coffee` 10/hearts); `POST /v1/gifts` header `Idempotency-Key`, body `SendGiftRequest` → server-side price × count, `wallet.debit`, insert `gift_orders`, `hub.broadcast(gift)` → `SendGiftResponse`; 402 with `{code:'insufficient'}`.
- [ ] Test via fastify inject: insufficient → 402; success debits and broadcasts (spy on hub); replay with same key → same `msgId`, no second broadcast.
- [ ] Commit `feat(api): gift catalog and idempotent gift sending`.

### Task 3.3: Web wallet, mock cashier, gift panel, gift animation layer

**Files:** `apps/web/src/routes/pay-mock.tsx`, `apps/web/src/components/wallet/wallet-badge.tsx`, `recharge-dialog.tsx`, `apps/web/src/components/gifts/gift-panel.tsx`, `apps/web/src/components/gifts/gift-layer.tsx`, `apps/web/src/components/gifts/animations.ts`, `animations.test.ts`

**Interfaces:** `GiftAnimation = (ctx: CanvasRenderingContext2D, t: number /*0..1*/, w, h, seed: number) => void` for `confetti|hearts|rocket`; `createGiftQueue(maxConcurrent=2)` → `{ push(gift: GiftMsg), tick(now) }` (pure, testable: big gifts (price ≥ 500) jump the queue). Gift panel: grid from `GET /v1/gifts`, count stepper, send with optimistic balance decrement via TanStack `useMutation` `onMutate/onError` rollback, generates `Idempotency-Key` = `crypto.randomUUID()` once per click. Pay mock page: shows order, buttons "支付成功" / "支付失败"; after clicking, polls `GET /v1/wallet/orders/:id` every 1s until `paid|failed`, shows the webhook delay drama.
- [ ] Test `animations.test.ts` for queue ordering.
- [ ] Commit `feat(web): wallet, mock cashier, gift panel with optimistic UI and canvas gift animations`.

---

## Phase P4 — Ops tools

### Task 4.1: Host console

**Files:** `apps/api/src/modules/rooms/health.ts` (MediaMTX `/v3/paths/get/:name` → `StreamHealth`, 2s cache; `GET /v1/rooms/:id/health` host/admin), `apps/web/src/routes/host.tsx`, `apps/web/src/components/host/stream-setup.tsx`, `health-card.tsx`, `moderation-panel.tsx`, `poll-panel.tsx`

- [ ] Host page (role host/admin only, else redirect): stream setup (ingest URLs + stream key with copy buttons + OBS/FFmpeg snippets), health card polling every 2s (ready, tracks, bytes/s computed from delta, readers), preview player (muted), moderation panel (mute user from a message context menu, slow mode select 0/5/10/30, keyword list, announcement, pin/unpin), poll panel (create 2–4 options, live results from `state.poll`, end), online count.
- [ ] Commit `feat(web,api): host console with stream health, moderation and polls`.

### Task 4.2: Admin dashboard

**Files:** `apps/api/src/modules/admin/routes.ts` (`GET /v1/admin/overview` → `AdminOverview` from hub online counts, per-room msg rate (1-min sliding window), and ClickHouse queries when configured else nulls), `apps/web/src/routes/admin.tsx`

- [ ] Admin page: rooms table (status, online, msg rate, actions: open host console), QoE tiles (TTFF p50/p95, stall per 100s, failure %, sessions in last 15 min), 10s refresh, links to Grafana.
- [ ] Commit `feat(web,api): admin overview with realtime room metrics and QoE summary`.

---

## Phase P5 — Observability and weak-network lab

### Task 5.1: `@livelab/telemetry` SDK

**Files:** `packages/telemetry/package.json`, `src/index.ts`, `src/queue.ts`, `queue.test.ts`, `src/ring-log.ts`, `ring-log.test.ts`, `src/context.ts`, `src/vitals.ts`

**Interfaces (Produces):**
```ts
export interface TelemetryOptions { endpoint: string; ctx: Omit<TelemetryContext,'sessionId'|'os'|'browser'|'netType'>; sampleRates?: Partial<Record<string, number>> /* default heartbeat 0.2, latency_sample 0.2, others 1 */; batchSize?: number (20); flushIntervalMs?: number (5000); maxQueue?: number (500); fetchImpl?: typeof fetch; now?: () => number }
export function createTelemetry(o: TelemetryOptions): { sessionId: string; track(name: string, attrs?: Record<string, string|number|boolean>, opts?: { viewId?: string; roomId?: string }): void; log(level, msg): void; flush(): Promise<void>; reportIssue(description: string, extra?: Record<string,string>): Promise<void>; captureVitals(): void; destroy(): void }
export function createQueue<T>(opts): { push(item: T): boolean; drain(): T[]; size(): number }
export function createRingLog(cap = 500): { push(line: string): void; dump(): string[] }
export function snapshotResources(sinceMs = 60000): Array<{ name: string; duration: number; transferSize: number; status?: number }>  // performance.getEntriesByType('resource') filtered by m3u8|m4s|ts|flv|whep
```
Behaviour: sampling decided per session (hash of sessionId) for heartbeat-class events so a session is either fully sampled or not; flush on `batchSize`, interval, and `visibilitychange === 'hidden'` (uses `fetch(..., { keepalive: true })`); on `error` events with `fatal:true`, attach `attrs.log` (last 50 ring lines joined) and `attrs.resources` (JSON of `snapshotResources()`); failures dropped silently with one warn.
- [ ] Tests: queue drops beyond `maxQueue`; batch flushes at 20; sampling deterministic per sessionId; hidden-flush uses keepalive; fatal error enriches attrs.
- [ ] Commit `feat(telemetry): browser QoE telemetry SDK with batching, sampling and ring log`.

### Task 5.2: Telemetry ingest → ClickHouse

**Files:** `apps/api/src/modules/telemetry/routes.ts`, `apps/api/src/modules/telemetry/sink.ts`, `sink.test.ts`, `apps/api/src/modules/telemetry/mapper.ts`, `mapper.test.ts`

**Interfaces:** `POST /v1/telemetry` (no auth, 64 KB limit, validates `TelemetryBatch`) → `mapper.toRows(batch): Row[]` (flatten ctx + event → `qoe.events` columns; `value_ms` = `ttffMs|durationMs|latencyMs|watchMs` by event; numeric attrs go to columns when names match else into `attrs` map as strings) → `sink.write(rows)` — `ClickHouseSink` buffers and POSTs `INSERT INTO qoe.events FORMAT JSONEachRow` every 2s or 1000 rows via fetch with basic auth; `ConsoleSink` when no URL. Also `GET /v1/telemetry/summary` used by admin: three SQLs from research 04 (TTFF quantiles, stall per 100s + stall view %, failure/EBVS) over last 15 min.
- [ ] Tests: mapper maps `first_frame{ttffMs:812}` → `event:'first_frame', value_ms: 812`; sink batching with fake fetch.
- [ ] Commit `feat(api): telemetry ingest with ClickHouse sink and QoE summary queries`.

### Task 5.3: Weak-network proxy and wiring telemetry into the web app

**Files:** `apps/api/src/modules/weaknet/routes.ts`, `weaknet.test.ts`, `apps/web/src/lib/telemetry-client.ts` (replace stub), `apps/web/src/hooks/use-player.ts` (modify), `apps/web/src/components/player/report-issue.tsx`

**Interfaces:** `GET /weaknet?u=<absolute upstream url>&delay=<ms>&loss=<0-100>&bw=<kbps>` — allowlist upstream hosts (`localhost:8888`, `localhost:8080`, `mediamtx`, `srs`), copies content-type, streams body with throttling (token bucket at `bw`), sleeps `delay` before first byte, returns 503 with probability `loss` (segments only, never playlists). Web: `telemetry-client.ts` creates the SDK singleton with ctx (`player:'livelab-web'`, version from `package.json`), `use-player` forwards every `QoeEvent` to `track('video.'+name)` with `viewId`/`roomId` and adds `protocol`, `cdn`, `pathway` attrs; `captureVitals()` on app start; "报障" button opens dialog → `reportIssue`.
- [ ] Test proxy with fastify inject + fake upstream (undici MockAgent or a local http server): delay honored; loss returns 503 for `.m4s` but never for `.m3u8`; disallowed host → 400.
- [ ] Commit `feat(api,web): weak-network proxy and telemetry wiring with report-issue flow`.

### Task 5.4: Grafana dashboards and alert rules

**Files:** `infra/grafana/provisioning/dashboards/json/qoe-overview.json`, `qoe-by-cdn-protocol.json`, `errors.json`, `infra/grafana/provisioning/alerting/rules.yml`

- [ ] Overview: stat panels (sessions 15m, TTFF p50/p95, 秒开率, stall per 100s, failure %, EBVS %), time series (TTFF p95 5m buckets, stall per 100s, live latency p50 by protocol), table (top error details). By CDN/protocol: grouped bars & time series with `cdn` and `protocol` variables. Errors: err_type/err_detail breakdown + recent fatal sessions table with `attrs['log']`. Alert rules per research 04 (TTFF p95 > 3000 for 10m; stall per 100s > 3 for 5m; failure % > 1 for 5m). SQL uses `$__timeFilter(ts)` and `$__interval`.
- [ ] Verify by playing `/room/demo` for a minute with weaknet loss 20% and confirming panels populate.
- [ ] Commit `infra: grafana QoE dashboards and alert rules`.

---

## Phase P6 — Co-host signaling (optional), E2E, tutorial

### Task 6.1: Co-host (连麦) signaling + WHIP publish (optional stretch)

**Files:** `apps/api/src/modules/interaction/cohost.ts`, `apps/web/src/components/cohost/*`, `packages/player-core/src/engines/whip-client.ts`

- [ ] Flow: viewer `POST /v1/rooms/:id/cohost/request` → host sees request in console → `accept` → server broadcasts `system{kind:'cohost', payload:{userId, path:'cohost/<room>/<user>', state:'live'}}` → viewer browser `getUserMedia` + WHIP publish to `http://localhost:8889/cohost/<room>/<user>/whip` → all clients render a PiP `WhepEngine` player for that path; `end` tears down.
- [ ] Commit `feat: co-host signaling with browser WHIP publish and WHEP PiP`.

### Task 6.2: Playwright E2E smoke

**Files:** `apps/web/playwright.config.ts`, `apps/web/e2e/room.spec.ts`

- [ ] Spec: open `/`, login as viewer, open `/room/demo`, expect `video.currentTime` > 1 within 15s and stats overlay to show a protocol; send chat "hello e2e" and expect it in chat list. Skips with a clear message when MediaMTX API is unreachable.
- [ ] Commit `test(web): playwright room smoke test`.

### Task 6.3: Tutorial

**Files:** `docs/tutorial/00-intro.md` … `13-cloud-and-cdn.md`, `docs/tutorial/README.md`, root `README.md`

- [ ] Each chapter: 目标 → 原理（引用 research）→ 代码走读（文件路径 + 关键片段）→ 动手实验（可复制命令、预期现象）→ 度量方法（看哪个指标怎么变）→ 生产注意事项 → 面试/复盘要点. Chapters as listed in spec §7. Chapter 13 includes cloud comparison table, multi-CDN scheduling design, Content Steering server sketch, ICP/跨境 checklist, cost estimation worksheet.
- [ ] Commit `docs: complete tutorial`.

---

## Self-review

- Spec coverage: playback (1.x), startup optimization (1.2/1.6/tutorial 04), stall/weak-net/cross-border (1.5, 5.3, 13), danmaku/IM (2.x), host interaction (2.3/2.4/3.x/6.1), payments (3.x), ops tools (4.x), monitoring/埋点/异常采集 (5.x), tutorial (6.3), cloud/CDN (0.2 + 13). Testing strategy covered per task; E2E in 6.2.
- Type consistency: `Pathway/PlayPolicy` defined in 0.3 used by 0.4/1.5/1.6; `ServerMsg/ServerFrame/ClientFrame` used by 2.2–2.4; `QoeEvent` from 1.5 consumed by 5.3; `TelemetryBatch` from 0.3 used by 5.1/5.2.
