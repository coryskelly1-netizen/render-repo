// server.js
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

// Store active browser sessions
const sessions = new Map();

// Store navigation logs for ToS enforcement
const navigationLogs = [];

// Session cleanup after 15 minutes of inactivity
const SESSION_TIMEOUT = 15 * 60 * 1000;

// Root endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "online",
    service: "Puppeteer Proxy Server - Remote Browser",
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
    activeSessions: sessions.size 
  });
});

// Key validation
app.get("/validate", (req, res) => {
  const key = req.query.key;
  const name = req.query.name;
  const valid = VALID_KEYS[key] && VALID_KEYS[key].toLowerCase() === name?.toLowerCase();
  res.json({ valid, expectedName: VALID_KEYS[key] });
});

// Create new browser session
app.post("/session/create", async (req, res) => {
  const sessionId = generateSessionId();
  const { userName, userKey } = req.body;
  
  try {
    const browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 800 },
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });
    
    const page = await browser.newPage();
    
    // Set a reasonable user agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    const session = {
      browser,
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
    
    console.log(`Session created: ${sessionId}`);
    res.json({ success: true, sessionId });
  } catch (error) {
    console.error('Error creating session:', error);
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
    await session.page.goto(url, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
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
    
    // Shorter wait for faster response (was 500ms)
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

// Get screenshot
app.get("/session/screenshot/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const quality = req.query.quality || 'medium'; // low, medium, high
  
  const session = sessions.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }
  
  try {
    // Quality settings for speed vs quality tradeoff
    const qualitySettings = {
      low: { type: 'jpeg', quality: 40 },
      medium: { type: 'jpeg', quality: 70 },
      high: { type: 'jpeg', quality: 90 }
    };
    
    const settings = qualitySettings[quality] || qualitySettings.medium;
    
    const screenshot = await session.page.screenshot({ 
      encoding: 'base64',
      fullPage: false,
      ...settings
    });
    
    session.lastActivity = Date.now();
    resetSessionTimeout(sessionId);
    
    const title = await session.page.title();
    const currentUrl = session.page.url();
    
    res.json({ 
      success: true,
      screenshot: `data:image/jpeg;base64,${screenshot}`,
      title,
      url: currentUrl
    });
  } catch (error) {
    console.error('Screenshot error:', error);
    res.status(500).json({ error: 'Screenshot failed', message: error.message });
  }
});

// Close session
app.post("/session/close", async (req, res) => {
  const { sessionId } = req.body;
  
  await closeSession(sessionId);
  res.json({ success: true });
});

// Get navigation logs (for ToS enforcement)
app.get("/admin/logs", (req, res) => {
  // Optional: Add admin authentication here
  const adminKey = req.query.adminKey;
  
  // Simple admin key check (you can change this)
  if (adminKey !== 'admin_secure_key_123') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  res.json({ 
    success: true, 
    logs: navigationLogs,
    totalLogs: navigationLogs.length
  });
});

// Clear logs (admin only)
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
  
  session.timeout = setTimeout(() => {
    console.log(`Session ${sessionId} timed out`);
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
    await session.browser.close();
  } catch (error) {
    console.error('Error closing browser:', error);
  }
  
  sessions.delete(sessionId);
  console.log(`Session closed: ${sessionId}`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Puppeteer proxy running on port ${PORT}`);
  console.log(`Chromium path: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'default'}`);
});