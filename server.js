// =========================================================
//  Remote Browser Proxy - Optimized for Render Free Tier
// =========================================================

import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import path from "path";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ------------------------------
// Global Browser (ONE INSTANCE)
// ------------------------------

let browser = null;
let sessions = new Map(); // sessionId -> { page, lastActive }

// Render free tier flags
async function launchBrowser() {
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
    defaultViewport: null,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });

  console.log("Browser launched");
  return browser;
}

// Generate simple session IDs
function makeId() {
  return Math.random().toString(36).substring(2, 12);
}

// ------------------------------
//  Create Session
// ------------------------------
app.post("/session/create", async (req, res) => {
  try {
    const browser = await launchBrowser();
    const page = await browser.newPage();

    await page.setViewport({ width: 1280, height: 720 });

    const sessionId = makeId();
    sessions.set(sessionId, { page, lastActive: Date.now() });

    res.json({ success: true, sessionId });
  } catch (err) {
    console.error("Create session error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ------------------------------
//  Navigate
// ------------------------------
app.post("/session/navigate", async (req, res) => {
  const { sessionId, url } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

    const title = await session.page.title();
    session.lastActive = Date.now();

    res.json({ success: true, title });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ------------------------------
//  Screenshot (WebP)
// ------------------------------
app.get("/session/screenshot/:id", async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();

  const quality = req.query.quality || "medium";
  const q = quality === "low" ? 40 : quality === "high" ? 90 : 60;

  try {
    const buf = await session.page.screenshot({
      type: "webp",
      quality: q,
      captureBeyondViewport: false,
    });

    session.lastActive = Date.now();
    res.set("Content-Type", "image/webp");
    res.send(buf);
  } catch (err) {
    res.status(500).end();
  }
});

// ------------------------------
//  Click
// ------------------------------
app.post("/session/click", async (req, res) => {
  const { sessionId, x, y } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.mouse.click(x, y);
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ------------------------------
//  Back
// ------------------------------
app.post("/session/back", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.goBack({ waitUntil: "domcontentloaded" });
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// ------------------------------
//  Forward
// ------------------------------
app.post("/session/forward", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.goForward({ waitUntil: "domcontentloaded" });
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// ------------------------------
//  Scroll
// ------------------------------
app.post("/session/scroll", async (req, res) => {
  const { sessionId, dx, dy } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.mouse.wheel({ deltaX: dx, deltaY: dy });
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false });
  }
});

// ------------------------------
//  Typing
// ------------------------------
app.post("/session/type", async (req, res) => {
  const { sessionId, text } = req.body;
  const session = sessions.get(sessionId);
  if (!session) return res.json({ success: false });

  try {
    await session.page.keyboard.type(text);
    session.lastActive = Date.now();
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

// ------------------------------
//  Close Session
// ------------------------------
app.post("/session/close", async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (session) {
    try { await session.page.close(); } catch {}
    sessions.delete(sessionId);
  }
  res.json({ success: true });
});

// ------------------------------
// Health
// ------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ------------------------------
// Automatic Session Cleanup
// ------------------------------
setInterval(() => {
  const now = Date.now();
  for (const [id, sess] of sessions) {
    if (now - sess.lastActive > 1000 * 60 * 5) { // 5min idle
      try { sess.page.close(); } catch {}
      sessions.delete(id);
      console.log("Cleaned idle session:", id);
    }
  }
}, 30000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on " + PORT));
