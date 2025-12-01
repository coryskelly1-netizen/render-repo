// server.js - RAM OPTIMIZED
// Uses a SINGLE shared browser with multiple tabs instead of one browser per session

import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
app.use(cors());
app.use(express.json());

// Centralized valid keys with names
let VALID_KEYS = {
  "8392017": "Alice",
  "4928371": "Bob",
  "1029384": "Charlie"
};

// SINGLE shared browser instance (saves RAM!)
let sharedBrowser = null;

// Store active sessions (now just pages, not full browsers)
const sessions = new Map();

// Store navigation logs for ToS enforcement
const navigationLogs = [];

// Session cleanup after 2 hours of inactivity (was 15 minutes)
const SESSION_TIMEOUT = 2 * 60 * 60 * 1000; // 2 hours

// Recommended viewport for 720p Chromebooks
const VIEWPORT = { width: 1366, height: 768, deviceScaleFactor: 1 };

// Initialize shared browser on startup
async function initBrowser() {
  if (!sharedBrowser) {
    console.log('🚀 Launching shared browser instance...');
    try {
      sharedBrowser = await puppeteer.launch({
        args: [
          ...chromium.args,
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-accelerated-2d-canvas',
          '--disable-software-rasterizer',
          '--single-process' // Important for low RAM
        ],
        defaultViewport: VIEWPORT,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        timeout: 60000 // 60 second timeout for launch
      });
      console.log('✅ Shared browser ready');
    } catch (error) {
      console.error('❌ Browser launch failed:', error);
      sharedBrowser = null;
      throw error;
    }
  }
  return sharedBrowser;
}

// Root endpoint
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
      type: "POST /session/type",
      screenshot: "GET /session/screenshot/:sessionId",
      closeSession: "POST /session/close"
    }
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    service: "puppeteer-proxy",
    activeSessions: sessions.size,
    browserActive: sharedBrowser !== null
  });
});

// Key validation
app.get("/validate", (req, res) => {
  const key = req.query.key;
  const name = req.query.name;
  const valid = VALID_KEYS[key] && VALID_KEYS[key].toLowerCase() === name?.toLowerCase();
  res.json({ valid, expectedName: VALID_KEYS[key] });
});

// Create new session (just a new tab in shared browser)
app.post("/session/create", async (req, res) => {
  const sessionId = generateSessionId();
  const { userName, userKey } = req.body;
  
  console.log(`📥 Session creation request from: ${userName}`);
  
  try {
    // Ensure shared browser is running
    console.log('🔍 Checking browser status...');
    const browser = await initBrowser();
    console.log('✅ Browser available, creating new page...');
    
    // Create new tab (page) instead of new browser
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    
    console.log('✅ Page created, setting user agent...');
    
    // Set user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const session = {
      page,
      lastActivity: Date.now(),
      timeout: null,
      userName: userName || 'Unknown',
      userKey: userKey || 'Unknown'
    };
    
    sessions.set(sessionId, session);
    
    // Set cleanup timeout
    resetSessionTimeout(sessionId);
    
    // Log session creation
    const logEntry = {
      timestamp: new Date().toISOString(),
      sessionId,
      userName: session.userName,
      userKey: session.userKey,
      action: 'SESSION_CREATED',
      ip: req.ip || req.connection.remoteAddress
    };
    navigationLogs.push(logEntry);
    console.log('📝 LOG:', JSON.stringify(logEntry));
    
    console.log(`✅ Session created: ${sessionId} (Total: ${sessions.size})`);
    res.json({ success: true, sessionId });
  } catch (error) {
    console.error('❌ Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session', message: error.message });
  }
});

// Navigate to URL
app.post("/session/navigate", async (req, res) => {
  const { sessionId, url } = req.body;
  
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    let safeUrl = url;
    if (!/^https?:\/\//i.test(safeUrl)) safeUrl = "https://" + safeUrl;

    await session.page.goto(safeUrl, { 
      waitUntil: 'domcontentloaded', // Faster than networkidle2
      timeout: 30000 
    }).catch(() => { /* ignore navigation timeouts */ });
    
    session.lastActivity = Date.now();
    resetSessionTimeout(sessionId);
    
    const title = await session.page.title();
    const currentUrl = session.page.url();
    
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
    
    res.json({ 
      success: true, 
      title,
      url: currentUrl
    });
  } catch (error) {
    console.error('Navigation error:', error);
    res.status(500).json({ error: 'Navigation failed', message: error.message });
  }
});

// Click at coordinates
app.post("/session/click", async (req, res) => {
  const { sessionId, x, y } = req.body;
  
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    await session.page.mouse.click(x, y);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    session.lastActivity = Date.now();
    resetSessionTimeout(sessionId);
    
    const title = await session.page.title();
    const currentUrl = session.page.url();
    
    res.json({ 
      success: true,
      title,
      url: currentUrl
    });
  } catch (error) {
    console.error('Click error:', error);
    res.status(500).json({ error: 'Click failed', message: error.message });
  }
});

// Type text
app.post("/session/type", async (req, res) => {
  const { sessionId, text, selector } = req.body;
  
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    if (selector) {
      await session.page.waitForSelector(selector, { timeout: 5000 });
      await session.page.type(selector, text);
    } else {
      await session.page.keyboard.type(text);
    }
    
    session.lastActivity = Date.now();
    resetSessionTimeout(sessionId);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Type error:', error);
    res.status(500).json({ error: 'Type failed', message: error.message });
  }
});

// Screenshot: returns binary WebP image
app.get("/session/screenshot/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const quality = req.query.quality || 'medium';
  
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    // WebP quality mapping
    const qualitySettings = {
      low: { type: 'webp', quality: 40 },
      medium: { type: 'webp', quality: 55 },
      high: { type: 'webp', quality: 75 }
    };
    
    const settings = qualitySettings[quality] || qualitySettings.medium;

    // Take webp screenshot (binary Buffer)
    const buffer = await session.page.screenshot({
      type: settings.type,
      quality: settings.quality,
      fullPage: false,
      optimizeForSpeed: true
    });

    session.lastActivity = Date.now();
    resetSessionTimeout(sessionId);

    res.set("Content-Type", "image/webp");
    res.set("Cache-Control", "no-store, max-age=0");
    res.send(buffer);
  } catch (error) {
    console.error('Screenshot error:', error);
    res.status(500).json({ error: 'Screenshot failed', message: error.message });
  }
});

// Close session (just close the tab, not the browser)
app.post("/session/close", async (req, res) => {
  const { sessionId } = req.body;
  await closeSession(sessionId);
  res.json({ success: true });
});

// Get navigation logs
app.get("/admin/logs", (req, res) => {
  const adminKey = req.query.adminKey;
  if (adminKey !== 'admin_secure_key_123') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ success: true, logs: navigationLogs, totalLogs: navigationLogs.length });
});

// Clear logs
app.post("/admin/clear-logs", (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== 'admin_secure_key_123') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const clearedCount = navigationLogs.length;
  navigationLogs.length = 0;
  console.log(`🗑️ Cleared ${clearedCount} log entries`);
  res.json({ success: true, clearedCount });
});

// Helper functions
function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function resetSessionTimeout(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  
  // Extended timeout - only close after 2 hours of complete inactivity
  session.timeout = setTimeout(() => {
    console.log(`⏱️ Session ${sessionId} timed out after 2 hours of inactivity`);
    closeSession(sessionId);
  }, SESSION_TIMEOUT);
}

async function closeSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;
  
  if (session.timeout) {
    clearTimeout(session.timeout);
  }
  
  try {
    // Just close the page/tab, not the whole browser
    await session.page.close();
  } catch (error) {
    console.error('Error closing page:', error);
  }
  
  sessions.delete(sessionId);
  console.log(`🗑️ Session closed: ${sessionId} (Remaining: ${sessions.size})`);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, closing browser...');
  if (sharedBrowser) {
    await sharedBrowser.close();
  }
  process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Puppeteer proxy running on port ${PORT}`);
  console.log(`💾 RAM-optimized mode: Single browser, multiple tabs`);
  console.log(`📊 Max sessions recommended: 3-5 concurrent`);
});