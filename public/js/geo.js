/** موقع المستخدم الحالي (بيرمي خطأ بكود مفهوم لو مفيش صلاحية) */
let last = null; // آخر موقع اتجاب (بنستخدمه في طلبات القائمة/القبول من غير ما نسأل الـGPS كل مرة)
/** آخر موقع معروف لو أحدث من 10 دقايق، وإلا null */
export const cachedPos = () => (last && Date.now() - last.at < 600000 ? { lat: last.lat, lng: last.lng } : null);
export const getPos = () => new Promise((res, rej) => {
  if (!navigator.geolocation) return rej(Object.assign(new Error('geo'), { code: 'geo_unsupported' }));
  navigator.geolocation.getCurrentPosition((p) => { last = { lat: p.coords.latitude, lng: p.coords.longitude, at: Date.now() }; res({ lat: last.lat, lng: last.lng }); },
    (e) => rej(Object.assign(new Error('geo'), { code: e.code === 1 ? 'geo_denied' : 'geo_failed' })), { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
});
