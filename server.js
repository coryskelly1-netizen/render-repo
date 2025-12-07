import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer } from "ws";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();

// CORS + strict routing FIX (required for Render)
app.use(cors());
app.enable("strict routing");

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  next();
});

app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// ---------- USER KEYS ----------
const VALID_KEYS = {
  "test": "123",
  "Alice": "8392017",
  "Bob": "4928371"
};

// ---------- BROWSER ----------
let browser = null;

async function ensureBrowser() {
  if (browser && browser.isConnected()) return browser;

  console.log("Launching Chromium...");

  const exec = await chromium.executablePath();

  browser = await puppeteer.launch({
    executablePath: exec,
    headless: chromium.headless,
    args: [
      ...chromium.args,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox"
    ]
  });

  console.log("Chromium launched!");
  return browser;
}

// ------------ ROUTES -------------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/validate", (req, res) => {
  const { name, key } = req.query;
  const valid = VALID_KEYS[name] === key;
  res.json({ valid });
});

// ---------- WEBSOCKET ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const sessions = new Map();

async function createSession(ws, userName) {
  const browser = await ensureBrowser();
  const page = await browser.newPage();

  await page.setViewport({ width: 1366, height: 768 });

  const session = { ws, page, userName, streaming: false };
  sessions.set(ws, session);

  return session;
}

async function startStream(session) {
  session.streaming = true;

  while (session.streaming && session.ws.readyState === session.ws.OPEN) {
    try {
      const frame = await session.page.screenshot({
        type: "jpeg",
        quality: 40
      });
      session.ws.send(frame);
    } catch (e) {
      break;
    }
    await new Promise(r => setTimeout(r, 120)); // ~8 FPS
  }
}

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type !== "control") return;

    let session = sessions.get(ws);

    if (msg.action === "create") {
      session = await createSession(ws, msg.userName);
      ws.send(JSON.stringify({ type: "info", action: "created" }));
      return;
    }

    if (!session) return;

    if (msg.action === "startStream") {
      startStream(session);
    }

    if (msg.action === "navigate") {
      let url = msg.url;
      if (!url.startsWith("http")) url = "https://" + url;
      await session.page.goto(url);
    }
  });

  ws.on("close", () => {
    const s = sessions.get(ws);
    if (s) s.streaming = false;
    sessions.delete(ws);
  });
});

// ---------- START SERVER ---------
server.listen(PORT, "0.0.0.0", () => {
  console.log("Server live on port", PORT);
});
