# Ayaz Video Maker 4.1.1 — Free Engine

این نسخه قرارداد Free Engine فعلی را حفظ می‌کند، اما اگر `FREE_ENGINE_URL` به یک Hugging Face Gradio/ZeroGPU Space عمومی اشاره کند، مستقیماً از Queue API آن استفاده می‌کند.

## Render

Build Command: `npm install`
Start Command: `npm start`

حداقل متغیر موردنیاز برای Free Engine:

`FREE_ENGINE_URL=https://multimodalart-minimax-h3.hf.space`

در این حالت `FREE_ENGINE_API_KEY` لازم نیست.

## موتور انتخاب‌شده

Hugging Face Space عمومی `multimodalart/minimax-h3` است. این Space روی ZeroGPU اجرا می‌شود و Text-to-Video دارد. Endpoint گرادیو آن `generate` است و ورودی‌های آن شامل prompt، canvas، duration، steps، seed و upsample است.

## محدودیت مهم

این Free Engine فعلاً برای Text-to-Video طراحی شده است. Image-to-Video همچنان به Runway سپرده می‌شود. خروجی H3 حداکثر حدود 14 ثانیه است؛ Backend مدت درخواست را برای این موتور به بازه 5 تا 14 ثانیه محدود می‌کند.

Free Engine عمومی Hugging Face سهمیه/صف ZeroGPU دارد و تضمین «نامحدود و همیشه در دسترس» نیست. طبق مستندات فعلی، درخواست‌های بدون احراز هویت سهمیه پایین‌تری دارند (۲ دقیقه روزانه) و حساب رایگان احراز‌شده ۵ دقیقه روزانه دارد؛ بنابراین عدد ۵ ویدئو/روز در Ayaz فقط سهمیه منطقی برنامه است و نباید آن را تضمین ۵ ویدئوی موفق از طرف GPU عمومی دانست. اگر Space عمومی موقتاً در صف یا متوقف باشد، پنل خطای دقیق را نمایش می‌دهد.

## تست

بعد از Deploy، این آدرس را باز کنید:
`https://YOUR-RENDER-SERVICE.onrender.com/api/health`

باید `freeEngineConfigured: true` را ببینید. سپس وارد پنل شوید و یک Prompt بدون تصویر بسازید.
