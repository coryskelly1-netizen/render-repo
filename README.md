# Proxy Access Portal

A simple proxy browser project built with:
- Frontend: `index.html`
- Backend: Node.js + Puppeteer, deployed on Render

## Deployment
1. Push repo to GitHub.
2. On Render:
   - Build Command: `./render-build.sh`
   - Start Command: `npm start`
3. Update `index.html` → set `BACKEND_BASE` to your Render URL.
4. Double-click `index.html` to use.
