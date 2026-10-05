# Ayaz Video Maker V4.1

این نسخه بر پایه پروژه فعلی Ayaz Video Maker ساخته شده است.

## Render
- Build Command: `npm install`
- Start Command: `npm start`

## Environment Variables
- `RUNWAYML_API_SECRET`
- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`
- `ALLOWED_ORIGINS=*`
- `DAILY_FREE_USER=5`
- `DAILY_FREE_ADMIN=80`
- `PRICE_PER_VIDEO=10000`
- `CURRENCY=IRT`
- `FREE_ENGINE_URL=`
- `FREE_ENGINE_API_KEY=`
- `ZARINPAL_MERCHANT_ID=`
- `ZARINPAL_CALLBACK_URL=https://YOUR-SERVICE.onrender.com/api/payment/zarinpal/callback`
- `ZARINPAL_API_BASE=https://api.zarinpal.com/pg/v4/payment`

## Rules
- Admin سهمیه ۸۰ روزانه دارد و بعد از آن هم برای تولید نیاز به شارژ کیف پول ندارد.
- کاربر عادی ۵ ویدئوی روزانه دارد؛ بعد از آن هر تولید از کیف پول کم می‌کند.
- پنل Admin در رابط کاربری کاربران عادی نمایش داده نمی‌شود و APIهای Admin نیز با role=admin محافظت شده‌اند.
- اطلاعات بانکی قابل تنظیم از پنل Admin است.
- Runway و Free Engine دو مسیر مستقل هستند.

## Important
فایل `data/db.json` برای نسخه فعلی استفاده می‌شود. روی Render Free فایل محلی ممکن است با redeploy/restart پایدار نماند؛ برای استفاده واقعی چندکاربره باید در مرحله بعد دیتابیس دائمی مانند Postgres اضافه شود.
