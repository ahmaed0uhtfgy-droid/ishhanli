/** موقع المستخدم الحالي (بيرمي خطأ بكود مفهوم لو مفيش صلاحية) */
export const getPos = () => new Promise((res, rej) => {
  if (!navigator.geolocation) return rej(Object.assign(new Error('geo'), { code: 'geo_unsupported' }));
  navigator.geolocation.getCurrentPosition((p) => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
    (e) => rej(Object.assign(new Error('geo'), { code: e.code === 1 ? 'geo_denied' : 'geo_failed' })), { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
});
