AYAZ VIDEO MAKER PRO V5.0.1

ساختار صحیح پروژه:
server.js
package.json
public/index.html
data/db.json

Render:
Build Command: npm install
Start Command: npm start

Environment Variables:
ADMIN_EMAIL
ADMIN_PASSWORD
RUNWAYML_API_SECRET
FREE_ENGINE_URL
FREE_ENGINE_API_KEY (اختیاری)
DAILY_FREE_USER=5
DAILY_FREE_ADMIN=80
PRICE_PER_VIDEO
CURRENCY
ZARINPAL_MERCHANT_ID (در صورت نیاز)
ZARINPAL_CALLBACK_URL (در صورت نیاز)

نکته: فایل index.html باید داخل public/ باشد. سرور مسیر / را به public/index.html سرو می‌کند.

Image -> Video: وقتی تصویر انتخاب شود، سرور به Runway Gen-4.5 image_to_video می‌رود و هدر X-Runway-Version: 2024-11-06 را ارسال می‌کند.
Text -> Video: وقتی تصویر انتخاب نشده باشد، مسیر Free Engine استفاده می‌شود.
