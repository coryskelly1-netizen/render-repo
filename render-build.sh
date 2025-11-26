#!/bin/bash
set -e

# Install Node.js dependencies
npm install

# Ensure Puppeteer downloads Chromium (Render doesn't include it by default)
npx puppeteer install
