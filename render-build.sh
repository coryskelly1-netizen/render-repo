#!/bin/bash
set -e

echo "🔧 Starting Render build script..."

# Set environment variable to skip Chromium download
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Install dependencies
npm install

echo "✅ Build script completed successfully."