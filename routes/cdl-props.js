/**
 * cdl-props-route.js
 * 
 * Express route handler for GET /api/cdl/props
 * Combines PandaScore match data with BreakingPoint player stats
 * to generate CDL player prop lines.
 * 
 * Setup:
 *   1. npm install cheerio (for HTML parsing in scraper)
 *   2. Add to your Express app:
 *      const cdlPropsRoute = require('./cdl-props-route');
 *      app.use('/api/cdl', cdlPropsRoute);
 *   3. Set up a cron to refresh stats:
 *      const { scrapeCDLStats } = require('./cdl-stats-scraper');
 *      setInterval(() => scrapeCDLStats(), 30 * 60 * 1000); // every 30 min
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();
const { scrapeCDLStats, generateProps, getCachedStats } = require('../services/cdl-stats-scraper');

const PANDASCORE_BASE = 'https://api.pandascore.co';

/**
 * GET /api/cdl/props
 * Returns CDL player props for upcoming matches
 */
router.get('/props', async (req, res) => {
  try {
    // Check if we have cached stats; if not, scrape first
    const cached = getCachedStats();
    if (cached.players.length === 0) {
      console.log('No cached CDL stats — triggering initial scrape...');
      await scrapeCDLStats();
    }
    
    // Get upcoming CDL matches from PandaScore
    const matchesResp = await axios.get(
      `${PANDASCORE_BASE}/codmw/matches/upcoming`,
      {
        headers: { Authorization: `Bearer ${process.env.PANDASCORE_API_KEY}` },
        params: { 'page[size]': 10, sort: 'scheduled_at' },
      }
    );
    
    const upcomingMatches = matchesResp.data || [];
    
    // Also get running matches
    let runningMatches = [];
    try {
      const runningResp = await axios.get(
        `${PANDASCORE_BASE}/codmw/matches/running`,
        {
          headers: { Authorization: `Bearer ${process.env.PANDASCORE_API_KEY}` },
        }
      );
      runningMatches = runningResp.data || [];
    } catch (e) {
      // Running matches endpoint may return empty
    }
    
    const allMatches = [...runningMatches, ...upcomingMatches];
    
    // Filter to CDL matches only (exclude Challengers for props)
    const cdlMatches = allMatches.filter(m => {
      const leagueName = m.league?.name || '';
      return leagueName.includes('Call of Duty League');
    });
    
    // Generate props for each match
    const matchProps = cdlMatches.map(match => {
      const team1Name = match.opponents?.[0]?.opponent?.name || 'TBD';
      const team2Name = match.opponents?.[1]?.opponent?.name || 'TBD';
      
      if (team1Name === 'TBD' || team2Name === 'TBD') {
        return {
          matchId: match.id,
          team1: { name: team1Name, players: [] },
          team2: { name: team2Name, players: [] },
          scheduledAt: match.scheduled_at,
          status: match.status,
        };
      }
      
      const props = generateProps(team1Name, team2Name);
      
      return {
        matchId: match.id,
        ...props,
        scheduledAt: match.scheduled_at,
        status: match.status,
        league: match.league?.name,
        tournament: match.tournament?.name,
      };
    });
    
    res.json({
      matches: matchProps,
      lastUpdated: getCachedStats().lastUpdated,
      totalPlayers: getCachedStats().players.length,
    });
  } catch (err) {
    console.error('CDL props error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cdl/props/stats
 * Returns raw cached player stats (for debugging/analysis)
 */
router.get('/props/stats', async (req, res) => {
  const cached = getCachedStats();
  res.json(cached);
});

/**
 * POST /api/cdl/props/refresh
 * Force-refresh the stats cache by scraping BreakingPoint
 */
router.post('/props/refresh', async (req, res) => {
  try {
    const result = await scrapeCDLStats();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cdl/props/safest
 * Returns the highest-confidence props across all upcoming matches
 * This powers the "Safest Picks" feature
 */
router.get('/props/safest', async (req, res) => {
  try {
    const cached = getCachedStats();
    if (cached.players.length === 0) {
      return res.json({ picks: [], message: 'No stats cached yet' });
    }
    
    // Get upcoming CDL matches
    const matchesResp = await axios.get(
      `${PANDASCORE_BASE}/codmw/matches/upcoming`,
      {
        headers: { Authorization: `Bearer ${process.env.PANDASCORE_API_KEY}` },
        params: { 'page[size]': 10, sort: 'scheduled_at' },
      }
    );
    
    const cdlMatches = (matchesResp.data || []).filter(m =>
      m.league?.name?.includes('Call of Duty League')
    );
    
    // Collect all props with edges
    const allEdges = [];
    
    for (const match of cdlMatches) {
      const team1 = match.opponents?.[0]?.opponent?.name;
      const team2 = match.opponents?.[1]?.opponent?.name;
      if (!team1 || !team2) continue;
      
      const props = generateProps(team1, team2);
      
      for (const team of [props.team1, props.team2]) {
        for (const player of team.players) {
          for (const prop of player.props) {
            if (prop.edge && prop.edge.confidence >= 55) {
              allEdges.push({
                player: player.player,
                team: player.team,
                matchup: `${team1} vs ${team2}`,
                scheduledAt: match.scheduled_at,
                ...prop,
              });
            }
          }
        }
      }
    }
    
    // Sort by confidence (highest first)
    allEdges.sort((a, b) => b.edge.confidence - a.edge.confidence);
    
    // Categorize
    const safest = allEdges.filter(e => e.market === 'map2_kills' && e.edge.direction === 'UNDER');
    const starOvers = allEdges.filter(e => e.market === 'map1_kills' && e.edge.direction === 'OVER' && e.edge.confidence >= 65);
    const kdPlays = allEdges.filter(e => e.market === 'series_kd');
    
    res.json({
      picks: allEdges.slice(0, 20),
      categories: {
        safestUnders: safest.slice(0, 5),
        starOvers: starOvers.slice(0, 5),
        kdPlays: kdPlays.slice(0, 5),
      },
      total: allEdges.length,
    });
  } catch (err) {
    console.error('Safest props error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
