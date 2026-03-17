/**
 * wnba.js — WNBA Coverage
 * 
 * Adds WNBA scores, standings, and props using the same
 * ESPN + Odds API pattern as NBA.
 * 
 * ESPN endpoints:
 *   Scores: site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard
 *   Standings: site.api.espn.com/apis/v2/sports/basketball/wnba/standings
 *   Teams: site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams
 * 
 * Odds API sport key: basketball_wnba
 * 
 * Setup:
 *   const wnba = require('./services/wnba');
 *   app.use('/api/wnba', wnba.router);
 */

const express = require('express');
const axios = require('axios');
const router = express.Router();

const ODDS_API_KEY = process.env.ODDS_API_KEY;

// ============================================================
// ESPN WNBA Data
// ============================================================

router.get('/scores', async (req, res) => {
  try {
    const resp = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/scoreboard',
      { timeout: 10000 }
    );
    const games = (resp.data?.events || []).map(event => {
      const comp = event.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      return {
        id: event.id,
        name: event.name,
        date: event.date,
        status: event.status?.type?.name,
        statusDisplay: event.status?.type?.description,
        homeTeam: home?.team?.abbreviation,
        homeScore: parseInt(home?.score) || 0,
        homeLogo: home?.team?.logo,
        homeName: home?.team?.displayName,
        awayTeam: away?.team?.abbreviation,
        awayScore: parseInt(away?.score) || 0,
        awayLogo: away?.team?.logo,
        awayName: away?.team?.displayName,
        broadcast: comp?.broadcasts?.[0]?.names?.[0] || '',
      };
    });
    res.json({ sport: 'wnba', games, count: games.length, date: new Date().toISOString() });
  } catch (err) {
    res.json({ sport: 'wnba', games: [], count: 0, error: err.message });
  }
});

router.get('/standings', async (req, res) => {
  try {
    const resp = await axios.get(
      'https://site.api.espn.com/apis/v2/sports/basketball/wnba/standings',
      { timeout: 10000 }
    );
    const groups = (resp.data?.children || []).map(conf => ({
      name: conf.name || 'WNBA',
      teams: (conf.standings?.entries || []).map(entry => {
        const statsMap = {};
        for (const s of (entry.stats || [])) {
          statsMap[s.name] = s.displayValue;
        }
        return {
          id: entry.team?.id,
          name: entry.team?.displayName,
          abbreviation: entry.team?.abbreviation,
          logo: entry.team?.logos?.[0]?.href,
          stats: {
            W: statsMap.wins || '0',
            L: statsMap.losses || '0',
            PCT: statsMap.winPercent || '.000',
            GB: statsMap.gamesBehind || '-',
            STRK: statsMap.streak || '-',
          },
        };
      }),
    }));
    res.json({ sport: 'wnba', groups });
  } catch (err) {
    res.json({ sport: 'wnba', groups: [], error: err.message });
  }
});

router.get('/props', async (req, res) => {
  if (!ODDS_API_KEY) {
    return res.json({ available: false, sport: 'wnba', props: [], message: 'Odds API key not configured' });
  }

  try {
    // Get WNBA events first
    const eventsResp = await axios.get(
      `https://api.the-odds-api.com/v4/sports/basketball_wnba/events`,
      { params: { apiKey: ODDS_API_KEY }, timeout: 10000 }
    );
    const events = eventsResp.data || [];
    if (events.length === 0) {
      return res.json({ available: true, sport: 'wnba', props: [], count: 0, message: 'No WNBA games today' });
    }

    // Get props for each event
    const allProps = [];
    const markets = ['player_points', 'player_rebounds', 'player_assists', 'player_threes'];

    for (const event of events.slice(0, 5)) {
      try {
        const oddsResp = await axios.get(
          `https://api.the-odds-api.com/v4/sports/basketball_wnba/events/${event.id}/odds`,
          {
            params: {
              apiKey: ODDS_API_KEY,
              regions: 'us',
              markets: markets.join(','),
              oddsFormat: 'american',
            },
            timeout: 10000,
          }
        );

        const gameData = oddsResp.data;
        const propMap = {};

        for (const book of (gameData?.bookmakers || [])) {
          for (const market of (book.markets || [])) {
            for (const outcome of (market.outcomes || [])) {
              const key = `${outcome.description}|${market.key}`;
              if (!propMap[key]) {
                propMap[key] = {
                  player: outcome.description,
                  market: market.key,
                  marketLabel: market.key.replace('player_', '').replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase()),
                  game: `${event.away_team} @ ${event.home_team}`,
                  gameId: event.id,
                  commenceTime: event.commence_time,
                  homeTeam: event.home_team,
                  awayTeam: event.away_team,
                  books: [],
                };
              }
              propMap[key].books.push({
                name: book.title,
                over: outcome.name === 'Over' ? { price: outcome.price, point: outcome.point } : undefined,
                under: outcome.name === 'Under' ? { price: outcome.price, point: outcome.point } : undefined,
              });
            }
          }
        }

        // Process props
        for (const prop of Object.values(propMap)) {
          // Merge over/under from same book
          const bookMap = {};
          for (const b of prop.books) {
            if (!bookMap[b.name]) bookMap[b.name] = { name: b.name };
            if (b.over) bookMap[b.name].over = b.over;
            if (b.under) bookMap[b.name].under = b.under;
          }
          prop.books = Object.values(bookMap);
          prop.bookCount = prop.books.length;

          // Consensus line
          const lines = prop.books.map(b => b.over?.point || b.under?.point).filter(Boolean);
          prop.consensusLine = lines.length > 0 ? +(lines.reduce((a, b) => a + b, 0) / lines.length).toFixed(1) : 0;

          // Line spread
          if (lines.length >= 2) {
            prop.lineSpread = +(Math.max(...lines) - Math.min(...lines)).toFixed(1);
          } else {
            prop.lineSpread = 0;
          }

          // Edge and line type detection
          prop.hasEdge = prop.lineSpread >= 1.5;
          prop.lineType = prop.bookCount >= 4 && prop.lineSpread >= 2 ? 'demon' :
                          prop.lineSpread >= 3 ? 'goblin' : 'normal';

          allProps.push(prop);
        }
      } catch (e) {
        // Skip event if props unavailable
      }
    }

    res.json({
      available: true,
      sport: 'wnba',
      props: allProps,
      count: allProps.length,
    });
  } catch (err) {
    res.json({ available: false, sport: 'wnba', props: [], error: err.message });
  }
});

router.get('/teams', async (req, res) => {
  try {
    const resp = await axios.get(
      'https://site.api.espn.com/apis/site/v2/sports/basketball/wnba/teams?limit=20',
      { timeout: 10000 }
    );
    const teams = (resp.data?.sports?.[0]?.leagues?.[0]?.teams || []).map(t => ({
      id: t.team.id,
      name: t.team.displayName,
      abbreviation: t.team.abbreviation,
      logo: t.team.logos?.[0]?.href,
    }));
    res.json({ sport: 'wnba', teams });
  } catch (err) {
    res.json({ sport: 'wnba', teams: [], error: err.message });
  }
});

module.exports = { router };
