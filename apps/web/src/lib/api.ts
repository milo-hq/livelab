import type { ZodType } from 'zod';
import { ErrorBody } from '@livelab/protocol';
import { useSession } from '../stores/session';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public body: unknown) {
    super(message);
  }
}

interface Opts { idempotencyKey?: string; signal?: AbortSignal }

async function request<T>(method: string, path: string, schema: ZodType<T>, body?: unknown, opts: Opts = {}): Promise<T> {
  const token = useSession.getState().token;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const parsed = ErrorBody.safeParse(json);
    if (res.status === 401) useSession.getState().logout();
    throw new ApiError(res.status, parsed.success ? parsed.data.code : 'http_error', parsed.success ? parsed.data.message : res.statusText, json);
  }
  return schema.parse(json);
}

export const api = {
  get: <T>(path: string, schema: ZodType<T>, opts?: Opts) => request('GET', path, schema, undefined, opts),
  post: <T>(path: string, body: unknown, schema: ZodType<T>, opts?: Opts) => request('POST', path, schema, body, opts),
  del: <T>(path: string, schema: ZodType<T>, opts?: Opts) => request('DELETE', path, schema, undefined, opts),
};
