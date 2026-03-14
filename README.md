# ⟁ ORACLE — AI Sports Prediction Engine

A full-stack AI-powered sports analytics platform that pulls live data from ESPN, betting odds from The Odds API, and generates intelligent predictions using Claude (Anthropic API).

## Features

- **Live Scores Dashboard** — Real-time scores across NBA, NFL, MLB, NHL, EPL, La Liga, NCAAM, NCAAF
- **AI Game Predictor** — Click any game for AI-powered win probabilities, spread predictions, over/under analysis
- **Player Stat Projections** — Search any player for AI-generated stat line forecasts
- **Betting Odds Integration** — Live odds from multiple sportsbooks via The Odds API
- **League Standings** — Current standings for all supported leagues

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React + Vite |
| Backend | Node.js + Express |
| AI Engine | Anthropic Claude API |
| Sports Data | ESPN public API (free, no key) |
| Odds Data | The Odds API (free tier) |
| Deployment | Railway |

## Quick Start (Local)

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/sports-oracle.git
cd sports-oracle

# Install all dependencies
cd server && npm install && cd ../client && npm install && cd ..
```

### 2. Configure Environment

```bash
cp server/.env.example server/.env
```

Edit `server/.env` and add your API keys:

```env
PORT=3001
NODE_ENV=development
CLIENT_URL=http://localhost:5173

# REQUIRED for AI predictions
ANTHROPIC_API_KEY=sk-ant-...

# OPTIONAL for betting odds (free: 500 req/month)
ODDS_API_KEY=your_key_here
```

> **Note:** ESPN data works with NO API key. The app is fully functional without the Odds API key — you'll just miss live betting lines.

### 3. Run

```bash
# Terminal 1 — Backend
cd server && npm run dev

# Terminal 2 — Frontend
cd client && npm run dev
```

Open **http://localhost:5173**

## Deploy to Railway

### Option A: One-Click (Recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select this repo
4. Add environment variables in Railway dashboard:
   - `NODE_ENV` = `production`
   - `ANTHROPIC_API_KEY` = your key
   - `ODDS_API_KEY` = your key (optional)
   - `CLIENT_URL` = your Railway app URL (e.g. `https://sports-oracle-production.up.railway.app`)
5. Railway auto-detects the `nixpacks.toml` config and builds everything

### Option B: Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Set environment variables
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set NODE_ENV=production
railway variables set ODDS_API_KEY=your_key

# Deploy
railway up
```

### Railway Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes (for AI) | Your Anthropic API key |
| `ODDS_API_KEY` | No | The Odds API key for live betting lines |
| `NODE_ENV` | Yes | Set to `production` |
| `CLIENT_URL` | Yes | Your Railway app URL |
| `PORT` | Auto | Railway sets this automatically |

## API Endpoints

### Sports Data
```
GET  /api/sports/scores/:sport      — Live/recent/upcoming scores
GET  /api/sports/standings/:sport   — League standings
GET  /api/sports/game/:sport/:id    — Game detail + box score
GET  /api/sports/team/:sport/:id    — Team info
GET  /api/sports/search/player?q=   — Search athletes
GET  /api/sports/leagues            — List all supported leagues
```

### AI Predictions
```
POST /api/predictions/game          — AI game prediction
     Body: { "sport": "nba", "gameId": "401..." }

POST /api/predictions/player        — AI player projection
     Body: { "playerName": "LeBron James", "sport": "nba" }
```

### Odds
```
GET  /api/odds/:sport               — Current betting odds
```

### System
```
GET  /api/health                    — Health check + service status
```

## Supported Sports

| Key | Sport | Data Source |
|-----|-------|------------|
| `nba` | NBA Basketball | ESPN |
| `nfl` | NFL Football | ESPN |
| `mlb` | MLB Baseball | ESPN |
| `nhl` | NHL Hockey | ESPN |
| `epl` | English Premier League | ESPN |
| `la_liga` | Spanish La Liga | ESPN |
| `ncaamb` | NCAA Men's Basketball | ESPN |
| `ncaafb` | NCAA Football | ESPN |

## Architecture

```
sports-oracle/
├── server/                    # Express API
│   ├── index.js              # Server entry + middleware
│   ├── routes/
│   │   ├── sports.js         # ESPN data endpoints
│   │   ├── predictions.js    # AI prediction endpoints
│   │   └── odds.js           # Betting odds endpoints
│   └── services/
│       ├── espn.js           # ESPN API integration
│       ├── anthropic.js      # Claude AI predictions
│       └── odds.js           # The Odds API integration
├── client/                    # React frontend
│   ├── src/
│   │   ├── App.jsx           # Main dashboard
│   │   ├── api.js            # API client
│   │   └── index.css         # Global styles
│   └── vite.config.js        # Vite + proxy config
├── railway.toml              # Railway deployment config
├── nixpacks.toml             # Build config
└── README.md
```

## Getting API Keys

1. **Anthropic API Key** (required for AI predictions)
   - Go to [console.anthropic.com](https://console.anthropic.com)
   - Create an account → Generate API key

2. **The Odds API Key** (optional, for betting lines)
   - Go to [the-odds-api.com](https://the-odds-api.com)
   - Free tier: 500 requests/month

3. **ESPN** — No API key needed! Uses public endpoints.

## Disclaimer

This tool is for **entertainment and informational purposes only**. AI predictions are not financial advice. Never gamble more than you can afford to lose. Please gamble responsibly.

---

Built with Claude AI · Powered by ESPN + The Odds API
