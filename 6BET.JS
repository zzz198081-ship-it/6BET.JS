const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const https = require('https');
const { setTimeout } = require('timers/promises');
const path = require('path');

const ADMIN_ID = 7343964083;
const BOT_TOKEN = "8562953676:AAEnSoOBNuM9czDCIqcqmuzUam-gx3ljbew";
const IGNORE_SSL = true;

// ============================================
// 🎮 PLATFORM CONFIG - 6LOTTERY တစ်ခုတည်း
// ============================================
const PLATFORM_CONFIG = {
  BASE_URL: "https://6lotteryapi.com/api/webapi/",
  GAME_NAME: "6 LOTTERY",
  LOGIN_PREFIX: "95"
};

// ============================================
// 📊 GAME TYPE CONFIGURATION
// ============================================
const GAME_TYPE_IDS = {
  'TRX': 13,
  'WINGO30S': 30,
  'WINGO1MIN': 1,
  'WINGO3MIN': 2,
  'WINGO5MIN': 3
};

const getGameTypeId = (gameType) => {
  return GAME_TYPE_IDS[gameType] || 30;
};

// ============================================
// ⚙️ SYSTEM SETTINGS
// ============================================
const WIN_LOSE_CHECK_INTERVAL = 2;
const MAX_RESULT_WAIT_TIME = 60;

// ⚡ BALANCE CHECK SETTINGS
const MAX_BALANCE_RETRIES = 10;
const BALANCE_RETRY_DELAY = 5;
const BALANCE_API_TIMEOUT = 20000;
const BET_API_TIMEOUT = 29000;
const MAX_BET_RETRIES = 5;
const BET_RETRY_DELAY = 5;
const MAX_CONSECUTIVE_ERRORS = 10;
const MESSAGE_RATE_LIMIT_SECONDS = 10;
const MAX_TELEGRAM_RETRIES = 3;
const TELEGRAM_RETRY_DELAY = 1000;

// ⚡ FAST MODE SETTINGS
const FAST_MODE = true;
const QUICK_BALANCE_CHECK = true;
const SKIP_TELEGRAM_CONFIRMATION = false;

// ⚡ Game type အလိုက် delay
const GAME_DELAYS = {
  'TRX': 3000,
  'WINGO30S': 2000,
  'WINGO1MIN': 3000,
  'WINGO3MIN': 5000,
  'WINGO5MIN': 7000
};

// ============================================
// 📁 FILE MANAGEMENT
// ============================================
const BANNED_USERS_FILE = 'banned_users.json';
const TIME_START_FILE = 'time_start_settings.json';
const CHANNEL_CONFIG_FILE = 'channel_config.json';

// ============================================
// 📊 USER DATA STRUCTURES
// ============================================
let bannedUsers = new Set();
const userTimeStarts = {};
let requiredChannels = [
  { id: "@lotteryking164", name: "(online money)တစ်ရက်30% ရှာမယ် 😇" },
  { id: "@lotteryking18", name: "ငွေဘယ်လို့ရှာကြမလဲ ️" }
];

const userState = {};
const userTemp = {};
const userSessions = {};
const userSettings = {};
const userPendingBets = {};
const userWaitingForResult = {};
const userStats = {};
const userGameInfo = {};
const userLastResult = {};
const userResultHistory = {};
const userSkippedBets = {};
const userShouldSkipNext = {};
const userBalanceWarnings = {};
const userSkipResultWait = {};
const userSLSkipWaitingForWin = {};
const userStopInitiated = {};
const userCommandLocks = {};
const userProcessedResults = {};
const userSilentMode = {};
const userProfitMessageId = {};
const userLastProfit = {};

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const httpsAgent = new https.Agent({
  rejectUnauthorized: !IGNORE_SSL,
  keepAlive: true,
  maxSockets: 50,
  timeout: 30000
});

const log = (level, message) => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`${timestamp} - ${level} - ${message}`);
};

// ============================================
// 📟 API RULE STRATEGY - တစ်ခုတည်း
// ============================================

// API RULE အတွက် state management
const initAPIRuleState = (userId) => {
  if (!userSettings[userId].api_rule_state) {
    userSettings[userId].api_rule_state = {
      last_skipped_number: null,
      last_skipped_issue: null,
      last_bet_issue: null
    };
  }
};

// API RULE ခန့်မှန်းချက်
const getAPIRulePrediction = async (userId, gameType = "TRX") => {
  try {
    const session = userSessions[userId];
    if (!session) {
      log('ERROR', `📟 API RULE: ❌ Session မရှိပါ user ${userId}`);
      return { result: null, skip: true, reason: "No session" };
    }

    initAPIRuleState(userId);
    const state = userSettings[userId].api_rule_state;

    const history = await getGameHistory(session, gameType, userId);
    
    if (!history || history.length === 0) {
      log('INFO', `📟 API RULE: ⏭️ ${gameType} - သမိုင်းအချက်အလက်မရှိ, SKIP`);
      
      if (userSettings[userId]?.running) {
        const skipMessage = `📟 API RULE: ⏭️ ${gameType} - သမိုင်းအချက်အလက်မရှိ, ကျော်လိုက်သည်...`;
        sendMessageWithRetry(userId, skipMessage).catch(e => {});
      }
      
      return { result: null, skip: true, reason: "No history" };
    }

    // User ရဲ့ API Rule Map ကိုယူ (ဥပမာ { 0: 'B', 1: 'S', 2: 'B', 5: 'S' })
    const ruleMap = userSettings[userId]?.api_rule_map || {};

    // Rule မရှိဘူးဆိုရင် Skip
    if (Object.keys(ruleMap).length === 0) {
      log('INFO', `📟 API RULE: ⏭️ Rule မရှိပါ user ${userId}, skipping`);
      
      if (userSettings[userId]?.running) {
        const skipMessage = `📟 API RULE: ⏭️ ${gameType} - Rule မရှိပါ, ကျော်လိုက်သည်...`;
        sendMessageWithRetry(userId, skipMessage).catch(e => {});
      }
      
      return { result: null, skip: true, reason: "No rules defined" };
    }

    // နောက်ဆုံးကျတဲ့ ပွဲရဲ့ အချက်အလက်တွေကိုယူ
    const lastResult = history[0];
    if (!lastResult || !lastResult.number) {
      log('INFO', `📟 API RULE: ⏭️ ${gameType} - မှားယွင်းသောရလဒ်, SKIP`);
      
      if (userSettings[userId]?.running) {
        const skipMessage = `📟 API RULE: ⏭️ ${gameType} - မှားယွင်းသောရလဒ်, ကျော်လိုက်သည်...`;
        sendMessageWithRetry(userId, skipMessage).catch(e => {});
      }
      
      return { result: null, skip: true, reason: "Invalid result" };
    }

    const lastNumber = parseInt(lastResult.number.toString(), 10) % 10;
    const lastIssue = lastResult.issueNumber || "N/A";
    const lastBigSmall = lastNumber >= 5 ? "BIG (B)" : "SMALL (S)";

    // ============================================
    // 🎯 SKIP Logic
    // ============================================
    
    // ဒီပွဲစဉ်ကို အရင် SKIP လုပ်ပြီးသားလားစစ်
    if (state.last_skipped_issue === lastIssue) {
      log('INFO', `📟 API RULE: ⏭️ ${gameType} - ပွဲစဉ် ${lastIssue} ကို အရင် skip လုပ်ပြီးသား`);
      return { 
        result: null, 
        skip: true, 
        reason: "Already skipped this issue",
        lastNumber: lastNumber,
        lastIssue: lastIssue
      };
    }

    // ဒီပွဲစဉ်ကို အရင် BET လုပ်ပြီးသားလားစစ်
    if (state.last_bet_issue === lastIssue) {
      log('INFO', `📟 API RULE: ⏭️ ${gameType} - ပွဲစဉ် ${lastIssue} ကို အရင် bet လုပ်ပြီးသား`);
      return { 
        result: null, 
        skip: true, 
        reason: "Already bet this issue",
        lastNumber: lastNumber,
        lastIssue: lastIssue
      };
    }

    // ဂဏန်းက Rule ထဲမှာပါလားစစ်
    if (ruleMap[lastNumber] !== undefined) {
      // Rule ထဲမှာပါတဲ့ ဂဏန်း → BET
      const prediction = ruleMap[lastNumber];
      const resultText = prediction === 'B' ? 'BIG' : 'SMALL';

      log('INFO', `📟 API RULE: ✅ ${gameType} - ပွဲစဉ်:${lastIssue}, နောက်ဆုံး:${lastNumber} (${lastBigSmall}) → နောက်ပွဲ:${prediction} (${resultText}) [BETTING]`);

      // BET လုပ်တဲ့အခါ state တွေကို update
      state.last_skipped_number = null;
      state.last_skipped_issue = null;
      state.last_bet_issue = lastIssue;

      if (userSettings[userId]?.running) {
        const ruleList = Object.entries(ruleMap)
          .map(([num, bs]) => `${num}=${bs}`)
          .join(', ');
        
        const betMessage = `📟 API RULE: 🎯 ${gameType}\n➡️ နောက်ပွဲ: ${resultText}\n📋 လက်ရှိ Rules: ${ruleList}`;
        sendMessageWithRetry(userId, betMessage).catch(e => {});
      }

      return {
        result: prediction,
        skip: false,
        lastNumber: lastNumber,
        lastIssue: lastIssue,
        ruleMap: ruleMap
      };
    }

    // ============================================
    // ဂဏန်းက Rule ထဲမှာမပါဘူး → SKIP
    // ============================================
    
    log('INFO', `📟 API RULE: ${gameType} - နောက်ဆုံး:${lastNumber} Rule ထဲမှာမပါ`);

    // ဒီ ဂဏန်းကို အရင် SKIP လုပ်ပြီးသားလားစစ်
    if (state.last_skipped_number === lastNumber) {
      // ဒီဂဏန်းကို အရင် SKIP လုပ်ပြီးသား → DEFAULT 'B' ထိုးမယ်
      log('INFO', `📟 API RULE: ဂဏန်း ${lastNumber} ကို အရင် skip လုပ်ပြီးသား, ဒီတစ်ခါ B ထိုးမယ်`);
      
      if (userSettings[userId]?.running) {
        const ruleList = Object.entries(ruleMap)
          .map(([num, bs]) => `${num}=${bs}`)
          .join(', ');
        
        const betMessage = `📟 API RULE: 🎯 ${gameType}\n➡️ နောက်ပွဲ: BIG [DEFAULT - ဒီဂဏန်းကို skip လုပ်ပြီးသား]\n📋 လက်ရှိ Rules: ${ruleList}`;
        sendMessageWithRetry(userId, betMessage).catch(e => {});
      }
      
      state.last_bet_issue = lastIssue;
      
      return {
        result: 'B',
        skip: false,
        lastNumber: lastNumber,
        lastIssue: lastIssue,
        ruleMap: ruleMap,
        default: true
      };
    } else {
      // ဒီဂဏန်းကို ပထမဆုံးတွေ့တာ → SKIP လုပ်မယ်
      log('INFO', `📟 API RULE: ⏭️ ${gameType} - ဂဏန်း ${lastNumber} ကို ပထမဆုံးတွေ့, SKIPPING`);

      state.last_skipped_number = lastNumber;
      state.last_skipped_issue = lastIssue;

      if (userSettings[userId]?.running) {
        const ruleList = Object.entries(ruleMap)
          .map(([num, bs]) => `${num}=${bs}`)
          .join(', ');
        
        const skipMessage = `📟 API RULE: ⏭️ ${gameType}\n❌ ဂဏန်း ${lastNumber} Rule ထဲမှာမပါ (ပထမဆုံး)\n📋 လက်ရှိ Rules: ${ruleList}\nဒီပွဲကို ကျော်လိုက်သည်...`;
        sendMessageWithRetry(userId, skipMessage).catch(e => {});
      }

      return {
        result: null,
        skip: true,
        reason: "Not in rule map - first skip",
        lastNumber: lastNumber,
        lastIssue: lastIssue,
        ruleMap: ruleMap
      };
    }

  } catch (error) {
    log('ERROR', `📟 API RULE ERROR: ${error.message}`);

    if (userSettings[userId]?.running) {
      const errorMessage = `📟 API RULE: ❌ ${gameType} - အမှားရှိ, ကျော်လိုက်သည်...`;
      sendMessageWithRetry(userId, errorMessage).catch(e => {});
    }

    return { result: null, skip: true, reason: "Error" };
  }
};

// ============================================
// 📁 FILE FUNCTIONS
// ============================================

// Load banned users
const loadBannedUsers = async () => {
  try {
    const data = await fs.readFile(BANNED_USERS_FILE, 'utf8');
    const parsed = JSON.parse(data);
    bannedUsers = new Set(parsed.banned_ids || []);
    log('INFO', `📂 Banned user ${bannedUsers.size} ယူပြီး`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      log('WARNING', `${BANNED_USERS_FILE} မရှိပါ။ အသစ်စတယ်`);
      bannedUsers = new Set();
      await saveBannedUsers();
    } else {
      log('ERROR', `🧨 ERROR loading ${BANNED_USERS_FILE}: ${error.message}`);
      bannedUsers = new Set();
    }
  }
};

// Save banned users
const saveBannedUsers = async () => {
  try {
    await fs.writeFile(
      BANNED_USERS_FILE,
      JSON.stringify({ banned_ids: Array.from(bannedUsers) }, null, 2)
    );
    log('INFO', `💾 Banned user ${bannedUsers.size} သိမ်းပြီး`);
  } catch (error) {
    log('ERROR', `🧨 ERROR saving banned users: ${error.message}`);
  }
};

// Load time start settings
const loadTimeStartSettings = async () => {
  try {
    const data = await fs.readFile(TIME_START_FILE, 'utf8');
    const parsed = JSON.parse(data);
    for (const [userId, starts] of Object.entries(parsed)) {
      userTimeStarts[userId] = starts;
    }
    log('INFO', `📂 Time start settings ${Object.keys(userTimeStarts).length} ယူပြီး`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      log('WARNING', `${TIME_START_FILE} မရှိပါ။ အသစ်စတယ်`);
      await saveTimeStartSettings();
    } else {
      log('ERROR', `🧨 ERROR loading time start settings: ${error.message}`);
    }
  }
};

// Save time start settings
const saveTimeStartSettings = async () => {
  try {
    await fs.writeFile(
      TIME_START_FILE,
      JSON.stringify(userTimeStarts, null, 2)
    );
    log('INFO', `💾 Time start settings ${Object.keys(userTimeStarts).length} သိမ်းပြီး`);
  } catch (error) {
    log('ERROR', `🧨 ERROR saving time start settings: ${error.message}`);
  }
};

// Load channel config
const loadChannelConfig = async () => {
  try {
    const data = await fs.readFile(CHANNEL_CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(data);
    requiredChannels = parsed.channels || requiredChannels;
    log('INFO', `📢 Channel config ${requiredChannels.length} ယူပြီး`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      log('WARNING', `${CHANNEL_CONFIG_FILE} မရှိပါ။ Default သုံးမယ်`);
      await saveChannelConfig();
    } else {
      log('ERROR', `🧨 ERROR loading channel config: ${error.message}`);
    }
  }
};

// Save channel config
const saveChannelConfig = async () => {
  try {
    await fs.writeFile(
      CHANNEL_CONFIG_FILE,
      JSON.stringify({ channels: requiredChannels }, null, 2)
    );
    log('INFO', `💾 Channel config ${requiredChannels.length} သိမ်းပြီး`);
  } catch (error) {
    log('ERROR', `🧨 ERROR saving channel config: ${error.message}`);
  }
};

// ============================================
// 🚫 BAN FUNCTIONS
// ============================================

// Ban user
const banUser = async (userId, username = '') => {
  bannedUsers.add(userId);
  await saveBannedUsers();
  
  if (userSettings[userId] && userSettings[userId].running) {
    userSettings[userId].running = false;
    if (userSettings[userId] && userSettings[userId].task) {
      if (userSettings[userId].task && typeof userSettings[userId].task === 'object' && userSettings[userId].task.cancel && typeof userSettings[userId].task.cancel === 'function') {
        userSettings[userId].task.cancel();
      }
      userSettings[userId].task = null;
    }
  }
  
  log('INFO', `🚫 User ${userId} (${username}) ကို ban လိုက်သည်`);
};

// Unban user
const unbanUser = async (userId) => {
  bannedUsers.delete(userId);
  await saveBannedUsers();
  log('INFO', `🎄 User ${userId} ကို unban လိုက်သည်`);
};

// Check if user is banned
const isUserBanned = (userId) => {
  return bannedUsers.has(userId);
};

// ============================================
// ⏰ TIME START FUNCTIONS
// ============================================

const parseTime = (timeStr) => {
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
  if (!match) return null;
  
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2]);
  const period = match[3] ? match[3].toLowerCase() : '';
  
  if (period === 'pm' && hours < 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;
  
  return { hours, minutes };
};

const formatTime = (hours, minutes) => {
  const period = hours >= 12 ? 'p.m.' : 'a.m.';
  const displayHours = hours % 12 || 12;
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
};

const isWithinTimeStart = (userId) => {
  const timeStarts = userTimeStarts[userId] ? userTimeStarts[userId] : [];
  if (timeStarts.length === 0) return true;
  
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentTime = currentHour * 60 + currentMinute;
  
  for (const startTime of timeStarts) {
    const parsed = parseTime(startTime);
    if (!parsed) continue;
    
    const startMinutes = parsed.hours * 60 + parsed.minutes;
    const endMinutes = startMinutes + 60;
    
    if (currentTime >= startMinutes && currentTime <= endMinutes) {
      return true;
    }
    
    if (endMinutes > 1440) {
      if (currentTime >= startMinutes || currentTime <= (endMinutes % 1440)) {
        return true;
      }
    }
  }
  
  return false;
};

const addTimeStart = (userId, startTime) => {
  if (!userTimeStarts[userId]) {
    userTimeStarts[userId] = [];
  }
  
  const parsed = parseTime(startTime);
  
  if (!parsed) {
    return { success: false, message: 'အချိန်ပုံစံမှားနေပါသည်။ Format: 9:00am or 14:30' };
  }
  
  if (userTimeStarts[userId].includes(startTime)) {
    return { success: false, message: 'ဒီအချိန်က ရှိပြီးသားပါ' };
  }
  
  userTimeStarts[userId].push(startTime);
  
  userTimeStarts[userId].sort((a, b) => {
    const timeA = parseTime(a);
    const timeB = parseTime(b);
    return (timeA.hours * 60 + timeA.minutes) - (timeB.hours * 60 + timeB.minutes);
  });
  
  saveTimeStartSettings();
  
  return { 
    success: true, 
    message: `⏰ Time Start ထည့်ပြီးပါပြီ: ${formatTime(parsed.hours, parsed.minutes)}\n\n🎯 Bot က ဒီအချိန်ကနေ ၁ နာရီအထိ အလုပ်လုပ်ပါမယ်` 
  };
};

const getTimeStartDisplay = (userId) => {
  const starts = userTimeStarts[userId] || [];
  if (starts.length === 0) {
    return '🕒 Time Start မရှိသေးပါ။ Bot က 24/7 အလုပ်လုပ်ပါမယ်။';
  }
  
  let display = '⏰ Time Starts:\n\n';
  starts.forEach((start, index) => {
    const parsed = parseTime(start);
    if (parsed) {
      display += `${index + 1}. ${formatTime(parsed.hours, parsed.minutes)}\n`;
      display += `   🎯 အလုပ်လုပ်မည့်အချိန်: ${formatTime(parsed.hours, parsed.minutes)} - ${formatTime((parsed.hours + 1) % 24, parsed.minutes)}\n\n`;
    }
  });
  
  display += `📊 စုစုပေါင်း: ${starts.length} ချိန်`;
  return display;
};

const clearTimeStarts = (userId) => {
  if (userTimeStarts[userId]) {
    delete userTimeStarts[userId];
    saveTimeStartSettings();
    return { success: true, message: '🎄 Time Start အားလုံးရှင်းလင်းပြီးပါပြီ။' };
  }
  return { success: false, message: '⚠️ ရှင်းလင်းရန် Time Start မရှိပါ။' };
};

// ============================================
// 🔐 LOGIN FUNCTION - 6LOTTERY တစ်ခုတည်း
// ============================================

const generateSignature = (data) => {
  const f = {};
  const exclude = ["signature", "timestamp"];
  
  Object.keys(data).sort().forEach(function(k) {
    const v = data[k];
    if (v !== null && v !== '' && !exclude.includes(k)) {
      f[k] = v;
    }
  });
  
  const jstr = JSON.stringify(f);
  return crypto.createHash('md5').update(jstr).digest('hex').toUpperCase();
};

const loginRequest = async (phone, password) => {
  console.log(`[LOGIN] 6LOTTERY အကောင့်ဝင်ရန်: ${phone}`);
  
  const session = axios.create({
    httpsAgent,
    timeout: 30000,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "Accept": "application/json, text/plain, */*",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0",
      "Ar-Origin": "https://6win598.com",
      "Origin": "https://6win598.com",
      "Referer": "https://6win598.com/",
      "Accept-Language": "en-US,en;q=0.5"
    }
  });
  
  const loginData = {
    username: PLATFORM_CONFIG.LOGIN_PREFIX + phone,
    pwd: password,
    phonetype: 1,
    logintype: "mobile",
    packId: "",
    deviceId: crypto.randomBytes(16).toString('hex'),
    language: 7,
    random: crypto.randomBytes(16).toString('hex')
  };
  
  const signature = generateSignature(loginData);
  loginData.signature = signature;
  loginData.timestamp = Math.floor(Date.now() / 1000);
  
  console.log(`[6LOTTERY] Login Data:`, JSON.stringify(loginData));
  
  try {
    const response = await session.post(PLATFORM_CONFIG.BASE_URL + "Login", loginData);
    
    if (response.data && response.data.code === 0 && response.data.data) {
      const tokenHeader = response.data.data.tokenHeader || "Bearer ";
      const token = response.data.data.token || "";
      session.defaults.headers.common.Authorization = `${tokenHeader}${token}`;
      console.log(`[6LOTTERY] အကောင့်ဝင်ပြီး SUCCESS!`);
      return [response.data, session];
    } else {
      console.log(`[6LOTTERY] အကောင့်ဝင်မရ FAILED:`, response.data);
      return [response.data, null];
    }
  } catch (error) {
    console.log(`[6LOTTERY] Login ERROR:`, error.message);
    return [{ code: -1, msg: error.message }, null];
  }
};

// ============================================
// 💰 BALANCE CHECK FUNCTIONS
// ============================================

const getBalance = async (session, userId) => {
  const body = {
    language: 7,
    random: crypto.randomBytes(16).toString('hex')
  };
  
  body.signature = generateSignature(body);
  body.timestamp = Math.floor(Date.now() / 1000);
  
  const axiosInstance = axios.create({
    httpsAgent: httpsAgent,
    timeout: BALANCE_API_TIMEOUT,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Ar-Origin": "https://www.6win577.com",
      ...(session.defaults.headers.common.Authorization ? 
        { Authorization: session.defaults.headers.common.Authorization } : {})
    }
  });
  
  try {
    const response = await axiosInstance.post(PLATFORM_CONFIG.BASE_URL + "GetBalance", body);
    const res = response.data;
    
    if (res.code === 0 && res.data) {
      const amount = res.data.balance || res.data.amount || 0;
      const balanceAmount = parseFloat(amount);
      
      if (userGameInfo[userId]) {
        userGameInfo[userId].balance = balanceAmount;
      }
      
      if (!userStats[userId]) {
        userStats[userId] = { start_balance: balanceAmount, profit: 0.0 };
      }
      
      log('INFO', `💰 Balance for ${userId}: ${balanceAmount.toFixed(2)} Ks`);
      return balanceAmount;
    }
    
    log('ERROR', `❌ Get balance failed for user ${userId}: ${res.msg || 'Unknown error'}, code: ${res.code}`);
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      log('ERROR', `⌛ Balance check timeout for user ${userId}`);
    } else if (error.response) {
      log('ERROR', `❌ Balance API error ${error.response.status} for user ${userId}: ${error.message}`);
    } else if (error.request) {
      log('ERROR', `❌ No response for balance check (${userId}): ${error.message}`);
    } else {
      log('ERROR', `❌ Balance check error for user ${userId}: ${error.message}`);
    }
  }
  
  return null;
};

const getBalanceWithRetry = async (session, userId, retryCount = 0) => {
  for (let attempt = 0; attempt < MAX_BALANCE_RETRIES; attempt++) {
    try {
      const balance = await getBalance(session, userId);
      
      if (balance !== null) {
        return balance;
      }
      
      log('WARNING', `⚠️ Balance check attempt ${attempt + 1}/${MAX_BALANCE_RETRIES} failed for user ${userId}`);
      
    } catch (error) {
      log('ERROR', `❌ Balance check attempt ${attempt + 1}/${MAX_BALANCE_RETRIES} error: ${error.message}`);
    }
    
    if (attempt === MAX_BALANCE_RETRIES - 1) {
      break;
    }
    
    const delayMs = BALANCE_RETRY_DELAY * 1000 * (attempt + 1);
    log('INFO', `⏳ ${delayMs/1000}စက္ကန့်စောင့်ပြီး ထပ်ကြိုးစားမယ်...`);
    await setTimeout(delayMs);
  }
  
  log('ERROR', `❌ Balance check အကုန်မအောင်မြင်ပါ user ${userId}`);
  return null;
};

// ============================================
// ℹ️ USER INFO FUNCTION
// ============================================

const getUserInfo = async (session, userId) => {
  const body = {
    language: 7,
    random: crypto.randomBytes(16).toString('hex')
  };
  
  body.signature = generateSignature(body);
  body.timestamp = Math.floor(Date.now() / 1000);
  
  try {
    const response = await session.post(PLATFORM_CONFIG.BASE_URL + "GetUserInfo", body, { timeout: 15000 });
    const res = response.data;
    
    if (res.code === 0 && res.data) {
      const info = {
        user_id: res.data.userId,
        username: res.data.userName,
        nickname: res.data.nickName,
        balance: res.data.amount,
        photo: res.data.userPhoto,
        login_date: res.data.userLoginDate,
        withdraw_count: res.data.withdrawCount,
        is_allow_withdraw: res.data.isAllowWithdraw === 1
      };
      
      userGameInfo[userId] = info;
      return info;
    }
  } catch (error) {
    log('ERROR', `❌ Get user info error: ${error.message}`);
  }
  
  return null;
};

// ============================================
// 🎮 GAME API FUNCTIONS
// ============================================

const getGameIssueRequest = async (session, gameType = "TRX") => {
  const typeId = getGameTypeId(gameType);

  let endpoint = gameType === "TRX" ? "GetTrxGameIssue" : "GetGameIssue";

  const body = {
    typeID: typeId,
    language: 7,
    random: crypto.randomBytes(16).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000)
  };

  body.signature = generateSignature(body);

  try {
    const response = await session.post(PLATFORM_CONFIG.BASE_URL + endpoint, body, { timeout: 15000 });
    
    if (response.data && response.data.code === 0) {
      let issueNumber = 'N/A';
      if (response.data.data) {
        if (gameType === "TRX") {
          issueNumber = response.data.data.predraw?.issueNumber || 'N/A';
        } else {
          issueNumber = response.data.data.issueNumber || 'N/A';
        }
      }
      log('INFO', `✅ ${gameType} issue: ${issueNumber}`);
      return response.data;
    } else {
      const errorMsg = response.data && response.data.msg ? response.data.msg : 'Unknown error';
      log('ERROR', `❌ ${gameType} issue failed: ${errorMsg}`);
      return { code: -1, error: errorMsg };
    }
  } catch (error) {
    log('ERROR', `❌ ${gameType} game issue error: ${error.message}`);
    return { code: -1, error: error.message };
  }
};

const getWingoGameResults = async (session, gameType = "WINGO30S") => {
  const typeId = getGameTypeId(gameType);
  
  const body = {
    "pageSize": 20,
    "typeId": typeId,
    "language": 7,
    "random": crypto.randomBytes(16).toString('hex'),
    "timestamp": Math.floor(Date.now() / 1000)
  };
  
  body.signature = generateSignature(body);
  
  try {
    log('INFO', `📊 ${gameType} ရလဒ်တွေယူနေတယ်...`);
    
    const response = await session.post(PLATFORM_CONFIG.BASE_URL + "GetNoaverageEmerdList", body, { 
      timeout: 15000,
      validateStatus: function (status) {
        return status >= 200 && status < 500;
      }
    });
    
    if (response.status !== 200) {
      log('WARNING', `⚠️ ${gameType} results - HTTP ${response.status}`);
      return { code: -1, error: `HTTP ${response.status}` };
    }
    
    if (response.data) {
      if (response.data.code === 0) {
        if (response.data.data && response.data.data.list) {
          log('INFO', `✅ ${gameType} ရလဒ် ${response.data.data.list.length} ခုရပြီ`);
          return response.data;
        } else {
          log('WARNING', `⚠️ ${gameType} results - List မရှိပါ`);
          return { code: -1, error: 'No list data' };
        }
      } else {
        log('WARNING', `⚠️ ${gameType} results error: ${response.data?.msg || 'Unknown'}, code: ${response.data?.code}`);
        return { code: response.data.code, error: response.data?.msg || 'Unknown error' };
      }
    } else {
      log('WARNING', `⚠️ ${gameType} results - Response data မရှိပါ`);
      return { code: -1, error: 'No response data' };
    }
  } catch (error) {
    log('ERROR', `🧨 ERROR getting ${gameType} results: ${error.message}`);
    if (error.response) {
      log('ERROR', `Response status: ${error.response.status}`);
    }
    return { error: error.message, code: -1 };
  }
};

const placeBetRequest = async (session, issueNumber, selectType, unitAmount, betCount, gameType, userId) => {
  const typeId = getGameTypeId(gameType);
  
  let endpoint = gameType === "TRX" ? "GameTrxBetting" : "GameBetting";
  
  const betBody = {
    typeId: typeId,
    issuenumber: issueNumber,
    language: 7,
    gameType: 2,
    amount: unitAmount,
    betCount: betCount,
    selectType: selectType,
    random: crypto.randomBytes(16).toString('hex'),
    timestamp: Math.floor(Date.now() / 1000)
  };
  
  betBody.signature = generateSignature(betBody);
  
  for (let attempt = 0; attempt < MAX_BET_RETRIES; attempt++) {
    try {
      const response = await session.post(PLATFORM_CONFIG.BASE_URL + endpoint, betBody, { timeout: BET_API_TIMEOUT });
      const res = response.data;
      log('INFO', `🎯 Bet request for user ${userId}, ${gameType}, issue ${issueNumber}, select_type ${selectType}, amount ${unitAmount * betCount}`);
      return res;
    } catch (error) {
      log('ERROR', `❌ Bet error for user ${userId}, attempt ${attempt + 1}: ${error.message}`);
      
      if (attempt < MAX_BET_RETRIES - 1) {
        await setTimeout(BET_RETRY_DELAY * 1000);
        continue;
      }
      return { error: error.message, code: -1 };
    }
  }
  return { error: "Failed after retries", code: -1 };
};

const getGameHistory = async (session, gameType = "WINGO30S", userId = null) => {
  try {
    if (gameType === "TRX") {
      const body = {
        pageSize: 20,
        typeId: 13,
        language: 7,
        random: crypto.randomBytes(16).toString('hex'),
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      body.signature = generateSignature(body);
      
      log('INFO', `📊 TRX history ယူနေတယ်...`);
      
      const endpoint = "GetTRXNoaverageEmerdList";
      const response = await session.post(PLATFORM_CONFIG.BASE_URL + endpoint, body, { timeout: 15000 });
      
      if (response.data && response.data.code === 0 && response.data.data && response.data.data.list) {
        const historyList = response.data.data.list;
        log('INFO', `✅ TRX history ${historyList.length} ခုရပြီ`);
        return historyList;
      } else {
        log('WARNING', `⚠️ TRX history error: ${response.data?.msg || 'Unknown'}`);
        return [];
      }
    } else {
      const typeId = getGameTypeId(gameType);
      
      const body = {
        pageSize: 20,
        typeId: typeId,
        language: 7,
        random: crypto.randomBytes(16).toString('hex'),
        timestamp: Math.floor(Date.now() / 1000)
      };
      
      body.signature = generateSignature(body);
      
      log('INFO', `📊 ${gameType} history ယူနေတယ်...`);
      
      const endpoint = "GetNoaverageEmerdList";
      const response = await session.post(PLATFORM_CONFIG.BASE_URL + endpoint, body, { timeout: 15000 });
      
      if (response.data) {
        if (response.data.code === 0) {
          if (response.data.data && response.data.data.list) {
            const historyList = response.data.data.list;
            log('INFO', `✅ ${gameType} history ${historyList.length} ခုရပြီ`);
            return historyList;
          } else {
            log('WARNING', `⚠️ ${gameType} history - List မရှိပါ`);
            return [];
          }
        } else {
          log('WARNING', `⚠️ ${gameType} history error: ${response.data?.msg || 'Unknown'}, code: ${response.data?.code}`);
          return [];
        }
      } else {
        log('WARNING', `⚠️ ${gameType} history - Response data မရှိပါ`);
        return [];
      }
    }
  } catch (error) {
    log('ERROR', `🧨 ERROR fetching game history: ${error.message}`);
    return [];
  }
};

// ============================================
// 🎯 WIN/LOSE CHECKER
// ============================================

const winLoseChecker = async () => {
  log('INFO', "🎮 Win/lose checker စတင်ပြီ (FAST MODE)");
  
  while (true) {
    try {
      const checkPromises = Object.entries(userSessions).map(async ([userId, session]) => {
        if (!session) return;
        if (isUserBanned(userId)) return;
        
        const settings = userSettings[userId] ? userSettings[userId] : {};
        const gameType = settings.game_type || "TRX";
        
        if (!userPendingBets[userId] && !userSkippedBets[userId]) return;
        
        try {
          let data = [];

          if (gameType.includes("WINGO")) {
            const wingoRes = await getWingoGameResults(session, gameType);
            
            if (!wingoRes || wingoRes.code !== 0) {
              if (userPendingBets[userId]) {
                for (const period of Object.keys(userPendingBets[userId])) {
                  const betTime = settings?.bet_time?.[period] || 0;
                  const timeoutSeconds = gameType === "WINGO30S" ? 35 : 
                                        gameType === "WINGO1MIN" ? 65 : 
                                        gameType === "WINGO3MIN" ? 185 : 305;
                  
                  if (betTime > 0 && Date.now() / 1000 - betTime > timeoutSeconds) {
                    log('WARNING', `⚠️ Timeout for ${period}, pending bet ကိုဖျက်မယ်`);
                    delete userPendingBets[userId][period];
                    if (Object.keys(userPendingBets[userId]).length === 0) {
                      delete userPendingBets[userId];
                    }
                    userWaitingForResult[userId] = false;
                  }
                }
              }
              return;
            }
            
            if (wingoRes.data && wingoRes.data.list) {
              data = wingoRes.data.list;
              log('INFO', `📊 ${data.length} ${gameType} ရလဒ်ရပြီ user ${userId}`);
            }
          } else {
            let issueRes = await getGameIssueRequest(session, gameType);
            
            if (!issueRes || issueRes.code !== 0) {
              return;
            }
            
            data = issueRes.data?.settled ? [issueRes.data.settled] : [];
          }
          
          if (userPendingBets[userId] && data.length > 0) {
            log('INFO', `🔍 Pending bets ${Object.keys(userPendingBets[userId]).length} ခုစစ်နေတယ် user ${userId}`);
            
            for (const period of Object.keys(userPendingBets[userId])) {
              const settled = data.find(item => {
                const itemIssue = item.issueNumber || item.issueNumber || '';
                return itemIssue.toString() === period.toString();
              });
              
              if (settled && settled.number) {
                const [betType, amount] = userPendingBets[userId][period] || [];
                const number = parseInt(settled.number.toString().slice(-1), 10);
                const bigSmall = number >= 5 ? "BIG" : "SMALL";
                const isWin = (betType === "B" && bigSmall === "BIG") || (betType === "S" && bigSmall === "SMALL");
                
                log('INFO', `✅ ${period} ရလဒ်ရပြီ: ${bigSmall} (${number}), isWin: ${isWin}`);
                
                let resultMessage;
                if (isWin) {
                  resultMessage = `🟢 WIN +${amount.toFixed(2)} KS\n📌 Period: ${period}\n📌 Result: ${bigSmall} (${number})`;
                } else {
                  resultMessage = `🔴 LOSE -${amount.toFixed(2)} KS\n📌 Period: ${period}\n📌 Result: ${bigSmall} (${number})`;
                }
                
                try {
                  await bot.sendMessage(userId, resultMessage);
                  log('INFO', `📨 Result ပို့ပြီ user ${userId}: ${resultMessage}`);
                } catch (error) {
                  log('ERROR', `❌ Failed to send result: ${error.message}`);
                }
                
                if (userStats[userId] && !settings.skip_betting) {
                  if (isWin) {
                    const profitChange = amount * 0.96;
                    userStats[userId].profit += profitChange;
                  } else {
                    const profitChange = -amount;
                    userStats[userId].profit += profitChange;
                  }
                }
                
                if (!settings.skip_betting) {
                  const bettingStrategy = settings.betting_strategy || "MARTINGALE";
                  
                  if (isWin) {
                    settings.consecutive_losses = 0;
                    settings.current_layer = 0;
                    
                    if (bettingStrategy === "ANTI-MARTINGALE") {
                      settings.martin_index = Math.min(
                        (settings.bet_sizes?.length || 1) - 1,
                        (settings.martin_index || 0) + 1
                      );
                    } else if (bettingStrategy === "MARTINGALE") {
                      settings.martin_index = 0;
                    } else if (bettingStrategy === "D'ALEMBERT") {
                      settings.dalembert_units = Math.max(1, (settings.dalembert_units || 1) - 1);
                    }
                  } else {
                    settings.consecutive_losses = (settings.consecutive_losses || 0) + 1;
                    settings.current_layer = (settings.current_layer || 0) + 1;
                    
                    if (bettingStrategy === "ANTI-MARTINGALE") {
                      settings.martin_index = 0;
                    } else if (bettingStrategy === "MARTINGALE") {
                      settings.martin_index = Math.min(
                        (settings.bet_sizes?.length || 1) - 1,
                        (settings.martin_index || 0) + 1
                      );
                    } else if (bettingStrategy === "D'ALEMBERT") {
                      settings.dalembert_units = (settings.dalembert_units || 1) + 1;
                    }
                    
                    const slLimit = settings.sl_limit;
                    if (slLimit && settings.consecutive_losses >= slLimit) {
                      settings.skip_betting = true;
                      log('INFO', `⛔ SL triggered for user ${userId}: ${settings.consecutive_losses} consecutive losses`);
                    }
                  }
                }
                
                delete userPendingBets[userId][period];
                
                if (Object.keys(userPendingBets[userId]).length === 0) {
                  delete userPendingBets[userId];
                }
                
                userWaitingForResult[userId] = false;
                
                if (userStats[userId]) {
                  const targetProfit = settings.target_profit;
                  const stopLoss = settings.stop_loss;
                  const currentProfit = userStats[userId].profit;
                  
                  if (targetProfit && currentProfit >= targetProfit) {
                    await sendMessageWithRetry(userId, 
                      `🎯 PROFIT TARGET ရောက်ပြီ!\n\n` +
                      `🎯 Target: ${targetProfit.toFixed(2)} Ks\n` +
                      `💰 Profit: ${currentProfit.toFixed(2)} Ks\n\n` +
                      `⚡ Bot ရပ်လိုက်သည်။`
                    );
                    settings.running = false;
                  } else if (stopLoss && currentProfit <= -stopLoss) {
                    await sendMessageWithRetry(userId, 
                      `🛑 STOP LOSS ရောက်ပြီ!\n\n` +
                      `🛑 Stop Loss: ${stopLoss.toFixed(2)} Ks\n` +
                      `📉 Loss: ${currentProfit.toFixed(2)} Ks\n\n` +
                      `⚡ Bot ရပ်လိုက်သည်။`
                    );
                    settings.running = false;
                  }
                }
                
                log('INFO', `🎄 Result processed for user ${userId}: ${isWin ? 'WIN' : 'LOSE'}`);
              } else {
                const betTime = settings?.bet_time?.[period] || 0;
                const timeoutSeconds = gameType === "WINGO30S" ? 35 : 
                                      gameType === "WINGO1MIN" ? 65 : 
                                      gameType === "WINGO3MIN" ? 185 : 
                                      gameType === "WINGO5MIN" ? 305 : 60;
                
                if (betTime > 0 && Date.now() / 1000 - betTime > timeoutSeconds) {
                  log('WARNING', `⚠️ Timeout waiting for result for user ${userId}, period ${period}`);
                  
                  delete userPendingBets[userId][period];
                  
                  if (Object.keys(userPendingBets[userId]).length === 0) {
                    delete userPendingBets[userId];
                  }
                  
                  userWaitingForResult[userId] = false;
                }
              }
            }
          }
          
        } catch (error) {
          log('ERROR', `❌ Error in win/lose check for user ${userId}: ${error.message}`);
        }
      });
      
      await Promise.allSettled(checkPromises);
      await setTimeout(1000);
      
    } catch (error) {
      log('ERROR', `❌ Win/lose checker error: ${error.message}`);
      await setTimeout(5000);
    }
  }
};

// ============================================
// 🏃 BETTING WORKER
// ============================================

const bettingWorker = async (userId, chatId) => {
  const settings = userSettings[userId] ? userSettings[userId] : {};
  const session = userSessions[userId];
  const gameType = settings.game_type ? settings.game_type : "TRX";
  
  if (!settings || Object.keys(settings).length === 0) {
    log('ERROR', `❌ Betting worker failed for user ${userId}: Settings မရှိပါ`);
    await sendMessageWithRetry(chatId, "❌ ကျေးဇူးပြု၍ အရင် login ဝင်ပါ");
    
    if (settings) {
      settings.running = false;
    }
    
    return;
  }
  
  if (!session) {
    log('ERROR', `❌ Betting worker failed for user ${userId}: Session မရှိပါ`);
    await sendMessageWithRetry(chatId, "❌ ကျေးဇူးပြု၍ အရင် login ဝင်ပါ");
    
    if (settings) {
      settings.running = false;
    }
    
    return;
  }
  
  userStats[userId] = {
    start_balance: (userStats[userId] && userStats[userId].start_balance) ? userStats[userId].start_balance : 0.0,
    profit: 0.0
  };
  
  settings.running = true;
  settings.bet_time = {};
  settings.last_issue = null;
  settings.consecutive_errors = 0;
  settings.consecutive_losses = 0;
  settings.current_layer = 0;
  settings.skip_betting = false;
  userWaitingForResult[userId] = false;

  let currentBalance = null;

  let balanceRetrieved = false;
  let balanceAttempts = 0;
  
  while (!balanceRetrieved && settings.running) {
    balanceAttempts++;
    
    try {
      log('INFO', `🔄 Balance check attempt #${balanceAttempts} for user ${userId}`);
      const balanceResult = await getBalance(session, userId);
      
      if (balanceResult !== null) {
        currentBalance = balanceResult;
        balanceRetrieved = true;
        log('INFO', `✅ Balance retrieved on attempt #${balanceAttempts}: ${currentBalance} Ks`);
        break;
      }
    } catch (error) {
      log('ERROR', `❌ Balance check attempt #${balanceAttempts} failed: ${error.message}`);
    }
    
    if (balanceAttempts === 1) {
      await sendMessageWithRetry(chatId, 
        `⚠️ Balance စစ်ဆေးမရသေးပါ။ ဆက်လက်ကြိုးစားနေပါသည်... (အကြိမ် ${balanceAttempts})`
      );
    } else if (balanceAttempts % 5 === 0) {
      await sendMessageWithRetry(chatId, 
        `⏳ Balance စစ်ဆေးရန် ဆက်လက်ကြိုးစားနေဆဲ... (အကြိမ် ${balanceAttempts})`
      );
    }
    
    await setTimeout(30000);
  }
  
  if (!balanceRetrieved) {
    await sendMessageWithRetry(chatId, 
      `❌ Balance စစ်ဆေးမရပါ။ ကျေးဇူးပြု၍ အကောင့်ပြန်ဝင်ကြည့်ပါ။`
    );
    settings.running = false;
    return;
  }
  
  log('INFO', `💰 Current balance: ${currentBalance} Ks`);
  
  const startedBalance = currentBalance;
  const displayBalance = `${(currentBalance).toFixed(2)} Ks`;
  const strategyDisplay = "📟 API RULE";
  const bettingStrategyDisplay = settings.betting_strategy || "MARTINGALE";
  const profitTargetDisplay = settings.target_profit ? `${settings.target_profit.toFixed(2)} Ks` : "Not Set";
  const stopLossDisplay = settings.stop_loss ? `${settings.stop_loss.toFixed(2)} Ks` : "Not Set";
  
  const startMessage = `
├─⚡ BOT ACTIVATED
│
├─🎮 Platform: 6 LOTTERY
├─💳 Balance: ${displayBalance}
├─🎲 Game: ${gameType}
├─🎯 Type: BIG/SMALL
├─📚 Strategy: ${strategyDisplay}
├─🔄 Betting: ${bettingStrategyDisplay}
├─🎯 Profit Target: ${profitTargetDisplay}
└─🛑 Stop Loss: ${stopLossDisplay}
`;
  
  await sendMessageWithRetry(chatId, startMessage, makeMainKeyboard(true, userId));
  
  if (userSilentMode[userId]) {
    await updateProfitMessage(userId, chatId, currentBalance, 0);
  }
  
  const betSizes = settings.bet_sizes || [];
  if (!betSizes.length) {
    log('ERROR', `❌ Bet size မရှိပါ user ${userId}`);
    await sendMessageWithRetry(chatId, "❌ Bet size မရှိပါ။ BET SIZE အရင်ထည့်ပါ။");
    settings.running = false;
    return;
  }
  
  const minBetAmount = Math.min(...betSizes);
  if (currentBalance < minBetAmount) {
    log('ERROR', `❌ Insufficient balance for user ${userId}: ${currentBalance} < ${minBetAmount}`);
    await sendMessageWithRetry(chatId, "❗ Balance မလုံလောက်ပါ။ ငွေထည့်ပြီးမှ ပြန်စပါ။");
    settings.running = false;
    return;
  }
  
  log('INFO', `🚀 Betting worker started for user ${userId}`);
  
  try {
    while (settings.running) {
      if (!isWithinTimeStart(userId)) {
        log('INFO', `⏰ User ${userId} outside time start windows. Waiting...`);
        await setTimeout(60000);
        continue;
      }
      
      if (userWaitingForResult[userId]) {
        log('DEBUG', `⏳ User ${userId} waiting for result, skipping cycle`);
        await setTimeout(500);
        continue;
      }
      
      if (userSkipResultWait[userId]) {
        await setTimeout(500);
        continue;
      }
      
      currentBalance = await getBalanceWithRetry(session, userId);
      
      if (!betSizes.length) {
        log('ERROR', `❌ Bet size မရှိပါ user ${userId}`);
        await sendMessageWithRetry(chatId, "❌ Bet size မရှိပါ။ BET SIZE အရင်ထည့်ပါ။");
        settings.running = false;
        break;
      }
      
      if (currentBalance !== null && 
          (settings.skip_betting || 
           (settings.layer_limit !== undefined && settings.layer_limit > 1 && 
            (settings.current_layer || 0) < settings.layer_limit - 1) || 
           currentBalance >= Math.min(...betSizes))) {
        settings.consecutive_errors = 0;
      } else {
        log('ERROR', `❌ Balance check failed for user ${userId}: ${currentBalance}`);
        await sendMessageWithRetry(chatId, "❌ Balance စစ်ဆေးမရပါ။ ရပ်လိုက်သည်။");
        settings.running = false;
        break;
      }
      
      if (!settings.running) {
        break;
      }
      
      const bettingStrategy = settings.betting_strategy || "MARTINGALE";
      
      let issueRes = await getGameIssueRequest(session, gameType);
      
      if (!issueRes || issueRes.code !== 0) {
        log('ERROR', `❌ Game issue request failed for user ${userId}, ${gameType}: ${JSON.stringify(issueRes)}`);
        settings.consecutive_errors += 1;
        
        if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
          log('ERROR', `❌ Max consecutive errors (${MAX_CONSECUTIVE_ERRORS}) reached for user ${userId}. Stopping bot.`);
          await sendMessageWithRetry(chatId, `❌ အမှားများလွန်းသည် (${MAX_CONSECUTIVE_ERRORS})။ Bot ရပ်လိုက်သည်။`);
          settings.running = false;
          break;
        }
        
        await setTimeout(1000);
        continue;
      }
      
      const data = issueRes.data || {};
      let currentIssue;
      let drawTime;
      
      if (gameType === "TRX") {
        currentIssue = data.predraw?.issueNumber;
        drawTime = data.predraw?.drawTime;
      } else {
        currentIssue = data.issueNumber;
        drawTime = data.drawTime;
      }
      
      if (!currentIssue) {
        log('WARNING', `⚠️ No valid issue number for user ${userId}, ${gameType}: ${JSON.stringify(data)}`);
        settings.consecutive_errors += 1;
        
        if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
          log('ERROR', `❌ Max consecutive errors (${MAX_CONSECUTIVE_ERRORS}) reached for user ${userId}. Stopping bot.`);
          await sendMessageWithRetry(chatId, `❌ အမှားများလွန်းသည် (${MAX_CONSECUTIVE_ERRORS})။ Bot ရပ်လိုက်သည်။`);
          settings.running = false;
          break;
        }
        
        await setTimeout(500);
        continue;
      }
      
      if (currentIssue === settings.last_issue) {
        log('DEBUG', `🔄 Same issue ${currentIssue} for user ${userId}, waiting for new issue`);
        await setTimeout(500);
        continue;
      }
      
      if (drawTime) {
        try {
          const drawTimestamp = parseInt(drawTime) / 1000;
          const currentTime = Date.now() / 1000;
          
          if (drawTimestamp <= currentTime + 3) {
            log('WARNING', `⚠️ Issue ${currentIssue} is settled or about to settle. Skipping...`);
            settings.last_issue = currentIssue;
            
            if (gameType.includes("WINGO")) {
              await setTimeout(2000);
            } else {
              await setTimeout(5000);
            }
            
            continue;
          }
          
          const remainingTime = drawTimestamp - currentTime;
          if (remainingTime < 2) {
            log('WARNING', `⚠️ Issue ${currentIssue} closing soon (${remainingTime.toFixed(1)}s). Skipping...`);
            settings.last_issue = currentIssue;
            await setTimeout(2000);
            continue;
          }
        } catch (error) {
          log('ERROR', `❌ Invalid drawTime for issue ${currentIssue}: ${drawTime}, error: ${error.message}`);
          settings.consecutive_errors += 1;
          
          if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
            log('ERROR', `❌ Max consecutive errors (${MAX_CONSECUTIVE_ERRORS}) reached for user ${userId}. Stopping bot.`);
            settings.running = false;
            break;
          }
          
          await setTimeout(500);
          continue;
        }
      }
      
      // 📟 API RULE တစ်ခုတည်းသုံးမယ်
      const prediction = await getAPIRulePrediction(userId, gameType);
      
      if (prediction.skip || !prediction.result) {
        log('INFO', `📟 API RULE: No match for ${gameType}, waiting for next game`);
        
        let waitTime;
        if (gameType === "TRX") {
          waitTime = 60000;
        } else if (gameType === "WINGO30S") {
          waitTime = 25000;
        } else if (gameType === "WINGO1MIN") {
          waitTime = 55000;
        } else if (gameType === "WINGO3MIN") {
          waitTime = 175000;
        } else if (gameType === "WINGO5MIN") {
          waitTime = 295000;
        } else {
          waitTime = GAME_DELAYS[gameType] || 60000;
        }
        
        log('INFO', `⏳ API RULE: No match, waiting ${waitTime/1000}s for next ${gameType} game...`);
        userWaitingForResult[userId] = false;
        await setTimeout(waitTime);
        continue;
      }
      
      const ch = prediction.result;
      log('INFO', `📟 API RULE: Bet ${ch} for ${gameType} (Last: ${prediction.lastNumber})`);
      
      const selectMap = { "B": 13, "S": 14 };
      const selectType = selectMap[ch];
      
      if (selectType === undefined) {
        log('ERROR', `❌ Invalid bet type ${ch} for user ${userId}`);
        settings.consecutive_errors += 1;
        
        if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
          log('ERROR', `❌ Max consecutive errors (${MAX_CONSECUTIVE_ERRORS}) reached for user ${userId}. Stopping bot.`);
          settings.running = false;
          break;
        }
        
        await setTimeout(1000);
        continue;
      }
      
      if (!betSizes.length) {
        log('ERROR', `❌ Bet size မရှိပါ user ${userId}`);
        await sendMessageWithRetry(chatId, "❌ Bet size မရှိပါ။ BET SIZE အရင်ထည့်ပါ။");
        settings.running = false;
        break;
      }
      
      let amount;
      
      if (bettingStrategy === "D'ALEMBERT") {
        if (betSizes.length > 1) {
          log('ERROR', `❌ D'ALEMBERT requires a single bet size for user ${userId}`);
          await sendMessageWithRetry(chatId, "❌ D'ALEMBERT အတွက် BET SIZE တစ်ခုတည်းသာထည့်ပါ။", makeMainKeyboard(true, userId));
          settings.running = false;
          break;
        }
        
        const unitSize = betSizes[0];
        const units = settings.dalembert_units || 1;
        amount = unitSize * units;
        
        log('INFO', `⚖️ D'ALEMBERT: Using bet size ${amount} MMK (unit_size=${unitSize}, units=${units}) for user ${userId}`);
      } else {
        const midx = Math.min((settings.martin_index || 0), betSizes.length - 1);
        amount = betSizes[midx];
        
        log('INFO', `${bettingStrategy}: Using bet size ${amount} MMK, martin_index=${midx} for user ${userId}`);
      }
      
      const layerLimit = settings.layer_limit;
      const skipBetting = settings.skip_betting || 
        (layerLimit !== undefined && layerLimit > 1 && (settings.current_layer || 0) < layerLimit - 1);
      
      if (!skipBetting && currentBalance < amount) {
        log('ERROR', `❌ Insufficient balance for user ${userId}: ${currentBalance} < ${amount}`);
        await sendMessageWithRetry(chatId, "❗ Balance မလုံလောက်ပါ။ ငွေထည့်ပြီးမှ ပြန်စပါ။");
        settings.running = false;
        break;
      }
      
      const betMsg = formatBetMessage(gameType, currentIssue, ch, amount, skipBetting);
      await sendMessageWithRetry(chatId, betMsg);
      
      log('INFO', `${skipBetting ? 'Simulating' : 'Placing'} bet for user ${userId}, ${gameType}: ${betMsg}`);
      
      if (!skipBetting) {
        const unitAmount = computeUnitAmount(amount);
        const betCount = unitAmount > 0 ? Math.floor(amount / unitAmount) : 1;
        
        const betResp = await placeBetRequest(session, currentIssue, selectType, unitAmount, betCount, gameType, userId);
        
        settings.last_issue = currentIssue;
        
        if (betResp.settled) {
          log('INFO', `⏭️ Period ${currentIssue} is settled, skipping to next cycle for user ${userId}`);
          await setTimeout(500);
          continue;
        }
        
        if (betResp.error) {
          log('ERROR', `❌ Bet error for user ${userId}, ${gameType}, issue ${currentIssue}: ${betResp.error}`);
          settings.consecutive_errors += 1;
          
          if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
            log('ERROR', `❌ Max consecutive errors (${MAX_CONSECUTIVE_ERRORS}) reached for user ${userId}. Stopping bot.`);
            await sendMessageWithRetry(chatId, `❌ အမှားများလွန်းသည် (${MAX_CONSECUTIVE_ERRORS})။ Bot ရပ်လိုက်သည်။`);
            settings.running = false;
            break;
          }
          
          await setTimeout(3000);
          continue;
        } else if (betResp.code !== 0) {
          const errorMsg = betResp.msg || "Unknown error";
          log('ERROR', `❌ API error for user ${userId}, ${gameType}, issue ${currentIssue}: ${errorMsg}`);
          
          if (!errorMsg.toLowerCase().includes("settled")) {
            settings.consecutive_errors += 1;
          }
          
          if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
            log('ERROR', `❌ Max consecutive errors (${MAX_CONSECUTIVE_ERRORS}) reached for user ${userId}. Stopping bot.`);
            await sendMessageWithRetry(chatId, `❌ အမှားများလွန်းသည် (${MAX_CONSECUTIVE_ERRORS})။ Bot ရပ်လိုက်သည်။`);
            settings.running = false;
            break;
          }
          
          await setTimeout(3000);
          continue;
        }
        
        settings.consecutive_errors = 0;
      }
      
      if (!userPendingBets[userId]) {
        userPendingBets[userId] = {};
      }
      
      userPendingBets[userId][currentIssue] = [ch, skipBetting ? 0 : amount];
      settings.bet_time[currentIssue] = Date.now() / 1000;
      userWaitingForResult[userId] = true;
      
      log('INFO', `${skipBetting ? 'Simulating' : 'Placed'} bet for user ${userId}, ${gameType}, waiting for result on issue ${currentIssue}`);
      
      let waitTime;
      if (gameType === "TRX") {
        waitTime = 3000;
      } else if (gameType === "WINGO30S") {
        waitTime = 28000;
      } else if (gameType === "WINGO1MIN") {
        waitTime = 58000;
      } else if (gameType === "WINGO3MIN") {
        waitTime = 178000;
      } else if (gameType === "WINGO5MIN") {
        waitTime = 298000;
      } else {
        waitTime = GAME_DELAYS[gameType] || 3000;
      }
      
      log('INFO', `⏳ Waiting ${waitTime/1000}s for ${gameType} result...`);
      await setTimeout(waitTime);
    }
  } catch (error) {
    if (error.name === 'CancelError') {
      log('INFO', `⏹️ Betting worker cancelled for user ${userId}`);
    } else {
      log('ERROR', `❌ Betting worker error for user ${userId}, ${gameType}: ${error.message}`);
      settings.consecutive_errors += 1;
      
      if (settings.consecutive_errors >= MAX_CONSECUTIVE_ERRORS) {
        log('ERROR', `❌ Max consecutive errors (${MAX_CONSECUTIVE_ERRORS}) reached for user ${userId}. Stopping bot.`);
        settings.running = false;
      }
    }
  } finally {
    settings.running = false;
    delete userWaitingForResult[userId];
    delete userShouldSkipNext[userId];
    delete userSkipResultWait[userId];
    
    let currentBalance = null;
    const session = userSessions[userId];
    currentBalance = session ? await getBalanceWithRetry(session, userId) : null;
    
    const balanceText = currentBalance !== null ? `🧩 Balance: ${(currentBalance).toFixed(2)} Ks\n📊 Total Profit: ${userStats[userId] ? (userStats[userId].profit >= 0 ? '+' : '') + userStats[userId].profit.toFixed(2) : 'N/A'} Ks` : '';
    
    await sendMessageWithRetry(chatId, 
      `├─⏹️ BOT STOPPED
│
├─💵 Balance: ${currentBalance !== null ? (currentBalance).toFixed(2) : 'N/A'} KS
└─🏆 Total Profit: ${userStats[userId] ? (userStats[userId].profit >= 0 ? '+' : '') + userStats[userId].profit.toFixed(2) : '0.00'} KS`,
      makeMainKeyboard(true, userId)
    );
  }
};

// ============================================
// 🔧 HELPER FUNCTIONS
// ============================================

const normalizeText = (text) => {
  return text.normalize('NFKC').trim();
};

const computeUnitAmount = (amt) => {
  if (amt <= 0) return 1;
  
  const amtStr = amt.toString();
  const trailingZeros = amtStr.length - amtStr.replace(/0+$/, '').length;
  
  if (trailingZeros === 4) return 10000;
  if (trailingZeros === 3) return 1000;
  if (trailingZeros === 2) return 100;
  if (trailingZeros === 1) return 10;
  
  return Math.pow(10, amtStr.length - 1);
};

const sendMessageWithRetry = async (chatId, text, replyMarkup = null, disableNotification = false) => {
  const silentMode = userSilentMode[chatId] || false;
  const settings = userSettings[chatId] || {};
  
  if (silentMode) {
    const silentKeywords = ["🏆 WIN", "⛔ LOSE", "🟢 WIN", "🔴 LOSE", "🎮", "BET:"];
    const isSilentMessage = silentKeywords.some(keyword => text.includes(keyword));
    
    if (isSilentMessage && !settings.running) {
      log('INFO', `🔇 Silent Mode: Skipping message to ${chatId}: ${text.substring(0, 50)}...`);
      return true;
    }
  }
  
  if (FAST_MODE && (text.includes("🎮") || text.includes("BET:") || text.includes("WIN") || text.includes("LOSE"))) {
    try {
      await bot.sendMessage(chatId, text, { 
        reply_markup: replyMarkup,
        parse_mode: 'HTML',
        disable_notification: silentMode || disableNotification
      });
      log('INFO', `📨 Fast message sent to ${chatId} (Silent: ${silentMode})`);
      return true;
    } catch (error) {
      return false;
    }
  }
  
  for (let attempt = 0; attempt < MAX_TELEGRAM_RETRIES; attempt++) {
    try {
      await bot.sendMessage(chatId, text, { 
        reply_markup: replyMarkup,
        parse_mode: 'HTML',
        disable_notification: silentMode || disableNotification
      });
      log('INFO', `📨 Message sent to ${chatId} (Silent: ${silentMode})`);
      return true;
    } catch (error) {
      log('ERROR', `❌ Failed to send message to ${chatId}, attempt ${attempt + 1}/${MAX_TELEGRAM_RETRIES}: ${error.message}`);
      
      if (attempt < MAX_TELEGRAM_RETRIES - 1) {
        await setTimeout(TELEGRAM_RETRY_DELAY);
        continue;
      }
      
      return false;
    }
  }
  
  return false;
};

const checkUserLoggedIn = (userId) => {
  return !!(userSessions[userId] && userSettings[userId]);
};

const updateProfitMessage = async (userId, chatId, currentBalance, currentProfit) => {
  try {
    const silentMode = userSilentMode[userId] ? true : false;
    
    if (!silentMode) return;
    
    const settings = userSettings[userId] ? userSettings[userId] : {};
    const gameType = settings.game_type || "TRX";
    
    if (userProfitMessageId[userId] !== undefined && userProfitMessageId[userId] !== null) {
      const updateMessage = `
📊 LIVE PROFIT UPDATE
════════════════════════
🎮 Platform: 6 LOTTERY
🎯 Game: ${gameType}
🧩 Current Balance: ${(currentBalance).toFixed(2)} Ks
📈 Current Profit: ${currentProfit >= 0 ? '+' : ''}${currentProfit.toFixed(2)} Ks
════════════════════════
🔄 Updated: ${new Date().toLocaleTimeString()}
`;
      
      try {
        await bot.editMessageText(updateMessage, {
          chat_id: chatId,
          message_id: userProfitMessageId[userId],
          parse_mode: 'HTML'
        });
        
        userLastProfit[userId] = currentProfit;
        log('INFO', `📊 Updated profit message for user ${userId}: ${currentProfit.toFixed(2)} Ks`);
      } catch (error) {
        log('ERROR', `🧨 ERROR updating profit message: ${error.message}`);
      }
    } else {
      const initialMessage = `
📊 LIVE PROFIT UPDATE
════════════════════════
🎮 Platform: 6 LOTTERY
🎯 Game: ${gameType}
🧩 Current Balance: ${(currentBalance).toFixed(2)} Ks
📈 Current Profit: ${currentProfit >= 0 ? '+' : ''}${currentProfit.toFixed(2)} Ks
════════════════════════
🔄 Updated: ${new Date().toLocaleTimeString()}
`;
      
      try {
        const sentMessage = await bot.sendMessage(chatId, initialMessage, { parse_mode: 'HTML' });
        userProfitMessageId[userId] = sentMessage.message_id;
        userLastProfit[userId] = currentProfit;
        log('INFO', `📊 Created profit message for user ${userId}`);
      } catch (error) {
        log('ERROR', `🧨 ERROR creating profit message: ${error.message}`);
      }
    }
  } catch (error) {
    log('ERROR', `🧨 ERROR in updateProfitMessage: ${error.message}`);
  }
};

// ============================================
// 📝 MESSAGE FORMATTING
// ============================================

const formatLoginMessage = () => {
  return `🎰 Selected: 6 LOTTERY

Now please login with:

LOGIN
YourPhoneNumber
YourPassword`;
};

const formatWelcomeMessage = () => {
  return `🌟 HELLO WELCOME ALL USER

🎰 6 LOTTERY BET BOT

⚡️ AUTO SYSTEM

├─ 🎯 Auto Bet
├─ 📟 API RULE Strategy
└─ ⏳ 24/7 Active
├─ 👑 Admin: @Thunwaiphyo
 
   🚀 START: Click 🔐 LOGIN 🔐`;
};

const formatLoginSuccess = (userInfo, balance) => {
  return `├─🎄 LOGIN SUCCESS!
│
├─🎮 Platform: 6 LOTTERY
├─🆔 User ID: ${userInfo.user_id}
└─💳 Balance: ${(balance).toFixed(2)} Ks`;
};

const formatBetMessage = (gameType, currentIssue, ch, amount, skipBetting) => {
  return `├─🎮 Game: 6 LOTTERY
├─💷 Bet: ${ch === 'B' ? 'BIG' : 'SMALL'} ${skipBetting ? 0 : (amount).toFixed(2)} KS
└─⏰ ${gameType}: ${currentIssue}`;
};

const formatInfoMessage = (userInfo, settings, currentBalance, gameType, userId) => {
  const strategyDisplay = "📟 API RULE";
  
  const bettingStrategy = settings.betting_strategy || "MARTINGALE";
  const betSizes = settings.bet_sizes || [];
  const profitTarget = settings.target_profit;
  const stopLoss = settings.stop_loss;
  const slLimit = settings.sl_limit;
  const layerLimit = settings.layer_limit;
  const running = settings.running ? '⚡ ACTIVATE' : '⏸️ DEACTIVATE';
  
  const silentMode = userSilentMode && userSilentMode[userId] ? '🔇 On' : '🔊 Off';

  const timeStarts = (userInfo && userInfo.user_id && userTimeStarts[userInfo.user_id]) ? userTimeStarts[userInfo.user_id] : [];
  const timeStartInfo = timeStarts.length > 0 ? 
    `${timeStarts.length} start time(s) active` : '24/7 (no restriction)';

  const balanceDisplay = currentBalance !== null ? (currentBalance).toFixed(2) : 'N/A';
  const profitTargetDisplay = typeof profitTarget === 'number' ? profitTarget.toFixed(2) + ' Ks' : 'Not Set';
  const stopLossDisplay = typeof stopLoss === 'number' ? stopLoss.toFixed(2) + ' Ks' : 'Not Set';
  const slLimitDisplay = slLimit !== undefined ? slLimit.toString() : 'Not Set';
  const layerLimitDisplay = layerLimit !== undefined ? layerLimit.toString() : 'Not Set';
  const betSizesDisplay = betSizes.length > 0 ? betSizes.join(', ') : 'Not Set';
  
  // API RULE Map ကိုပြမယ်
  const ruleMap = settings.api_rule_map || {};
  const ruleList = Object.keys(ruleMap).length > 0 
    ? Object.entries(ruleMap).map(([num, bs]) => `${num}=${bs}`).join(', ')
    : 'Not Set';
  
  return (
  `├─💻 USER INFO\n` +
  `├─🎮 Platform: 6 LOTTERY\n` +
  `├─🖥 User ID: ${userInfo && userInfo.user_id ? userInfo.user_id : 'N/A'}\n` +
  `├─💵 Balance: ${balanceDisplay} Ks\n` +
  `├─🔊 Silent Mode: ${silentMode}\n\n` +
    
    `├─⚙️ SETTINGS\n` +
    `├─🎮 Game: ${gameType}\n` +
    `├─📚 Strategy: ${strategyDisplay}\n` +
    `├─📋 API Rules: ${ruleList}\n` +
    `├─🔄 Betting Strategy: ${bettingStrategy}\n` +
    `├─💰 Bet Size: ${betSizesDisplay} MMK\n` +
    `├─🎯 Profit Target: ${profitTargetDisplay}\n` +
    `├─🛑 Stop Loss: ${stopLossDisplay}\n` +
    `├─💥 SL Limit: ${slLimitDisplay}\n` +
    `├─🎢 Entry Layer: ${layerLimitDisplay}\n` +
    `└─⏰ Time Starts: ${timeStartInfo}\n\n` +
    
    `└─🚀 BOT STATUS\n` +
    `   └─ Status: ${running}`
  );
};

// ============================================
// 🎚️ KEYBOARD LAYOUTS
// ============================================

const makeMainKeyboard = (loggedIn = false, userId = null) => {
  if (!loggedIn) {
    return {
      keyboard: [["🔐 LOGIN 🔐"]],
      resize_keyboard: true,
      one_time_keyboard: false
    };
  }
  
  const silentMode = userSilentMode[userId] ? true : false;
  const silentButton = silentMode ? "🔇 SILENT" : "🔊 SILENT";
  
  return {
    keyboard: [
      ["⚡ ACT", "⏸️ DEACT"],
      ["💰 BET", silentButton, "⚙️ RISK"],
      ["🎮 GAME", "⏰ TIME", "ℹ️ INFO"],
      ["🔄 RE-LOGIN 🔄"]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
};

const makeBetPlaceSettingsKeyboard = () => {
  return {
    keyboard: [
      ["🔄 ANTI/MARTINGALE 🔄"],
      ["🎲 GAME TYPE 🎲"],
      ["🔙 BACK TO MAIN 🔙"]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
};

const makeRiskControlKeyboard = () => {
  return {
    keyboard: [
      ["🎯 PROFIT TARGET 🎯"],
      ["🛑 STOP LOSS 🛑"],
      ["🎢 ENTRY LAYER 🎢"],
      ["💥 SL LIMIT 💥"],
      ["📚 STRATEGY 📚"],
      ["🔙 BACK TO MAIN 🔙"]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
};

const makeRiskControlStrategyKeyboard = () => {
  return {
    keyboard: [
      ["📟 API RULE 📟"],  // API RULE တစ်ခုတည်း
      ["🔙 BACK TO RISK 🔙"]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
};

const makeTimeStartKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: "⏰ ADD TIME START ⏰", callback_data: "time_start:add" }],
      [{ text: "📋 VIEW TIME STARTS 📋", callback_data: "time_start:view" }],
      [{ text: "🗑️ CLEAR ALL 🗑️", callback_data: "time_start:clear" }]
    ]
  };
};

const makeAdminKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: "📊 USER STATS", callback_data: "admin:stats" }],
      [{ text: "📢 BROADCAST", callback_data: "admin:broadcast" }, { text: "🚫 BAN USER", callback_data: "admin:ban" }],
      [{ text: "✅ UNBAN USER", callback_data: "admin:unban" }, { text: "📢 CHANNEL MGMT", callback_data: "admin:channels" }]
    ]
  };
};

const makeChannelManagementKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: "➕ ADD CHANNEL ➕", callback_data: "channel:add" }],
      [{ text: "🗑️ REMOVE CHANNEL 🗑️", callback_data: "channel:remove" }],
      [{ text: "📋 LIST CHANNELS 📋", callback_data: "channel:list" }],
      [{ text: "🔙 BACK 🔙", callback_data: "admin:back" }]
    ]
  };
};

const makeLoginKeyboard = () => {
  return {
    keyboard: [["🔐 LOGIN 🔐"]],
    resize_keyboard: true,
    one_time_keyboard: false
  };
};

const makeGameTypeKeyboard = () => {
  return {
    keyboard: [
      ["🎰 TRX 🎰"],
      ["⚡ WINGO30S ⚡"],
      ["⏱️ WINGO1MIN ⏱️"],
      ["🕒 WINGO3MIN 🕒"],
      ["⌛ WINGO5MIN ⌛"],
      ["🔙 BACK 🔙"]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
};

const makeBettingStrategyKeyboard = () => {
  return {
    keyboard: [
      ["📈 ANTI-MARTINGALE 📈"],
      ["📉 MARTINGALE 📉"],
      ["⚖️ D'ALEMBERT ⚖️"],
      ["🔙 BACK 🔙"]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };
};

const makeNumberPadKeyboard = (type, title = "") => {
  return {
    inline_keyboard: [
      [{ text: title || type, callback_data: `${type}:title` }],
      [{ text: "❌ 0 (DISABLE) ❌", callback_data: `${type}:0` }],
      [
        { text: "1️⃣ 1", callback_data: `${type}:1` },
        { text: "2️⃣ 2", callback_data: `${type}:2` },
        { text: "3️⃣ 3", callback_data: `${type}:3` }
      ],
      [
        { text: "4️⃣ 4", callback_data: `${type}:4` },
        { text: "5️⃣ 5", callback_data: `${type}:5` },
        { text: "6️⃣ 6", callback_data: `${type}:6` }
      ],
      [
        { text: "7️⃣ 7", callback_data: `${type}:7` },
        { text: "8️⃣ 8", callback_data: `${type}:8` },
        { text: "9️⃣ 9", callback_data: `${type}:9` }
      ]
    ]
  };
};

const makeEntryLayerKeyboard = () => {
  return {
    inline_keyboard: [
      [{ text: "🎢 ENTRY LAYER SETTINGS 🎢", callback_data: "layer:title" }],
      [{ text: "❌ 0 (DISABLE) ❌", callback_data: "layer_limit:0" }],
      [
        { text: "1️⃣ 1️⃣", callback_data: "layer_limit:1" },
        { text: "2️⃣ 2️⃣", callback_data: "layer_limit:2" },
        { text: "3️⃣ 3️⃣", callback_data: "layer_limit:3" }
      ],
      [
        { text: "4️⃣ 4️⃣", callback_data: "layer_limit:4" },
        { text: "5️⃣ 5️⃣", callback_data: "layer_limit:5" },
        { text: "6️⃣ 6️⃣", callback_data: "layer_limit:6" }
      ],
      [
        { text: "7️⃣ 7️⃣", callback_data: "layer_limit:7" },
        { text: "8️⃣ 8️⃣", callback_data: "layer_limit:8" },
        { text: "9️⃣ 9️⃣", callback_data: "layer_limit:9" }
      ]
    ]
  };
};

// ============================================
// 🤖 TELEGRAM COMMAND HANDLERS
// ============================================

bot.onText(/\/start/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const username = msg.from.username ? `@${msg.from.username}` : 'No username';
  const firstName = msg.from.first_name || '';
  const lastName = msg.from.last_name || '';
  const fullName = `${firstName} ${lastName}`.trim() || 'User';
  
  if (isUserBanned(userId)) {
    await bot.sendMessage(chatId, 
      `🚫 သင့်ကို bot သုံးခွင့်ပိတ်ထားပါသည်။\n\n📞 Admin @Thunwaiphyo ကိုဆက်သွယ်ပါ။`
    );
    return;
  }
  
  log('INFO', `/start command from user ${userId}`);
  
  if (!userSettings[userId]) {
    userSettings[userId] = {
      mode: "REAL",
      strategy: "API_RULE",  // API RULE ကို default ထား
      betting_strategy: "MARTINGALE",
      martin_index: 0,
      dalembert_units: 1,
      pattern_index: 0,
      running: false,
      consecutive_losses: 0,
      current_layer: 0,
      skip_betting: false,
      game_type: "TRX",
      api_rule_map: {}  // API RULE map အသစ်
    };
    
    log('INFO', `🆕 User ${userId} initialized with default settings`);
  }
  
  delete userTemp[userId];
  
  let userPhoto = null;
  try {
    const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
    if (photos.total_count > 0) {
      userPhoto = photos.photos[0][0].file_id;
    }
  } catch (error) {
    log('ERROR', `❌ Could not get user profile photo: ${error.message}`);
  }
  
  if (checkUserLoggedIn(userId)) {
    const welcomeBackMessage = `
✅ WELCOME BACK!
━━━━━━━━━━━━━━━━━━━━━━
👤 User: ${fullName}
🆔 ID: ${userId}
📊 Status: Logged In
━━━━━━━━━━━━━━━━━━━━━━
`;
    
    if (userPhoto) {
      try {
        await bot.sendPhoto(chatId, userPhoto, {
          caption: welcomeBackMessage,
          reply_markup: makeMainKeyboard(true, userId),
          parse_mode: 'HTML'
        });
      } catch (error) {
        await bot.sendMessage(chatId, welcomeBackMessage, {
          reply_markup: makeMainKeyboard(true, userId)
        });
      }
    } else {
      await bot.sendMessage(chatId, welcomeBackMessage, {
        reply_markup: makeMainKeyboard(true, userId)
      });
    }
  } else {
    const platformMessage = `
🎯 6 LOTTERY BOT
━━━━━━━━━━━━━━━━━━━━━━
👤 User: ${fullName}
🆔 ID: ${userId}
━━━━━━━━━━━━━━━━━━━━━━

အကောင့်ဝင်ရန် LOGIN ကိုနှိပ်ပါ။
`;
    
    if (userPhoto) {
      try {
        await bot.sendPhoto(chatId, userPhoto, {
          caption: platformMessage,
          reply_markup: makeLoginKeyboard(),
          parse_mode: 'HTML'
        });
      } catch (error) {
        await bot.sendMessage(chatId, platformMessage, {
          reply_markup: makeLoginKeyboard()
        });
      }
    } else {
      await bot.sendMessage(chatId, platformMessage, {
        reply_markup: makeLoginKeyboard()
      });
    }
  }
  
  if (!global.winLoseTask || global.winLoseTask.finished) {
    global.winLoseTask = winLoseChecker();
  }
});

// Admin command
bot.onText(/\/admin/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (userId !== ADMIN_ID) {
    await sendMessageWithRetry(chatId, "⛔ Admin Only\n\nThis command is restricted to administrators.");
    return;
  }
  
  await sendMessageWithRetry(chatId, "🛠️ Admin Control Panel", makeAdminKeyboard());
});

// Ban user command
bot.onText(/\/ban (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (userId !== ADMIN_ID) {
    await sendMessageWithRetry(chatId, "⛔ Admin Only\n\nThis command is restricted to administrators.");
    return;
  }
  
  const username = match[1].trim();
  const userToBan = parseInt(username);
  
  if (isNaN(userToBan)) {
    await sendMessageWithRetry(chatId, "⚠️ Invalid User ID\n\nPlease provide a valid numeric user ID.");
    return;
  }
  
  await banUser(userToBan, username);
  
  try {
    await sendMessageWithRetry(userToBan, 
      `🚫 You have been banned from using this bot.\n\n📞 Contact admin @Thunwaiphyo for assistance.`
    );
  } catch (error) {
    log('ERROR', `❌ Failed to send ban message to user ${userToBan}: ${error.message}`);
  }
  
  await sendMessageWithRetry(chatId, `🎄 User ${userToBan} has been banned.`);
});

// Unban user command
bot.onText(/\/unban (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (userId !== ADMIN_ID) {
    await sendMessageWithRetry(chatId, "⛔ Admin Only\n\nThis command is restricted to administrators.");
    return;
  }
  
  const username = match[1].trim();
  const userToUnban = parseInt(username);
  
  if (isNaN(userToUnban)) {
    await sendMessageWithRetry(chatId, "⚠️ Invalid User ID\n\nPlease provide a valid numeric user ID.");
    return;
  }
  
  if (!isUserBanned(userToUnban)) {
    await sendMessageWithRetry(chatId, `⚠️ User ${userToUnban} is not banned.`);
    return;
  }
  
  await unbanUser(userToUnban);
  
  try {
    await sendMessageWithRetry(userToUnban, 
      `🎄 Your ban has been lifted!\n\nYou can now use the bot again.\n\nType /start to begin.`
    );
  } catch (error) {
    log('ERROR', `❌ Failed to send unban message to user ${userToUnban}: ${error.message}`);
  }
  
  await sendMessageWithRetry(chatId, `🎄 User ${userToUnban} has been unbanned.`);
});

// Broadcast command
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (userId !== ADMIN_ID) {
    await sendMessageWithRetry(chatId, "⛔ Admin Only\n\nThis command is restricted to administrators.");
    return;
  }
  
  const message = match[1];
  await broadcastMessage(message, userId);
});

// Stats command
bot.onText(/\/stats/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  
  if (userId !== ADMIN_ID) {
    await sendMessageWithRetry(chatId, "⛔ Admin Only\n\nThis command is restricted to administrators.");
    return;
  }
  
  const stats = formatUserStats();
  await sendMessageWithRetry(chatId, stats);
});

// Broadcast function
const broadcastMessage = async (message, adminId) => {
  const allUsers = Object.keys(userSessions);
  let successCount = 0;
  let failCount = 0;
  
  log('INFO', `📢 Starting broadcast to ${allUsers.length} users`);
  
  for (const userId of allUsers) {
    try {
      await sendMessageWithRetry(userId, `📢 Broadcast Message:\n\n${message}`);
      successCount++;
      log('INFO', `📨 Broadcast sent to user ${userId}`);
    } catch (error) {
      log('ERROR', `❌ Failed to broadcast to user ${userId}: ${error.message}`);
      failCount++;
    }
    
    await setTimeout(100);
  }

  const report = `📢 Broadcast Report\n\n🎄 Sent: ${successCount} users\n❌ Failed: ${failCount} users\n\nTotal: ${allUsers.length} users`;
  await sendMessageWithRetry(adminId, report);
};

// Format user stats
const formatUserStats = () => {
  const totalUsers = Object.keys(userSessions).length;
  const activeUsers = Object.values(userSettings).filter(s => s && s.running).length;
  const bannedCount = bannedUsers.size;
  const inactiveUsers = totalUsers - activeUsers;
  
  return (
    `📊 SYSTEM STATISTICS\n` +
    `════════════════════════\n` +
    `👥 Total Users: ${totalUsers}\n` +
    `🟢 Active Users: ${activeUsers}\n` +
    `🔴 Banned Users: ${bannedCount}\n` +
    `⚫ Inactive Users: ${inactiveUsers}\n` +
    `════════════════════════`
  );
};

// ============================================
// 📞 CALLBACK QUERY HANDLER
// ============================================

bot.on('callback_query', async (query) => {
  try {
    const userId = query.from.id;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    
    console.log(`🔔 Callback: ${query.data} from user ${userId}`);
    
    await bot.answerCallbackQuery(query.id);
    
    if (!userSettings[userId]) {
      userSettings[userId] = {
        mode: "REAL",
        strategy: "API_RULE",
        betting_strategy: "MARTINGALE",
        martin_index: 0,
        dalembert_units: 1,
        pattern_index: 0,
        running: false,
        consecutive_losses: 0,
        current_layer: 0,
        skip_betting: false,
        game_type: "TRX",
        api_rule_map: {}
      };
    }
    
    // ============================================
    // TIME START
    // ============================================
    if (query.data.startsWith("time_start:")) {
      const action = query.data.split(":")[1];
      
      if (action === "add") {
        userState[userId] = { state: "INPUT_TIME_START" };
        await bot.sendMessage(chatId,
          `⏰ Add Time Start\n\nEnter start time (format: 9:00am or 14:30):`,
          { reply_markup: makeMainKeyboard(true, userId) }
        );
      } else if (action === "view") {
        const display = getTimeStartDisplay(userId);
        await bot.sendMessage(chatId, display, {
          reply_markup: makeTimeStartKeyboard()
        });
      } else if (action === "clear") {
        const result = clearTimeStarts(userId);
        await bot.sendMessage(chatId, result.message, {
          reply_markup: makeTimeStartKeyboard()
        });
      } else if (action === "back") {
        await bot.sendMessage(chatId, "🔙 Returning to main menu...", {
          reply_markup: makeMainKeyboard(true, userId)
        });
      }
      
      await bot.deleteMessage(chatId, messageId);
      return;
    }
    
    // ============================================
    // ADMIN
    // ============================================
    if (query.data.startsWith("admin:")) {
      if (userId !== ADMIN_ID) {
        await bot.sendMessage(chatId, "⛔ Admin Only");
        return;
      }
      
      const action = query.data.split(":")[1];
      
      switch(action) {
        case "stats":
          await bot.sendMessage(chatId, formatUserStats(), { reply_markup: makeAdminKeyboard() });
          break;
        case "broadcast":
          userState[userId] = { state: "ADMIN_BROADCAST" };
          await bot.sendMessage(chatId, "📢 Enter broadcast message:");
          break;
        case "ban":
          userState[userId] = { state: "ADMIN_BAN_USER" };
          await bot.sendMessage(chatId, "🚫 Enter user ID to ban:");
          break;
        case "unban":
          userState[userId] = { state: "ADMIN_UNBAN_USER" };
          await bot.sendMessage(chatId, "✅ Enter user ID to unban:");
          break;
        case "channels":
          await bot.sendMessage(chatId, "📢 Channel Management", {
            reply_markup: makeChannelManagementKeyboard()
          });
          break;
        case "back":
          await bot.sendMessage(chatId, "🔙 Admin Panel", { reply_markup: makeAdminKeyboard() });
          break;
      }
      
      await bot.deleteMessage(chatId, messageId);
      return;
    }
    
    // ============================================
    // CHANNEL MANAGEMENT
    // ============================================
    if (query.data.startsWith("channel:")) {
      if (userId !== ADMIN_ID) {
        await bot.sendMessage(chatId, "⛔ Admin Only");
        return;
      }
      
      const action = query.data.split(":")[1];
      
      if (action === "add") {
        userState[userId] = { state: "ADMIN_ADD_CHANNEL" };
        await bot.sendMessage(chatId, "➕ Send: @channel_id Channel Name");
      } else if (action === "remove") {
        userState[userId] = { state: "ADMIN_REMOVE_CHANNEL" };
        let list = "🗑️ Current channels:\n\n";
        requiredChannels.forEach((ch, i) => {
          list += `${i+1}. ${ch.name}\n   ${ch.id}\n\n`;
        });
        list += "Enter channel ID to remove:";
        await bot.sendMessage(chatId, list);
      } else if (action === "list") {
        let list = "📋 Channel List\n\n";
        if (requiredChannels.length === 0) {
          list += "No channels.";
        } else {
          requiredChannels.forEach((ch, i) => {
            list += `${i+1}. ${ch.name}\n   ${ch.id}\n\n`;
          });
        }
        await bot.sendMessage(chatId, list, {
          reply_markup: makeChannelManagementKeyboard()
        });
      }
      
      await bot.deleteMessage(chatId, messageId);
      return;
    }
    
    // ============================================
    // SL LIMIT
    // ============================================
    if (query.data.startsWith("sl_limit:")) {
      const limit = parseInt(query.data.split(":")[1]);
      userSettings[userId].sl_limit = limit > 0 ? limit : null;
      userSettings[userId].consecutive_losses = 0;
      userSettings[userId].skip_betting = false;
      await bot.sendMessage(chatId, `✅ SL: ${limit > 0 ? limit : 'Disabled'}`, {
        reply_markup: makeRiskControlKeyboard()
      });
      await bot.deleteMessage(chatId, messageId);
      return;
    }
    
    // ============================================
    // LAYER LIMIT
    // ============================================
    if (query.data.startsWith("layer_limit:")) {
      const limit = parseInt(query.data.split(":")[1]);
      userSettings[userId].layer_limit = limit > 0 ? limit : null;
      userSettings[userId].current_layer = 0;
      userSettings[userId].skip_betting = false;
      await bot.sendMessage(chatId, `✅ Layer: ${limit > 0 ? limit : 'Disabled'}`, {
        reply_markup: makeRiskControlKeyboard()
      });
      await bot.deleteMessage(chatId, messageId);
      return;
    }
    
  } catch (error) {
    console.error(`❌ Callback error:`, error);
    log('ERROR', `🧨 Callback error for user ${query?.from?.id}: ${error.message}`);
  }
});

// ============================================
// 📨 MESSAGE HANDLER
// ============================================

bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) {
    return;
  }
  
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const rawText = msg.text || "";
  const text = normalizeText(rawText);
  
  log('INFO', `📨 Message from user ${userId}: ${rawText}`);
  
  if (isUserBanned(userId)) {
    await sendMessageWithRetry(chatId, 
      `🚫 You have been banned from using this bot.\n\n📞 Contact admin @Thunwaiphyo for assistance.`
    );
    return;
  }
  
  const lines = text.split('\n').map(line => line.trim()).filter(line => line);
  const command = text.toUpperCase().replace(/[_\s\/\(\)]/g, '').replace('🔐', '');
  
  // Admin state handling
  if (userId === ADMIN_ID) {
    const currentState = userState[userId]?.state;
    
    if (currentState === "ADMIN_ADD_CHANNEL") {
      const args = rawText.split(' ');
      if (args.length < 2) {
        await sendMessageWithRetry(chatId, 
          `❌ Invalid format\n\nUse: @channel_id Channel Name\n\nExample: @DOLIVERjackoffical DOLIVER JACK OFFICIAL`
        );
        return;
      }
      
      const channelId = args[0];
      const channelName = args.slice(1).join(' ');
      
      try {
        await bot.getChat(channelId);
        
        const exists = requiredChannels.some(ch => ch.id === channelId);
        if (exists) {
          await sendMessageWithRetry(chatId, 
            `⚠️ Channel Already Exists\n\n📢 ${channelName}\n🔗 ${channelId}`
          );
        } else {
          requiredChannels.push({ id: channelId, name: channelName });
          await saveChannelConfig();
          
          await sendMessageWithRetry(chatId, 
            `🎄 Channel Added\n\n📢 ${channelName}\n🔗 ${channelId}\n\nTotal channels: ${requiredChannels.length}`,
            makeChannelManagementKeyboard()
          );
        }
      } catch (error) {
        await sendMessageWithRetry(chatId, 
          `❌ Invalid Channel\n\nMake sure:\n1. Bot is admin in channel\n2. Channel ID is correct\n3. Channel is public`
        );
      }
      
      delete userState[userId];
      return;
    } 
    else if (currentState === "ADMIN_REMOVE_CHANNEL") {
      const channelId = rawText.trim();
      
      const initialLength = requiredChannels.length;
      requiredChannels = requiredChannels.filter(ch => ch.id !== channelId);
      
      if (requiredChannels.length < initialLength) {
        await saveChannelConfig();
        await sendMessageWithRetry(chatId, 
          `🎄 Channel Removed\n\n🔗 ${channelId}\n\nRemaining channels: ${requiredChannels.length}`,
          makeChannelManagementKeyboard()
        );
      } else {
        await sendMessageWithRetry(chatId, 
          `⚠️ Channel Not Found\n\nChannel ID: ${channelId}`
        );
      }
      
      delete userState[userId];
      return;
    }
    else if (currentState === "ADMIN_BROADCAST") {
      await broadcastMessage(text, userId);
      delete userState[userId];
      return;
    } else if (currentState === "ADMIN_BAN_USER") {
      const userToBan = parseInt(text);
      
      if (isNaN(userToBan)) {
        await sendMessageWithRetry(chatId, "⚠️ Invalid User ID\n\nPlease provide a valid numeric user ID.");
        return;
      }
      
      await banUser(userToBan, text);
      
      try {
        await sendMessageWithRetry(userToBan, 
          `🚫 You have been banned from using this bot.\n\n📞 Contact admin @Thunwaiphyo for assistance.`
        );
      } catch (error) {
        log('ERROR', `❌ Failed to send ban message to user ${userToBan}: ${error.message}`);
      }
      
      await sendMessageWithRetry(chatId, `🎄 User ${userToBan} has been banned.`);
      delete userState[userId];
      return;
    } else if (currentState === "ADMIN_UNBAN_USER") {
      const userToUnban = parseInt(text);
      
      if (isNaN(userToUnban)) {
        await sendMessageWithRetry(chatId, "⚠️ Invalid User ID\n\nPlease provide a valid numeric user ID.");
        return;
      }
      
      if (!isUserBanned(userToUnban)) {
        await sendMessageWithRetry(chatId, `⚠️ User ${userToUnban} is not banned.`);
        delete userState[userId];
        return;
      }
      
      await unbanUser(userToUnban);
      
      try {
        await sendMessageWithRetry(userToUnban, 
          `🎄 Your ban has been lifted!\n\nYou can now use the bot again.\n\nType /start to begin.`
        );
      } catch (error) {
        log('ERROR', `❌ Failed to send unban message to user ${userToUnban}: ${error.message}`);
      }
      
      await sendMessageWithRetry(chatId, `🎄 User ${userToUnban} has been unbanned.`);
      delete userState[userId];
      return;
    }
  }
  
  const currentState = userState[userId]?.state;
  
  // Time start input handling
  if (currentState === "INPUT_TIME_START") {
    const startTime = text.trim();
    
    const result = addTimeStart(userId, startTime);
    
    if (result.success) {
      const display = getTimeStartDisplay(userId);
      await sendMessageWithRetry(chatId, 
        `🎄 ${result.message}\n\n${display}`,
        makeTimeStartKeyboard()
      );
    } else {
      await sendMessageWithRetry(chatId, 
        `❌ ${result.message}\n\nPlease try again.`,
        makeTimeStartKeyboard()
      );
    }
    
    delete userState[userId];
    return;
  }
  
  // 📟 API RULE Input Handler
  if (currentState === "INPUT_API_RULE") {
    const ruleLines = rawText.split('\n').map(line => line.trim()).filter(line => line);
    
    const ruleMap = {};
    let hasError = false;
    let errorMessage = "";

    for (const line of ruleLines) {
      const match = line.match(/^(\d+)\s*[=:]\s*([BS])$/i);
      if (!match) {
        hasError = true;
        errorMessage = `ပုံစံမှားနေပါသည်: "${line}"\n\nပုံစံ: 0=B or 1:S`;
        break;
      }
      
      const num = parseInt(match[1], 10);
      const val = match[2].toUpperCase();
      
      if (num >= 0 && num <= 9) {
        ruleMap[num] = val;
      } else {
        hasError = true;
        errorMessage = `ဂဏန်း ${num} က 0-9 ကြားမှာရှိရမယ်။`;
        break;
      }
    }

    if (hasError) {
      await sendMessageWithRetry(chatId, 
        `❌ ${errorMessage}\n\n` +
        `ကျေးဇူးပြု၍ အောက်ပါအတိုင်းရိုက်ပါ။\n\n` +
        `✅ 0=B\n` +
        `✅ 1=S\n` +
        `✅ 2 = B\n` +
        `✅ 3 : S`,
        makeRiskControlKeyboard()
      );
      return;
    }

    if (Object.keys(ruleMap).length === 0) {
      await sendMessageWithRetry(chatId, 
        `❌ အနည်းဆုံး rule တစ်ခုတော့ထည့်ပေးပါ။\n\n` +
        `ဥပမာ:\n` +
        `0=B\n` +
        `1=S`,
        makeRiskControlKeyboard()
      );
      return;
    }

    userSettings[userId].api_rule_map = ruleMap;
    userSettings[userId].strategy = "API_RULE";

    const ruleList = Object.entries(ruleMap)
      .map(([num, bs]) => `${num} → ${bs === 'B' ? 'BIG' : 'SMALL'}`)
      .join('\n');

    await sendMessageWithRetry(chatId, 
      `📟 API RULE သိမ်းပြီးပါပြီ!\n\n` +
      `📋 သင့်ရဲ့ Rules:\n${ruleList}\n\n` +
      `🎲 စုစုပေါင်း: ${Object.keys(ruleMap).length} rule(s)\n\n` +
      `✅ သင်ထည့်ထားတဲ့ ဂဏန်းတွေကျမှ ထိုးပါမယ်။\n` +
      `❌ မထည့်ထားတဲ့ ဂဏန်းကျရင် Skip လုပ်ပါမယ်။`,
      makeRiskControlKeyboard()
    );

    delete userState[userId];
    return;
  }
  
  // Login handling
  if (command === "LOGIN" || (lines.length > 0 && lines[0].toLowerCase() === "login")) {
    if (lines.length >= 3 && lines[0].toLowerCase() === "login") {
      const username = lines[1];
      const password = lines[2];
      
      log('INFO', `🔐 Processing login for user ${userId}: username=${username}`);
      await sendMessageWithRetry(chatId, "🔍 အကောင့်ဝင်နေတယ်...");
      
      const [res, session] = await loginRequest(username, password);
      
      if (session) {
        const userInfo = await getUserInfo(session, userId);
        
        if (userInfo && userInfo.user_id) {
          userSessions[userId] = session;
          userGameInfo[userId] = userInfo;
          userTemp[userId] = { password };
          
          if (!userSettings[userId]) {
            userSettings[userId] = {
              platform: '6LOTTERY',
              mode: "REAL",
              strategy: "API_RULE",
              betting_strategy: "MARTINGALE",
              martin_index: 0,
              dalembert_units: 1,
              pattern_index: 0,
              running: false,
              consecutive_losses: 0,
              current_layer: 0,
              skip_betting: false,
              game_type: "TRX",
              api_rule_map: {}
            };
          } else {
            userSettings[userId].platform = '6LOTTERY';
          }
          
          const balance = await getBalanceWithRetry(session, userId);
          userStats[userId] = { start_balance: parseFloat(balance || 0), profit: 0.0 };
          
          const balanceDisplay = balance !== null ? balance : 0.0;
          await sendMessageWithRetry(chatId, formatLoginSuccess(userInfo, balanceDisplay), makeMainKeyboard(true, userId));
        } else {
          await sendMessageWithRetry(chatId, 
            `❌ Login Failed\n\nUnable to retrieve user information.\n\n🔑 Please check your credentials and try again`,
            makeLoginKeyboard()
          );
        }
      } else {
        const errorMsg = res.msg || "Login failed";
        await sendMessageWithRetry(chatId, 
          `❌ Login Error\n\n${errorMsg}\n\n🔑 Please check your credentials and try again`,
          makeLoginKeyboard()
        );
      }
      
      delete userState[userId];
      return;
    }
    
    if (lines.length === 1 && lines[0].toLowerCase() === "login") {
      userState[userId] = { state: "WAIT_PHONE" };
      await sendMessageWithRetry(chatId, 
        `📱 ဖုန်းနံပါတ်ထည့်ပါ\n\nဖုန်းနံပါတ်ထည့်ပါ (country code မပါ):\n\n9123456789\n\n⚠️ "95" မထည့်ပါနဲ့`
      );
      return;
    }
    
    if (userState[userId]?.state === "WAIT_PHONE") {
      userTemp[userId] = { ...userTemp[userId], phone: text };
      userState[userId] = { state: "WAIT_PASS" };
      await sendMessageWithRetry(chatId, 
        `🔐 စကားဝှက်ထည့်ပါ\n\nသင့်စကားဝှက်ကိုထည့်ပါ:`
      );
      return;
    }
    
    if (userState[userId]?.state === "WAIT_PASS") {
      const phone = userTemp[userId]?.phone;
      const password = text;
      
      if (!phone) {
        await sendMessageWithRetry(chatId, formatWelcomeMessage(), makeLoginKeyboard());
        return;
      }
      
      log('INFO', `🔐 Processing login for user ${userId}: username=${phone}`);
      await sendMessageWithRetry(chatId, "🔍 အကောင့်ဝင်နေတယ်...");
      
      const [res, session] = await loginRequest(phone, password);
      
      if (session) {
        const userInfo = await getUserInfo(session, userId);
        
        if (userInfo && userInfo.user_id) {
          userSessions[userId] = session;
          userGameInfo[userId] = userInfo;
          userTemp[userId] = { password };
          
          if (!userSettings[userId]) {
            userSettings[userId] = {
              platform: '6LOTTERY',
              mode: "REAL",
              strategy: "API_RULE",
              betting_strategy: "MARTINGALE",
              martin_index: 0,
              dalembert_units: 1,
              pattern_index: 0,
              running: false,
              consecutive_losses: 0,
              current_layer: 0,
              skip_betting: false,
              game_type: "TRX",
              api_rule_map: {}
            };
          } else {
            userSettings[userId].platform = '6LOTTERY';
          }
          
          const balance = await getBalanceWithRetry(session, userId);
          userStats[userId] = { start_balance: parseFloat(balance || 0), profit: 0.0 };
          
          const balanceDisplay = balance !== null ? balance : 0.0;
          await sendMessageWithRetry(chatId, formatLoginSuccess(userInfo, balanceDisplay), makeMainKeyboard(true, userId));
        } else {
          await sendMessageWithRetry(chatId, 
            `❌ Login Failed\n\nUnable to retrieve user information.\n\n🔑 Please check your credentials and try again`,
            makeLoginKeyboard()
          );
        }
      } else {
        const errorMsg = res.msg || "Login failed";
        await sendMessageWithRetry(chatId, 
          `❌ Login Error\n\n${errorMsg}\n\n🔑 Please check your credentials and try again`,
          makeLoginKeyboard()
        );
      }
      
      delete userState[userId];
      return;
    }
    
    await sendMessageWithRetry(chatId, 
      `🔐 Login Instructions\n\n🎮 Example:\nLOGIN\n9123456789\npassword123`
    );
    return;
  }
  
  // Check if user is logged in
  const isLoggedIn = checkUserLoggedIn(userId);
  
  if (!isLoggedIn) {
    if (rawText === "🔐 LOGIN 🔐") {
      await sendMessageWithRetry(chatId, formatWelcomeMessage(), makeLoginKeyboard());
      return;
    }
    
    await sendMessageWithRetry(chatId, 
      `🔐 Login Required\n\nPlease login first to use the bot features.\n\n👇 Click LOGIN button:`,
      makeLoginKeyboard()
    );
    return;
  }
  
  if (!userSettings[userId]) {
    userSettings[userId] = {
      mode: "REAL",
      strategy: "API_RULE",
      betting_strategy: "MARTINGALE",
      martin_index: 0,
      dalembert_units: 1,
      pattern_index: 0,
      running: false,
      consecutive_losses: 0,
      current_layer: 0,
      skip_betting: false,
      game_type: "TRX",
      api_rule_map: {}
    };
  }
  
  try {
    const currentState = userState[userId] ? userState[userId].state : null;
    const settings = userSettings[userId] ? userSettings[userId] : {};
    
    // State-based input handling
    if (currentState === "INPUT_BET_SIZES") {
      const betSizes = lines.filter(s => /^\d+$/.test(s)).map(Number);
      
      if (!betSizes.length) {
        throw new Error("No valid numbers provided");
      }
      
      userSettings[userId].bet_sizes = betSizes;
      userSettings[userId].dalembert_units = 1;
      await sendMessageWithRetry(chatId, 
        `💰 Bet Sizes Updated\n\n🧩 Sizes: ${betSizes.join(', ')} MMK\n\n🎄 Bet sizes configured successfully`,
        makeMainKeyboard(true, userId)
      );
      delete userState[userId];
      
    } else if (currentState === "INPUT_PROFIT_TARGET") {
      const target = parseFloat(lines[0]);
      
      if (isNaN(target) || target <= 0) {
        throw new Error("Invalid profit target amount");
      }
      
      userSettings[userId].target_profit = target;
      await sendMessageWithRetry(chatId, 
        `🎯 Profit Target Updated\n\n🧩 Target: ${target.toFixed(2)} Ks\n\n🎄 Target profit configured successfully`,
        makeRiskControlKeyboard()
      );
      delete userState[userId];
      
    } else if (currentState === "INPUT_STOP_LIMIT") {
      const stopLoss = parseFloat(lines[0]);
      
      if (isNaN(stopLoss) || stopLoss <= 0) {
        throw new Error("Invalid stop loss amount");
      }
      
      userSettings[userId].stop_loss = stopLoss;
      await sendMessageWithRetry(chatId, 
        `🛑 Stop Loss Updated\n\n📉 Limit: ${stopLoss.toFixed(2)} Ks\n\n🎄 Stop loss configured successfully`,
        makeRiskControlKeyboard()
      );
      delete userState[userId];
      
    } else {
      // Menu Button Handling
      if (rawText.trim() === "⚡ ACT") {
        log('INFO', `⚡ ACTIVATE command for user ${userId}, settings: ${JSON.stringify(settings)}`);
        
        if (!settings.bet_sizes || settings.bet_sizes.length === 0) {
          await sendMessageWithRetry(chatId,
            `🧨 ERROR: Bet Size မထည့်ရသေးပါ!\n\n` +
            `🎋 Bet size အရင်ထည့်ပါ!\n\n` +
            `⚙️ "BET SIZE" ကိုနှိပ်ပါ\n` +
            `📝 တစ်ကြောင်းချင်းစီထည့်ပါ:\n` +
            `100\n300\n700\n1500\n\n` +
            `🚫 Bet size မရှိရင် Bot မစနိုင်ပါ!`,
            makeMainKeyboard(true, userId)
          );
          return;
        }
        
        if (settings.betting_strategy === "D'ALEMBERT" && settings.bet_sizes.length > 1) {
          await sendMessageWithRetry(chatId, 
            `⚠️ D'ALEMBERT Configuration\n\nD'ALEMBERT အတွက် BET SIZE တစ်ခုတည်းသာထည့်ပါ။\n\n⚙️ BET SIZE ကိုပြန်သတ်မှတ်ပါ`,
            makeMainKeyboard(true, userId)
          );
          return;
        }
        
        if (settings.running) {
          await sendMessageWithRetry(chatId, 
            `⚠️ Bot စနေပြီးသားပါ\n\nThe bot is already active.\n\n⏸️ Stop the bot first to change settings`,
            makeMainKeyboard(true, userId)
          );
          return;
        }
        
        settings.martin_index = 0;
        settings.dalembert_units = 1;
        settings.pattern_index = 0;
        settings.consecutive_losses = 0;
        settings.current_layer = 0;
        settings.skip_betting = false;
        settings.running = true;
        settings.consecutive_errors = 0;
        userWaitingForResult[userId] = false;
        
        if (!isWithinTimeStart(userId)) {
          const timeStarts = getTimeStartDisplay(userId);
          await sendMessageWithRetry(chatId, 
            `⏰ Time Start Restriction\n\nBot က သတ်မှတ်ချိန်မှသာ အလုပ်လုပ်ပါမယ်:\n\n${timeStarts}\n\nလက်ရှိအချိန်က သတ်မှတ်ချိန်မဟုတ်ပါ။ စောင့်ဆိုင်းနေပါမယ်။`,
            makeMainKeyboard(true, userId)
          );
        }
        
        settings.task = bettingWorker(userId, chatId);
        
      } else if (rawText.trim() === "⏸️ DEACT") {
        const settings = userSettings[userId] || {};
        
        if (!settings.running) {
          await sendMessageWithRetry(chatId, 
            `⚠️ Bot ရပ်နေပြီးသားပါ\n\nThe bot is currently stopped.\n\n⚡ Use ACTIVATE to begin`,
            makeMainKeyboard(true, userId)
          );
          return;
        }
        
        settings.running = false;
        
        if (settings.task) {
          if (typeof settings.task === 'object' && typeof settings.task.cancel === 'function') {
            settings.task.cancel();
          }
          settings.task = null;
        }
        
        delete userWaitingForResult[userId];
        
        if (userProfitMessageId[userId]) {
          try {
            await bot.deleteMessage(userId, userProfitMessageId[userId]);
          } catch (error) {
            log('INFO', `⚠️ Could not delete profit message: ${error.message}`);
          }
          delete userProfitMessageId[userId];
        }
        
        await sendMessageWithRetry(chatId, 
          `⏸️ Stopping Bot\n\nBot shutdown in progress...\n\n⏳ Please wait for confirmation`
        );
        
      } else if (rawText.trim() === "💰 BET") {
        userState[userId] = { state: "INPUT_BET_SIZES" };
        await sendMessageWithRetry(chatId, 
          `💰 Bet Size ထည့်ပါ\n\nBet sizes ကို MMK နဲ့ထည့်ပါ (တစ်ကြောင်းချင်းစီ):\n\n100\n200\n500\n\n💡 ဥပမာ: 100 = 100KS`,
          makeMainKeyboard(true, userId)
        );
        
      } else if (rawText.trim() === "🔊 SILENT" || rawText.trim() === "🔇 SILENT") {
        userSilentMode[userId] = !userSilentMode[userId];
        
        const modeText = userSilentMode[userId] ? "🔇 SILENT MODE" : "🔊 SILENT MODE";
        const statusText = userSilentMode[userId] ? 
          "(Silent Mode On)\n\n🎄 အနိုင်အရှုံး notification မပေးတော့ပါ\n📊 Profit update တွေကို auto-edit လုပ်ပါမယ်" :
          "(Silent Mode Off)\n\n🎄 အနိုင်အရှုံး notification ပေးပါတယ်";
        
        await sendMessageWithRetry(chatId, 
          `${modeText}\n\n${statusText}`,
          makeMainKeyboard(true, userId)
        );
        
      } else if (rawText.trim() === "⚙️ RISK") {
        await sendMessageWithRetry(chatId, "⚙️ Risk Control Menu:", makeRiskControlKeyboard());
        
      } else if (rawText.trim() === "🎮 GAME") {
        await sendMessageWithRetry(chatId, "🎮 Game Type ရွေးပါ:", makeGameTypeKeyboard());
        
      } else if (rawText.trim() === "⏰ TIME") {
        await sendMessageWithRetry(chatId, "⏰ Time Start Settings:", makeTimeStartKeyboard());
        
      } else if (rawText.trim() === "ℹ️ INFO") {
        const session = userSessions[userId];
        const userInfo = await getUserInfo(session, userId);
        
        let currentBalance = null;
        if (session) {
          currentBalance = await getBalanceWithRetry(session, userId);
        }
        
        const gameType = settings.game_type || "TRX";
        const infoMessage = formatInfoMessage(userInfo, settings, currentBalance, gameType, userId);
        await sendMessageWithRetry(chatId, infoMessage, makeMainKeyboard(true, userId));
        
      } else if (rawText.trim() === "🔄 RE-LOGIN 🔄") {
        delete userSessions[userId];
        delete userTemp[userId];
        delete userSettings[userId]?.platform;
        await sendMessageWithRetry(chatId, 
          `🔄 Re-Login\n\nSession cleared. Please login again.`,
          makeLoginKeyboard()
        );
        
      } else if (rawText.trim() === "🔄 ANTI/MARTINGALE 🔄") {
        await sendMessageWithRetry(chatId, "🔄 Betting Strategy ရွေးပါ:", makeBettingStrategyKeyboard());
        
      } else if (rawText.trim() === "🎲 GAME TYPE 🎲") {
        await sendMessageWithRetry(chatId, "🎮 Game Type ရွေးပါ:", makeGameTypeKeyboard());
        
      } else if (rawText.trim() === "🔙 BACK TO MAIN 🔙") {
        await sendMessageWithRetry(chatId, "🔙 Main Menu ကိုပြန်သွားမယ်...", makeMainKeyboard(true, userId));
        
      } else if (rawText.trim() === "🎯 PROFIT TARGET 🎯") {
        userState[userId] = { state: "INPUT_PROFIT_TARGET" };
        await sendMessageWithRetry(chatId, 
          `🎯 Profit Target ထည့်ပါ\n\nTarget profit ကို Ks နဲ့ထည့်ပါ:\n\n5000\n\n💡 ဒီပမာဏရောက်ရင် Bot ရပ်သွားပါမယ်`,
          makeRiskControlKeyboard()
        );
        
      } else if (rawText.trim() === "🛑 STOP LOSS 🛑") {
        userState[userId] = { state: "INPUT_STOP_LIMIT" };
        await sendMessageWithRetry(chatId, 
          `🛑 Stop Loss ထည့်ပါ\n\nအရှုံးကန့်သတ်ချက်ကို Ks နဲ့ထည့်ပါ:\n\nဥပမာ: 5000\n\n🧩 ဒီပမာဏအရှုံးရောက်ရင် Bot ရပ်သွားပါမယ်`,
          makeRiskControlKeyboard()
        );
        
      } else if (rawText.trim() === "🎢 ENTRY LAYER 🎢") {
        await sendMessageWithRetry(chatId, "🎢 Entry Layer ရွေးပါ:", makeEntryLayerKeyboard());
        
      } else if (rawText.trim() === "💥 SL LIMIT 💥") {
        await sendMessageWithRetry(chatId, "💥 SL (Stop Loss) limit ရွေးပါ:", makeNumberPadKeyboard("sl_limit", "SL Limit"));
        
      } else if (rawText.trim() === "📚 STRATEGY 📚") {
        await sendMessageWithRetry(chatId, "📚 Strategy ရွေးပါ:", makeRiskControlStrategyKeyboard());
        
      } else if (rawText.trim() === "🔙 BACK TO RISK 🔙") {
        await sendMessageWithRetry(chatId, "🔙 Risk Control ကိုပြန်သွားမယ်...", makeRiskControlKeyboard());
        
      } else if (rawText.trim() === "📟 API RULE 📟") {
        userState[userId] = { state: "INPUT_API_RULE" };
        await sendMessageWithRetry(chatId, 
          `📟 API RULE Selected!\n\n` +
          `ကျေးဇူးပြု၍ သင်အလိုရှိသော Rule များကိုရိုက်ထည့်ပါ။\n\n` +
          `📝 Format: ဂဏန်း = B သို့မဟုတ် S\n\n` +
          `ဥပမာ:\n` +
          `0=B\n` +
          `1=S\n` +
          `2=B\n` +
          `3=S\n` +
          `5=B\n\n` +
          `✅ 0-9 ထိ ကြိုက်သလောက်ထည့်နိုင်ပါတယ်။\n` +
          `❌ မထည့်ထားတဲ့ ဂဏန်းကျရင် Skip လုပ်ပါမယ်။`,
          makeRiskControlKeyboard()
        );
        
      } else if (rawText.trim() === "📈 ANTI-MARTINGALE 📈") {
        userSettings[userId].betting_strategy = "ANTI-MARTINGALE";
        await sendMessageWithRetry(chatId, `🎄 Betting Strategy ကို ANTI-MARTINGALE ထားပြီးပါပြီ`, makeBetPlaceSettingsKeyboard());
        
      } else if (rawText.trim() === "📉 MARTINGALE 📉") {
        userSettings[userId].betting_strategy = "MARTINGALE";
        await sendMessageWithRetry(chatId, `🎄 Betting Strategy ကို MARTINGALE ထားပြီးပါပြီ`, makeBetPlaceSettingsKeyboard());
        
      } else if (rawText.trim() === "⚖️ D'ALEMBERT ⚖️") {
        userSettings[userId].betting_strategy = "D'ALEMBERT";
        await sendMessageWithRetry(chatId, `🎄 Betting Strategy ကို D'ALEMBERT ထားပြီးပါပြီ`, makeBetPlaceSettingsKeyboard());
        
      } else if (rawText.trim() === "🎰 TRX 🎰") {
        userSettings[userId].game_type = "TRX";
        await sendMessageWithRetry(chatId, `🎄 Game Type ကို TRX ထားပြီးပါပြီ`, makeBetPlaceSettingsKeyboard());
        
      } else if (rawText.trim() === "⚡ WINGO30S ⚡") {
        userSettings[userId].game_type = "WINGO30S";
        await sendMessageWithRetry(chatId, `🎄 Game Type ကို WINGO30S ထားပြီးပါပြီ`, makeBetPlaceSettingsKeyboard());
        
      } else if (rawText.trim() === "⏱️ WINGO1MIN ⏱️") {
        userSettings[userId].game_type = "WINGO1MIN";
        await sendMessageWithRetry(chatId, `🎄 Game Type ကို WINGO1MIN ထားပြီးပါပြီ`, makeBetPlaceSettingsKeyboard());
        
      } else if (rawText.trim() === "🕒 WINGO3MIN 🕒") {
        userSettings[userId].game_type = "WINGO3MIN";
        await sendMessageWithRetry(chatId, `🎄 Game Type ကို WINGO3MIN ထားပြီးပါပြီ`, makeBetPlaceSettingsKeyboard());
        
      } else if (rawText.trim() === "⌛ WINGO5MIN ⌛") {
        userSettings[userId].game_type = "WINGO5MIN";
        await sendMessageWithRetry(chatId, `🎄 Game Type ကို WINGO5MIN ထားပြီးပါပြီ`, makeBetPlaceSettingsKeyboard());
        
      } else if (rawText.trim() === "🔙 BACK 🔙") {
        await sendMessageWithRetry(chatId, "🔙 Bet Settings ကိုပြန်သွားမယ်...", makeBetPlaceSettingsKeyboard());
        
      } else {
        await sendMessageWithRetry(chatId, 
          `🤔 Command မှားနေပါတယ်\n\nPlease use the menu buttons below:\n\n👇 Select an option from the menu:`,
          makeMainKeyboard(true, userId)
        );
      }
    }
  } catch (error) {
    log('ERROR', `🧨 ERROR handling input for user ${userId}: ${error.message}`);
    await sendMessageWithRetry(chatId, 
      `🧨 ERROR\n\n${error.message}\n\n🔄 Please try again or contact support`,
      makeMainKeyboard(true, userId)
    );
  }
});

// ============================================
// 🚀 BOT INITIALIZATION
// ============================================

const init = async () => {
  try {
    try {
      await fs.access(BANNED_USERS_FILE);
    } catch {
      await saveBannedUsers();
    }
    
    try {
      await fs.access(TIME_START_FILE);
    } catch {
      await saveTimeStartSettings();
    }
    
    try {
      await fs.access(CHANNEL_CONFIG_FILE);
    } catch {
      await saveChannelConfig();
    }
    
    await loadBannedUsers();
    await loadTimeStartSettings();
    await loadChannelConfig();
    
    global.winLoseTask = winLoseChecker();
    
    log('INFO', '🤖 6LOTTERY Bot Initialized');
    log('INFO', `📢 Required Channels: ${requiredChannels.length}`);
    log('INFO', '⚡ Fast Mode: ENABLED');
    log('INFO', '🛡️ User Management System: ACTIVE');
    log('INFO', '⏰ Time Start System: ENABLED');
    log('INFO', '🔊 Silent Mode: ENABLED');
    log('INFO', '📊 Auto-Edit Profit: ENABLED');
    log('INFO', '📢 Channel Verification: ENABLED');
    log('INFO', '📟 Strategy: API RULE (Only)');
    log('INFO', '🎄 Bot is ready and listening for commands');
    
    console.log('\n' + '='.repeat(60));
    console.log('🤖 6LOTTERY AUTO BET BOT');
    console.log('='.repeat(60));
    console.log(`📢 Required Channels: ${requiredChannels.length}`);
    console.log('⚡ Fast Mode: ENABLED');
    console.log('🔊 Silent Mode: ENABLED');
    console.log('📊 Auto-Edit Profit: ENABLED');
    console.log('📢 Channel Verification: ENABLED');
    console.log('📟 Strategy: API RULE (Only)');
    console.log(`💰 Balance Retries: ${MAX_BALANCE_RETRIES}`);
    console.log(`⏱️ Balance Timeout: ${BALANCE_API_TIMEOUT}ms`);
    console.log('👑 Admin ID:', ADMIN_ID);
    console.log('📞 Admin: @Thunwaiphyo');
    console.log('🚀 Status: RUNNING');
    console.log('='.repeat(60) + '\n');
    
  } catch (error) {
    log('ERROR', `❌ Failed to initialize bot: ${error.message}`);
    console.error('❌ Bot initialization failed:', error);
    process.exit(1);
  }
};

// Handle process termination
process.on('SIGINT', () => {
  log('INFO', '⏹️ Bot shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('INFO', '⏹️ Bot terminating...');
  process.exit(0);
});

// Start the bot
init().catch(error => {
  log('ERROR', `❌ Failed to start bot: ${error.message}`);
  console.error('❌ Bot startup failed:', error);
  process.exit(1);
});