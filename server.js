// server.js - Full working remote browser proxy
import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

/* ---------- Browser Launcher ---------- */
let browser = null;

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;

  const execPath = await chromium.executablePath();

  browser = await puppeteer.launch({
    executablePath: execPath,
    args: [...chromium.args, "--no-sandbox"],
    headless: chromium.headless
  });

  console.log("✅ Chromium launched");
  return browser;
}

/* ---------- HTTP Routes ---------- */
app.get("/", (req, res) => {
  res.json({ status: "online" });
});

const server = http.createServer(app);

/* ---------- WebSocket Server ---------- */
const wss = new WebSocketServer({
  server,
  path: "/ws"
});

const sessions = new Map();

/* ---------- Session Cleanup ---------- */
async function cleanup(ws) {
  const s = sessions.get(ws);
  if (!s) return;

  try { if (s.page && !s.page.isClosed()) await s.page.close(); }
  catch {}

  sessions.delete(ws);
}

/* ---------- Streaming Loop ---------- */
async function streamLoop(session) {
  session.streaming = true;

  while (session.streaming && session.ws.readyState === session.ws.OPEN) {
    try {
      const frame = await session.page.screenshot({
        type: "jpeg",
        quality: 55,
        optimizeForSpeed: true
      });

      session.ws.send(frame);
    } catch (err) {
      break;
    }

    await new Promise(r => setTimeout(r, 80)); // ~12 FPS
  }

  session.streaming = false;
}

/* ---------- WS Connection ---------- */
wss.on("connection", (ws) => {
  console.log("🔌 WS connected");

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { return; }

    let session = sessions.get(ws);

    /* ---------- Create Session ---------- */
    if (msg.action === "create") {
      const browser = await getBrowser();
      const page = await browser.newPage();
      await page.setViewport({ width: 1366, height: 768 });

      sessions.set(ws, {
        ws,
        page,
        streaming: false
      });

      ws.send(JSON.stringify({ type: "created" }));
      return;
    }

    if (!session) return;

    /* ---------- Navigation ---------- */
    if (msg.action === "navigate") {
      const url = msg.url.startsWith("http") ? msg.url : "https://" + msg.url;
      try {
        await session.page.goto(url, { waitUntil: "domcontentloaded" });
      } catch {}
      return;
    }

    /* ---------- Start Stream ---------- */
    if (msg.action === "startStream") {
      if (!session.streaming) streamLoop(session);
      return;
    }

    /* ---------- Mouse ---------- */
    if (msg.action === "click") {
      await session.page.mouse.click(msg.x, msg.y);
      return;
    }

    if (msg.action === "scroll") {
      await session.page.mouse.wheel({ deltaY: msg.dy || 0 });
      return;
    }

    /* ---------- Keyboard ---------- */
    if (msg.action === "type") {
      if (msg.special) {
        // Special keys
        try { await session.page.keyboard.press(msg.text); } catch {}
      } else {
        // Printable characters
        try { await session.page.keyboard.type(msg.text, { delay: 10 }); } catch {}
      }
      return;
    }
  });

  ws.on("close", () => cleanup(ws));
  ws.on("error", () => cleanup(ws));
});

/* ---------- Start Server ---------- */
server.listen(PORT, () => {
  console.log("🚀 Server live on port " + PORT);
});
