# ⟁ ORACLE — AI Sports Prediction Engine

AI-powered sports predictions across NBA, NFL, MLB, NHL, EPL, La Liga, NCAAM, NCAAF.

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select this repo
4. Go to **Variables** tab and add:
   - `ANTHROPIC_API_KEY` = your Anthropic API key
   - `ODDS_API_KEY` = your Odds API key (optional)
5. Railway will auto-build and deploy

## Local Development

```bash
npm install

# Terminal 1 - backend
npm run dev

# Terminal 2 - frontend
npm run dev:client
```

Open http://localhost:5173

## API Keys

- **Anthropic** (required for AI predictions): [console.anthropic.com](https://console.anthropic.com)
- **The Odds API** (optional, betting lines): [the-odds-api.com](https://the-odds-api.com) — free tier: 500 req/month
- **ESPN** — no key needed, free public endpoints

## API Endpoints

```
GET  /api/sports/scores/:sport       — Live scores
GET  /api/sports/standings/:sport    — Standings
GET  /api/sports/game/:sport/:id     — Game detail
GET  /api/sports/search/player?q=    — Search players
POST /api/predictions/game           — AI game prediction
POST /api/predictions/player         — AI player projection
GET  /api/odds/:sport                — Betting odds
GET  /api/health                     — Health check
```
