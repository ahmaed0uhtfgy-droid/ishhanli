// اختبار أداء k6: خليط حقيقي من الزيارات (صفحات ثابتة + API عام + API بتوكن).
// التشغيل: k6 run -e BASE=http://127.0.0.1:4173 -e VUS=50 -e DURATION=15s test/perf/load.js
// ⚠️ على سيرفر الاختبار المحلي (Node + Firestore وهمي في الذاكرة) النتائج بتقيس كود التطبيق فقط، مش Cloudflare ولا Firestore الحقيقي.
//    لا تشغّله على الإنتاج بأحمال عالية (بيستهلك كوتا Firestore المجانية).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://127.0.0.1:4173';
export const options = {
  scenarios: { load: { executor: 'constant-vus', vus: Number(__ENV.VUS || 20), duration: __ENV.DURATION || '15s' } },
  thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<800'], checks: ['rate>0.99'] },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};
const tApi = new Trend('api_auth_duration', true), tStatic = new Trend('static_duration', true), errs = new Rate('app_errors');

export function setup() {
  const seed = http.post(`${BASE}/__e2e/seed?n=40`);
  if (seed.status !== 200) return { tokens: [] }; // سيرفر مش اختباري: بنقيس العام بس
  const uids = seed.json('uids');
  return { tokens: uids.map((u) => http.get(`${BASE}/__e2e/token?uid=${u}`).json('token')) };
}

const CAIRO = { lat: 30.0444, lng: 31.2357, address: 'x' }, GIZA = { lat: 30.0131, lng: 31.2089, address: 'y' };
export default function (data) {
  const r = Math.random();
  if (r < 0.45) { const res = http.get(`${BASE}/`); tStatic.add(res.timings.duration); errs.add(res.status !== 200); check(res, { 'home 200': (x) => x.status === 200 }); }
  else if (r < 0.60) { const res = http.get(`${BASE}/js/app.js`); tStatic.add(res.timings.duration); check(res, { 'app.js 200': (x) => x.status === 200 }); }
  else if (r < 0.70) { const res = http.get(`${BASE}/api/health`); check(res, { 'health 200': (x) => x.status === 200 }); }
  else if (r < 0.78) { const res = http.get(`${BASE}/api/about`); check(res, { 'about 200': (x) => x.status === 200 }); }
  else if (data.tokens.length) {
    const h = { headers: { Authorization: 'Bearer ' + data.tokens[__VU % data.tokens.length], 'Content-Type': 'application/json' } };
    const pick = Math.random();
    const res = pick < 0.5 ? http.post(`${BASE}/api/me`, '{}', h) : pick < 0.8 ? http.post(`${BASE}/api/orders/list`, '{}', h) : http.post(`${BASE}/api/quote`, JSON.stringify({ pickup: CAIRO, dropoff: GIZA, category: 'goods', size: 'small' }), h);
    tApi.add(res.timings.duration); errs.add(res.status >= 500);
    check(res, { 'api < 500': (x) => x.status < 500, 'api 200': (x) => x.status === 200 });
  }
  sleep(Math.random() * 0.3);
}
