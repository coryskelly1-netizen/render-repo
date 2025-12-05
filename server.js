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

// ---- VALID USER KEYS ----
const VALID_KEYS = {
  "Alice": "8392017",
  "Bob": "4928371",
  "Charlie": "1029384"
};

// ---- SINGLE BROWSER INSTANCE ----
let browser = null;

async function ensureBrowser() {
  if (browser) return browser;

  console.log("Launching headless Chromium...");

  const execPath = await chromium.executablePath;

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
      "--no-zygote",
      "--renderer-process-limit=1"
    ]
  });

  console.log("Chromium launched");
  return browser;
}

// ---- REST ROUTES ----
app.get("/", (req, res) => res.json({ status: "online" }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/validate", (req, res) => {
  const name = req.query.name || "";
  const key = req.query.key || "";
  const valid = VALID_KEYS[name] === key;
  res.json({ valid });
});

// ---- HTTP + WS SERVER ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/*
Each WebSocket = 1 session:
{
  ws,
  page,
  id,
  lastActive,
  streaming
}
*/
const sessions = new Map();

// ---- STREAM LOOP (MJPEG over WS) ----
async function streamLoop(session) {
  session.streaming = true;
  const ws = session.ws;

  while (ws.readyState === ws.OPEN) {
    try {
      const jpeg = await session.page.screenshot({
        type: "jpeg",
        quality: 60
      });
      ws.send(jpeg); // binary frame
    } catch (err) {
      console.log("Screenshot error:", err.message);
    }

    // balance CPU vs FPS:
    await new Promise(r => setTimeout(r, 80)); // ~12 FPS
  }

  session.streaming = false;
}

// ---- CREATE PAGE FOR WS CLIENT ----
async function createSession(ws, userName = "unknown") {
  const browser = await ensureBrowser();
  const page = await browser.newPage();

  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  const id = Math.random().toString(36).slice(2, 12);
  const session = {
    ws,
    page,
    id,
    userName,
    lastActive: Date.now(),
    streaming: false
  };

  sessions.set(ws, session);

  return session;
}

// ---- WS CONNECTION ----
wss.on("connection", (ws) => {
  console.log("WS connected");
  ws.isAlive = true;

  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", async (msg) => {
    let data;
    try { data = JSON.parse(msg); }
    catch (e) { return; }

    if (data.type !== "control") return;

    let session = sessions.get(ws);

    if (data.action === "create") {
      session = await createSession(ws, data.userName);
      ws.send(JSON.stringify({
        type: "info",
        action: "created",
        sessionId: session.id
      }));
      return;
    }

    if (!session) return;

    // ------- ACTION HANDLERS -------
    if (data.action === "navigate") {
      const raw = data.url.trim();
      const url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;

      try {
        await session.page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });
      } catch {}

      ws.send(JSON.stringify({
        type: "info",
        action: "navigated",
        url: session.page.url(),
        title: await session.page.title()
      }));

      session.lastActive = Date.now();
      return;
    }

    if (data.action === "startStream") {
      if (!session.streaming) streamLoop(session);
      return;
    }

    if (data.action === "click") {
      await session.page.mouse.click(data.x, data.y).catch(() => {});
      session.lastActive = Date.now();
      return;
    }

    if (data.action === "scroll") {
      await session.page.mouse.wheel({
        deltaX: data.dx || 0,
        deltaY: data.dy || 0
      }).catch(() => {});
      session.lastActive = Date.now();
      return;
    }

    if (data.action === "type") {
      const text = data.text || "";
      await session.page.keyboard.type(text, { delay: 10 }).catch(() => {});
      session.lastActive = Date.now();
      return;
    }

    if (data.action === "back") {
      await session.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      session.lastActive = Date.now();
      return;
    }

    if (data.action === "forward") {
      await session.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
      session.lastActive = Date.now();
      return;
    }

    if (data.action === "close") {
      try { await session.page.close(); } catch {}
      sessions.delete(ws);
      return;
    }
  });

  ws.on("close", async () => {
    console.log("WS closed");
    const session = sessions.get(ws);
    if (session) {
      try { await session.page.close(); } catch {}
      sessions.delete(ws);
    }
  });
});

// ---- WS HEARTBEAT ----
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// ---- AUTO CLEANUP OLD SESSIONS ----
setInterval(() => {
  const now = Date.now();
  for (const [ws, s] of sessions.entries()) {
    if (now - s.lastActive > 1000 * 60 * 30) { // 30 min idle
      try { s.page.close(); } catch {}
      sessions.delete(ws);
    }
  }
}, 60000);

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
