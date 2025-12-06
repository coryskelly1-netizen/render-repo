// server.js - Improved version with better error handling and cleanup
import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = process.env.NODE_ENV === 'production' ? 2 : 5; // Lower limit for free tier
const SESSION_TIMEOUT = 20 * 60 * 1000; // 20 minutes (before Render auto-sleeps)

/* ------------ USER KEYS (should be in environment variables) ------------ */
const VALID_KEYS = process.env.USER_KEYS 
  ? JSON.parse(process.env.USER_KEYS)
  : {
      "Alice": "8392017",
      "Bob": "4928371",
      "Charlie": "1029384"
    };

/* ------------ PUPPETEER BROWSER ------------ */
let browser = null;
let browserInitializing = false;

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  
  if (browserInitializing) {
    // Wait for initialization to complete
    while (browserInitializing) {
      await new Promise(r => setTimeout(r, 100));
    }
    return browser;
  }

  browserInitializing = true;
  console.log("Launching Chromium...");

  try {
    const execPath = await chromium.executablePath();

    browser = await puppeteer.launch({
      executablePath: execPath,
      headless: chromium.headless,
      args: [
        ...chromium.args,
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--single-process",
        "--no-zygote"
      ]
    });

    console.log("✅ Chromium launched successfully");
    browserInitializing = false;
    return browser;
  } catch (error) {
    console.error("❌ Failed to launch browser:", error);
    browserInitializing = false;
    throw error;
  }
}

/* ------------ API ROUTES ------------ */
app.get("/", (req, res) => {
  res.json({ 
    status: "online",
    sessions: sessions.size,
    maxSessions: MAX_SESSIONS
  });
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok",
    browserConnected: browser?.isConnected() || false,
    activeSessions: sessions.size
  });
});

app.get("/validate", (req, res) => {
  const { name, key } = req.query;
  
  if (!name || !key) {
    return res.json({ valid: false, error: "Missing credentials" });
  }
  
  const valid = VALID_KEYS[name] === key;
  
  if (!valid) {
    console.log(`❌ Invalid login attempt: ${name}`);
  }
  
  res.json({ valid });
});

/* ------------ WEBSOCKET SETUP ------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const sessions = new Map();

/*
session = {
  ws,
  page,
  userName,
  streaming,
  lastActivity,
  createdAt
}
*/

/* ------------ SESSION CLEANUP ------------ */
async function cleanupSession(ws) {
  const session = sessions.get(ws);
  if (!session) return;

  console.log(`🧹 Cleaning up session for ${session.userName}`);
  
  session.streaming = false;
  
  try {
    if (session.page && !session.page.isClosed()) {
      await session.page.close();
    }
  } catch (error) {
    console.error("Error closing page:", error.message);
  }
  
  sessions.delete(ws);
}

// Periodic cleanup of idle sessions
setInterval(() => {
  const now = Date.now();
  sessions.forEach((session, ws) => {
    if (now - session.lastActivity > SESSION_TIMEOUT) {
      console.log(`⏰ Session timeout for ${session.userName}`);
      try {
        ws.close();
      } catch (e) {
        console.error("Error closing WebSocket:", e.message);
      }
      cleanupSession(ws);
    }
  });
}, 60000); // Check every minute

/* ------------ STREAM LOOP (MJPEG) ------------ */
async function startStream(session) {
  if (session.streaming) return;
  
  session.streaming = true;
  const ws = session.ws;
  let frameCount = 0;

  console.log(`📹 Starting stream for ${session.userName}`);

  while (session.streaming && ws.readyState === ws.OPEN) {
    try {
      const frame = await session.page.screenshot({
        type: "jpeg",
        quality: 50, // Lower quality for better performance
        optimizeForSpeed: true
      });
      
      if (ws.readyState === ws.OPEN) {
        ws.send(frame);
        frameCount++;
      }
      
      session.lastActivity = Date.now();
    } catch (error) {
      console.error(`Screenshot error for ${session.userName}:`, error.message);
      break;
    }

    await new Promise(r => setTimeout(r, 100)); // ~10 FPS
  }

  console.log(`🛑 Stream stopped for ${session.userName} (${frameCount} frames)`);
  session.streaming = false;
}

/* ------------ CREATE SESSION ------------ */
async function createSession(ws, userName) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error("Maximum sessions reached");
  }

  console.log(`🆕 Creating session for ${userName}`);
  
  const browser = await ensureBrowser();
  const page = await browser.newPage();

  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  // Block unnecessary resources for better performance
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const resourceType = request.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      request.abort();
    } else {
      request.continue();
    }
  });

  const session = { 
    ws, 
    page, 
    userName, 
    streaming: false,
    lastActivity: Date.now(),
    createdAt: Date.now()
  };
  
  sessions.set(ws, session);
  console.log(`✅ Session created for ${userName} (${sessions.size}/${MAX_SESSIONS})`);

  return session;
}

/* ------------ WS CONNECTION ------------ */
wss.on("connection", (ws) => {
  console.log("🔌 New WebSocket connection");
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", async (raw) => {
    let msg;
    try { 
      msg = JSON.parse(raw); 
    } catch { 
      console.error("Invalid JSON message");
      return; 
    }

    if (msg.type !== "control") return;

    let session = sessions.get(ws);

    // Create new page
    if (msg.action === "create") {
      try {
        if (session) {
          ws.send(JSON.stringify({
            type: "error",
            message: "Session already exists"
          }));
          return;
        }

        session = await createSession(ws, msg.userName);
        ws.send(JSON.stringify({
          type: "info",
          action: "created"
        }));
      } catch (error) {
        console.error("Error creating session:", error);
        ws.send(JSON.stringify({
          type: "error",
          message: error.message
        }));
      }
      return;
    }

    if (!session) {
      ws.send(JSON.stringify({
        type: "error",
        message: "No active session"
      }));
      return;
    }

    session.lastActivity = Date.now();

    // Handle actions
    try {
      switch (msg.action) {
        case "navigate":
          const url = /^https?:\/\//i.test(msg.url) ? msg.url : "https://" + msg.url;
          await session.page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000
          });
          break;

        case "startStream":
          if (!session.streaming) {
            startStream(session);
          }
          break;

        case "click":
          await session.page.mouse.click(msg.x, msg.y);
          break;

        case "scroll":
          await session.page.mouse.wheel({
            deltaX: msg.dx || 0,
            deltaY: msg.dy || 0
          });
          break;

        case "type":
          if (msg.text) {
            await session.page.keyboard.type(msg.text, { delay: 12 });
          }
          break;

        case "back":
          await session.page.goBack({ waitUntil: "domcontentloaded" });
          break;

        case "forward":
          await session.page.goForward({ waitUntil: "domcontentloaded" });
          break;

        case "close":
          await cleanupSession(ws);
          ws.close();
          break;
      }
    } catch (error) {
      console.error(`Error handling ${msg.action}:`, error.message);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WebSocket closed");
    cleanupSession(ws);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
    cleanupSession(ws);
  });
});

/* ---- WS Heartbeat ---- */
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      console.log("💀 Terminating dead connection");
      cleanupSession(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

/* ---- Graceful Shutdown ---- */
process.on('SIGTERM', async () => {
  console.log("📡 SIGTERM received, shutting down gracefully...");
  
  clearInterval(heartbeatInterval);
  
  // Close all sessions
  for (const [ws, session] of sessions) {
    await cleanupSession(ws);
    ws.close();
  }
  
  // Close browser
  if (browser) {
    await browser.close();
  }
  
  server.close(() => {
    console.log("✅ Server closed");
    process.exit(0);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
  console.log(`📊 Max sessions: ${MAX_SESSIONS}`);
});