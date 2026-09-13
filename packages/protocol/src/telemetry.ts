import { z } from 'zod';

export const TelemetryAttrValue = z.union([z.string(), z.number(), z.boolean()]);

export const TelemetryEvent = z.object({
  /** e.g. `video.first_frame`, `video.stall_end`, `web.vital` */
  name: z.string().min(1).max(64),
  ts: z.number(),
  viewId: z.string().optional(),
  roomId: z.string().optional(),
  attrs: z.record(z.string(), TelemetryAttrValue).default({}),
});
export type TelemetryEvent = z.infer<typeof TelemetryEvent>;

export const TelemetryContext = z.object({
  sessionId: z.string(),
  userId: z.string().optional(),
  player: z.string(),
  playerVer: z.string(),
  os: z.string(),
  browser: z.string(),
  netType: z.string(),
  region: z.string().default('local'),
  isp: z.string().default('local'),
});
export type TelemetryContext = z.infer<typeof TelemetryContext>;

export const TelemetryBatch = z.object({
  ctx: TelemetryContext,
  events: z.array(TelemetryEvent).min(1).max(500),
});
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;

/** Canonical event names emitted by the player QoE probe (prefixed with `video.` on the wire). */
export const VIDEO_EVENTS = [
  'play_attempt', 'first_frame', 'stall_start', 'stall_end', 'level_switch',
  'latency_sample', 'heartbeat', 'error', 'recovery_action', 'end', 'report_issue',
] as const;
export type VideoEventName = (typeof VIDEO_EVENTS)[number];
