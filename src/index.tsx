import { serveStatic } from "@hono/node-server/serve-static";
import { Button, Frog, TextInput } from 'frog';
import { serve } from "@hono/node-server";
import { neynar } from 'frog/middlewares';
import fs from 'fs/promises';
import Moralis from 'moralis';
import { NeynarAPIClient, Configuration } from "@neynar/nodejs-sdk";

// تایپ‌ها
interface ApiRow {
  fid?: string;
  parent_fid?: string;
  sent_peanut_count?: number;
  daily_peanut_count?: number;
  all_time_peanut_count?: number;
  rank?: number;
  [key: string]: any;
}

interface NFTHolder {
  wallet: string;
  count: number;
}

// ثابت‌ها
const cacheFile = './cache.json';
const ogHoldersFile = './nft_holders.json';
const newHoldersFile = './new_nft_holders.json';
let cache: {
  queries: Record<string, { rows: { fid: string; data: ApiRow; cumulativeExcess: number }[]; lastUpdated: number }>;
  initialFetchDone: boolean;
  updateCountToday: number;
  lastUpdateDay: number;
} = {
  queries: { '4837362': { rows: [], lastUpdated: 0 } },
  initialFetchDone: false,
  updateCountToday: 0,
  lastUpdateDay: 0
};

const secondTimestamps: number[] = [];
const minuteTimestamps: number[] = [];
const MAX_RPS = 7;
const MAX_RPM = 300;
const LOAD_THRESHOLD = 4;
const SECOND_DURATION = 1000;
const MINUTE_DURATION = 60000;

let isUpdating = false;
let apiRequestCount = 0;
let OGpic: number = 0;
let Usertype = "";
const OG_NFT_CONTRACT_ADDRESS = '0x8AaB3b53d0F29A3EE07B24Ea253494D03a42e2fB';
const NEW_NFT_CONTRACT_ADDRESS = '0x36d4a78d0FB81A16A1349b8f95AF7d5d3CA25081';
const MORALIS_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6ImE1MjE5NDlkLTU2MWItNDE5NC1hMmI5LTQxZTgxMDA4M2E3NyIsIm9yZ0lkIjoiNDM3MDA0IiwidXNlcklkIjoiNDQ5NTY1IiwidHlwZUlkIjoiNmJmNzAzZGItNmM1Ni00NGViLTg4ZmMtNjJjOWMzMTk4Zjc2IiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3NDIzMzMzNTksImV4cCI6NDg5ODA5MzM1OX0.Lv8JHB8RrbC7UWLJXHijd3kUsaaqmfUt14QCcW71JU0';

// دکمه TRUE/FALSE برای هولدرهای بدون NFT
const ALLOW_NON_HOLDERS = false;

// تنظیمات Neynar با API Key جدید
const config = new Configuration({ apiKey: '0AFD6D12-474C-4AF0-B580-312341F61E17' });
const client = new NeynarAPIClient(config);

// راه‌اندازی Moralis
console.log('[Moralis] Initializing Moralis SDK');
Moralis.start({ apiKey: MORALIS_API_KEY }).then(() => {
  console.log('[Moralis] Moralis SDK initialized successfully');
}).catch((error) => {
  console.error('[Moralis] Error initializing Moralis SDK:', error);
});

// تابع کمکی برای fetch با تایم‌اوت و retry
async function fetchWithTimeoutAndRetry(url: string, options: RequestInit, timeout = 5000, retries = 3): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);
      const response = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
      }
      return response;
    } catch (error) {
      if (i === retries - 1) throw error;
      console.log(`[Fetch] Attempt ${i + 1} failed: ${(error as Error).message}. Retrying...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw new Error('Unexpected error in fetchWithTimeoutAndRetry');
}

// توابع
function checkRateLimit(): { isAllowed: boolean; isLoading: boolean } {
  const now = Date.now();
  
  // پاک کردن تایم‌استمپ‌های قدیمی
  while (secondTimestamps.length > 0 && now - secondTimestamps[0] > SECOND_DURATION) {
    secondTimestamps.shift();
  }
  while (minuteTimestamps.length > 0 && now - minuteTimestamps[0] > MINUTE_DURATION) {
    minuteTimestamps.shift();
  }
  
  // افزودن تایم‌استمپ فقط اگر مجاز باشد
  if (secondTimestamps.length >= MAX_RPS) {
    console.log('[RateLimit] Too many requests per second:', secondTimestamps.length);
    return { isAllowed: false, isLoading: false };
  }
  
  if (minuteTimestamps.length >= MAX_RPM) {
    console.log('[RateLimit] Too many requests per minute:', minuteTimestamps.length);
    return { isAllowed: false, isLoading: false };
  }
  
  // اضافه کردن یک حالت "در حال بررسی" برای زمانی که به حد مجاز نزدیک می‌شویم
  if (secondTimestamps.length >= MAX_RPS * 0.8 || minuteTimestamps.length >= MAX_RPM * 0.9) {
    console.log('[RateLimit] Approaching limit. Switching to loading state.');
    return { isAllowed: true, isLoading: true };
  }
  
  // ثبت تایم‌استمپ جدید
  secondTimestamps.push(now);
  minuteTimestamps.push(now);
  
  return { isAllowed: true, isLoading: false };
}

async function loadCache() {
  console.log('[Cache] Loading cache from file');
  try {
    const data = await fs.readFile(cacheFile, 'utf8');
    const loadedCache = JSON.parse(data) as typeof cache;
    cache = {
      queries: { '4837362': loadedCache.queries['4837362'] || { rows: [], lastUpdated: 0 } },
      initialFetchDone: loadedCache.initialFetchDone || false,
      updateCountToday: loadedCache.updateCountToday || 0,
      lastUpdateDay: loadedCache.lastUpdateDay || 0
    };
    cache.queries['4837362'].rows = cache.queries['4837362'].rows.map(row => ({
      fid: String(row.fid || (row.data && row.data.fid) || (row.data && row.data.parent_fid) || ''),
      data: row.data || row,
      cumulativeExcess: row.cumulativeExcess || 0
    }));
    console.log(`[Cache] Loaded from cache.json: rows=${cache.queries['4837362'].rows.length}`);
  } catch (error) {
    console.log('[Cache] No cache file found or invalid JSON. Starting fresh');
  }
}

async function saveCache() {
  console.log('[Cache] Saving cache to cache.json');
  await fs.writeFile(cacheFile, JSON.stringify(cache, null, 2));
  console.log(`[Cache] Cache saved to cache.json with ${cache.queries['4837362'].rows.length} rows`);
}

console.log('[Server] Initializing cache');
loadCache().then(() => console.log('[Server] Cache initialized'));

export const app = new Frog({
  imageAspectRatio: '1:1',
  title: 'Nuts State',
  imageOptions: { fonts: [{ name: 'Poetsen One', weight: 400, source: 'google' }] },
});

app.use(neynar({ apiKey: '0AFD6D12-474C-4AF0-B580-312341F61E17', features: ['interactor', 'cast'] }));
app.use('/*', serveStatic({ root: './public' }));

async function executeQuery(queryId: string): Promise<string | null> {
  console.log(`[API] Executing Query ${queryId} (Request #${++apiRequestCount}) - 1 credit consumed`);
  try {
    const response = await fetchWithTimeoutAndRetry(
      `https://api.dune.com/api/v1/query/${queryId}/execute`,
      {
        method: 'POST',
        headers: { 'X-Dune-API-Key': 'jaXtS6fQFj8jFgU2Kk11NYa1k0Xt41J0' }
      },
      5000,
      3
    );
    const data = await response.json() as { execution_id: string };
    console.log(`[API] Query ${queryId} execution started with ID: ${data.execution_id}`);
    return data.execution_id;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[API] Error executing Query ${queryId}:`, errorMessage);
    return null;
  }
}

async function fetchQueryResult(executionId: string, queryId: string): Promise<ApiRow[] | null> {
  console.log(`[API] Fetching results for Query ${queryId} with execution ID ${executionId} (Request #${++apiRequestCount}) - 1 credit consumed`);
  try {
    const response = await fetchWithTimeoutAndRetry(
      `https://api.dune.com/api/v1/execution/${executionId}/results`,
      {
        method: 'GET',
        headers: { 'X-Dune-API-Key': 'jaXtS6fQFj8jFgU2Kk11NYa1k0Xt41J0' }
      },
      5000,
      3
    );
    const data = await response.json() as { state: string; result?: { rows: ApiRow[] } };
    if (data.state === 'EXECUTING' || data.state === 'PENDING') {
      console.log(`[API] Query ${queryId} still executing or pending. Results not ready yet.`);
      return null;
    }
    const results: ApiRow[] = data?.result?.rows || [];
    console.log(`[API] Fetched ${results.length} rows for Query ${queryId}`);
    return results;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[API] Error fetching Query ${queryId}:`, errorMessage);
    return [];
  }
}

function generateHashId(fid: string): string {
  console.log(`[Hash] Generating hashId for FID ${fid}`);
  const timestamp = Date.now();
  const randomHash = Math.random().toString(36).substr(2, 9);
  const hashId = `${timestamp}-${fid}-${randomHash}`;
  console.log(`[Hash] Generated hashId: ${hashId}`);
  return hashId;
}

const hashIdCache: Record<string, string> = {};

async function getOrGenerateHashId(fid: string): Promise<string> {
  console.log(`[Hash] Checking hashId for FID ${fid}`);
  if (hashIdCache[fid]) {
    console.log(`[Hash] Using cached hashId: ${hashIdCache[fid]}`);
    return hashIdCache[fid];
  }
  const newHashId = generateHashId(fid);
  hashIdCache[fid] = newHashId;
  console.log(`[Hash] New hashId stored: ${newHashId}`);
  return newHashId;
}
function getCurrentUTCDay(): number {
  console.log('[Time] Calculating current UTC day');
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
  console.log(`[Time] Current UTC day start: ${new Date(dayStart).toUTCString()}`);
  return dayStart;
}
function shouldUpdateApi(lastUpdated: number, isCacheEmpty: boolean): boolean {
  console.log('[UpdateCheck] Checking if API update is allowed');
  const now = new Date();
  const TWO_HOURS_IN_MS = 2 * 60 * 60 * 1000;
  const utcHours = now.getUTCHours();
  const utcMinutes = now.getUTCMinutes();
  const totalMinutes = utcHours * 60 + utcMinutes;
  // آپدیت‌ها در ۰۰:۰۰ (0)، ۰۶:۰۰ (360)، ۱۲:۰۰ (720) و ۲۱:۰۰ (1260) UTC
  const updateTimes = [0, 360,648, 720,990, 1260];

  if (isCacheEmpty) {
    console.log(`[UpdateCheck] Cache is empty. Allowing immediate update at ${utcHours}:${utcMinutes} UTC`);
    return true;
  }

  const closestUpdateTime = updateTimes.find(time => Math.abs(totalMinutes - time) <= 5);
  if (!closestUpdateTime) {
    console.log(`[UpdateCheck] Current time: ${utcHours}:${utcMinutes} UTC, Not in update window`);
    return false;
  }

  const timeSinceLastUpdate = now.getTime() - lastUpdated;
  if (timeSinceLastUpdate < TWO_HOURS_IN_MS) {
    console.log(`[UpdateCheck] In update window (${closestUpdateTime} minutes), but last update was ${(timeSinceLastUpdate / (1000 * 60)).toFixed(2)} minutes ago (< 2 hours). No update allowed`);
    return false;
  }

  console.log(`[UpdateCheck] In update window (${closestUpdateTime} minutes) and last update was ${(timeSinceLastUpdate / (1000 * 60)).toFixed(2)} minutes ago (> 2 hours). Allowing update`);
  return true;
}

async function updateQueries() {
  if (isUpdating) {
    console.log('[Update] Update already in progress. Skipping');
    return;
  }
  isUpdating = true;
  try {
    console.log('[Update] Entering updateQueries');
    const now = Date.now();
    const currentDay = getCurrentUTCDay();
    const queryId = '4837362';

    const lastUpdated = cache.queries[queryId].lastUpdated;
    const isCacheEmpty = cache.queries[queryId].rows.length === 0;
    console.log(`[Update] Last updated: ${new Date(lastUpdated).toUTCString()}, Initial Fetch Done: ${cache.initialFetchDone}, Update Count: ${cache.updateCountToday}, Cache Empty: ${isCacheEmpty}`);

    if (cache.lastUpdateDay < currentDay) {
      console.log('[Update] New day detected. Resetting update count');
      cache.updateCountToday = 0;
      cache.lastUpdateDay = currentDay;
    }

    if (cache.updateCountToday >= 6) {
      console.log('[Update] Max 6 updates reached for today. Skipping');
      return;
    }

    if (!shouldUpdateApi(lastUpdated, isCacheEmpty)) {
      console.log('[Update] Conditions for update not met. Skipping');
      return;
    }

    console.log(`[Update] Starting update at ${new Date().toUTCString()} - Only 2 requests allowed`);
    const executionId = await executeQuery(queryId);
    if (!executionId) {
      console.error('[Update] Failed to get execution ID. Aborting update');
      return;
    }

    console.log('[Update] Waiting 3 minutes for query execution to complete');
    await new Promise(resolve => setTimeout(resolve, 180000));

    const rows = await fetchQueryResult(executionId, queryId);
    if (rows === null) {
      console.warn('[Update] Results not ready after 3 minutes. Aborting');
      return;
    }
    if (rows.length === 0) {
      console.warn('[Update] No rows fetched from API despite expecting data');
    }

    const updatedRows = rows.map(async (row: ApiRow) => {
      const fid = String(row.fid || row.parent_fid || '');
      const sentPeanutCount = row.sent_peanut_count || 0;

      const ogNFTCount = await isOGNFTHolder(fid);
      const newNFTCount = await isNewNFTHolder(fid);
      const ogAllowance = ogNFTCount * 150;
      const newAllowance = newNFTCount === 1 ? 30 : newNFTCount === 2 ? 45 : newNFTCount >= 3 ? 60 : 0;
      const nonHolderAllowance = (ogNFTCount === 0 && newNFTCount === 0 && ALLOW_NON_HOLDERS) ? 30 : 0;
      const maxAllowance = ogAllowance + newAllowance + nonHolderAllowance;

      const excess = sentPeanutCount > maxAllowance ? sentPeanutCount - maxAllowance : 0;
      const existingRow = cache.queries[queryId].rows.find(r => r.fid === fid);
      const cumulativeExcess = (existingRow ? existingRow.cumulativeExcess : 0) + excess;

      return { fid, data: row, cumulativeExcess };
    });

    cache.queries[queryId] = { rows: await Promise.all(updatedRows), lastUpdated: now };
    if (!cache.initialFetchDone && isCacheEmpty) {
      cache.initialFetchDone = true;
      console.log('[Update] Initial fetch completed and locked');
    }
    cache.updateCountToday += 1;
    cache.lastUpdateDay = currentDay;
    await saveCache();
    console.log(`[Update] Update completed. Total requests: 2, Update count today: ${cache.updateCountToday}`);
  } finally {
    isUpdating = false;
  }
}

function scheduleUpdates() {
  setInterval(async () => {
    console.log('[Scheduler] Checking for scheduled update');
    await updateQueries();
  }, 60 * 1000); // هر ۱ دقیقه چک کن
}

console.log('[Server] Starting update scheduler');
scheduleUpdates();

// تابع بهبود یافته برای فراخوانی API نیینار با تایم‌اوت مناسب
async function getWalletAddressFromFid(fid: string): Promise<{ wallet1: string | null; wallet2: string | null }> {
  console.log(`[Neynar] Fetching verified wallet addresses for FID ${fid}`);
  if (fid === 'N/A') {
    console.log('[Neynar] FID is N/A, skipping request');
    return { wallet1: null, wallet2: null };
  }
  
  // اضافه کردن منطق کش ساده
  const cacheKey = `wallet_${fid}`;
  const cachedWallet = userDataCache.get(cacheKey);
  if (cachedWallet && (Date.now() - cachedWallet.timestamp < 3600000)) { // 1 ساعت
    return cachedWallet.data;
  }
  
  try {
    // اضافه کردن تایم‌اوت به درخواست
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000); // تایم‌اوت 2 ثانیه
    
    const response = await client.fetchBulkUsers({ fids: [Number(fid)] });
    clearTimeout(timeoutId);
    
    const user = response.users[0];
    const ethAddresses = user?.verified_addresses?.eth_addresses || [];
    const wallet1 = ethAddresses[0] || null;
    const wallet2 = ethAddresses[1] || null;
    
    const result = { wallet1, wallet2 };
    userDataCache.set(cacheKey, { data: result, timestamp: Date.now() });
    
    console.log(`[Neynar] Verified wallets for FID ${fid}: Wallet1: ${wallet1}, Wallet2: ${wallet2}`);
    return result;
  } catch (error) {
    console.error(`[Neynar] Error fetching verified wallet addresses: ${error}`);
    return { wallet1: null, wallet2: null };
  }
}

async function isOGNFTHolder(fid: string): Promise<number> {
  console.log(`[NFT] Checking if FID ${fid} holds OG NFT from ${OG_NFT_CONTRACT_ADDRESS} using offline data`);
  try {
    const { wallet1, wallet2 } = await getWalletAddressFromFid(fid);
    if (!wallet1 && !wallet2) {
      console.log(`[NFT] No wallet address found for FID ${fid}`);
      return 0;
    }

    const holdersData = await fs.readFile(ogHoldersFile, 'utf8');
    const { holders }: { holders: NFTHolder[] } = JSON.parse(holdersData);

    let count = 0;

    // بررسی مالکیت برای wallet1
    if (wallet1) {
      const holder1 = holders.find(h => h.wallet.toLowerCase() === wallet1.toLowerCase());
      count += holder1 ? holder1.count : 0;
      console.log(`[NFT] FID ${fid} (Wallet1: ${wallet1}) holds ${holder1 ? holder1.count : 0} OG NFTs`);
    }

    // بررسی مالکیت برای wallet2
    if (wallet2) {
      const holder2 = holders.find(h => h.wallet.toLowerCase() === wallet2.toLowerCase());
      count += holder2 ? holder2.count : 0;
      console.log(`[NFT] FID ${fid} (Wallet2: ${wallet2}) holds ${holder2 ? holder2.count : 0} OG NFTs`);
    }

    return count;
  } catch (error) {
    console.error(`[NFT] Error checking OG holder status offline: ${error}`);
    return 0;
  }
}


async function isNewNFTHolder(fid: string): Promise<number> {
  console.log(`[NFT] Checking if FID ${fid} holds New NFT from ${NEW_NFT_CONTRACT_ADDRESS} using offline data`);
  try {
    const { wallet1, wallet2 } = await getWalletAddressFromFid(fid);
    if (!wallet1 && !wallet2) {
      console.log(`[NFT] No wallet address found for FID ${fid}`);
      return 0;
    }
    const holdersData = await fs.readFile(newHoldersFile, 'utf8');
    const { holders }: { holders: NFTHolder[] } = JSON.parse(holdersData);
    let count = 0;
    if (wallet1) {
      const holder1 = holders.find(h => h.wallet.toLowerCase() === wallet1.toLowerCase());
      count += holder1 ? holder1.count : 0;
    }
    if (wallet2) {
      const holder2 = holders.find(h => h.wallet.toLowerCase() === wallet2.toLowerCase());
      count += holder2 ? holder2.count : 0;
    }
    console.log(`[NFT] FID ${fid} (Wallets: ${wallet1}, ${wallet2}) holds ${count} New NFTs`);
    return count;
  } catch (error) {
    console.error(`[NFT] Error checking New NFT holder status offline: ${error}`);
    return 0;
  }
}

// جلوگیری از فراخوانی‌های مکرر API با کش در حافظه
const userDataCache = new Map<string, { data: any; timestamp: number }>();
const USER_CACHE_TTL = 30000; // 30 ثانیه

async function getUserDataFromCache(fid: string) {
  // بررسی اگر داده در کش حافظه وجود دارد
  const cacheKey = `user_${fid}`;
  const now = Date.now();
  const cachedData = userDataCache.get(cacheKey);
  
  if (cachedData && (now - cachedData.timestamp < USER_CACHE_TTL)) {
    console.log(`[Cache] Using in-memory cache for FID ${fid}`);
    return cachedData.data;
  }
  
  console.log(`[Data] Fetching data for FID ${fid}`);
  const userRow = cache.queries['4837362'].rows.find((row) => row.fid === fid) || { data: {}, cumulativeExcess: 0 };
  const userData: ApiRow = userRow.data;

  const todayPeanutCount = userData.daily_peanut_count || 0;
  const totalPeanutCount = userData.all_time_peanut_count || 0;
  const sentPeanutCount = userData.sent_peanut_count || 0;

  const ogNFTCount = await isOGNFTHolder(fid);
  const newNFTCount = await isNewNFTHolder(fid);

  OGpic = ogNFTCount;
  if (newNFTCount === 1) {
    Usertype = "Member";
  } else if (newNFTCount === 2) {
    Usertype = "Regular";
  } else if (newNFTCount >= 3) {
    Usertype = "Active";
  } else {
    Usertype = "Noobie";
  }

  let maxAllowance: number;
  let remainingAllowance: string;
  let reduceEndSeason = '';

  const ogAllowance = ogNFTCount * 150;
  const newAllowance = newNFTCount === 1 ? 30 : newNFTCount === 2 ? 45 : newNFTCount >= 3 ? 60 : 0;
  const nonHolderAllowance = (ogNFTCount === 0 && newNFTCount === 0 && ALLOW_NON_HOLDERS) ? 30 : 0;
  maxAllowance = ogAllowance + newAllowance + nonHolderAllowance;

  if (ogNFTCount > 0 || newNFTCount > 0) {
    remainingAllowance = `${maxAllowance} / ${Math.max(maxAllowance - sentPeanutCount, 0)}`;
    reduceEndSeason = sentPeanutCount > maxAllowance ? String(sentPeanutCount - maxAllowance) : '';
  } else {
    if (ALLOW_NON_HOLDERS) {
      remainingAllowance = `${maxAllowance} / ${Math.max(maxAllowance - sentPeanutCount, 0)}`;
      reduceEndSeason = sentPeanutCount > maxAllowance ? String(sentPeanutCount - maxAllowance) : '';
    } else {
      maxAllowance = 0;
      remainingAllowance = 'mint your allowance';
      reduceEndSeason = sentPeanutCount > maxAllowance ? String(sentPeanutCount - maxAllowance) : '';
    }
  }

  const existingRowIndex = cache.queries['4837362'].rows.findIndex(row => row.fid === fid);
  if (existingRowIndex !== -1 && (ogNFTCount > 0 || newNFTCount > 0)) {
    cache.queries['4837362'].rows[existingRowIndex].cumulativeExcess = userRow.cumulativeExcess + (sentPeanutCount > maxAllowance ? sentPeanutCount - maxAllowance : 0);
  } else if (existingRowIndex === -1 && (ogNFTCount > 0 || newNFTCount > 0)) {
    cache.queries['4837362'].rows.push({ fid, data: userData, cumulativeExcess: sentPeanutCount > maxAllowance ? sentPeanutCount - maxAllowance : 0 });
  }

  const userRank = userData.rank || 0;

  const { wallet1, wallet2 } = await getWalletAddressFromFid(fid);
  const verifiedWallet1 = wallet1 ? `${wallet1.slice(0, 3)}...${wallet1.slice(-3)}` : 'N/A';
  const verifiedWallet2 = wallet2 ? `${wallet2.slice(0, 3)}...${wallet2.slice(-3)}` : 'N/A';
  const warpcastVerifiedLink1 = wallet1 ? `https://warpcast.com/~/profile/${fid}` : 'N/A';
  const warpcastVerifiedLink2 = wallet2 ? `https://warpcast.com/~/profile/${fid}` : 'N/A';

  console.log(`[Data] FID ${fid} - Today: ${todayPeanutCount}, Total: ${totalPeanutCount}, Sent: ${sentPeanutCount}, Allowance: ${remainingAllowance}, Rank: ${userRank}, ReduceEndSeason: ${reduceEndSeason}, VerifiedWallet1: ${verifiedWallet1}, VerifiedWallet2: ${verifiedWallet2}`);
  const result = { todayPeanutCount, totalPeanutCount, sentPeanutCount, remainingAllowance, userRank, reduceEndSeason, verifiedWallet1, verifiedWallet2, warpcastVerifiedLink1, warpcastVerifiedLink2 };
  
  // ذخیره نتیجه در کش حافظه
  userDataCache.set(cacheKey, { data: result, timestamp: now });
  
  return result;
}

// اضافه کردن سِمافور ساده برای محدود کردن تعداد درخواست‌های همزمان
const semaphore = {
  count: 0,
  max: 20, // حداکثر 20 درخواست همزمان
  queue: [] as (() => void)[],
  
  async acquire() {
    if (this.count >= this.max) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.count++;
  },
  
  release() {
    this.count--;
    const next = this.queue.shift();
    if (next) next();
  }
};

app.frame('/', async (c) => {
  try {
    // بررسی rate limit
    const rateLimitStatus = checkRateLimit();
    if (!rateLimitStatus.isAllowed) {
      // کد موجود برای پاسخ rate limit
      return c.res({
        image: (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%', backgroundColor: '#ffcccc' }}>
            <p style={{ color: '#ff0000', fontSize: '30px', fontFamily: 'Poetsen One' }}>Too many requests. Wait a moment.</p>
          </div>
        ),
        intents: [<Button value="my_state">Try Again</Button>]
      });
    }
    
    // اکتساب سِمافور با تایم‌اوت
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Semaphore acquisition timeout')), 1000);
    });
    
    try {
      await Promise.race([semaphore.acquire(), timeoutPromise]);
    } catch (error) {
      return c.res({
        image: (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%', backgroundColor: '#fff3cd' }}>
            <p style={{ color: '#856404', fontSize: '30px', fontFamily: 'Poetsen One' }}>Server is busy. Please try again.</p>
          </div>
        ),
        intents: [<Button value="my_state">Try Again</Button>]
      });
    }
    
    // کد اصلی پردازش با تایم‌اوت
    try {
      console.log(`[Frame] Request received at ${new Date().toUTCString()}`);
      const urlParams = new URLSearchParams(c.req.url.split('?')[1]);
      const defaultInteractor = { fid: "N/A", username: "Unknown", pfpUrl: "" };
      const interactor = (c.var as any)?.interactor ?? defaultInteractor;

      const fid = String(urlParams.get("fid") || interactor.fid || "N/A");
      const username = urlParams.get("username") || interactor.username || "Unknown";
      const pfpUrl = urlParams.get("pfpUrl") || interactor.pfpUrl || "";

      const { todayPeanutCount, totalPeanutCount, sentPeanutCount, remainingAllowance, userRank, reduceEndSeason, verifiedWallet1, verifiedWallet2, warpcastVerifiedLink1, warpcastVerifiedLink2 } = await getUserDataFromCache(fid);
      const hashId = await getOrGenerateHashId(fid);
      const frameUrl = `https://nuts-state.up.railway.app/?hashid=${hashId}&fid=${fid}&username=${encodeURIComponent(username)}&pfpUrl=${encodeURIComponent(pfpUrl)}`;
      const composeCastUrl = `https://warpcast.com/~/compose?text=${encodeURIComponent('Check out your 🥜 stats! \n\n Frame by @arsalang.eth & @jeyloo.eth ')}&embeds[]=${encodeURIComponent(frameUrl)}`;

      console.log("usertype:", Usertype);
      return c.res({
        image: (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              width: "100%",
              height: "100%",
              backgroundColor: "black",
              color: "white",
              fontFamily: "'Lilita One','Poppins'",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <img
              src="/bg.png"
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                position: "absolute",
                top: 0,
                left: 0,
              }}
            />
            {pfpUrl && (
              <img
                src={anticURLSanitize(pfpUrl)}
                alt="Profile Picture"
                style={{
                  width: "160px",
                  height: "160px",
                  borderRadius: "50%",
                  position: "absolute",
                  top: "3.5%",
                  left: "25.5%",
                  border: "3px solid white",
                }}
              />
            )}
            <p
              style={{
                position: "absolute",
                top: "8%",
                left: "57%",
                transform: "translateX(-50%)",
                color: "cyan",
                fontSize: "30px",
                fontWeight: "700",
              }}
            >
              {username}
            </p>
            <p
              style={{
                position: "absolute",
                top: "14%",
                left: "57%",
                transform: "translateX(-50%)",
                color: "white",
                fontSize: "15px",
                fontWeight: "500",
              }}
            >
              {fid}
            </p>
            <p
              style={{
                position: "absolute",
                top: "46%",
                left: "58%",
                color: "#ff8c00",
                fontSize: "33px",
              }}
            >
              {totalPeanutCount}
            </p>
            {remainingAllowance === 'mint your allowance' ? (
              <p
                style={{
                  position: "absolute",
                  top: "66%",
                  left: "33%",
                  color: "#28a745",
                  fontSize: "18px",
                  fontWeight: "bold",
                }}
              >
                {remainingAllowance}
              </p>
            ) : (
              <p
                style={{
                  position: "absolute",
                  top: "64%",
                  left: "36%",
                  color: "#28a745",
                  fontSize: "33px",
                }}
              >
                {remainingAllowance}
              </p>
            )}
            <p
              style={{
                position: "absolute",
                top: "46%",
                left: "40%",
                color: "#ff8c00",
                fontSize: "33px",
              }}
            >
              {todayPeanutCount}
            </p>
            <p
              style={{
                position: "absolute",
                top: "80%",
                left: "62%",
                color: "#ffffff",
                fontSize: "23px",
              }}
            >
              {verifiedWallet1}
            </p>
            <p
              style={{
                position: "absolute",
                top: "85%",
                left: "62%",
                color: "#ffffff",
                fontSize: "23px",
              }}
            >
              {verifiedWallet2}
            </p>
            <p
              style={{
                position: "absolute",
                top: "64%",
                left: "58%",
                color: "#007bff",
                fontSize: "33px",
              }}
            >
              {userRank}
            </p>
            {OGpic > 0 && (
              <img
                src="/og.png"
                width="131"
                height="187"
                style={{
                  position: "absolute",
                  top: "7.8%",
                  left: "37.5%",
                }}
              />
            )}
            {(Usertype === "Member" || Usertype === "Regular" || Usertype === "Active") && (
              <img
                src="/member.png"
                width="100"
                height="100"
                style={{
                  position: "absolute",
                  top: "25%",
                  left: "66%",
                }}
              />
            )}
            {(Usertype === "Regular" || Usertype === "Active") && (
              <img
                src="/regular.png"
                width="100"
                height="100"
                style={{
                  position: "absolute",
                  top: "25%",
                  left: "57.5%",
                }}
              />
            )}
            {Usertype === "Active" && (
              <img
                src="/active.png"
                width="100"
                height="100"
                style={{
                  position: "absolute",
                  top: "25%",
                  left: "49%",
                }}
              />
            )}
            {(reduceEndSeason === "" || isNaN(Number(reduceEndSeason))) && (
              <img
                src="/tik.png"
                width="55"
                height="55"
                style={{
                  position: "absolute",
                  top: "83%",
                  left: "35%",
                }}
              />
            )}
            <p
              style={{
                position: "absolute",
                top: "81%",
                left: "35%",
                color: "#ff0000",
                fontSize: "35px",
              }}
            >
              {reduceEndSeason}
            </p>
          </div>
        ),
        intents: [
          <Button value="my_state">My State</Button>,
          <Button.Link href={composeCastUrl}>Share</Button.Link>,
          <Button.Link href="https://foundation.app/mint/base/0x8AaB3b53d0F29A3EE07B24Ea253494D03a42e2fB">Be OG</Button.Link>,
          <Button.Link href="https://foundation.app/mint/base/0x36d4a78d0FB81A16A1349b8f95AF7d5d3CA25081">Allowance</Button.Link>,
        ],
      });
    } catch (error) {
      console.error('[Frame] Error processing request:', error);
      return c.res({
        image: (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%', backgroundColor: '#ffcccc' }}>
            <p style={{ color: '#ff0000', fontSize: '30px', fontFamily: 'Poetsen One' }}>Error processing request. Please try again.</p>
          </div>
        ),
        intents: [<Button value="my_state">Try Again</Button>]
      });
    } finally {
      semaphore.release();
    }
  } catch (error) {
    console.error('[Frame] Unexpected error:', error);
    return c.res({
      image: (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%', width: '100%', backgroundColor: '#ffcccc' }}>
          <p style={{ color: '#ff0000', fontSize: '30px', fontFamily: 'Poetsen One' }}>Unexpected error. Please try again.</p>
        </div>
      ),
      intents: [<Button value="my_state">Try Again</Button>]
    });
  }
});

function anticURLSanitize(url: string): string {
  const decodedURL = decodeURIComponent(url);
  const cleanURL = decodedURL.replace(/[<>"'`;]/g, "");
  const urlPattern = /^(https?:\/\/)?([\da-z.-]+)\.([a-z.]{2,6})([/\w .-]*)*\/?$/i;
  if (!urlPattern.test(cleanURL)) {
    return "";
  }
  return cleanURL;
}

const port: number = Number(process.env.PORT) || 3000;
console.log(`[Server] Starting server on port ${port}`);

serve(app);