import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ================================
// CONFIG
// ================================
const PORT = process.env.PORT || 3000;

// Load keys from environment variable or use defaults
let VALID_KEYS = {};
try {
  if (process.env.VALID_KEYS_JSON) {
    VALID_KEYS = JSON.parse(process.env.VALID_KEYS_JSON);
    console.log('✅ Loaded keys from environment variables');
  } else {
    console.warn('⚠️ WARNING: Using hardcoded keys!');
    VALID_KEYS = {
      "8392017": "Alice",
      "4928371": "Bob",
      "1029384": "Charlie"
    };
  }
} catch (error) {
  console.error('❌ Error loading keys:', error);
  VALID_KEYS = {
    "8392017": "Alice",
    "4928371": "Bob",
    "1029384": "Charlie"
  };
}

// ================================
// SESSION STORAGE
// ================================
const sessions = new Map();
const navigationLogs = [];

// Single shared browser instance (RAM optimization)
let sharedBrowser = null;

async function getBrowser() {
  if (!sharedBrowser || !sharedBrowser.isConnected()) {
    console.log('🚀 Launching shared browser...');
    sharedBrowser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1366, height: 768 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });
    console.log('✅ Browser ready');
  }
  return sharedBrowser;
}

// ================================
// ROOT ENDPOINT
// ================================
app.get("/", (req, res) => {
  res.json({ 
    status: "online",
    service: "Puppeteer Proxy Server",
    activeSessions: sessions.size,
    endpoints: {
      health: "/health",
      validate: "/validate?key=YOUR_KEY&name=YOUR_NAME",
      createSession: "POST /session/create",
      navigate: "POST /session/navigate",
      screenshot: "GET /session/screenshot/:id",
      click: "POST /session/click",
      scroll: "POST /session/scroll"
    }
  });
});

// ================================
// HEALTH
// ================================
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok",
    activeSessions: sessions.size,
    browserActive: sharedBrowser !== null
  });
});

// ================================
// VALIDATE LOGIN
// ================================
app.get("/validate", (req, res) => {
  const key = req.query.key;
  const name = req.query.name;

  console.log('🔍 Validation - Key:', key, 'Name:', name);

  if (!key || !name) {
    return res.json({ valid: false });
  }

  // Check if key exists and name matches (case-insensitive)
  const valid = VALID_KEYS[key] && VALID_KEYS[key].toLowerCase() === name.toLowerCase();
  
  console.log('✅ Result:', valid ? 'VALID' : 'INVALID');

  res.json({ 
    valid: valid,
    expectedName: VALID_KEYS[key]
  });
});

// ================================
// CREATE SESSION
// ================================
app.post("/session/create", async (req, res) => {
  try {
    const userName = req.body.userName || "unknown";
    const sessionId = Math.random().toString(36).slice(2);

    console.log("📥 Creating session:", sessionId, "for", userName);

    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    sessions.set(sessionId, { 
      page, 
      userName,
      lastActive: Date.now()
    });

    // Log session creation
    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId,
      userName,
      action: 'SESSION_CREATED',
      ip: req.ip || req.connection.remoteAddress
    };
    navigationLogs.push(logEntry);
    console.log('📝 LOG:', JSON.stringify(logEntry));

    console.log("✅ Session created:", sessionId, "(Total:", sessions.size + ")");
    
    res.json({ 
      success: true,
      sessionId: sessionId 
    });
  } catch (e) {
    console.error("❌ Session create error:", e);
    res.status(500).json({ 
      success: false,
      error: e.message 
    });
  }
});

// ================================
// NAVIGATE
// ================================
app.post("/session/navigate", async (req, res) => {
  const { sessionId, url } = req.body;

  if (!sessions.has(sessionId)) {
    return res.json({ success: false, error: "invalid session" });
  }

  try {
    const session = sessions.get(sessionId);
    const { page } = session;
    
    let safeUrl = url;
    if (!/^https?:\/\//i.test(safeUrl)) safeUrl = "https://" + safeUrl;
    
    await page.goto(safeUrl, { 
      waitUntil: "domcontentloaded", 
      timeout: 30000 
    }).catch(() => {}); // Ignore timeouts
    
    const title = await page.title();
    const currentUrl = page.url();
    
    session.lastActive = Date.now();

    // Log navigation
    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId,
      userName: session.userName,
      action: 'NAVIGATE',
      url: currentUrl,
      pageTitle: title,
      ip: req.ip || req.connection.remoteAddress
    };
    navigationLogs.push(logEntry);
    console.log('📝 LOG:', JSON.stringify(logEntry));

    res.json({ 
      success: true,
      title: title,
      url: currentUrl
    });
  } catch (e) {
    console.error("Navigation error:", e);
    res.json({ success: false, error: e.message });
  }
});

// ================================
// SCREENSHOT
// ================================
app.get("/session/screenshot/:id", async (req, res) => {
  const sessionId = req.params.id;
  const quality = req.query.quality || "medium";

  if (!sessions.has(sessionId)) {
    return res.status(404).end();
  }

  try {
    const session = sessions.get(sessionId);
    const { page } = session;

    const qualityMap = { low: 40, medium: 60, high: 80 };
    const q = qualityMap[quality] || 60;

    const buffer = await page.screenshot({
      type: "webp",
      quality: q,
      optimizeForSpeed: true
    });

    session.lastActive = Date.now();

    res.set("Content-Type", "image/webp");
    res.set("Cache-Control", "no-store");
    res.send(buffer);

  } catch (e) {
    console.error("Screenshot error:", e);
    res.status(500).end();
  }
});

// ================================
// CLICK
// ================================
app.post("/session/click", async (req, res) => {
  const { sessionId, x, y } = req.body;

  if (!sessions.has(sessionId)) {
    return res.json({ success: false, error: "invalid session" });
  }

  try {
    const session = sessions.get(sessionId);
    const { page } = session;
    
    await page.mouse.click(x, y);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    session.lastActive = Date.now();
    
    const title = await page.title();
    const currentUrl = page.url();

    res.json({ 
      success: true,
      title: title,
      url: currentUrl
    });
  } catch (e) {
    console.error("Click error:", e);
    res.json({ success: false, error: e.message });
  }
});

// ================================
// SCROLL
// ================================
app.post("/session/scroll", async (req, res) => {
  const { sessionId, dx, dy } = req.body;

  if (!sessions.has(sessionId)) {
    return res.json({ success: false, error: "invalid session" });
  }

  try {
    const session = sessions.get(sessionId);
    const { page } = session;
    
    await page.mouse.wheel({ deltaX: dx, deltaY: dy });
    
    session.lastActive = Date.now();
    
    res.json({ success: true });
  } catch (e) {
    console.error("Scroll error:", e);
    res.json({ success: false, error: e.message });
  }
});

// ================================
// CLOSE SESSION
// ================================
app.post("/session/close", async (req, res) => {
  const { sessionId } = req.body;
  
  if (sessions.has(sessionId)) {
    try {
      const session = sessions.get(sessionId);
      await session.page.close();
      sessions.delete(sessionId);
      console.log(`🗑️ Session closed: ${sessionId} (Remaining: ${sessions.size})`);
    } catch (e) {
      console.error("Close error:", e);
    }
  }
  
  res.json({ success: true });
});

// ================================
// ADMIN: GET LOGS
// ================================
app.get("/admin/logs", (req, res) => {
  const adminKey = req.query.adminKey;
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

// ================================
// ADMIN: CLEAR LOGS
// ================================
app.post("/admin/clear-logs", (req, res) => {
  const { adminKey } = req.body;
  const ADMIN_KEY = process.env.ADMIN_KEY || 'admin_access_2024';
  
  if (adminKey !== ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const clearedCount = navigationLogs.length;
  navigationLogs.length = 0;
  console.log(`🗑️ Cleared ${clearedCount} log entries`);
  res.json({ success: true, clearedCount });
});

// ================================
// CLEANUP (AUTO CLOSE IDLE SESSIONS)
// ================================
const SESSION_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours

setInterval(async () => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    try {
      if (now - session.lastActive > SESSION_TIMEOUT) {
        console.log("⏱️ Cleaning idle session:", id);
        await session.page.close();
        sessions.delete(id);
      }
    } catch (e) {
      console.error("Cleanup error:", e);
      sessions.delete(id);
    }
  }
}, 60000); // Check every minute

// ================================
// GRACEFUL SHUTDOWN
// ================================
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, closing browser...');
  if (sharedBrowser) {
    await sharedBrowser.close();
  }
  process.exit(0);
});

// ================================
// START SERVER
// ================================
app.listen(PORT, () => {
  console.log("🚀 Server ready on port", PORT);
  console.log("💾 RAM-optimized: Single shared browser");
});