// رسوم شركات الشحن (cf): عدّادين (إجمالي + دورة)، الحد من الأدمن (ثابت/نسبة)، فحص الحد قبل القبول، الإلغاء بيرجّع، السداد بيصفّر عدّاد الدورة — Firestore وهمي.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { boot } from '../helpers/harness.mjs';
import { DEFAULTS } from '../../functions/_lib/logic.js'; DEFAULTS.samePickupMax = 0; // حد «نفس النقطة» مش موضوع الاختبار ده

const JPEG = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 7)]).toString('base64');
const CAIRO = { lat: 30.0444, lng: 31.2357, address: 'وسط البلد' }, GIZA = { lat: 30.0131, lng: 31.2089, address: 'الجيزة' };

describe('رسوم شركات الشحن', () => {
  let h, cur; const dataOf = (id) => JSON.parse(h.FS.get(`orders/${id}`).data || '{}');
  const save = (p) => h.call('adm', 'admin/settings/save', { ...cur, ...p });
  const up = async (uid, kind) => (await h.call(uid, 'files/upload', { kind, data: JPEG })).ref;
  const mkOrder = async (price) => {
    h.FS.list('rl').forEach((d) => h.FS.del(`rl/${d._id}`));
    const r = await h.call('cust', 'orders/create', { pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small', weightKg: 100, description: 'كراتين أدوات منزلية 4 قطع', declaredValue: 100, scheduledAt: new Date(Date.now() + 3600e3).toISOString(), photos: [await up('cust', 'cargo')] });
    expect(r.status, JSON.stringify(r)).toBe(200);
    h.FS.patch(`orders/${r.id}`, { price, data: JSON.stringify({ ...dataOf(r.id), price, amountDue: price }) });
    return r.id;
  };
  const accept = (uid, orderId) => h.call(uid, 'orders/accept', { orderId, agree: true });
  const sum = (uid) => h.call(uid, 'cf/summary', {});

  beforeAll(async () => {
    h = await boot({});
    h.user('adm', { role: 'admin' }); h.user('cust');
    h.user('comp1', { role: 'driver', account_type: 'company', company_name: 'شركة النيل للنقل', vehicle_type: 'pickup' });
    h.user('indiv1', { role: 'driver', account_type: 'individual', vehicle_type: 'pickup' });
    cur = { ...(await h.call('cust', 'settings')).settings, maxActiveJobs: 50, dcEnabled: false };
  });
  afterAll(() => h.restore());

  it('مقفول افتراضياً: القبول مش بيتحسب على أي عدّاد', async () => {
    expect(cur.cfEnabled).toBe(false);
    const o = await mkOrder(500);
    expect((await accept('comp1', o)).status).toBe(200);
    const s = await sum('comp1'); expect(s.enabled).toBe(false); expect(s.total).toBe(0); expect(s.cycle).toBe(0);
    await h.call('cust', 'orders/cancel', { orderId: o });
  });

  it('الأدمن بس يحدد الإعدادات، والنسبة لحد 100', async () => {
    expect((await h.call('cust', 'admin/settings/save', { ...cur, cfEnabled: true, cfValue: 50, cfLimit: 1000 })).status).toBe(403);
    expect((await save({ cfEnabled: true, cfType: 'percent', cfValue: 101, cfLimit: 1000 })).status).toBe(400);
    expect((await save({ cfEnabled: true, cfType: 'fixed', cfValue: 50, cfLimit: 1000 })).status).toBe(200);
    const S = (await h.call('cust', 'settings')).settings; expect([S.cfEnabled, S.cfType, S.cfValue, S.cfLimit]).toEqual([true, 'fixed', 50, 1000]);
  });

  it('950 ثم طلب 150: يقبل (الحد قبل القبول) وبعدها يتوقف؛ الإلغاء يرجّع؛ الفردي مش متأثر', async () => {
    const o1 = await mkOrder(950), o2 = await mkOrder(150), o3 = await mkOrder(100);
    expect((await accept('comp1', o1)).status).toBe(200);
    let s = await sum('comp1'); expect([s.cycle, s.total, s.blocked, s.due]).toEqual([950, 950, false, 50]);
    expect((await accept('comp1', o2)).status).toBe(200); // 950 تحت الحد فيقبل حتى لو الطلب هيعدّيه
    s = await sum('comp1'); expect([s.cycle, s.total, s.blocked]).toEqual([1100, 1100, true]);
    const blocked = await accept('comp1', o3); expect([blocked.status, blocked.error]).toEqual([403, 'cf_blocked']);
    expect((await accept('indiv1', o3)).status).toBe(200); // سواق فردي مش بيتحسب عليه
    expect(h.FS.get('users/indiv1').cf_total).toBeUndefined();
    expect((await h.call('cust', 'orders/cancel', { orderId: o2 })).status).toBe(200); // العميل لغى → الطلب يتشال من العدّادين
    s = await sum('comp1'); expect([s.cycle, s.total, s.blocked]).toEqual([950, 950, false]);
    expect(dataOf(o2).cfAmount).toBe(0);
  });

  it('السداد: إثبات + تأكيد الأدمن يصفّر عدّاد الدورة ويفضل الإجمالي', async () => {
    const o = await mkOrder(100); await accept('comp1', o); // 1050 → متوقف
    let s = await sum('comp1'); expect([s.cycle, s.blocked]).toEqual([1050, true]);
    expect((await h.call('indiv1', 'cf/pay', {})).status).toBe(403);
    const pay = await h.call('comp1', 'cf/pay', { method: 'wallet', proofRef: await up('comp1', 'payment'), reference: 'CF-12345' });
    expect(pay.status, JSON.stringify(pay)).toBe(200); expect(pay.amount).toBe(50);
    expect((await h.call('comp1', 'cf/pay', { method: 'wallet', proofRef: await up('comp1', 'payment'), reference: 'CF-99999' })).error).toBe('cf_pending');
    expect((await h.call('cust', 'admin/cf/list', {})).status).toBe(403);
    const list = await h.call('adm', 'admin/cf/list', {}); expect(list.pending.length).toBe(1); expect(list.companies[0].id).toBe('comp1');
    expect((await h.call('adm', 'admin/cf/confirm', { id: pay.id, action: 'confirm' })).status).toBe(200);
    s = await sum('comp1'); expect([s.cycle, s.total, s.blocked]).toEqual([0, 1050, false]);
    expect(h.FS.get('users/comp1').cf_paid_total).toBe(50);
    expect((await accept('comp1', await mkOrder(100))).status).toBe(200); // رجع يقبل
  });

  it('رفض الإثبات بسبب إجباري، والنسبة المئوية، وتعديل الأدمن اليدوي', async () => {
    expect((await save({ cfEnabled: true, cfType: 'percent', cfValue: 5, cfLimit: 150 })).status).toBe(200);
    await accept('comp1', await mkOrder(100)); // عدّاد الدورة 200 ≥ 150 → متوقف
    let s = await sum('comp1'); expect([s.cycle, s.due, s.blocked, s.type]).toEqual([200, 10, true, 'percent']);
    const pay = await h.call('comp1', 'cf/pay', { method: 'instapay', proofRef: await up('comp1', 'payment'), reference: 'CF-55555' });
    expect(pay.amount).toBe(10);
    expect((await h.call('adm', 'admin/cf/confirm', { id: pay.id, action: 'reject' })).status).toBe(400);
    expect((await h.call('adm', 'admin/cf/confirm', { id: pay.id, action: 'reject', note: 'الصورة مش واضحة' })).status).toBe(200);
    expect((await sum('comp1')).blocked).toBe(true); // الرفض مابيفكش التوقف
    expect((await h.call('adm', 'admin/cf/adjust', { uid: 'comp1', cycle: 40, note: 'تصحيح' })).status).toBe(200);
    s = await sum('comp1'); expect([s.cycle, s.blocked]).toEqual([40, false]);
    expect((await h.call('adm', 'admin/cf/adjust', { uid: 'comp1', note: 'x' })).status).toBe(400);
    expect((await h.call('adm', 'admin/cf/adjust', { uid: 'indiv1', cycle: 1, note: 'ملهوش' })).status).toBe(404);
  });
});
