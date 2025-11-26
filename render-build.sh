#!/bin/bash
set -e

# Install Node.js dependencies
npm install

# Force Puppeteer to download Chromium for Render's environment
npx puppeteer install

# Optional: clear npm cache to avoid build issues
npm cache verify
