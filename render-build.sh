#!/bin/bash
set -e

echo "🔧 Starting Render build script..."

# Install all dependencies
echo "📦 Running npm install..."
npm install

# Ensure Puppeteer downloads Chromium
echo "🧭 Installing Puppeteer Chromium..."
npx puppeteer install

# Log Chromium path for debugging
echo "📍 Chromium executable path:"
node -e "try { console.log(require('puppeteer').executablePath()); } catch (e) { console.error('❌ Puppeteer not found:', e); process.exit(1); }"

echo "✅ Build script completed successfully."
