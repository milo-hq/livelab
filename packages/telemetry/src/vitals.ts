/**
 * Core Web Vitals capture via Google's `web-vitals` (v6).
 *
 * The library handles all the tricky parts (PerformanceObserver buffering,
 * bfcache restores, reporting the final CLS/INP value only when the page is
 * hidden), so our job is just to translate each `Metric` into one
 * `web.vital` telemetry event. `metric.id` lets the backend de-duplicate the
 * multiple reports a single metric may emit over a page's life.
 */
import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

export type VitalTracker = (
  name: string,
  attrs: Record<string, string | number | boolean>,
) => void;

export function captureVitals(track: VitalTracker): void {
  const report = (metric: Metric) =>
    track('web.vital', { name: metric.name, value: metric.value, rating: metric.rating, id: metric.id });
  try {
    onLCP(report);
    onINP(report);
    onCLS(report);
    onTTFB(report);
    onFCP(report);
  } catch {
    // Older browsers without PerformanceObserver: vitals are optional.
  }
}
