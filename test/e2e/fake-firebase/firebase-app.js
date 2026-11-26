// بديل اختباري لـ firebase-app (E2E فقط): مفيش اتصال بـ Firebase الحقيقي أبداً.
export const initializeApp = (cfg) => ({ options: cfg, name: '[DEFAULT]' });
