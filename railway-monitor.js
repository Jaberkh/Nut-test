import http from 'http';
import { exec } from 'child_process';
import fs from 'fs';

// تنظیمات
const PORT = process.env.MONITOR_PORT || 3001;
const CHECK_INTERVAL = 60000; // هر 1 دقیقه چک کن
const ERROR_THRESHOLD = 4; // بیش از 4 خطا

// آرایه برای ذخیره لاگ‌های HTTP
const httpErrors = [];
let lastRestartTime = 0;
const RESTART_COOLDOWN = 5 * 60 * 1000; // 5 دقیقه فاصله بین ریستارت‌ها

// تابع بررسی لاگ‌های Railway و ریستارت در صورت نیاز
async function checkLogsAndRestart() {
  console.log('[RailwayMonitor] Checking HTTP error logs...');
  
  // برای جلوگیری از ریستارت‌های مکرر در زمان کوتاه
  const now = Date.now();
  if (now - lastRestartTime < RESTART_COOLDOWN) {
    console.log(`[RailwayMonitor] In cooldown period, last restart was ${Math.floor((now - lastRestartTime) / 1000)} seconds ago`);
    return;
  }
  
  // شمارش خطاهای 499 و 500 در آرایه httpErrors
  // فقط 10 لاگ آخر را بررسی می‌کنیم
  const recentErrors = httpErrors.slice(0, 10);
  const errorCount = recentErrors.filter(err => err.status === 499 || err.status === 500).length;
  
  console.log(`[RailwayMonitor] Found ${errorCount} errors in last 10 logs`);
  
  if (errorCount > ERROR_THRESHOLD) {
    console.log('[RailwayMonitor] Error threshold exceeded! Restarting application...');
    
    // ثبت زمان ریستارت
    lastRestartTime = now;
    fs.appendFileSync('restart-history.log', `${new Date().toISOString()}: Application restarted due to error threshold (${errorCount} errors)\n`);
    
    // اجرای دستور ریستارت
    exec('kill 1', (error) => {
      if (error) {
        console.error('[RailwayMonitor] Failed to restart:', error.message);
        fs.appendFileSync('monitor-errors.log', `${new Date().toISOString()}: Restart failed: ${error.message}\n`);
      }
    });
  }
}

// ایجاد سرور ساده HTTP برای دریافت لاگ‌ها
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/log') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const logData = JSON.parse(body);
        
        // اگر این یک لاگ HTTP است با status
        if (logData.status) {
          console.log(`[RailwayMonitor] Received HTTP log with status ${logData.status}`);
          
          // افزودن به ابتدای آرایه
          httpErrors.unshift({
            timestamp: Date.now(),
            status: Number(logData.status),
            path: logData.path || '/'
          });
          
          // محدود کردن اندازه آرایه
          if (httpErrors.length > 20) {
            httpErrors.pop();
          }
          
          // بررسی وضعیت خطاها
          checkLogsAndRestart();
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (error) {
        console.error('[RailwayMonitor] Error processing log:', error.message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid log data' }));
      }
    });
  }
  else if (req.method === 'GET' && req.url === '/status') {
    // ارائه اطلاعات وضعیت فعلی
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      errorCount: httpErrors.slice(0, 10).filter(err => err.status === 499 || err.status === 500).length,
      lastRestart: lastRestartTime ? new Date(lastRestartTime).toISOString() : null,
      recentErrors: httpErrors.slice(0, 10)
    }));
  }
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// شروع سرور
server.listen(PORT, () => {
  console.log(`[RailwayMonitor] Server started on port ${PORT}`);
  console.log('[RailwayMonitor] POST /log to send HTTP logs');
  console.log('[RailwayMonitor] GET /status to check monitor status');
});

// سرور را در برابر خطاها محافظت کن
server.on('error', (error) => {
  console.error('[RailwayMonitor] Server error:', error.message);
  fs.appendFileSync('monitor-errors.log', `${new Date().toISOString()}: Server error: ${error.message}\n`);
}); 