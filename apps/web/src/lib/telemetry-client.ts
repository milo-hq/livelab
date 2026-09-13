import { createTelemetry, createViewId } from '@livelab/telemetry';
import pkg from '../../package.json';

/**
 * One telemetry session per tab. Events go to the api (`/v1/telemetry`, proxied by Vite in dev) which
 * writes them into ClickHouse; Grafana reads them back. Heartbeat/latency samples are 20% sampled per
 * session, first_frame/error/end/report_issue are always delivered.
 */
export const telemetry = createTelemetry({
  endpoint: '/v1/telemetry',
  ctx: { player: 'livelab-web', playerVer: pkg.version, region: 'local', isp: 'local' },
});

telemetry.captureVitals();

export { createViewId };
