import { z } from 'zod';

/** Delivery lane. Server-side sampling/batching only ever drops `chat`; `gift` and `system` are always delivered. */
export const Lane = z.enum(['chat', 'gift', 'system']);
export type Lane = z.infer<typeof Lane>;

export const Role = z.enum(['viewer', 'host', 'admin']);
export type Role = z.infer<typeof Role>;

export const UserRef = z.object({ id: z.string(), name: z.string(), role: Role });
export type UserRef = z.infer<typeof UserRef>;

export const GiftAnimation = z.enum(['confetti', 'hearts', 'rocket']);
export type GiftAnimation = z.infer<typeof GiftAnimation>;

// ---------------------------------------------------------------------------
// Client -> Server frames
// ---------------------------------------------------------------------------
export const ClientFrame = z.discriminatedUnion('t', [
  /** First frame after connect. `lastSeq` lets the server replay missed messages. */
  z.object({ t: z.literal('hello'), room: z.string(), lastSeq: z.number().int().nonnegative().optional() }),
  z.object({ t: z.literal('ping'), ts: z.number() }),
  /** `cid` is a client-generated id so the sender can match the echoed message and drop its optimistic copy. */
  z.object({ t: z.literal('chat'), cid: z.string(), text: z.string().trim().min(1).max(200) }),
  /** Likes are aggregated client-side (n clicks per 500ms) and again server-side (per second). */
  z.object({ t: z.literal('like'), n: z.number().int().min(1).max(50) }),
  z.object({ t: z.literal('vote'), pollId: z.string(), option: z.number().int().min(0) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

// ---------------------------------------------------------------------------
// Server -> Client messages (all carry a per-room monotonically increasing seq)
// ---------------------------------------------------------------------------
const Base = { seq: z.number().int(), room: z.string(), ts: z.number() };

export const ChatMsg = z.object({
  ...Base,
  t: z.literal('chat'),
  lane: z.literal('chat'),
  id: z.string(),
  cid: z.string().optional(),
  user: UserRef,
  text: z.string(),
});
export type ChatMsg = z.infer<typeof ChatMsg>;

export const GiftMsg = z.object({
  ...Base,
  t: z.literal('gift'),
  lane: z.literal('gift'),
  id: z.string(),
  user: UserRef,
  gift: z.object({ id: z.string(), name: z.string(), price: z.number(), animation: GiftAnimation, icon: z.string() }),
  count: z.number().int().min(1),
});
export type GiftMsg = z.infer<typeof GiftMsg>;

export const LikeAgg = z.object({
  ...Base,
  t: z.literal('like_agg'),
  lane: z.literal('system'),
  /** likes in the last aggregation window */
  count: z.number().int(),
  /** running total for the room */
  total: z.number().int(),
});
export type LikeAgg = z.infer<typeof LikeAgg>;

export const SystemKind = z.enum([
  'join', 'leave', 'announce', 'pin', 'unpin', 'poll', 'poll_end', 'mod', 'slow_mode', 'cohost', 'online',
]);
export type SystemKind = z.infer<typeof SystemKind>;

export const SystemMsg = z.object({
  ...Base,
  t: z.literal('system'),
  lane: z.literal('system'),
  kind: SystemKind,
  payload: z.record(z.string(), z.unknown()),
});
export type SystemMsg = z.infer<typeof SystemMsg>;

export const ServerMsg = z.discriminatedUnion('t', [ChatMsg, GiftMsg, LikeAgg, SystemMsg]);
export type ServerMsg = z.infer<typeof ServerMsg>;

export const Poll = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).min(2).max(4),
  votes: z.array(z.number().int()),
  endsAt: z.number(),
});
export type Poll = z.infer<typeof Poll>;

export const RoomState = z.object({
  online: z.number().int(),
  slowModeSec: z.number().int(),
  pinned: ChatMsg.nullable(),
  announce: z.string().nullable(),
  poll: Poll.nullable(),
  likes: z.number().int(),
});
export type RoomState = z.infer<typeof RoomState>;

export const ErrorCode = z.enum(['unauthorized', 'muted', 'slow_mode', 'rate_limited', 'bad_frame', 'room_closed', 'filtered']);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ServerFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('welcome'), seq: z.number().int(), state: RoomState, history: z.array(ServerMsg) }),
  z.object({ t: z.literal('pong'), ts: z.number(), serverTs: z.number() }),
  /** Messages are batched every ~150ms server-side to reduce syscalls and React state updates. */
  z.object({ t: z.literal('batch'), msgs: z.array(ServerMsg) }),
  z.object({ t: z.literal('state'), state: RoomState.partial() }),
  z.object({ t: z.literal('error'), code: ErrorCode, message: z.string(), retryAfterMs: z.number().optional(), cid: z.string().optional() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
