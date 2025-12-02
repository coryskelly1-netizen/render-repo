// =========================================================
//  Remote Browser Proxy - Optimized for Render Free Tier
// =========================================================

import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ------------------------------
// Valid Keys with Names
// ------------------------------
// IMPORTANT: Move these to environment variables for security!
// In Render: Dashboard → Environment → Add Variable
// Key: VALID_KEYS_JSON
// Value: {"8392017":"Alice","4928371":"Bob","1029384":"Charlie"}
let VALID_KEYS = {};

// Load keys from environment variable or use defaults
try {
  if (process.env.VALID_KEYS_JSON) {
    VALID_KEYS = JSON.parse(process.env.VALID_KEYS_JSON);
    console.log('✅ Loaded keys from environment variables');
  } else {
    // Fallback to hardcoded (NOT SECURE - only for testing)
    console.warn('⚠️ WARNING: Using hardcoded keys! Set VALID_KEYS_JSON environment variable for security!');
    VALID_KEYS = {
      "8392017": "Alice",
      "4928371": "Bob",
      "1029384": "Charlie"
    };
  }
} catch (error) {
  console.error('❌ Error loading keys:', error);
  VALID_KEYS = {};
}

// ------------------------------
// Global Browser (ONE INSTANCE)
// ------------------------------

let browser = null;
let sessions = new Map(); // sessionId -> { page, lastActive, userName, userKey }

// Store navigation logs for ToS enforcement
const navigationLogs = [];

// Session timeout: 2 hours of inactivity
const SESSION_TIMEOUT = 2 * 60 * 60 * 1000;

// Render free tier flags
async function launchBrowser() {
  if (browser) return browser;

  console.log('🚀 Launching shared browser instance...');
  browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--single-process",
      "--no-zygote",
      "--renderer-process-limit=1"
    ],
    defaultViewport: null,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    timeout: 60000
  });

  console.log("✅ Browser launched");
  return browser;
}

// Generate simple session IDs
function makeId() {
  return Math.random().toString(36).substring(2, 12);
}

// ------------------------------
// Root endpoint
// ------------------------------
app.get("/", (req, res) => {
  res.json({ 
    status: "online",
    service: "Puppeteer Proxy Server - RAM Optimized",
    activeSessions: sessions.size,
    endpoints: {
      health: "/health",
      validate: "/validate?key=YOUR_KEY&name=YOUR_NAME",
      createSession: "POST /session/create",
      navigate: "POST /session/navigate",
      click: "POST /session/click",
      screenshot: "GET /session/screenshot/:sessionId",
      back: "POST /session/back",
      forward: "POST /session/forward",
      scroll: "POST /session/scroll",
      type: "POST /session/type",
      closeSession: "POST /session/close"
    }
  });
});

// ------------------------------
// Health
// ------------------------------
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok",
    service: "puppeteer-proxy",
    activeSessions: sessions.size,
    browserActive: browser !== null
  });
});

// ------------------------------
// Key Validation
// ------------------------------
app.get("/validate", (req, res) => {
  const key = req.query.key;
  const name = req.query.name;
  
  console.log('🔍 Validation request - Key:', key, 'Name:', name);
  
  const valid = VALID_KEYS[key] && VALID_KEYS[key].toLowerCase() === name?.toLowerCase();
  
  console.log('✅ Validation result:', valid ? 'VALID' : 'INVALID');
  
  res.json({ 
    valid, 
    expectedName: VALID_KEYS[key] 
  });
});

// ------------------------------
//  Create Session
// ------------------------------
app.post("/session/create", async (req, res) => {
  const { userName, userKey } = req.body;
  
  console.log(`📥 Session creation request from: ${userName}`);
  
  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const sessionId = makeId();
    sessions.set(sessionId, { 
      page, 
      lastActive: Date.now(),
      userName: userName || 'Unknown',
      userKey: userKey || 'Unknown'
    });

    // Log session creation
    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId,
      userName: userName || 'Unknown',
      userKey: userKey || 'Unknown',
      action: 'SESSION_CREATED',
      ip: req.ip || req.connection.remoteAddress
    };
    navigationLogs.push(logEntry);
    console.log('📝 LOG:', JSON.stringify(logEntry));

    console.log(`✅ Session created: ${sessionId} (Total: ${sessions.size})`);
    res.json({ success: true, sessionId });
  } catch (err) {
    console.error("❌ Create session error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------------
//  Navigate
// ------------------------------
app.post("/session/navigate", async (req, res) => {
  const { sessionId, url } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    let safeUrl = url;
    if (!/^https?:\/\//i.test(safeUrl)) safeUrl = "https://" + safeUrl;

    await session.page.goto(safeUrl, { 
      waitUntil: "domcontentloaded", 
      timeout: 30000 
    }).catch(() => {}); // Ignore navigation timeouts

    const title = await session.page.title();
    const currentUrl = session.page.url();
    session.lastActive = Date.now();

    // Log navigation
    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId,
      userName: session.userName,
      userKey: session.userKey,
      action: 'NAVIGATE',
      url: currentUrl,
      pageTitle: title,
      ip: req.ip || req.connection.remoteAddress
    };
    navigationLogs.push(logEntry);
    console.log('📝 LOG:', JSON.stringify(logEntry));

    res.json({ success: true, title, url: currentUrl });
  } catch (e) {
    console.error('Navigation error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ------------------------------
//  Screenshot (WebP)
// ------------------------------
app.get("/session/screenshot/:id", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();

  const quality = req.query.quality || "medium";
  const qualityMap = { low: 40, medium: 60, high: 80 };
  const q = qualityMap[quality] || 60;

  try {
    const buf = await session.page.screenshot({
      type: "webp",
      quality: q,
      captureBeyondViewport: false,
      optimizeForSpeed: true
    });

    session.lastActive = Date.now();
    res.set("Content-Type", "image/webp");
    res.set("Cache-Control", "no-store, max-age=0");
    res.send(buf);
  } catch (err) {
    console.error('Screenshot error:', err);
    res.status(500).end();
  }
});

// ------------------------------
//  Click
// ------------------------------
app.post("/session/click", async (req, res) => {
  const { sessionId, x, y } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.mouse.click(x, y);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    session.lastActive = Date.now();
    
    const title = await session.page.title();
    const currentUrl = session.page.url();
    
    res.json({ success: true, title, url: currentUrl });
  } catch (e) {
    console.error('Click error:', e);
    res.json({ success: false, error: e.message });
  }
});

// ------------------------------
//  Back
// ------------------------------
app.post("/session/back", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.goBack({ waitUntil: "domcontentloaded" });
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// ------------------------------
//  Forward
// ------------------------------
app.post("/session/forward", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.goForward({ waitUntil: "domcontentloaded" });
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// ------------------------------
//  Scroll
// ------------------------------
app.post("/session/scroll", async (req, res) => {
  const { sessionId, dx, dy } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.mouse.wheel({ deltaX: dx, deltaY: dy });
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// ------------------------------
//  Typing
// ------------------------------
app.post("/session/type", async (req, res) => {
  const { sessionId, text, selector } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    if (selector) {
      await session.page.waitForSelector(selector, { timeout: 5000 });
      await session.page.type(selector, text);
    } else {
      await session.page.keyboard.type(text);
    }
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ------------------------------
//  Close Session
// ------------------------------
app.post("/session/close", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (session) {
    try { await session.page.close(); } catch {}
    sessions.delete(sessionId);
    console.log(`🗑️ Session closed: ${sessionId} (Remaining: ${sessions.size})`);
  }
  res.json({ success: true });
});

// ------------------------------
// Admin: Get Logs
// ------------------------------
app.get("/admin/logs", (req, res) => {
  const adminKey = req.query.adminKey;
  
  // Get admin key from environment variable for security
  const ADMIN_KEY = process.env.ADMIN_KEY || 'admin_access_2024';
  
  if (adminKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({ 
    success: true, 
    logs: navigationLogs, 
    totalLogs: navigationLogs.length 
  });
});

// ------------------------------
// Admin: Clear Logs
// ------------------------------
app.post("/admin/clear-logs", (req, res) => {
  const { adminKey } = req.body;
  
  // Get admin key from environment variable for security
  const ADMIN_KEY = process.env.ADMIN_KEY || 'admin_access_2024';
  
  if (adminKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const clearedCount = navigationLogs.length;
  navigationLogs.length = 0;
  console.log(`🗑️ Cleared ${clearedCount} log entries`);
  res.json({ success: true, clearedCount });
});

// ------------------------------
// Automatic Session Cleanup
// ------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastActive > SESSION_TIMEOUT) {
      try { sess.page.close(); } catch {}
      sessions.delete(id);
      console.log("⏱️ Cleaned idle session:", id);
    }
  }
}, 60000); // Check every minute

// ------------------------------
// Graceful Shutdown
// ------------------------------
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, closing browser...');
  if (browser) {
    await browser.close();
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Puppeteer proxy running on port ${PORT}`);
  console.log(`💾 RAM-optimized mode: Single browser, multiple tabs`);
  console.log(`📊 Max sessions recommended: 3-5 concurrent`);
});