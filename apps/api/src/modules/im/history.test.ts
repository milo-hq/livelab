import { afterAll, describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import type { ServerMsg } from '@livelab/protocol';
import { createMemoryHistory, createRedisHistory, type History } from './history.js';
import { createRedisBus } from './bus.js';

const user = { id: 'u1', name: 'A', role: 'viewer' as const };
const chat = (seq: number, room = 'r'): ServerMsg => ({ t: 'chat', lane: 'chat', seq, room, ts: seq, id: `m${seq}`, user, text: `msg ${seq}` });

function suite(name: string, make: () => History | Promise<History>, room: () => string) {
  describe(name, () => {
    it('allocates strictly increasing seqs per room', async () => {
      const h = await make();
      const r = room();
      expect(await h.latestSeq(r)).toBe(0);
      expect(await h.nextSeq(r)).toBe(1);
      expect(await h.nextSeq(r)).toBe(2);
      expect(await h.latestSeq(r)).toBe(2);
      expect(await h.nextSeq(`${r}-other`)).toBe(1);
    });
    it('since() returns messages after seq, ascending, newest 200 when truncating', async () => {
      const h = await make();
      const r = room();
      for (let i = 1; i <= 250; i++) await h.append(r, chat(i, r));
      const since10 = await h.since(r, 10);
      expect(since10).toHaveLength(200);
      expect(since10[0]!.seq).toBe(51);
      expect(since10[199]!.seq).toBe(250);
      const since245 = await h.since(r, 245);
      expect(since245.map((m) => m.seq)).toEqual([246, 247, 248, 249, 250]);
      expect(await h.since(r, 250)).toEqual([]);
      const last50 = await h.since(r, 0, 50);
      expect(last50).toHaveLength(50);
      expect(last50[0]!.seq).toBe(201);
    });
    it('keeps only the newest 500 messages', async () => {
      const h = await make();
      const r = room();
      for (let i = 1; i <= 520; i++) await h.append(r, chat(i, r));
      const all = await h.since(r, 0, 1000);
      expect(all).toHaveLength(500);
      expect(all[0]!.seq).toBe(21);
    });
  });
}

suite('memory history', () => createMemoryHistory(), () => `r${Math.random()}`);

// Redis variant runs only when a local Redis is reachable (infra: redis://localhost:6390).
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6390';
const probe = createRedisBus(redisUrl);
const redisUp = await probe.ready(500).then(() => true, () => false);
await probe.close();

describe.skipIf(!redisUp)('redis', () => {
  const client = new Redis(redisUrl, { lazyConnect: true });
  const used: string[] = [];
  const room = () => { const r = `test:${Math.random().toString(36).slice(2)}`; used.push(r); return r; };
  afterAll(async () => {
    if (used.length) await client.del(...used.flatMap((r) => [`hist:${r}`, `seq:${r}`, `hist:${r}-other`, `seq:${r}-other`]));
    client.disconnect();
  });
  suite('redis history', async () => { if (client.status === 'wait') await client.connect(); return createRedisHistory(client); }, room);

  it('redis bus delivers validated ServerMsg to subscribers of the room', async () => {
    const a = createRedisBus(redisUrl);
    const b = createRedisBus(redisUrl);
    await Promise.all([a.ready(), b.ready()]);
    const r = room();
    const got: ServerMsg[] = [];
    const unsub = b.subscribe(r, (m) => got.push(m));
    await new Promise((res) => setTimeout(res, 50)); // SUBSCRIBE round-trip
    await a.publish(r, chat(1, r));
    await a.client.publish(`room:${r}`, '{"t":"garbage"}');
    await new Promise((res) => setTimeout(res, 100));
    expect(got).toEqual([chat(1, r)]);
    unsub();
    await a.close();
    await b.close();
  });
});
