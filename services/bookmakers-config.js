/**
 * bookmakers-config.js — Expanded Sportsbook Coverage (23 books)
 * 
 * Expands from 5 to 23+ sportsbooks/DFS platforms.
 * Use REGIONS in Odds API calls to get all books.
 */

const express = require('express');
const router = express.Router();

const US_SPORTSBOOKS = [
  { key: 'fanduel', name: 'FanDuel', type: 'sportsbook' },
  { key: 'draftkings', name: 'DraftKings', type: 'sportsbook' },
  { key: 'betmgm', name: 'BetMGM', type: 'sportsbook' },
  { key: 'caesars', name: 'Caesars', type: 'sportsbook' },
  { key: 'betrivers', name: 'BetRivers', type: 'sportsbook' },
  { key: 'fanatics', name: 'Fanatics', type: 'sportsbook' },
  { key: 'espnbet', name: 'ESPN BET', type: 'sportsbook' },
  { key: 'hardrockbet', name: 'Hard Rock Bet', type: 'sportsbook' },
  { key: 'bet365', name: 'bet365', type: 'sportsbook' },
  { key: 'wynnbet', name: 'WynnBET', type: 'sportsbook' },
  { key: 'pointsbetus', name: 'PointsBet', type: 'sportsbook' },
];

const US2_SPORTSBOOKS = [
  { key: 'bovada', name: 'Bovada', type: 'sportsbook' },
  { key: 'mybookieag', name: 'MyBookie', type: 'sportsbook' },
  { key: 'betonlineag', name: 'BetOnline', type: 'sportsbook' },
  { key: 'lowvig', name: 'LowVig', type: 'sportsbook' },
  { key: 'betus', name: 'BetUS', type: 'sportsbook' },
];

const DFS_PLATFORMS = [
  { key: 'prizepicks', name: 'PrizePicks', type: 'dfs' },
  { key: 'underdog', name: 'Underdog', type: 'dfs' },
  { key: 'fliff', name: 'Fliff', type: 'dfs' },
  { key: 'sleeper', name: 'Sleeper', type: 'dfs' },
  { key: 'draftkings_pick6', name: 'DK Pick6', type: 'dfs' },
  { key: 'dabble', name: 'Dabble', type: 'dfs' },
  { key: 'parlayplay', name: 'ParlayPlay', type: 'dfs' },
];

const ALL_BOOKS = [...US_SPORTSBOOKS, ...US2_SPORTSBOOKS, ...DFS_PLATFORMS];
const REGIONS = 'us,us2';
const ALL_BOOKMAKER_KEYS = ALL_BOOKS.map(b => b.key).join(',');

router.get('/list', (req, res) => {
  res.json({
    total: ALL_BOOKS.length,
    sportsbooks: US_SPORTSBOOKS.length + US2_SPORTSBOOKS.length,
    dfs: DFS_PLATFORMS.length,
    books: ALL_BOOKS,
    regions: REGIONS,
  });
});

module.exports = { router, ALL_BOOKS, REGIONS, ALL_BOOKMAKER_KEYS, US_SPORTSBOOKS, US2_SPORTSBOOKS, DFS_PLATFORMS };
