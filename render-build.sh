#!/bin/bash
set -e

echo "🔧 Starting Render build script..."

# Install Chromium dependencies
apt-get update && apt-get install -y \
  chromium \
  chromium-sandbox \
  --no-install-recommends

# Skip Puppeteer's Chromium download
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

npm install

echo "📍 Chromium executable path:"
node -e "try { const puppeteer = require('puppeteer'); console.log(puppeteer.executablePath()); } catch(e) { console.log('❌ Puppeteer not found:', e); }"

echo "✅ Build script completed successfully."