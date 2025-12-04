import express from "express";
import cors from "cors";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cors());

// ================================
// CONFIG
// ================================
const PORT = process.env.PORT || 3000;
const VALID_KEYS = {
  "John Doe": "1234",
  "Test": "abcd"
};

// ================================
// SESSION STORAGE
// ================================
const sessions = new Map();

// ================================
// HEALTH
// ================================
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ================================
// VALIDATE LOGIN
// ================================
app.get("/validate", (req, res) => {
  const { name, key } = req.query;

  if (!name || !key)
    return res.json({ valid: false });

  const good = VALID_KEYS[name] && VALID_KEYS[name] === key;
  res.json({ valid: good });
});

// ================================
// CREATE SESSION
// ================================
app.post("/session/create", async (req, res) => {
  try {
    const userName = req.body.userName || "unknown";
    const sessionId = Math.random().toString(36).slice(2);

    console.log("Creating session:", sessionId);

    const browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    sessions.set(sessionId, { browser, page, userName });

    res.json({ sessionId });
  } catch (e) {
    console.error("Session create error:", e);
    res.json({ error: true });
  }
});

// ================================
// NAVIGATE
// ================================
app.post("/session/navigate", async (req, res) => {
  const { sessionId, url } = req.body;

  if (!sessions.has(sessionId))
    return res.json({ error: "invalid session" });

  try {
    const { page } = sessions.get(sessionId);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    res.json({ ok: true });
  } catch (e) {
    console.error("Navigation error:", e);
    res.json({ ok: false });
  }
});

// ================================
// SCREENSHOT
// ================================
app.get("/session/screenshot/:id", async (req, res) => {
  const sessionId = req.params.id;
  const quality = req.query.quality || "medium";

  if (!sessions.has(sessionId))
    return res.status(404).end();

  try {
    const { page } = sessions.get(sessionId);

    let q = 50;
    if (quality === "low") q = 30;
    if (quality === "high") q = 90;

    const buffer = await page.screenshot({
      type: "webp",
      quality: q,
      optimizeForSpeed: true
    });

    res.set("Content-Type", "image/webp");
    res.send(buffer);

  } catch (e) {
    console.error("Screenshot error:", e);
    res.status(500).end();
  }
});

// ================================
// CLICK
// ================================
app.post("/session/click", async (req, res) => {
  const { sessionId, x, y } = req.body;

  if (!sessions.has(sessionId))
    return res.json({ error: "invalid session" });

  try {
    const { page } = sessions.get(sessionId);
    await page.mouse.click(x, y, { delay: 30 });
    res.json({ ok: true });
  } catch (e) {
    console.error("Click error:", e);
    res.json({ ok: false });
  }
});

// ================================
// SCROLL
// ================================
app.post("/session/scroll", async (req, res) => {
  const { sessionId, dx, dy } = req.body;

  if (!sessions.has(sessionId))
    return res.json({ error: "invalid session" });

  try {
    const { page } = sessions.get(sessionId);
    await page.mouse.wheel({ deltaX: dx, deltaY: dy });
    res.json({ ok: true });
  } catch (e) {
    console.error("Scroll error:", e);
    res.json({ ok: false });
  }
});

// ================================
// CLEANUP (AUTO CLOSE DEAD SESSIONS)
// ================================
setInterval(async () => {
  for (const [id, sess] of sessions) {
    try {
      const pages = await sess.browser.pages();
      if (pages.length === 0) {
        console.log("Cleaning session:", id);
        await sess.browser.close();
        sessions.delete(id);
      }
    } catch {
      sessions.delete(id);
    }
  }
}, 30000);

// ================================
// START SERVER
// ================================
app.listen(PORT, () => {
  console.log("Server ready on port", PORT);
});
