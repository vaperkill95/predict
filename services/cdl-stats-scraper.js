/**
 * cdl-stats-scraper.js
 * 
 * Scrapes CDL player stats from BreakingPoint.gg for props generation.
 * BreakingPoint uses Next.js with Supabase — stats are embedded in __NEXT_DATA__.
 * 
 * Usage:
 *   const { scrapeCDLStats, getPlayerProps } = require('./cdl-stats-scraper');
 *   
 *   // Scrape all CDL player stats (run on cron every 30 min during match days)
 *   await scrapeCDLStats();
 *   
 *   // Get props for a specific match
 *   const props = await getPlayerProps(team1Id, team2Id);
 */

const axios = require('axios');
const cheerio = require('cheerio');

// CDL Teams (from BreakingPoint.gg)
const CDL_TEAMS = [
  { id: 6, name: 'Boston Breach', abbr: 'BOS' },
  { id: 26, name: 'Carolina Royal Ravens', abbr: 'CRR' },
  { id: 63, name: 'Cloud9 New York', abbr: 'C9' },
  { id: 1, name: 'FaZe Vegas', abbr: 'FAZE' },
  { id: 11, name: 'G2 Minnesota', abbr: 'MIN' },
  { id: 2, name: 'Los Angeles Thieves', abbr: 'LAT' },
  { id: 27, name: 'Miami Heretics', abbr: 'MIA' },
  { id: 4, name: 'OpTic Texas', abbr: 'OPT' },
  { id: 743, name: 'Paris Gentle Mates', abbr: 'PGM' },
  { id: 62, name: 'Riyadh Falcons', abbr: 'RYD' },
  { id: 12, name: 'Toronto KOI', abbr: 'TOR' },
  { id: 3, name: 'Vancouver Surge', abbr: 'VAN' },
];

const CDL_TEAM_MAP = Object.fromEntries(CDL_TEAMS.map(t => [t.id, t]));

// In-memory cache (replace with Redis in production)
let playerStatsCache = {};
let lastScraped = null;

/**
 * Extract __NEXT_DATA__ JSON from a BreakingPoint.gg page
 */
function extractNextData(html) {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find __NEXT_DATA__ in page');
  return JSON.parse(match[1]);
}

/**
 * Scrape the player roster from the stats page
 */
async function scrapePlayerRoster() {
  const resp = await axios.get('https://www.breakingpoint.gg/stats/players', {
    headers: { 'User-Agent': 'ORACLE-CDL-Props/1.0' },
    timeout: 15000,
  });
  
  const data = extractNextData(resp.data);
  const players = data.props.pageProps.allPlayers;
  
  // Filter to active CDL team players
  const cdlTeamIds = CDL_TEAMS.map(t => t.id);
  return players.filter(p => cdlTeamIds.includes(p.current_team_id) && !p.retired);
}

/**
 * Scrape detailed per-mode stats for a single player
 */
async function scrapePlayerStats(playerId, playerTag) {
  try {
    const resp = await axios.get(
      `https://www.breakingpoint.gg/players/${playerId}/${encodeURIComponent(playerTag)}`,
      {
        headers: { 'User-Agent': 'ORACLE-CDL-Props/1.0' },
        timeout: 15000,
      }
    );
    
    const data = extractNextData(resp.data);
    const allStats = data.props.pageProps.aggregatedStats;
    
    // Find this player's stats (may contain stats for comparison players too)
    const playerStats = allStats.find(s => s.player_id === playerId && s.kills > 0)
      || allStats.find(s => s.player_tag === playerTag && s.kills > 0)
      || allStats[0]; // Fallback to first entry
    
    if (!playerStats || playerStats.kills === 0) {
      return null; // No stats available
    }
    
    // Calculate per-map averages
    const hpGames = playerStats.hp_game_count || 0;
    const sndGames = playerStats.snd_game_count || 0;
    const ctlGames = playerStats.ctl_game_count || 0;
    const ovlGames = playerStats.ovl_game_count || 0;
    
    return {
      playerId,
      tag: playerTag,
      teamId: data.props.pageProps.player?.current_team_id,
      
      // Raw totals
      totalKills: playerStats.kills,
      totalDeaths: playerStats.deaths,
      totalGames: playerStats.game_count,
      damage: playerStats.damage,
      firstBloods: playerStats.first_blood_count,
      
      // Per-mode stats
      hp: {
        games: hpGames,
        kills: playerStats.hp_kills || 0,
        deaths: playerStats.hp_deaths || 0,
        assists: playerStats.hp_assists || 0,
        avg: hpGames > 0 ? +(playerStats.hp_kills / hpGames).toFixed(1) : 0,
        kd: playerStats.hp_deaths > 0 ? +(playerStats.hp_kills / playerStats.hp_deaths).toFixed(3) : 0,
      },
      snd: {
        games: sndGames,
        kills: playerStats.snd_kills || 0,
        deaths: playerStats.snd_deaths || 0,
        assists: playerStats.snd_assists || 0,
        avg: sndGames > 0 ? +(playerStats.snd_kills / sndGames).toFixed(1) : 0,
        kd: playerStats.snd_deaths > 0 ? +(playerStats.snd_kills / playerStats.snd_deaths).toFixed(3) : 0,
      },
      ctl: {
        games: ctlGames,
        kills: playerStats.ctl_kills || 0,
        deaths: playerStats.ctl_deaths || 0,
        avg: ctlGames > 0 ? +(playerStats.ctl_kills / ctlGames).toFixed(1) : 0,
      },
      ovl: {
        games: ovlGames,
        kills: playerStats.ovl_kills || 0,
        deaths: playerStats.ovl_deaths || 0,
        avg: ovlGames > 0 ? +(playerStats.ovl_kills / ovlGames).toFixed(1) : 0,
      },
      
      // Overall
      kd: playerStats.deaths > 0 ? +(playerStats.kills / playerStats.deaths).toFixed(3) : 0,
      avgKillsPerGame: playerStats.game_count > 0 ? +(playerStats.kills / playerStats.game_count).toFixed(1) : 0,
    };
  } catch (err) {
    console.error(`Failed to scrape stats for ${playerTag}:`, err.message);
    return null;
  }
}

/**
 * Scrape all CDL player stats. Rate-limited to avoid overloading BreakingPoint.
 * Call this on a cron job (every 30 min during match days, hourly otherwise).
 */
async function scrapeCDLStats() {
  console.log('Starting CDL stats scrape...');
  
  const roster = await scrapePlayerRoster();
  console.log(`Found ${roster.length} active CDL players`);
  
  const stats = {};
  let scraped = 0;
  
  for (const player of roster) {
    const playerStats = await scrapePlayerStats(player.id, player.tag);
    if (playerStats) {
      stats[player.id] = {
        ...playerStats,
        teamName: CDL_TEAM_MAP[player.current_team_id]?.name || 'Unknown',
        teamAbbr: CDL_TEAM_MAP[player.current_team_id]?.abbr || '???',
        headshot: player.headshot,
      };
      scraped++;
    }
    
    // Rate limit: 2 seconds between requests
    await new Promise(r => setTimeout(r, 2000));
  }
  
  playerStatsCache = stats;
  lastScraped = new Date().toISOString();
  console.log(`Scraped stats for ${scraped}/${roster.length} CDL players`);
  
  return { scraped, total: roster.length, timestamp: lastScraped };
}

/**
 * Generate prop lines for players in a match.
 * Maps PandaScore team names to BreakingPoint team IDs.
 */
function generateProps(team1Name, team2Name) {
  const allPlayers = Object.values(playerStatsCache);
  
  // Fuzzy match team names from PandaScore to BreakingPoint
  const matchTeam = (name) => {
    const lower = name.toLowerCase();
    return CDL_TEAMS.find(t => 
      lower.includes(t.name.toLowerCase().split(' ').pop()) || // Match last word
      lower.includes(t.abbr.toLowerCase())
    );
  };
  
  const t1 = matchTeam(team1Name);
  const t2 = matchTeam(team2Name);
  
  const team1Players = allPlayers.filter(p => p.teamId === t1?.id);
  const team2Players = allPlayers.filter(p => p.teamId === t2?.id);
  
  const generatePlayerProps = (player) => {
    const props = [];
    
    // Map 1: Hardpoint kills
    if (player.hp.games >= 3) {
      const line = Math.round(player.hp.avg * 2) / 2; // Round to nearest 0.5
      props.push({
        market: 'map1_kills',
        label: 'Map 1 Kills (HP)',
        line,
        avg: player.hp.avg,
        games: player.hp.games,
        edge: calculateEdge(player.hp.avg, line, 'hp'),
        suggestion: player.hp.avg > line + 1.5 ? 'OVER' : player.hp.avg < line - 1.5 ? 'UNDER' : null,
      });
    }
    
    // Map 2: Search & Destroy kills
    if (player.snd.games >= 3) {
      const line = Math.round(player.snd.avg * 2) / 2;
      props.push({
        market: 'map2_kills',
        label: 'Map 2 Kills (SnD)',
        line,
        avg: player.snd.avg,
        games: player.snd.games,
        edge: calculateEdge(player.snd.avg, line, 'snd'),
        suggestion: player.snd.avg > line + 0.8 ? 'OVER' : player.snd.avg < line - 0.8 ? 'UNDER' : null,
      });
    }
    
    // Map 3: Control or Overload kills
    const mode3 = player.ovl.games > player.ctl.games ? player.ovl : player.ctl;
    const mode3Label = player.ovl.games > player.ctl.games ? 'Overload' : 'Control';
    if (mode3.games >= 3) {
      const line = Math.round(mode3.avg * 2) / 2;
      props.push({
        market: 'map3_kills',
        label: `Map 3 Kills (${mode3Label})`,
        line,
        avg: mode3.avg,
        games: mode3.games,
        edge: calculateEdge(mode3.avg, line, 'ctl'),
      });
    }
    
    // Total kills Maps 1-3
    const totalAvg = player.hp.avg + player.snd.avg + mode3.avg;
    if (player.hp.games >= 3 && player.snd.games >= 3) {
      props.push({
        market: 'total_kills',
        label: 'Total Kills (Maps 1-3)',
        line: Math.round(totalAvg * 2) / 2,
        avg: +totalAvg.toFixed(1),
        games: Math.min(player.hp.games, player.snd.games),
      });
    }
    
    // Series K/D
    if (player.totalGames >= 5) {
      props.push({
        market: 'series_kd',
        label: 'Series K/D',
        line: Math.round(player.kd * 20) / 20, // Round to 0.05
        avg: player.kd,
        games: player.totalGames,
      });
    }
    
    return {
      player: player.tag,
      playerId: player.playerId,
      team: player.teamAbbr,
      teamName: player.teamName,
      headshot: player.headshot,
      kd: player.kd,
      props,
    };
  };
  
  return {
    team1: { name: t1?.name || team1Name, players: team1Players.map(generatePlayerProps) },
    team2: { name: t2?.name || team2Name, players: team2Players.map(generatePlayerProps) },
    lastUpdated: lastScraped,
  };
}

/**
 * Calculate confidence edge for a prop.
 * Higher = more confident the line is beatable.
 */
function calculateEdge(avg, line, mode) {
  // SnD has low variance (kills capped by round count)
  // HP has moderate variance
  // CTL/OVL have high variance
  const stddevMap = { hp: 5.5, snd: 2.0, ctl: 4.5, ovl: 4.0 };
  const stddev = stddevMap[mode] || 4.0;
  
  const diff = Math.abs(avg - line);
  const zScore = diff / stddev;
  
  // Convert z-score to a confidence percentage (simplified)
  // z=0.5 → ~69%, z=1.0 → ~84%, z=1.5 → ~93%
  const confidence = Math.min(99, Math.round(50 + 50 * (1 - Math.exp(-zScore * 1.5))));
  
  return {
    direction: avg > line ? 'OVER' : 'UNDER',
    confidence,
    diff: +(avg - line).toFixed(1),
  };
}

/**
 * Get cached stats for the API
 */
function getCachedStats() {
  return {
    players: Object.values(playerStatsCache),
    lastUpdated: lastScraped,
    teamCount: CDL_TEAMS.length,
  };
}

module.exports = {
  scrapeCDLStats,
  scrapePlayerStats,
  generateProps,
  getCachedStats,
  CDL_TEAMS,
  CDL_TEAM_MAP,
};
