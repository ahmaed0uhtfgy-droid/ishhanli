// الإشعارات: صندوق الإشعارات الداخلي، إرسال FCM (نجاح/جهاز ميت/خطأ)، وترتيب وتوزيع الطلب الجديد على السواقين.
// FCM بيتحاكى بـfetch وهمي (مفيش اتصال حقيقي).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { notify, dispatchNewOrder } from '../../functions/_lib/push.js';
import { DEFAULTS } from '../../functions/_lib/logic.js';
import { boot } from '../helpers/harness.mjs';

let h, inner, sent;
const CAIRO = { lat: 30.0444, lng: 31.2357, address: 'وسط البلد' };
const near = (km) => ({ lat: CAIRO.lat + km / 111, lng: CAIRO.lng });
const tok = (uid, t, extra = {}) => h.FS.put(`push_tokens/${uid}-${t}`, { token: t, uid, created_at: 1, last_seen: 1, ...extra });
const pres = (uid, p, extra = {}) => h.FS.put(`driver_presence/${uid}`, { uid, online: true, seen_at: Date.now(), lat: p.lat, lng: p.lng, ...extra });
const wipe = () => ['inbox', 'push_tokens', 'driver_presence'].forEach((c) => h.FS.list(c).forEach((d) => h.FS.del?.(`${c}/${d._id || d.id}`)));

beforeAll(async () => {
  h = await boot({ PUSH_DISABLED: '0' });
  inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://fcm.googleapis.com/')) {
      const m = JSON.parse(init.body).message; sent.push(m);
      if (m.token.startsWith('dead')) return new Response('{"error":{"status":"NOT_FOUND","message":"UNREGISTERED"}}', { status: 404 });
      if (m.token.startsWith('boom')) return new Response('oops', { status: 500 });
      return new Response('{}', { status: 200 });
    }
    return inner(url, init);
  };
});
afterAll(() => { globalThis.fetch = inner; h.restore(); });
beforeEach(() => { sent = []; });

describe('notify', () => {
  it('نوع مجهول أو قائمة فاضية = 0 ومفيش كتابة', async () => {
    const n = h.FS.list('inbox').length;
    expect(await notify(h.env, ['u1'], 'nope_type')).toBe(0); expect(await notify(h.env, [], 'driver_arrived')).toBe(0); expect(await notify(h.env, undefined, 'driver_arrived')).toBe(0);
    expect(h.FS.list('inbox').length).toBe(n); expect(sent).toEqual([]);
  });
  it('صندوق الإشعارات بيتسجّل حتى لو الإشعارات الخارجية مقفولة، وبدون تكرار وبحد 12 مستخدم', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `u${i}`); const before = h.FS.list('inbox').length;
    expect(await notify({ ...h.env, PUSH_DISABLED: '1' }, [...ids, ...ids], 'driver_arrived', { no: '#A1' })).toBe(0);
    const rows = h.FS.list('inbox').slice(before); expect(rows.length).toBe(12); expect(new Set(rows.map((r) => r.uid)).size).toBe(12); expect(rows.every((r) => r.read === false && r.type === 'driver_arrived')).toBe(true); expect(sent).toEqual([]);
  });
  it('FCM: بيبعت بلغة كل مستخدم، وبيمسح الجهاز الميت، ويعدّ الناجح بس، ويتحمّل الخطأ', async () => {
    h.user('pa', { role: 'customer', lang: 'ar' }); h.user('pe', { role: 'customer', lang: 'en' }); h.user('pb', { role: 'customer', lang: 'ar' });
    tok('pa', 'good1'); tok('pe', 'good2'); tok('pb', 'dead1'); tok('pb', 'boom1');
    const n = await notify(h.env, ['pa', 'pe', 'pb'], 'driver_arrived', { no: '#A1' }, { url: '/#/order/x', tag: 't1' });
    expect(n).toBe(2); expect(sent.length).toBe(4);
    const by = Object.fromEntries(sent.map((m) => [m.token, m.data]));
    expect(by.good1.title).toBe('السواق وصل'); expect(by.good2.title).toBe('Your driver arrived'); expect(by.good2.body).toContain('#A1'); expect(by.good1.url).toBe('/#/order/x'); expect(by.good1.tag).toBe('t1'); expect(by.good1.type).toBe('driver_arrived');
    expect(h.FS.get('push_tokens/pb-dead1')).toBeFalsy(); // الجهاز الميت اتمسح
    expect(h.FS.get('push_tokens/pb-boom1')).toBeTruthy(); // خطأ مؤقت: ما يتمسحش
    expect(h.FS.get('push_tokens/pa-good1')).toBeTruthy();
  });
  it('جهاز مستخدم محذوف (مفيش users/uid) بيتجاهل ومش بيتبعتله', async () => {
    tok('ghost', 'good9'); const n = await notify(h.env, ['ghost'], 'driver_arrived', { no: '#A1' }); expect(n).toBe(0); expect(sent.find((m) => m.token === 'good9')).toBeUndefined();
  });
  it('حد أقصى 30 جهاز في الإرسال الواحد (حد الـsubrequests)', async () => {
    h.user('many', { role: 'customer', lang: 'ar' }); for (let i = 0; i < 40; i++) tok('many', `tk${i}`);
    sent = []; const n = await notify(h.env, ['many'], 'driver_arrived', { no: '#A1' }); expect(sent.length).toBeLessThanOrEqual(30); expect(n).toBe(sent.length);
  });
});

describe('dispatchNewOrder (توزيع الطلب الجديد)', () => {
  const S = { ...DEFAULTS, dispatchRadiusKm: 25, dispatchMaxDrivers: 3 };
  const order = (extra = {}) => ({ id: 'order0000001', pickup: CAIRO, dropoff: { lat: 30.01, lng: 31.2, address: 'الجيزة' }, price: 150, size: 'small', service: 'goods', ...extra });
  const drv = (uid, o = {}) => { h.user(uid, { role: 'driver', status: 'active', vehicle_type: 'pickup', lang: 'ar', ...o }); tok(uid, 'g-' + uid); };
  const recipients = () => sent.map((m) => m.token.replace('g-', '')).sort();

  it('بيختار الأقرب فقط بحد أقصى dispatchMaxDrivers، ويستبعد البعيد والأوفلاين والمعلّق وقديم الحضور والعربية الصغيرة على طلب كبير', async () => {
    const T = { vehicle_type: 'truck' }; // طلب حجم كبير: نقل (truck) يخدمه، وبيك أب (pickup) لا
    ['d1', 'd2', 'd3', 'd4', 'dfar', 'doff', 'dstale'].forEach((u) => drv(u, T)); drv('dpend', { ...T, status: 'pending' }); drv('dpickup', { vehicle_type: 'pickup' });
    pres('d1', near(1)); pres('d2', near(2)); pres('d3', near(3)); pres('d4', near(4)); pres('dfar', near(80)); pres('doff', near(1), { online: false }); pres('dpend', near(1)); pres('dstale', near(1), { seen_at: Date.now() - 13 * 3600e3 }); pres('dpickup', near(1));
    sent = []; const n = await dispatchNewOrder(h.env, order({ size: 'large' }), S);
    expect(n).toBe(3); expect(recipients()).toEqual(['d1', 'd2', 'd3']); // الأقرب 3 فقط (d4 فوق الحد، dfar برّه النطاق، والباقي مستبعد)
    expect(sent.every((m) => m.data.type === 'new_order' && m.data.url === '/#/order/order0000001')).toBe(true); expect(sent[0].data.body).toContain('150');
  });
  it('عربية بيك أب بتخدم الطلب الصغير (نفس السواقين، حجم مختلف)', async () => {
    sent = []; await dispatchNewOrder(h.env, order({ size: 'small' }), { ...S, dispatchMaxDrivers: 20 });
    expect(recipients()).toContain('dpickup');
  });
  it('الرحلة (passengers) بتبعت new_trip للعربيات المناسبة', async () => {
    sent = []; h.user('dcar', { role: 'driver', status: 'active', vehicle_type: 'car', lang: 'ar' }); tok('dcar', 'g-dcar'); pres('dcar', near(1));
    await dispatchNewOrder(h.env, order({ service: 'passengers', vehicleClass: 'car', passengers: 3 }), S);
    expect(recipients()).toContain('dcar'); expect(sent.find((m) => m.token === 'g-dcar').data.type).toBe('new_trip');
  });
  it('الإشعارات مقفولة = 0 ومفيش إرسال، وأي خطأ داخلي ما بيكسرش', async () => {
    sent = []; expect(await dispatchNewOrder({ ...h.env, PUSH_DISABLED: '1' }, order(), S)).toBe(0); expect(sent).toEqual([]);
    expect(await dispatchNewOrder(h.env, { id: 'x' }, S)).toBe(0); // طلب ناقص (من غير pickup): يرجّع 0 مش exception
  });
});
