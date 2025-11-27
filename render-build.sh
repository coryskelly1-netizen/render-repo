#!/bin/bash
set -e

echo "🔧 Starting Render build script..."

npm install
npx puppeteer install

echo "📍 Chromium executable path:"
node -e "try { console.log(require('puppeteer').executablePath()); } catch (e) { console.error('❌ Puppeteer not found:', e); process.exit(1); }"

echo "✅ Build script completed successfully."
