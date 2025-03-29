web: node build/index.js
monitor: node railway-monitor.js

# این فایل برای Railway است و هر خط یک فرآیند مجزا را مشخص می‌کند
# برنامه اصلی و مانیتور به طور همزمان اجرا می‌شوند

# برای ذخیره لاگ‌ها در فایل موقت، می‌توانید این خط را فعال کنید:
# log-collector: railway logs --limit 50 > /tmp/railway-logs.txt && sleep 60 && rm /tmp/railway-logs.txt && echo "logs collected" >> /tmp/log-collector.log 