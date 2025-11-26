#!/bin/bash
set -e

# Install dependencies
npm install

# Ensure Puppeteer downloads Chromium
npx puppeteer install
