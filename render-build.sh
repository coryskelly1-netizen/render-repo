#!/bin/bash
set -e

# Install dependencies
npm install

# Force Puppeteer to download Chromium (Render doesn't include it by default)
npx puppeteer install

# Optional: verify Chromium path (for debugging)
echo "Chromium path:"
node -e "console.log(require('puppeteer').executablePath())"
