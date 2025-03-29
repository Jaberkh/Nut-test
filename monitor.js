import { execSync, exec } from 'child_process';
import fs from 'fs';

// تنظیمات
const LOG_CHECK_INTERVAL = 60000; // بررسی هر یک دقیقه
const ERROR_THRESHOLD = 4; // حداکثر تعداد خطای مجاز
const LOG_COUNT = 10; // تعداد لاگ‌های مورد بررسی

// تابع بررسی لاگ‌ها
function checkLogs() {
  console.log('[Monitor] Checking Railway logs for error status codes...');
  
  try {
    // گرفتن آخرین لاگ‌ها از Railway
    // نکته: این روش‌ها به Railway CLI نیاز دارد که باید نصب و تنظیم شده باشد
    
    // روش 1: استفاده مستقیم از CLI
    // const logs = execSync('railway logs --limit 20').toString();
    
    // روش 2: خواندن لاگ از فایل موقت (مناسب برای محیط تولید)
    // در Railway لاگ‌ها معمولاً در مسیر خاصی ذخیره می‌شوند
    // ابتدا باید یک cron job یا دستور در Procfile تنظیم کنید که دوره‌ای لاگ‌ها را در فایل بنویسد
    let logs = '';
    try {
      if (fs.existsSync('/tmp/railway-logs.txt')) {
        logs = fs.readFileSync('/tmp/railway-logs.txt', 'utf8');
      } else {
        // اگر فایل وجود نداشت، سعی می‌کنیم مستقیم از CLI بگیریم
        logs = execSync('railway logs --limit 20').toString();
      }
    } catch (err) {
      console.error('[Monitor] Error reading logs, trying alternative method');
      // اگر CLI هم جواب نداد، لاگ‌ها را از stdout سرویس می‌خوانیم (با فرض اینکه لاگ‌های HTTP در اینجا هستند)
      logs = execSync('echo $RAILWAY_SERVICE_STDOUT').toString();
    }
    
    // جستجوی وضعیت‌های خطا (499 یا 500) در لاگ‌ها
    const matches = logs.match(/status(=| |:)+(499|500)/gi) || [];
    const errorCount = matches.length;
    
    console.log(`[Monitor] Found ${errorCount} error status codes in last logs`);
    
    // نوشتن آمار در فایل برای تحلیل بعدی
    fs.appendFileSync('monitor-stats.log', `${new Date().toISOString()}: Found ${errorCount} errors\n`);
    
    // بررسی تعداد خطاها و تصمیم‌گیری برای ریستارت
    if (errorCount > ERROR_THRESHOLD) {
      console.log('[Monitor] Error threshold exceeded! Restarting application...');
      restartApp();
    }
  } catch (error) {
    console.error('[Monitor] Error checking logs:', error.message);
    
    // نوشتن خطا در فایل لاگ محلی برای بررسی بعدی
    fs.appendFileSync('monitor-errors.log', `${new Date().toISOString()}: ${error.message}\n`);
  }
}

// تابع ریستارت برنامه
function restartApp() {
  try {
    console.log('[Monitor] Executing restart command...');
    
    // ثبت زمان ریستارت در فایل لاگ
    fs.appendFileSync('restart-history.log', `${new Date().toISOString()}: Application restarted due to error threshold\n`);
    
    // در محیط Railway، این دستور باعث ریستارت شدن سرویس می‌شود
    exec('kill 1', (error) => {
      if (error) {
        console.error('[Monitor] Failed to restart with kill 1:', error.message);
        
        // ثبت خطای ریستارت در فایل لاگ
        fs.appendFileSync('monitor-errors.log', `${new Date().toISOString()}: Restart failed: ${error.message}\n`);
        
        // یک روش جایگزین: فقط در محیط Railway کار می‌کند
        try {
          execSync('railway service restart');
          fs.appendFileSync('restart-history.log', `${new Date().toISOString()}: Application restarted with railway CLI command\n`);
        } catch (cliError) {
          console.error('[Monitor] Failed to restart with railway CLI:', cliError.message);
          fs.appendFileSync('monitor-errors.log', `${new Date().toISOString()}: CLI restart failed: ${cliError.message}\n`);
        }
      }
    });
  } catch (error) {
    console.error('[Monitor] Error restarting application:', error.message);
    fs.appendFileSync('monitor-errors.log', `${new Date().toISOString()}: Restart error: ${error.message}\n`);
  }
}

// شروع چرخه بررسی لاگ‌ها
console.log('[Monitor] Starting Railway log monitoring service');
console.log(`[Monitor] Checking for ${ERROR_THRESHOLD}+ error status codes every ${LOG_CHECK_INTERVAL/1000} seconds`);

// بررسی اولیه
// اجرا با تأخیر کوتاه برای اطمینان از راه‌اندازی کامل سرویس اصلی
setTimeout(checkLogs, 10000);

// تنظیم بررسی دوره‌ای
setInterval(checkLogs, LOG_CHECK_INTERVAL); 