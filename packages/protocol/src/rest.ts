import { z } from 'zod';
import { GiftAnimation, Role, UserRef, ChatMsg, Cohost } from './im.js';

export const Protocol = z.enum(['whep', 'llhls', 'hls', 'flv']);
export type Protocol = z.infer<typeof Protocol>;

/** One playable URL. Several pathways per room = multi-CDN / multi-protocol failover material. */
export const Pathway = z.object({
  protocol: Protocol,
  url: z.string(),
  /** CDN / edge label used as a QoE dimension. */
  cdn: z.string(),
  /** Lower is tried first. */
  priority: z.number().int(),
});
export type Pathway = z.infer<typeof Pathway>;

export const RecoveryAction = z.enum(['nudge', 'downgrade', 'seek_live', 'switch_pathway', 'switch_protocol']);
export type RecoveryAction = z.infer<typeof RecoveryAction>;

export const PlayPolicy = z.object({
  preferred: Protocol,
  targetLatencySec: z.number(),
  maxStartupMs: z.number(),
  stallLadder: z.array(RecoveryAction),
});
export type PlayPolicy = z.infer<typeof PlayPolicy>;

export const PlayResponse = z.object({ roomId: z.string(), pathways: z.array(Pathway), policy: PlayPolicy });
export type PlayResponse = z.infer<typeof PlayResponse>;

export const RoomMode = z.enum(['standard', 'interactive']);
export type RoomMode = z.infer<typeof RoomMode>;

export const Room = z.object({
  id: z.string(),
  title: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  status: z.enum(['live', 'offline']),
  mode: RoomMode,
  viewers: z.number().int(),
  coverUrl: z.string(),
  /** MediaMTX path name the room maps to. */
  streamPath: z.string(),
  createdAt: z.number(),
});
export type Room = z.infer<typeof Room>;

export const RoomWithKey = Room.extend({
  streamKey: z.string(),
  ingest: z.object({ rtmp: z.string(), whip: z.string(), srt: z.string() }),
});
export type RoomWithKey = z.infer<typeof RoomWithKey>;

export const Gift = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number().int(),
  animation: GiftAnimation,
  icon: z.string(),
});
export type Gift = z.infer<typeof Gift>;

export const Wallet = z.object({ userId: z.string(), balance: z.number().int() });
export type Wallet = z.infer<typeof Wallet>;

export const OrderStatus = z.enum(['created', 'paid', 'failed', 'expired']);
export const Order = z.object({
  id: z.string(),
  userId: z.string(),
  coins: z.number().int(),
  priceCents: z.number().int(),
  status: OrderStatus,
  createdAt: z.number(),
  paidAt: z.number().nullable(),
});
export type Order = z.infer<typeof Order>;

export const RechargeRequest = z.object({ coins: z.number().int().min(10).max(100000) });
export const RechargeResponse = z.object({ order: Order, payUrl: z.string() });

export const SendGiftRequest = z.object({ roomId: z.string(), giftId: z.string(), count: z.number().int().min(1).max(99) });
export type SendGiftRequest = z.infer<typeof SendGiftRequest>;
export const SendGiftResponse = z.object({ ok: z.literal(true), balance: z.number().int(), msgId: z.string() });
export type SendGiftResponse = z.infer<typeof SendGiftResponse>;

export const AuthRequest = z.object({ name: z.string().trim().min(1).max(24), role: Role.default('viewer') });
export type AuthRequest = z.infer<typeof AuthRequest>;
export const AuthResponse = z.object({ token: z.string(), user: UserRef });
export type AuthResponse = z.infer<typeof AuthResponse>;

export const ModAction = z.object({
  action: z.enum([
    'mute', 'unmute', 'ban', 'pin', 'unpin', 'slow_mode', 'announce',
    'poll_start', 'poll_end', 'keyword_add', 'keyword_remove',
  ]),
  targetUserId: z.string().optional(),
  msgId: z.string().optional(),
  seconds: z.number().int().min(0).optional(),
  text: z.string().max(500).optional(),
  question: z.string().max(200).optional(),
  options: z.array(z.string().max(60)).min(2).max(4).optional(),
});
export type ModAction = z.infer<typeof ModAction>;

export const ModState = z.object({
  muted: z.array(z.object({ userId: z.string(), until: z.number() })),
  banned: z.array(z.string()),
  keywords: z.array(z.string()),
  slowModeSec: z.number().int(),
});
export type ModState = z.infer<typeof ModState>;

export const StreamHealth = z.object({
  ready: z.boolean(),
  bytesReceived: z.number(),
  readers: z.number().int(),
  tracks: z.array(z.string()),
  sourceType: z.string().nullable(),
  sampledAt: z.number(),
});
export type StreamHealth = z.infer<typeof StreamHealth>;

export const QoeSummary = z.object({
  ttffP50: z.number().nullable(),
  ttffP95: z.number().nullable(),
  fastStartPct: z.number().nullable(),
  stallPer100s: z.number().nullable(),
  stallViewPct: z.number().nullable(),
  failurePct: z.number().nullable(),
  sessions: z.number().int(),
  source: z.enum(['clickhouse', 'none']),
});
export type QoeSummary = z.infer<typeof QoeSummary>;

export const AdminOverview = z.object({
  rooms: z.array(Room.extend({ online: z.number().int(), msgRate: z.number() })),
  qoe: QoeSummary,
});
export type AdminOverview = z.infer<typeof AdminOverview>;

export const CohostRequest = z.object({ userId: z.string(), name: z.string(), at: z.number() });
export type CohostRequest = z.infer<typeof CohostRequest>;
export const CohostOverview = z.object({ requests: z.array(CohostRequest), active: z.array(Cohost), max: z.number().int() });
export type CohostOverview = z.infer<typeof CohostOverview>;
export const CohostTarget = z.object({ userId: z.string().optional() });

export const ErrorBody = z.object({ code: z.string(), message: z.string() });

export { ChatMsg };
