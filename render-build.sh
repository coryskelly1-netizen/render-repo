#!/bin/bash
set -e

# Install dependencies
npm install

# Ensure Puppeteer downloads Chromium
npx puppeteer install

# Optional: log Chromium path
echo "Chromium path:"
node -e "console.log(require('puppeteer').executablePath())"
