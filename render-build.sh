#!/bin/bash
set -e

echo "🔧 Starting Render build script..."

npm install

echo "📍 Chromium executable path:"
node -e "try { const puppeteer = require('puppeteer'); console.log(puppeteer.executablePath()); } catch(e) { console.log('❌ Puppeteer not found:', e); }"

echo "✅ Build script completed successfully."