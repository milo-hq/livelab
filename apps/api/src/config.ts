const env = (k: string, d: string) => process.env[k] ?? d;

export interface Config {
  port: number;
  jwtSecret: string;
  webhookSecret: string;
  apiPublicUrl: string;
  mediamtxHls: string;
  mediamtxWebrtc: string;
  mediamtxApi: string;
  mediamtxRtmp: string;
  mediamtxSrt: string;
  srsFlv: string;
  redisUrl: string | undefined;
  clickhouseUrl: string | undefined;
  clickhouseUser: string;
  clickhousePassword: string;
  dbPath: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: Number(env('PORT', '8787')),
    jwtSecret: env('JWT_SECRET', 'dev-secret-change-me'),
    webhookSecret: env('WEBHOOK_SECRET', 'dev-webhook-secret'),
    apiPublicUrl: env('API_PUBLIC_URL', 'http://localhost:8787'),
    mediamtxHls: env('MEDIAMTX_HLS', 'http://localhost:8888'),
    mediamtxWebrtc: env('MEDIAMTX_WEBRTC', 'http://localhost:8889'),
    mediamtxApi: env('MEDIAMTX_API', 'http://localhost:9997'),
    mediamtxRtmp: env('MEDIAMTX_RTMP', 'rtmp://localhost:1935'),
    mediamtxSrt: env('MEDIAMTX_SRT', 'srt://localhost:8890'),
    srsFlv: env('SRS_FLV', 'http://localhost:8080'),
    redisUrl: process.env.REDIS_URL || undefined,
    clickhouseUrl: process.env.CLICKHOUSE_URL || undefined,
    clickhouseUser: env('CLICKHOUSE_USER', 'default'),
    clickhousePassword: env('CLICKHOUSE_PASSWORD', 'livelab'),
    dbPath: env('DB_PATH', './data/livelab.db'),
    ...overrides,
  };
}
