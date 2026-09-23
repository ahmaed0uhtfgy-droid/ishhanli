-- اشحنلي — مخطط قاعدة بيانات Cloudflare D1 (SQLite).  آمن للتشغيل أكتر من مرة (IF NOT EXISTS).
-- التنفيذ:  npm run db:init:local   |   npm run db:init:remote

CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('customer','driver','admin')),
  status TEXT NOT NULL DEFAULT 'pending',
  status_reason TEXT,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,               -- UNIQUE = منع تكرار الموبايل (NULL مسموح للأدمن)
  email TEXT,
  national_id TEXT UNIQUE,         -- UNIQUE = منع تكرار الرقم القومي
  area TEXT,
  lang TEXT DEFAULT 'ar',
  id_ref TEXT, license_ref TEXT, vehicle_reg_ref TEXT, vehicle_photo_ref TEXT, vehicle_type TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  rating_sum INTEGER NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  completed_orders INTEGER NOT NULL DEFAULT 0,
  cancel_count INTEGER NOT NULL DEFAULT 0,
  reviewed_by TEXT, reviewed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at);

-- الحقول المستعلَم عنها أعمدة، والباقي (عناوين، صور، سجل الحالات...) في data كـ JSON
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  driver_id TEXT,
  status TEXT NOT NULL,
  escrow_status TEXT NOT NULL DEFAULT 'none',
  price INTEGER NOT NULL,
  commission INTEGER,
  driver_net INTEGER,
  customer_refund INTEGER,
  scheduled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,   -- للتحكم في التزامن (optimistic locking)
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);

-- CHECK(balance >= 0): حماية إضافية على مستوى القاعدة ضد الرصيد السالب
CREATE TABLE IF NOT EXISTS wallets (
  uid TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  total_earned INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS wallet_tx (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER NOT NULL,
  order_id TEXT, gross INTEGER, commission INTEGER, withdrawal_id TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_uid ON wallet_tx(uid, at);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, name TEXT, phone TEXT, amount INTEGER NOT NULL,
  method TEXT NOT NULL, account TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', note TEXT,
  decided_by TEXT, decided_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wd_uid ON withdrawals(uid, created_at);
CREATE INDEX IF NOT EXISTS idx_wd_status ON withdrawals(status);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, customer_id TEXT NOT NULL, driver_id TEXT,
  opened_by TEXT NOT NULL, opened_by_role TEXT NOT NULL, reason TEXT NOT NULL, details TEXT, evidence TEXT,
  order_price INTEGER, status TEXT NOT NULL DEFAULT 'open',
  decision TEXT, customer_pct INTEGER, customer_refund INTEGER, driver_net INTEGER, commission INTEGER, note TEXT,
  refund_paid INTEGER NOT NULL DEFAULT 0, refund_paid_at INTEGER, resolved_by TEXT, resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_disputes_status ON disputes(status, created_at);

CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blacklist (k TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT NOT NULL, reason TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS live_locations (order_id TEXT PRIMARY KEY, lat REAL NOT NULL, lng REAL NOT NULL, acc INTEGER, at INTEGER NOT NULL);

-- بيانات الملفات (ACL) هنا دايماً. المحتوى نفسه في file_blobs (قاعدة FILES المنفصلة) أو في R2.
CREATE TABLE IF NOT EXISTS files_meta (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, store TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files_meta(owner, created_at);
CREATE TABLE IF NOT EXISTS file_blobs (id TEXT PRIMARY KEY, data TEXT NOT NULL);  -- base64؛ بيُستخدم لو مفيش R2

-- عروض أسعار السواقين على طلب مفتوح (سعر الموقع اقتراحي، والسواق يقدر يقترح تعديل والعميل يختار)
CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, driver_id TEXT NOT NULL, price INTEGER NOT NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | accepted | rejected | withdrawn
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_order ON offers(order_id, status);
CREATE INDEX IF NOT EXISTS idx_offers_driver ON offers(driver_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_pending ON offers(order_id, driver_id) WHERE status = 'pending';  -- عرض واحد معلّق لكل سواق

-- "متاح لاستقبال الطلبات" + آخر موقع معروف (بيتحدّث والصفحة مفتوحة) — لتوجيه الإشعارات لأقرب السواقين
CREATE TABLE IF NOT EXISTS driver_presence (uid TEXT PRIMARY KEY, online INTEGER NOT NULL DEFAULT 0, lat REAL, lng REAL, seen_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_presence_online ON driver_presence(online);

-- أجهزة الإشعارات (FCM tokens)
CREATE TABLE IF NOT EXISTS push_tokens (token TEXT PRIMARY KEY, uid TEXT NOT NULL, ua TEXT, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_push_uid ON push_tokens(uid, last_seen);

-- استرجاع فلوس العميل (طلب مدفوع مقدماً ماحدش قبله / اتلغى): الأدمن يحوّل يدوياً (InstaPay) ويعلّم "تم"
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, customer_id TEXT NOT NULL, amount INTEGER NOT NULL,
  reason TEXT NOT NULL,                        -- no_driver (انتهى الميعاد) | cancelled (العميل لغى)
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | paid
  note TEXT, created_at INTEGER NOT NULL, paid_at INTEGER, paid_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_refund_order ON refunds(order_id);   -- استرجاع واحد لكل طلب (يمنع التكرار عند التنافس)

-- شات العميل والسواق داخل الطلب
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, sender_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_order ON messages(order_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_sender ON messages(sender_id, created_at);

-- بلاغات المستخدمين (سلوك مسيء، قيادة غير آمنة، احتيال...) ومعاها لقطة من الشات كدليل
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, target_id TEXT NOT NULL, order_id TEXT NOT NULL, reason TEXT NOT NULL, details TEXT, context TEXT,
  status TEXT NOT NULL DEFAULT 'open',            -- open | resolved | dismissed
  admin_note TEXT, handled_by TEXT, handled_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at);

-- زر الطوارئ أثناء رحلات الركاب
CREATE TABLE IF NOT EXISTS sos_events (
  id TEXT PRIMARY KEY, order_id TEXT NOT NULL, user_id TEXT NOT NULL, lat REAL, lng REAL,
  status TEXT NOT NULL DEFAULT 'open',            -- open | handled
  note TEXT, handled_by TEXT, handled_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sos_status ON sos_events(status, created_at);
CREATE INDEX IF NOT EXISTS idx_sos_user ON sos_events(user_id, created_at);

-- جدول حراسة: أي INSERT بـ NULL فيه بيفشل ويرجّع المعاملة كلها (بنستخدمه كـ "شرط لازم يتحقق")
CREATE TABLE IF NOT EXISTS _guard (x INTEGER NOT NULL);
