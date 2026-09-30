import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { compress } from '../src/app';

describe('response compression', () => {
  const app = Fastify();
  app.addHook('onSend', async (req, reply, payload) => compress(req.headers['accept-encoding'], reply, payload));
  app.get('/big', async () => ({ rows: Array.from({ length: 200 }, (_, i) => ({ i, name: `Student ${i}` })) }));
  app.get('/small', async () => ({ ok: true }));

  it('gzips big JSON when the client accepts it, and the body round-trips', async () => {
    const r = await app.inject({ url: '/big', headers: { 'accept-encoding': 'gzip, deflate' } });
    expect(r.headers['content-encoding']).toBe('gzip');
    expect(String(r.headers.vary)).toContain('accept-encoding');
    const body = JSON.parse(gunzipSync(r.rawPayload).toString());
    expect(body.rows).toHaveLength(200);
    expect(r.rawPayload.length).toBeLessThan(JSON.stringify(body).length / 3);
  });

  it('leaves small answers and clients without gzip alone', async () => {
    expect((await app.inject({ url: '/small', headers: { 'accept-encoding': 'gzip' } })).headers['content-encoding']).toBeUndefined();
    const plain = await app.inject({ url: '/big' });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.json().rows).toHaveLength(200);
  });
});
