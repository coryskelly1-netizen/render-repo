// server.js
import express from "express";
import cors from "cors";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";

const app = express();
app.use(cors());

// Centralized valid keys with names
let VALID_KEYS = {
  "8392017": "Alice",
  "4928371": "Bob",
  "1029384": "Charlie"
};

// Root endpoint
app.get("/", (req, res) => {
  res.json({ 
    status: "online",
    service: "Puppeteer Proxy Server",
    endpoints: {
      health: "/health",
      validate: "/validate?key=YOUR_KEY",
      proxy: "/proxy?url=YOUR_URL"
    }
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "puppeteer-proxy" });
});

// Key validation
app.get("/validate", (req, res) => {
  const key = req.query.key;
  const name = req.query.name;
  const valid = VALID_KEYS[key] && VALID_KEYS[key].toLowerCase() === name?.toLowerCase();
  res.json({ valid, expectedName: VALID_KEYS[key] });
});

// Proxy endpoint
app.get("/proxy", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send("Missing url");
  
  let browser;
  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless
    });
    
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
    const content = await page.content();
    await browser.close();
    
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(content);
  } catch (err) {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error("Error closing browser:", e.message);
      }
    }
    console.error("Proxy error:", err.message);
    res.status(500).send("Proxy error: " + err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Puppeteer proxy running on port ${PORT}`);
  console.log(`Chromium path: ${process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium'}`);
});