import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOTIFICATION_CATEGORIES, notificationCategory } from '@attendly/protocol';
import { createTestApp, type TestCtx } from './harness';

let ctx: TestCtx;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => ctx?.close());

describe('notification thumbnails', () => {
  it('every category has a PNG thumbnail, served publicly and cached', async () => {
    for (const cat of Object.keys(NOTIFICATION_CATEGORIES)) {
      const r = await ctx.app.inject({ method: 'GET', url: `/v1/thumbs/${cat}.png` });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toBe('image/png');
      expect(r.rawPayload.subarray(1, 4).toString()).toBe('PNG');
      expect(r.headers['cache-control']).toContain('immutable');
    }
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/thumbs/nope.png' })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/thumbs/toString.png' })).statusCode).toBe(404);
  });

  it('maps each kind of news to one look', () => {
    expect(notificationCategory('rescheduled')).toBe('class');
    expect(notificationCategory('notice')).toBe('notice');
    expect(notificationCategory('attendance')).toBe('attendance');
    expect(notificationCategory('device_request')).toBe('phone');
    expect(notificationCategory('security')).toBe('security');
    expect(notificationCategory('request')).toBe('request');
  });
});
