const express = require('express');
const router = express.Router();
const anthropicService = require('../services/anthropic');
const espnService = require('../services/espn');
const cdlService = require('../services/cdl');

const ESPN_SPORTS = ['nba', 'nfl', 'mlb', 'nhl', 'epl', 'la_liga', 'serie_a', 'bundesliga', 'ligue_1', 'mls', 'champions_league', 'ncaafb', 'ncaamb', 'ncaawb'];
const ESPORTS = ['cdl'];

// Game prediction
router.post('/game', async (req, res) => {
  try {
    const { sport, gameId, homeTeam, awayTeam } = req.body;

    if (!sport) {
      return res.status(400).json({ error: 'Sport is required' });
    }

    let gameContext = { sport, homeTeam, awayTeam, gameId };

    if (ESPORTS.includes(sport.toLowerCase())) {
      // CDL / esports path — pull data from PandaScore
      try {
        const matches = await cdlService.getMatches();
        const match = matches.find(m => String(m.id) === String(gameId));
        if (match) {
          gameContext = {
            ...gameContext,
            league: 'Call of Duty League (CDL)',
            status: match.status,
            scheduledAt: match.scheduled_at,
            opponents: match.opponents?.map(o => o.opponent?.name),
            tournament: match.tournament?.name,
            serie: match.serie?.full_name,
          };
        }
      } catch (e) {
        console.warn('CDL context fetch failed, continuing with basic info:', e.message);
      }
    } else if (ESPN_SPORTS.includes(sport.toLowerCase())) {
      // ESPN path
      try {
        const scores = await espnService.getScores(sport);
        const game = scores.find(g => g.id === gameId);
        if (game) {
          gameContext = { ...gameContext, ...game };
        }
      } catch (e) {
        console.warn('ESPN context fetch failed, continuing with basic info:', e.message);
      }
    }

    const prediction = await anthropicService.predictGame(gameContext);
    res.json({ prediction, gameContext });
  } catch (error) {
    console.error('Game prediction error:', error);
    res.status(500).json({ error: 'Failed to generate prediction', details: error.message });
  }
});

// Player projection
router.post('/player', async (req, res) => {
  try {
    const { sport, playerName, opponent } = req.body;

    if (!playerName) {
      return res.status(400).json({ error: 'Player name is required' });
    }

    const projection = await anthropicService.projectPlayer({ sport, playerName, opponent });
    res.json({ projection });
  } catch (error) {
    console.error('Player projection error:', error);
    res.status(500).json({ error: 'Failed to generate projection', details: error.message });
  }
});

module.exports = router;
