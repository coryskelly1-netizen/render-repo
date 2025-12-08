// server.js - Render-friendly remote browser server
import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();

/* -------- Middleware & CORS -------- */
app.use(cors());
app.enable("strict routing");
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});
app.use(express.json({ limit: "2mb" }));

/* -------- Config -------- */
const PORT = process.env.PORT || 3000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS || 1); // keep low for free tier
const SCREENSHOT_QUALITY = Number(process.env.SCREENSHOT_QUALITY || 50);
const SCREENSHOT_INTERVAL_MS = Number(process.env.SCREENSHOT_INTERVAL_MS || 100); // ~10 FPS

/* -------- Simple keys (replace with env USER_KEYS in production) -------- */
const VALID_KEYS = process.env.USER_KEYS
  ? JSON.parse(process.env.USER_KEYS)
  : { "Alice": "8392017", "Bob": "4928371", "Charlie": "1029384" };

/* -------- Puppeteer / Chromium (Render-safe) -------- */
let browser = null;
let browserInitializing = false;

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browserInitializing) {
    // wait for existing initialization
    while (browserInitializing) await new Promise(r => setTimeout(r, 100));
    if (browser && browser.isConnected()) return browser;
  }
  browserInitializing = true;
  console.log("Launching Chromium (Render safe) ...");

  try {
    // sparticuz exposes executablePath (may be async property or function)
    const execPath = typeof chromium.executablePath === "function"
      ? await chromium.executablePath()
      : chromium.executablePath;

    browser = await puppeteer.launch({
      executablePath: execPath,
      headless: true,
      ignoreHTTPSErrors: true,
      defaultViewport: { width: 1366, height: 768 },
      args: [
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--single-process",
        "--no-zygote",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-breakpad",
        "--disable-extensions",
        "--disable-sync",
        "--hide-scrollbars",
        "--mute-audio",
        "--no-first-run",
        "--disable-features=site-per-process"
      ]
    });

    console.log("✅ Chromium launched successfully");
    browserInitializing = false;
    return browser;
  } catch (err) {
    console.error("❌ Chromium launch failed:", err && err.message ? err.message : err);
    browserInitializing = false;
    throw err;
  }
}

/* -------- HTTP routes -------- */
app.get("/", (req, res) => {
  res.json({ status: "online" });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    browserConnected: !!(browser && browser.isConnected())
  });
});

app.get("/validate", (req, res) => {
  const { name, key } = req.query;
  if (!name || !key) return res.json({ valid: false });
  const valid = VALID_KEYS[name] === key;
  if (!valid) console.log(`Invalid login attempt for ${name}`);
  res.json({ valid });
});

/* -------- WebSocket streaming server -------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 50 * 1024 * 1024 });

const sessions = new Map(); // ws -> { ws, page, userName, streaming, lastActivity }

/* helper - create new browser page session */
async function createSession(ws, userName) {
  if (sessions.size >= MAX_SESSIONS) {
    throw new Error("Maximum sessions reached");
  }

  const b = await ensureBrowser();
  const page = await b.newPage();

  await page.setViewport({ width: 1366, height: 768 });
  // block heavy resources to reduce memory/CPU
  await page.setRequestInterception(true);
  page.on("request", req => {
    const t = req.resourceType();
    if (["image", "media", "font"].includes(t)) req.abort();
    else req.continue();
  });

  const session = { ws, page, userName, streaming: false, lastActivity: Date.now(), createdAt: Date.now() };
  sessions.set(ws, session);
  console.log(`✅ Session created for ${userName} (${sessions.size}/${MAX_SESSIONS})`);
  return session;
}

/* streaming loop - send JPEG frames to client */
async function startStream(session) {
  if (session.streaming) return;
  session.streaming = true;
  const ws = session.ws;
  const page = session.page;
  console.log(`📹 Starting stream for ${session.userName}`);

  try {
    while (session.streaming && ws.readyState === ws.OPEN) {
      try {
        const frame = await page.screenshot({ type: "jpeg", quality: SCREENSHOT_QUALITY, optimizeForSpeed: true });
        if (ws.readyState === ws.OPEN) ws.send(frame);
        session.lastActivity = Date.now();
      } catch (err) {
        console.warn("Screenshot error:", err && err.message ? err.message : err);
        break;
      }
      await new Promise(r => setTimeout(r, SCREENSHOT_INTERVAL_MS));
    }
  } finally {
    session.streaming = false;
    console.log(`🛑 Stream stopped for ${session.userName}`);
  }
}

/* cleanup session */
async function cleanupSession(ws) {
  const s = sessions.get(ws);
  if (!s) return;
  s.streaming = false;
  try { if (s.page && !s.page.isClosed()) await s.page.close(); } catch {}
  sessions.delete(ws);
  console.log(`🧹 Cleaned session for ${s.userName}`);
}

/* WS connection handling */
wss.on("connection", ws => {
  console.log("🔌 WebSocket connection");
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type !== "control") return;

    let session = sessions.get(ws);

    // create session
    if (msg.action === "create") {
      try {
        session = await createSession(ws, msg.userName || "guest");
        ws.send(JSON.stringify({ type: "info", action: "created" }));
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", message: err.message || "create failed" }));
      }
      return;
    }

    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "No active session" }));
      return;
    }

    session.lastActivity = Date.now();

    // actions
    try {
      switch (msg.action) {
        case "startStream":
          startStream(session);
          break;
        case "navigate": {
          let url = msg.url || "";
          if (!/^https?:\/\//i.test(url)) url = "https://" + url;
          await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          break;
        }
        case "click":
          await session.page.mouse.click(Math.round(msg.x), Math.round(msg.y)).catch(() => {});
          break;
        case "scroll":
          await session.page.mouse.wheel({ deltaY: Number(msg.dy) || 0 }).catch(() => {});
          break;
        case "type":
          if (msg.text) await session.page.keyboard.type(String(msg.text)).catch(() => {});
          break;
        case "back":
          await session.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
          break;
        case "forward":
          await session.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
          break;
        case "close":
          await cleanupSession(ws);
          ws.close();
          break;
      }
    } catch (err) {
      console.error("Action error:", err && err.message ? err.message : err);
    }
  });

  ws.on("close", () => {
    console.log("🔌 WS closed");
    cleanupSession(ws);
  });

  ws.on("error", err => {
    console.error("WS error:", err && err.message ? err.message : err);
    cleanupSession(ws);
  });
});

/* heartbeat - clean dead sockets */
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      try { ws.terminate(); } catch (e) {}
      cleanupSession(ws);
      return;
    }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 20000);

/* session timeout cleanup (idle) */
setInterval(() => {
  const now = Date.now();
  for (const [ws, s] of sessions) {
    if (now - s.lastActivity > (20 * 60 * 1000)) { // 20 min
      try { ws.terminate(); } catch {}
      cleanupSession(ws);
    }
  }
}, 60000);

/* graceful shutdown */
process.on("SIGTERM", async () => {
  console.log("SIGTERM - shutting down");
  clearInterval(heartbeat);
  for (const [ws] of sessions) { try { ws.terminate(); } catch {} }
  if (browser) try { await browser.close(); } catch {}
  server.close(() => process.exit(0));
});

/* start server listening */
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server live on port", PORT);
});
