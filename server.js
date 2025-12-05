// server.js
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

// Simple in-memory valid keys (edit as you like)
const VALID_KEYS = {
  "Alice": "8392017",
  "Bob": "4928371",
  "Charlie": "1029384"
};

// Global single browser instance (shared)
let browser = null;
async function ensureBrowser() {
  if (browser) return browser;
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
    executablePath: await chromium.executablePath(),
    headless: chromium.headless
  });
  console.log("Launched Chromium");
  return browser;
}

// REST endpoints for health / validate
app.get("/", (req, res) => {
  res.json({ status: "online", msg: "WebSocket MJPEG proxy" });
});
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/validate", (req, res) => {
  const name = req.query.name || "";
  const key = req.query.key || "";
  const valid = VALID_KEYS[name] && VALID_KEYS[name] === key;
  res.json({ valid: !!valid });
});

// Start HTTP server and attach WebSocket server
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/*
Session model:
Each ws connection gets an entry:
{
  ws,
  page,           // puppeteer Page
  lastActive,     // timestamp
  streaming,      // boolean streaming loop state
}
*/
const sessions = new Map();

// Helper: stream loop - send JPEG frames over ws as binary
async function streamLoop(ws, session) {
  if (!session || !session.page) return;
  session.streaming = true;
  try {
    while (ws.readyState === ws.OPEN) {
      try {
        // small throttle for CPU/memory tradeoff. ~20-30 fps -> 33-50ms waits.
        const buf = await session.page.screenshot({ type: "jpeg", quality: 60 });
        // send as binary
        ws.send(buf);
      } catch (err) {
        console.warn("screenshot error:", err?.message || err);
        // if screenshot fails, give a short pause and retry
      }
      // sleep ~80ms -> ~12 fps; you can lower to 50ms for ~20fps if CPU allows
      await new Promise(r => setTimeout(r, 80));
    }
  } finally {
    session.streaming = false;
  }
}

// Helper: create a new page for a connection
async function createSessionForWS(ws, userName = "unknown") {
  const browser = await ensureBrowser();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  const id = Math.random().toString(36).slice(2, 12);
  const session = { ws, page, id, userName, lastActive: Date.now(), streaming: false };
  sessions.set(ws, session);

  // optional: set user agent
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  // on page error, log
  page.on("error", e => console.error("Page error:", e));
  page.on("pageerror", e => console.error("Page pageerror:", e));

  return session;
}

// Handle incoming WS connections
wss.on("connection", (ws, req) => {
  console.log("WS client connected");
  // We'll create a session once client sends a create action.
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", async (data, isBinary) => {
    // Text messages are control JSON. Binary messages could be ignored.
    if (isBinary) {
      // ignore binary from client
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) {
      console.warn("Invalid JSON from client");
      return;
    }

    // Control message format: { type: "control", action: "...", ... }
    if (msg.type !== "control") return;

    try {
      if (msg.action === "create") {
        const userName = msg.userName || "unknown";
        const session = await createSessionForWS(ws, userName);
        // Start streaming when client asks for it; we also send ack
        ws.send(JSON.stringify({ type: "info", action: "created", sessionId: session.id }));
      } else if (msg.action === "navigate") {
        const session = sessions.get(ws);
        if (!session) return ws.send(JSON.stringify({ type: "error", error: "no session" }));
        const url = msg.url;
        // ensure scheme
        const safeUrl = (/^https?:\/\//i.test(url)) ? url : "https://" + url;
        await session.page.goto(safeUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(e => {});
        session.lastActive = Date.now();
        ws.send(JSON.stringify({ type: "info", action: "navigated", url: session.page.url(), title: await session.page.title() }).catch(()=>{}));
      } else if (msg.action === "startStream") {
        const session = sessions.get(ws);
        if (!session) return ws.send(JSON.stringify({ type: "error", error: "no session" }));
        if (!session.streaming) streamLoop(ws, session).catch(()=>{});
      } else if (msg.action === "click") {
        const session = sessions.get(ws);
        if (!session) return;
        const { x, y } = msg;
        await session.page.mouse.click(x, y).catch(()=>{});
        session.lastActive = Date.now();
      } else if (msg.action === "scroll") {
        const session = sessions.get(ws);
        if (!session) return;
        const dx = msg.dx || 0;
        const dy = msg.dy || 0;
        // try mouse wheel
        await session.page.mouse.wheel({ deltaX: dx, deltaY: dy }).catch(async ()=> {
          // fallback: evaluate window.scrollBy
          await session.page.evaluate((sx, sy) => { window.scrollBy(sx, sy); }, dx, dy).catch(()=>{});
        });
        session.lastActive = Date.now();
      } else if (msg.action === "type") {
        const session = sessions.get(ws);
        if (!session) return;
        const text = msg.text || "";
        // type the exact text
        await session.page.keyboard.type(text, { delay: 8 }).catch(()=>{});
        session.lastActive = Date.now();
      } else if (msg.action === "back") {
        const session = sessions.get(ws);
        if (!session) return;
        await session.page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(()=>{});
        session.lastActive = Date.now();
      } else if (msg.action === "forward") {
        const session = sessions.get(ws);
        if (!session) return;
        await session.page.goForward({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(()=>{});
        session.lastActive = Date.now();
      } else if (msg.action === "close") {
        const session = sessions.get(ws);
        if (session) {
          try { await session.page.close(); } catch {}
          sessions.delete(ws);
        }
      }
    } catch (err) {
      console.error("control handling error", err);
    }
  });

  ws.on("close", async () => {
    console.log("WS closed, cleaning session");
    const session = sessions.get(ws);
    if (session) {
      try { await session.page.close(); } catch {}
      sessions.delete(ws);
    }
  });
});

// ping/pong to detect dead clients
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// cleanup old pages every few minutes (safeguard)
setInterval(async () => {
  const now = Date.now();
  for (const [ws, s] of sessions) {
    if (!s.lastActive) continue;
    if (now - s.lastActive > 1000 * 60 * 30) { // 30 minutes idle
      try { await s.page.close(); } catch {}
      sessions.delete(ws);
    }
  }
}, 60_000);

server.listen(PORT, () => {
  console.log("Server listening on port", PORT);
});
