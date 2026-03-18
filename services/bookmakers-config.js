/**
 * bookmakers-config.js — Expanded Sportsbook List
 * 
 * Use this in routes/props.js to request more bookmakers from the Odds API.
 * 
 * Change your props route's bookmakers parameter to:
 *   const { BOOKMAKERS_STRING } = require('../services/bookmakers-config');
 *   // Then in your API call:
 *   bookmakers: BOOKMAKERS_STRING
 * 
 * Or if you construct the URL manually:
 *   &bookmakers=${BOOKMAKERS_STRING}
 */

// All US sportsbooks available in the Odds API
const US_SPORTSBOOKS = [
  'draftkings',      // DraftKings
  'fanduel',         // FanDuel
  'betmgm',          // BetMGM
  'caesars',          // Caesars Sportsbook
  'pointsbetus',     // PointsBet
  'betrivers',       // BetRivers
  'bovada',          // Bovada
  'betonlineag',     // BetOnline.ag
  'mybookieag',      // MyBookie.ag
  'superbook',       // SuperBook
  'wynnbet',         // WynnBet
  'espnbet',         // ESPN BET
  'fanatics',        // Fanatics Sportsbook
];

// DFS/Pick'em sites (projections, not traditional odds)
const DFS_SITES = [
  'prizepicks',      // PrizePicks
  'underdogfantasy', // Underdog Fantasy
  'fliff',           // Fliff
  // 'sleeper',       // Sleeper (may not be in Odds API yet)
  // 'parlayplay',    // ParlayPlay (may not be in Odds API yet)
];

// All bookmakers combined
const ALL_BOOKMAKERS = [...US_SPORTSBOOKS, ...DFS_SITES];

// Comma-separated string for API parameter
const BOOKMAKERS_STRING = ALL_BOOKMAKERS.join(',');

module.exports = {
  US_SPORTSBOOKS,
  DFS_SITES,
  ALL_BOOKMAKERS,
  BOOKMAKERS_STRING,
};
