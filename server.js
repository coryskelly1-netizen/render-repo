// ----- server.js (CLEAN + FULLY FUNCTIONAL VERSION) -----

import express from "express";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

// Paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App setup
const app = express();
app.use(cors());
app.use(express.json());

// Serve static public folder
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

// Login keys
const VALID_KEYS = {
  "Alice": "8392017",
  "Bob": "4928371",
  "Charlie": "1029384"
};

// Browser instance
let browser = null;

// ---------- LAUNCH CHROMIUM ----------
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  console.log("Launching Chromium...");

  browser = await puppeteer.launch({
    executablePath: await chromium.executablePath(),
    args: chromium.args,
    headless: chromium.headless,
    defaultViewport: { width: 1366, height: 768 }
  });

  console.log("Chromium launched.");
  return browser;
}

// ---------- API ----------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/validate", (req, res) => {
  const { name, key } = req.query;
  res.json({ valid: VALID_KEYS[name] === key });
});

// ---------- SERVER + WEBSOCKET ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const sessions = new Map();

// ---------- STREAM LOOP ----------
async function stream(session) {
  session.streaming = true;

  while (session.streaming && session.ws.readyState === 1) {
    try {
      const frame = await session.page.screenshot({
        type: "jpeg",
        quality: 60
      });

      session.ws.send(frame);
    } catch (e) {
      console.log("Stream error:", e.message);
      break;
    }

    await new Promise(r => setTimeout(r, 80));
  }

  session.streaming = false;
}

// ---------- NEW SESSION ----------
async function createSession(ws, user) {
  const browser = await getBrowser();
  const page = await browser.newPage();

  page.setViewport({ width: 1366, height: 768 });

  return {
    ws,
    page,
    user,
    streaming: false
  };
}

// ---------- WEBSOCKET HANDLER ----------
wss.on("connection", ws => {
  let session = null;

  ws.on("message", async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type !== "control") return;

    // Create session
    if (msg.action === "create") {
      session = await createSession(ws, msg.userName);

      sessions.set(ws, session);

      ws.send(JSON.stringify({ type: "info", action: "created" }));
      return;
    }

    if (!session) return;

    // Navigation
    if (msg.action === "navigate") {
      const url = msg.url.startsWith("http") ? msg.url : "https://" + msg.url;
      await session.page.goto(url).catch(() => {});
      return;
    }

    // Start streaming
    if (msg.action === "startStream") {
      if (!session.streaming) stream(session);
      return;
    }

    // Click
    if (msg.action === "click") {
      await session.page.mouse.click(msg.x, msg.y).catch(() => {});
      return;
    }

    // Keyboard typing
    if (msg.action === "type") {
      await session.page.keyboard.type(msg.text).catch(() => {});
      return;
    }

    if (msg.action === "scroll") {
      await session.page.mouse.wheel({ deltaX: 0, deltaY: msg.dy });
      return;
    }

    if (msg.action === "back") {
      await session.page.goBack().catch(() => {});
      return;
    }

    if (msg.action === "forward") {
      await session.page.goForward().catch(() => {});
      return;
    }

    if (msg.action === "close") {
      if (session.page) await session.page.close();
      sessions.delete(ws);
      ws.close();
      return;
    }
  });

  ws.on("close", () => {
    if (session && session.page) {
      session.page.close().catch(() => {});
      sessions.delete(ws);
    }
  });
});

// ---------- START ----------
server.listen(PORT, () => {
  console.log("Server live on port " + PORT);
});
