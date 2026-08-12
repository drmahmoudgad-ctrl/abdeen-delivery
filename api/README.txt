# ABDEEN DELIVERY - Backend Routing

## التشغيل على Vercel
1. ارفع الملفات الثلاثة:
   - index.html
   - vercel.json
   - api/route.js
2. Deploy على Vercel.
3. افتح رابط الموقع من Vercel.

الـHTML لا يتصل بمحركات Routing العامة مباشرة من المتصفح.
الطلبات تمر عبر `/api/route` في Vercel، ثم يحاول السيرفر Valhalla للموتوسيكل، ويستخدم OSRM كاحتياطي.

لا يحتاج Google Maps API Key.
