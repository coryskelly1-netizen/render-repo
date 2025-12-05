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

/* ------------ USER KEYS (edit these) ------------ */
const VALID_KEYS = {
  "Alice": "8392017",
  "Bob": "4928371",
  "Charlie": "1029384"
};

/* ------------ PUPPETEER BROWSER ------------ */
let browser = null;

async function ensureBrowser() {
  if (browser) return browser;

  console.log("Launching Chromium 114 (Sparticuz)...");

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
      "--no-zygote"
    ]
  });

  console.log("Chromium launched.");
  return browser;
}

/* ------------ API ROUTES ------------ */
app.get("/", (req, res) => res.json({ status: "online" }));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/validate", (req, res) => {
  const { name, key } = req.query;
  const valid = VALID_KEYS[name] === key;
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
  streaming
}
*/

/* ------------ STREAM LOOP (MJPEG) ------------ */
async function startStream(session) {
  session.streaming = true;
  const ws = session.ws;

  while (ws.readyState === ws.OPEN) {
    try {
      const frame = await session.page.screenshot({
        type: "jpeg",
        quality: 60
      });
      ws.send(frame);
    } catch (e) {
      console.log("Screenshot error:", e.message);
    }

    await new Promise(r => setTimeout(r, 80)); // ~12 FPS
  }

  session.streaming = false;
}

/* ------------ CREATE SESSION ------------ */
async function createSession(ws, userName) {
  const browser = await ensureBrowser();
  const page = await browser.newPage();

  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
  );

  const session = { ws, page, userName, streaming: false };
  sessions.set(ws, session);

  return session;
}

/* ------------ WS CONNECTION ------------ */
wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => ws.isAlive = true);

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type !== "control") return;

    let session = sessions.get(ws);

    // create new page
    if (msg.action === "create") {
      session = await createSession(ws, msg.userName);
      ws.send(JSON.stringify({
        type: "info",
        action: "created"
      }));
      return;
    }

    if (!session) return;

    // actions
    if (msg.action === "navigate") {
      const url = /^https?:\/\//i.test(msg.url) ? msg.url : "https://" + msg.url;
      try {
        await session.page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });
      } catch {}
      return;
    }

    if (msg.action === "startStream") {
      if (!session.streaming) startStream(session);
      return;
    }

    if (msg.action === "click") {
      await session.page.mouse.click(msg.x, msg.y).catch(() => {});
      return;
    }

    if (msg.action === "scroll") {
      await session.page.mouse.wheel({
        deltaX: msg.dx || 0,
        deltaY: msg.dy || 0
      }).catch(() => {});
      return;
    }

    if (msg.action === "type") {
      await session.page.keyboard.type(msg.text, { delay: 12 }).catch(() => {});
      return;
    }

    if (msg.action === "back") {
      await session.page.goBack({
        waitUntil: "domcontentloaded"
      }).catch(() => {});
      return;
    }

    if (msg.action === "forward") {
      await session.page.goForward({
        waitUntil: "domcontentloaded"
      }).catch(() => {});
      return;
    }

    if (msg.action === "close") {
      try { await session.page.close(); } catch {}
      sessions.delete(ws);
    }
  });

  ws.on("close", () => {
    const s = sessions.get(ws);
    if (s) try { s.page.close(); } catch {}
    sessions.delete(ws);
  });
});

/* ---- WS Heartbeat ---- */
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

server.listen(PORT, () => console.log("Server started on", PORT));
