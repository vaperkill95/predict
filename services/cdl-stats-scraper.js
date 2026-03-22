/**
 * cdl-stats-scraper.js — ENHANCED CDL Prediction Engine v2
 * 
 * Scrapes CDL player stats from BreakingPoint.gg for props generation.
 * BreakingPoint uses Next.js with Supabase — stats are embedded in __NEXT_DATA__.
 * 
 * ENHANCEMENTS over v1:
 *   1. Full 140-field scrape (BP Rating, damage, first bloods, clutch stats)
 *   2. Match history scraping for per-series, per-player kill data
 *   3. Opponent-adjusted lines (adjusts for specific team matchup)
 *   4. Recent form weighting (last 3 series weighted 2x)
 *   5. Variance/consistency scoring (stddev from actual match data)
 *   6. Team pace factor (fast teams inflate kill totals)
 * 
 * Usage:
 *   const { scrapeCDLStats, generateProps, getCachedStats } = require('./cdl-stats-scraper');
 *   await scrapeCDLStats();
 *   const props = generateProps('OpTic Texas', 'FaZe Vegas');
 */

const axios = require('axios');

// ============================================================
// CDL Teams (BreakingPoint IDs → PandaScore name matching)
// ============================================================
const CDL_TEAMS = [
  { id: 6, name: 'Boston Breach', abbr: 'BOS', aliases: ['breach', 'boston'] },
  { id: 26, name: 'Carolina Royal Ravens', abbr: 'CRR', aliases: ['ravens', 'carolina', 'royal ravens'] },
  { id: 63, name: 'Cloud9 New York', abbr: 'C9', aliases: ['cloud9', 'new york', 'c9 new york'] },
  { id: 1, name: 'FaZe Vegas', abbr: 'FAZE', aliases: ['faze', 'vegas'] },
  { id: 11, name: 'G2 Minnesota', abbr: 'MIN', aliases: ['g2', 'minnesota', 'rokkr'] },
  { id: 2, name: 'Los Angeles Thieves', abbr: 'LAT', aliases: ['thieves', 'los angeles', 'la thieves'] },
  { id: 27, name: 'Miami Heretics', abbr: 'MIA', aliases: ['heretics', 'miami'] },
  { id: 4, name: 'OpTic Texas', abbr: 'OPT', aliases: ['optic', 'texas'] },
  { id: 743, name: 'Paris Gentle Mates', abbr: 'PGM', aliases: ['gentle mates', 'paris'] },
  { id: 62, name: 'Riyadh Falcons', abbr: 'RYD', aliases: ['falcons', 'riyadh'] },
  { id: 12, name: 'Toronto KOI', abbr: 'TOR', aliases: ['koi', 'toronto'] },
  { id: 3, name: 'Vancouver Surge', abbr: 'VAN', aliases: ['surge', 'vancouver'] },
];

const CDL_TEAM_MAP = Object.fromEntries(CDL_TEAMS.map(t => [t.id, t]));

// ============================================================
// Caches (in-memory, synced to Redis by server.js)
// ============================================================
var playerStatsCache = {};   // { playerId: { ...fullStats } }
var matchHistoryCache = {};  // { _h2h: { "teamA_vs_teamB": [...] }, _lastFetched }
var teamPaceCache = {};      // { teamId: { hp: paceMultiplier, snd: ..., ovl: ... } }
var lastScraped = null;

// v3 Caches
var playerMatchKills = {};   // { playerId: [ { matchId, date, opponentId, mode, mapNum, kills } ] }
var teamMapWinRates = {};    // { teamId: { "mapId_modeId": { wins, losses, pct } } }
var mapPickHistory = {};     // { teamId: [ { matchId, action: 'Pick'|'Ban', mapId, modeId } ] }
var recentMatchIds = [];     // Match IDs already scraped (avoid re-scraping)

// ============================================================
// Utility: extract __NEXT_DATA__ from BreakingPoint pages
// ============================================================
function extractNextData(html) {
  var match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find __NEXT_DATA__');
  return JSON.parse(match[1]);
}

// ============================================================
// Fuzzy team name matching (PandaScore → BreakingPoint)
// ============================================================
function matchTeam(name) {
  if (!name) return null;
  var lower = name.toLowerCase();
  // Exact name match first
  var exact = CDL_TEAMS.find(function(t) { return t.name.toLowerCase() === lower; });
  if (exact) return exact;
  // Alias match
  for (var i = 0; i < CDL_TEAMS.length; i++) {
    var t = CDL_TEAMS[i];
    for (var j = 0; j < t.aliases.length; j++) {
      if (lower.includes(t.aliases[j])) return t;
    }
    if (lower.includes(t.abbr.toLowerCase())) return t;
  }
  return null;
}

// ============================================================
// SCRAPE: Player roster from /stats/players
// ============================================================
async function scrapePlayerRoster() {
  var resp = await axios.get('https://www.breakingpoint.gg/stats/players', {
    headers: { 'User-Agent': 'ORACLE-CDL-Props/2.0' },
    timeout: 15000,
  });
  var data = extractNextData(resp.data);
  var players = data.props.pageProps.allPlayers;
  var cdlTeamIds = CDL_TEAMS.map(function(t) { return t.id; });
  return players.filter(function(p) { return cdlTeamIds.includes(p.current_team_id) && !p.retired; });
}

// ============================================================
// SCRAPE: Full 140-field player stats from /players/{id}/{tag}
// Includes BP Rating, damage, first bloods, clutch stats,
// plus ALL other players' aggregated stats for leaderboard context
// ============================================================
async function scrapePlayerStats(playerId, playerTag) {
  try {
    var resp = await axios.get(
      'https://www.breakingpoint.gg/players/' + playerId + '/' + encodeURIComponent(playerTag),
      { headers: { 'User-Agent': 'ORACLE-CDL-Props/2.0' }, timeout: 15000 }
    );
    var data = extractNextData(resp.data);
    var allStats = data.props.pageProps.aggregatedStats;

    // Find this player's season stats (the entry matching their player_id)
    var ps = allStats.find(function(s) { return s.player_id === playerId && s.kills > 0; })
      || allStats.find(function(s) { return s.player_tag === playerTag && s.kills > 0; });
    if (!ps || ps.kills === 0) return null;

    var hpG = ps.hp_game_count || 0;
    var sndG = ps.snd_game_count || 0;
    var ctlG = ps.ctl_game_count || 0;
    var ovlG = ps.ovl_game_count || 0;
    var totalG = ps.game_count || 0;
    var matchesPlayed = ps.matches_played || 0;

    // Build per-series kill history from aggregated stats
    // The aggregated stats page contains multiple entries per player (one per event/stage)
    // Extract ALL entries for this player to compute recent form + variance
    var playerEntries = allStats.filter(function(s) {
      return (s.player_id === playerId || s.player_tag === playerTag) && s.kills > 0;
    });

    // Compute per-series averages from each entry (each entry = one event/stage)
    var hpKillsPerSeries = [];
    var sndKillsPerSeries = [];
    var ovlKillsPerSeries = [];
    var totalKillsPerSeries = [];
    playerEntries.forEach(function(entry) {
      if (entry.hp_game_count > 0) hpKillsPerSeries.push(entry.hp_kills / entry.hp_game_count);
      if (entry.snd_game_count > 0) sndKillsPerSeries.push(entry.snd_kills / entry.snd_game_count);
      if (entry.ovl_game_count > 0) ovlKillsPerSeries.push(entry.ovl_kills / entry.ovl_game_count);
      if (entry.game_count > 0) totalKillsPerSeries.push(entry.kills / entry.game_count);
    });

    return {
      playerId: playerId,
      tag: playerTag,
      teamId: data.props.pageProps.player ? data.props.pageProps.player.current_team_id : null,

      // Season totals
      totalKills: ps.kills,
      totalDeaths: ps.deaths,
      totalGames: totalG,
      matchesPlayed: matchesPlayed,
      damage: ps.damage || 0,
      firstBloods: ps.first_blood_count || 0,
      firstDeaths: ps.first_death_count || 0,

      // Advanced stats
      nonTradedKills: ps.non_traded_kills || 0,
      highestStreak: ps.highest_streak || 0,
      clutch1v1: ps.one_v_one_win_count || 0,
      clutch1v2: ps.one_v_two_win_count || 0,
      clutch1v3: ps.one_v_three_win_count || 0,
      clutch1v4: ps.one_v_four_win_count || 0,
      hillTime: ps.hill_time || 0,
      contestedHillTime: ps.contested_hill_time || 0,
      plants: ps.plant_count || 0,
      defuses: ps.defuse_count || 0,
      zoneCaptures: ps.zone_capture_count || 0,
      overloads: ps.overloads || 0,

      // BP Ratings (impact metric, 1.0 = average)
      bpRating: {
        hp: ps.hp_bp_rating ? +(ps.hp_bp_rating / Math.max(hpG, 1)).toFixed(3) : 0,
        snd: ps.snd_bp_rating ? +(ps.snd_bp_rating / Math.max(sndG, 1)).toFixed(3) : 0,
        ctl: ps.ctl_bp_rating ? +(ps.ctl_bp_rating / Math.max(ctlG, 1)).toFixed(3) : 0,
        ovl: ps.ovl_bp_rating ? +(ps.ovl_bp_rating / Math.max(ovlG, 1)).toFixed(3) : 0,
      },

      // Max kills (ceiling indicator)
      maxKills: {
        hp: ps.max_hp_kills || 0,
        snd: ps.max_snd_kills || 0,
        ctl: ps.max_ctl_kills || 0,
        ovl: ps.max_ovl_kills || 0,
        series: ps.max_match_kills || 0,
        maxKD: ps.max_match_kd || 0,
      },

      // Per-mode detailed stats
      hp: {
        games: hpG,
        kills: ps.hp_kills || 0,
        deaths: ps.hp_deaths || 0,
        assists: ps.hp_assists || 0,
        damage: ps.hp_damage || 0,
        avg: hpG > 0 ? +(ps.hp_kills / hpG).toFixed(1) : 0,
        kd: ps.hp_deaths > 0 ? +(ps.hp_kills / ps.hp_deaths).toFixed(3) : 0,
        damagePerMap: hpG > 0 ? +((ps.hp_damage || 0) / hpG).toFixed(0) : 0,
        mapWins: ps.hp_map_wins || 0,
        mapWinPct: hpG > 0 ? +((ps.hp_map_wins || 0) / hpG * 100).toFixed(1) : 0,
        // Variance from per-series data
        killHistory: hpKillsPerSeries,
        stddev: computeStddev(hpKillsPerSeries),
      },
      snd: {
        games: sndG,
        kills: ps.snd_kills || 0,
        deaths: ps.snd_deaths || 0,
        assists: ps.snd_assists || 0,
        avg: sndG > 0 ? +(ps.snd_kills / sndG).toFixed(1) : 0,
        kd: ps.snd_deaths > 0 ? +(ps.snd_kills / ps.snd_deaths).toFixed(3) : 0,
        rounds: ps.snd_rounds || 0,
        avgPerRound: ps.snd_rounds > 0 ? +(ps.snd_kills / ps.snd_rounds).toFixed(3) : 0,
        firstBloods: ps.snd_first_blood_count || ps.first_blood_count || 0,
        mapWins: ps.snd_map_wins || 0,
        killHistory: sndKillsPerSeries,
        stddev: computeStddev(sndKillsPerSeries),
      },
      ctl: {
        games: ctlG,
        kills: ps.ctl_kills || 0,
        deaths: ps.ctl_deaths || 0,
        avg: ctlG > 0 ? +(ps.ctl_kills / ctlG).toFixed(1) : 0,
        kd: ps.ctl_deaths > 0 ? +(ps.ctl_kills / ps.ctl_deaths).toFixed(3) : 0,
        mapWins: ps.ctl_map_wins || 0,
      },
      ovl: {
        games: ovlG,
        kills: ps.ovl_kills || 0,
        deaths: ps.ovl_deaths || 0,
        avg: ovlG > 0 ? +(ps.ovl_kills / ovlG).toFixed(1) : 0,
        kd: ps.ovl_deaths > 0 ? +(ps.ovl_kills / ps.ovl_deaths).toFixed(3) : 0,
        overloads: ps.overloads || 0,
        mapWins: ps.ovl_map_wins || 0,
        killHistory: ovlKillsPerSeries,
        stddev: computeStddev(ovlKillsPerSeries),
      },

      // Overall
      kd: ps.deaths > 0 ? +(ps.kills / ps.deaths).toFixed(3) : 0,
      avgKillsPerGame: totalG > 0 ? +(ps.kills / totalG).toFixed(1) : 0,

      // Win rates
      matchWins: ps.match_wins || 0,
      matchWinPct: matchesPlayed > 0 ? +((ps.match_wins || 0) / matchesPlayed * 100).toFixed(1) : 0,
      mapWins: ps.map_wins || 0,
      mapWinPct: totalG > 0 ? +((ps.map_wins || 0) / totalG * 100).toFixed(1) : 0,

      // Recent form (from per-event entries)
      recentForm: computeRecentForm(playerEntries),
      killHistoryAll: totalKillsPerSeries,
    };
  } catch (err) {
    console.error('Failed to scrape stats for ' + playerTag + ':', err.message);
    return null;
  }
}

// ============================================================
// SCRAPE: Match history from PandaScore (for H2H + recent form)
// Uses past matches endpoint with player stats per game
// ============================================================
async function scrapeMatchHistory() {
  try {
    var apiKey = process.env.PANDASCORE_API_KEY;
    if (!apiKey) { console.log('[CDL] No PandaScore key — skipping match history'); return; }

    var resp = await axios.get('https://api.pandascore.co/codmw/matches/past', {
      headers: { Authorization: 'Bearer ' + apiKey },
      params: { 'page[size]': 50, sort: '-scheduled_at', 'filter[league_id]': 4747 },
      timeout: 15000,
    });

    var matches = resp.data || [];
    var h2hData = {}; // { "teamA_vs_teamB": [ { date, team1Score, team2Score } ] }

    for (var m of matches) {
      if (!m.opponents || m.opponents.length < 2) continue;
      var t1Name = m.opponents[0].opponent ? m.opponents[0].opponent.name : null;
      var t2Name = m.opponents[1].opponent ? m.opponents[1].opponent.name : null;
      if (!t1Name || !t2Name) continue;
      var t1 = matchTeam(t1Name);
      var t2 = matchTeam(t2Name);
      if (!t1 || !t2) continue;

      var key1 = t1.id + '_vs_' + t2.id;
      var key2 = t2.id + '_vs_' + t1.id;
      if (!h2hData[key1]) h2hData[key1] = [];
      if (!h2hData[key2]) h2hData[key2] = [];

      var entry = {
        date: m.scheduled_at,
        matchId: m.id,
        winner: m.winner ? matchTeam(m.winner.name) : null,
        games: (m.games || []).length,
        t1Score: m.results && m.results[0] ? m.results[0].score : 0,
        t2Score: m.results && m.results[1] ? m.results[1].score : 0,
      };
      h2hData[key1].push(entry);
      h2hData[key2].push({ ...entry, t1Score: entry.t2Score, t2Score: entry.t1Score });
    }

    // Store in cache
    matchHistoryCache._h2h = h2hData;
    matchHistoryCache._lastFetched = new Date().toISOString();
    matchHistoryCache._matchIds = matches.map(function(m) { return m.id; });
    console.log('[CDL] Fetched ' + matches.length + ' past matches for H2H data');
  } catch (err) {
    console.warn('[CDL] Match history fetch failed:', err.message);
  }
}

// ============================================================
// v3: SCRAPE per-match scoreboards from BreakingPoint match pages
// Gets actual kills per player per mode per match for:
//   - True H2H player-level kill data vs specific opponents
//   - Recent 5-match form with actual kill numbers
//   - Per-map kill variance (real stddev from match data)
// ============================================================
async function scrapeMatchScoreboards() {
  try {
    // Get list of recent match IDs from PandaScore
    var apiKey = process.env.PANDASCORE_API_KEY;
    if (!apiKey) return;

    var resp = await axios.get('https://api.pandascore.co/codmw/matches/past', {
      headers: { Authorization: 'Bearer ' + apiKey },
      params: { 'page[size]': 20, sort: '-scheduled_at', 'filter[league_id]': 4747, 'filter[status]': 'finished' },
      timeout: 15000,
    });

    var pandaMatches = resp.data || [];
    // Map PandaScore match to BreakingPoint match IDs
    // We'll scrape individual match pages on BreakingPoint using team IDs + dates
    // For now, scrape recent completed matches from BreakingPoint /matches page
    var bpMatchIds = [];
    
    // Get recent BP match IDs from the matches page
    try {
      var bpResp = await axios.get('https://www.breakingpoint.gg/matches', {
        headers: { 'User-Agent': 'ORACLE-CDL-Props/2.0' },
        timeout: 15000,
      });
      var bpData = extractNextData(bpResp.data);
      var trpc = bpData.props.pageProps.trpcState;
      if (trpc && trpc.json && trpc.json.queries) {
        for (var i = 0; i < trpc.json.queries.length; i++) {
          var q = trpc.json.queries[i];
          var qk = JSON.stringify(q.queryKey || '');
          if (qk.includes('fetchMatches') && q.state && q.state.data) {
            var matchData = q.state.data;
            if (Array.isArray(matchData)) {
              matchData.forEach(function(m) {
                if (m.id && m.winner_id && !recentMatchIds.includes(m.id)) {
                  bpMatchIds.push(m.id);
                }
              });
            } else if (matchData.pages) {
              // Paginated format
              (matchData.pages || []).forEach(function(page) {
                (page || []).forEach(function(m) {
                  if (m.id && m.winner_id && !recentMatchIds.includes(m.id)) {
                    bpMatchIds.push(m.id);
                  }
                });
              });
            }
          }
        }
      }
    } catch(e) { /* matches page may fail */ }

    // Limit to 10 matches per scrape cycle to avoid rate limits
    var toScrape = bpMatchIds.slice(0, 10);
    var totalNewKills = 0;

    for (var mi = 0; mi < toScrape.length; mi++) {
      var matchId = toScrape[mi];
      try {
        var mResp = await axios.get('https://lab.breakingpoint.gg/match/' + matchId, {
          headers: { 'User-Agent': 'ORACLE-CDL-Props/2.0' },
          timeout: 15000,
        });
        var mData = extractNextData(mResp.data);
        var pp = mData.props.pageProps;

        // Extract playersLastFiveMatchStats — per-player, per-mode, per-map kills
        var plfms = pp.playersLastFiveMatchStats;
        if (plfms) {
          var entries = Object.values(plfms);
          entries.forEach(function(e) {
            if (!e.player_id || !e.kills) return;
            var pid = e.player_id;
            if (!playerMatchKills[pid]) playerMatchKills[pid] = [];

            // Determine opponent
            var opponentId = e.matches.team_1_id === e.team_id ? e.matches.team_2_id : e.matches.team_1_id;

            playerMatchKills[pid].push({
              matchId: e.match_id,
              date: e.matches.datetime,
              opponentId: opponentId,
              teamId: e.team_id,
              modeId: e.mode_id, // 1=HP, 2=SnD, 3=CTL, 5=OVL
              mapNum: e.games ? e.games.game_num : null,
              kills: e.kills,
              firstBloods: e.first_blood_count || 0,
              won: e.matches.winner_id === e.team_id,
              seriesScore: e.matches.team_1_id === e.team_id
                ? e.matches.team_1_score + '-' + e.matches.team_2_score
                : e.matches.team_2_score + '-' + e.matches.team_1_score,
            });
            totalNewKills++;
          });
        }

        // Extract map pick/ban data from trpcState
        if (pp.trpcState && pp.trpcState.json && pp.trpcState.json.queries) {
          pp.trpcState.json.queries.forEach(function(q) {
            var qk = JSON.stringify(q.queryKey || '');
            // Map picks and vetoes
            if (qk.includes('fetchMapPicksAndVetoes') && q.state && q.state.data) {
              var picks = q.state.data;
              if (Array.isArray(picks)) {
                picks.forEach(function(p) {
                  var tid = p.team_id;
                  if (!tid) return;
                  if (!mapPickHistory[tid]) mapPickHistory[tid] = [];
                  mapPickHistory[tid].push({
                    matchId: p.match_id,
                    action: p.action, // 'Pick' or 'Ban'
                    mapId: p.map_id,
                    modeId: p.mode_id,
                    mapNumber: p.map_number,
                    order: p.order,
                  });
                });
              }
            }
            // Team map-mode win rates (60 days)
            if (qk.includes('fetchMapModeStatsForTeams') && q.state && q.state.data) {
              var teamData = q.state.data;
              for (var tid in teamData) {
                if (!teamMapWinRates[tid]) teamMapWinRates[tid] = {};
                var maps = teamData[tid];
                if (Array.isArray(maps)) {
                  maps.forEach(function(m) {
                    var key = m.map_id + '_' + m.mode_id;
                    teamMapWinRates[tid][key] = {
                      mapName: m.map_name,
                      modeName: m.mode_name,
                      wins: m.wins || 0,
                      losses: m.losses || 0,
                      pct: m.percentage || (m.wins + m.losses > 0 ? Math.round(m.wins / (m.wins + m.losses) * 100) : 0),
                    };
                  });
                }
              }
            }
          });
        }

        recentMatchIds.push(matchId);
        // Rate limit between match page scrapes
        await new Promise(function(r) { setTimeout(r, 2000); });
      } catch(e) {
        // Individual match scrape failures are OK
      }
    }

    console.log('[CDL-v3] Scraped ' + toScrape.length + ' match scoreboards, ' + totalNewKills + ' kill entries, ' + Object.keys(teamMapWinRates).length + ' team map stats, ' + Object.keys(mapPickHistory).length + ' team pick histories');
  } catch(err) {
    console.warn('[CDL-v3] Match scoreboard scrape failed:', err.message);
  }
}

// ============================================================
// v3: Get player's kill history vs a specific opponent (H2H)
// ============================================================
function getPlayerH2HKills(playerId, opponentTeamId, modeId) {
  var kills = playerMatchKills[playerId] || [];
  var h2h = kills.filter(function(k) {
    return k.opponentId === opponentTeamId && (modeId === undefined || k.modeId === modeId);
  });
  if (h2h.length === 0) return null;

  var killValues = h2h.map(function(k) { return k.kills; });
  var avg = killValues.reduce(function(s, v) { return s + v; }, 0) / killValues.length;
  var stddev = computeStddev(killValues);
  var wins = h2h.filter(function(k) { return k.won; }).length;

  return {
    matches: h2h.length,
    avgKills: +avg.toFixed(1),
    stddev: stddev,
    minKills: Math.min.apply(null, killValues),
    maxKills: Math.max.apply(null, killValues),
    winPct: +(wins / h2h.length * 100).toFixed(1),
    recentKills: h2h.sort(function(a, b) { return new Date(b.date) - new Date(a.date); }).slice(0, 3).map(function(k) { return k.kills; }),
  };
}

// ============================================================
// v3: Get player's recent form from actual match kill data
// More accurate than aggregated stats — uses real per-match kills
// ============================================================
function getPlayerRecentKills(playerId, modeId, count) {
  var kills = playerMatchKills[playerId] || [];
  var modeKills = kills.filter(function(k) { return modeId === undefined || k.modeId === modeId; });
  // Sort by date descending
  modeKills.sort(function(a, b) { return new Date(b.date) - new Date(a.date); });
  var recent = modeKills.slice(0, count || 5);
  if (recent.length === 0) return null;

  var killValues = recent.map(function(k) { return k.kills; });
  var avg = killValues.reduce(function(s, v) { return s + v; }, 0) / killValues.length;

  return {
    matches: recent.length,
    avgKills: +avg.toFixed(1),
    kills: killValues,
    stddev: computeStddev(killValues),
    trend: killValues.length >= 3 ? (killValues[0] > avg ? 'up' : killValues[0] < avg ? 'down' : 'flat') : 'unknown',
  };
}

// ============================================================
// v3: Get team's preferred maps from pick history
// ============================================================
function getTeamMapPreferences(teamId, modeId) {
  var picks = mapPickHistory[teamId] || [];
  var modePicks = picks.filter(function(p) {
    return p.action === 'Pick' && (modeId === undefined || p.modeId === modeId);
  });
  // Count how often each map is picked
  var mapCounts = {};
  modePicks.forEach(function(p) {
    var k = p.mapId;
    if (!mapCounts[k]) mapCounts[k] = 0;
    mapCounts[k]++;
  });
  // Sort by count
  var sorted = Object.keys(mapCounts).sort(function(a, b) { return mapCounts[b] - mapCounts[a]; });
  return sorted.map(function(mapId) {
    return { mapId: parseInt(mapId), count: mapCounts[mapId] };
  });
}

// ============================================================
// COMPUTE: Standard deviation from kill history
// ============================================================
function computeStddev(values) {
  if (!values || values.length < 2) return 0;
  var mean = values.reduce(function(s, v) { return s + v; }, 0) / values.length;
  var variance = values.reduce(function(s, v) { return s + Math.pow(v - mean, 2); }, 0) / values.length;
  return +Math.sqrt(variance).toFixed(2);
}

// ============================================================
// COMPUTE: Recent form from per-event stat entries
// Weight last 3 entries 2x vs older entries
// ============================================================
function computeRecentForm(entries) {
  if (!entries || entries.length < 2) return { trend: 'neutral', recentAvg: 0, seasonAvg: 0, momentum: 0 };

  // Sort by game count descending (most recent events have highest counts)
  // Actually, entries are pre-sorted from the aggregated stats
  var recent = entries.slice(-3); // Last 3 events
  var older = entries.slice(0, -3);

  var recentKPG = 0, seasonKPG = 0;
  var rGames = 0, sGames = 0;

  recent.forEach(function(e) {
    if (e.game_count > 0) { recentKPG += e.kills; rGames += e.game_count; }
  });
  entries.forEach(function(e) {
    if (e.game_count > 0) { seasonKPG += e.kills; sGames += e.game_count; }
  });

  recentKPG = rGames > 0 ? recentKPG / rGames : 0;
  seasonKPG = sGames > 0 ? seasonKPG / sGames : 0;

  var momentum = seasonKPG > 0 ? +((recentKPG - seasonKPG) / seasonKPG * 100).toFixed(1) : 0;
  var trend = momentum > 5 ? 'hot' : momentum < -5 ? 'cold' : 'neutral';

  return {
    trend: trend,
    recentAvg: +recentKPG.toFixed(1),
    seasonAvg: +seasonKPG.toFixed(1),
    momentum: momentum, // +10% = performing 10% better recently
    recentGames: rGames,
  };
}

// ============================================================
// COMPUTE: Team pace factor
// Measures total team kills per mode — fast-paced teams inflate everyone's numbers
// ============================================================
function computeTeamPace() {
  var teamKills = {}; // { teamId: { hp: totalKills, hpG: games, snd: ..., ovl: ... } }

  var allPlayers = Object.values(playerStatsCache);
  allPlayers.forEach(function(p) {
    if (!p.teamId) return;
    if (!teamKills[p.teamId]) teamKills[p.teamId] = { hp: 0, hpG: 0, snd: 0, sndG: 0, ovl: 0, ovlG: 0, total: 0, totalG: 0 };
    var tk = teamKills[p.teamId];
    tk.hp += p.hp.kills; tk.hpG = Math.max(tk.hpG, p.hp.games); // Use max (all teammates play same maps)
    tk.snd += p.snd.kills; tk.sndG = Math.max(tk.sndG, p.snd.games);
    tk.ovl += p.ovl.kills; tk.ovlG = Math.max(tk.ovlG, p.ovl.games);
    tk.total += p.totalKills; tk.totalG = Math.max(tk.totalG, p.totalGames);
  });

  // Compute league average pace
  var leagueHP = 0, leagueSND = 0, leagueOVL = 0, teamCount = 0;
  for (var tid in teamKills) {
    var tk = teamKills[tid];
    if (tk.hpG > 0) leagueHP += tk.hp / tk.hpG;
    if (tk.sndG > 0) leagueSND += tk.snd / tk.sndG;
    if (tk.ovlG > 0) leagueOVL += tk.ovl / tk.ovlG;
    teamCount++;
  }
  leagueHP /= Math.max(teamCount, 1);
  leagueSND /= Math.max(teamCount, 1);
  leagueOVL /= Math.max(teamCount, 1);

  // Calculate pace factor for each team (1.0 = league average)
  for (var tid in teamKills) {
    var tk = teamKills[tid];
    teamPaceCache[tid] = {
      hp: leagueHP > 0 && tk.hpG > 0 ? +((tk.hp / tk.hpG) / leagueHP).toFixed(3) : 1.0,
      snd: leagueSND > 0 && tk.sndG > 0 ? +((tk.snd / tk.sndG) / leagueSND).toFixed(3) : 1.0,
      ovl: leagueOVL > 0 && tk.ovlG > 0 ? +((tk.ovl / tk.ovlG) / leagueOVL).toFixed(3) : 1.0,
      totalKillsPerMap: tk.totalG > 0 ? +(tk.total / tk.totalG).toFixed(1) : 0,
    };
  }
}

// ============================================================
// MAIN SCRAPE: Scrape all CDL player stats + match history
// ============================================================
async function scrapeCDLStats() {
  console.log('Starting CDL stats scrape...');
  var roster = await scrapePlayerRoster();
  console.log('Found ' + roster.length + ' active CDL players');

  var stats = {};
  var scraped = 0;

  for (var i = 0; i < roster.length; i++) {
    var player = roster[i];
    var playerStats = await scrapePlayerStats(player.id, player.tag);
    if (playerStats) {
      stats[player.id] = Object.assign({}, playerStats, {
        teamName: CDL_TEAM_MAP[player.current_team_id] ? CDL_TEAM_MAP[player.current_team_id].name : 'Unknown',
        teamAbbr: CDL_TEAM_MAP[player.current_team_id] ? CDL_TEAM_MAP[player.current_team_id].abbr : '???',
        headshot: player.headshot,
      });
      scraped++;
    }
    // Rate limit: 1.5 seconds between requests
    await new Promise(function(r) { setTimeout(r, 1500); });
  }

  playerStatsCache = stats;
  lastScraped = new Date().toISOString();
  console.log('Scraped stats for ' + scraped + '/' + roster.length + ' CDL players');

  // Compute team pace factors
  computeTeamPace();
  console.log('[CDL] Team pace factors computed for ' + Object.keys(teamPaceCache).length + ' teams');

  // Fetch match history for H2H data (non-blocking)
  scrapeMatchHistory().catch(function(e) { console.warn('[CDL] H2H fetch error:', e.message); });

  // v3: Scrape per-match scoreboards for player-level H2H kills (non-blocking, runs after main scrape)
  setTimeout(function() {
    scrapeMatchScoreboards().catch(function(e) { console.warn('[CDL-v3] Scoreboard scrape error:', e.message); });
  }, 5000); // Wait 5s after main scrape to avoid rate limits

  return { scraped: scraped, total: roster.length, timestamp: lastScraped };
}

// ============================================================
// GENERATE PROPS: Enhanced prediction engine
// ============================================================
function generateProps(team1Name, team2Name) {
  var allPlayers = Object.values(playerStatsCache);
  var t1 = matchTeam(team1Name);
  var t2 = matchTeam(team2Name);
  var team1Players = allPlayers.filter(function(p) { return p.teamId === (t1 ? t1.id : -1); });
  var team2Players = allPlayers.filter(function(p) { return p.teamId === (t2 ? t2.id : -1); });

  // Get H2H data for this matchup
  var h2h = null;
  if (t1 && t2 && matchHistoryCache._h2h) {
    h2h = matchHistoryCache._h2h[t1.id + '_vs_' + t2.id] || null;
  }

  // Get opponent team pace (the opposing team's pace affects kill totals)
  var t1Pace = t1 && teamPaceCache[t1.id] ? teamPaceCache[t1.id] : { hp: 1.0, snd: 1.0, ovl: 1.0 };
  var t2Pace = t2 && teamPaceCache[t2.id] ? teamPaceCache[t2.id] : { hp: 1.0, snd: 1.0, ovl: 1.0 };

  function buildPlayerProps(player, opponentTeam, opponentPace) {
    var props = [];

    // ---- ADJUSTMENT FACTORS ----

    // 1. Opponent pace adjustment: if opponent is a fast team (pace > 1.0),
    //    expect more kills for everyone. If slow team, fewer kills.
    //    Blend with 1.0 (50% weight) to avoid over-adjusting
    var paceAdjHP = (1.0 + opponentPace.hp) / 2;
    var paceAdjSND = (1.0 + opponentPace.snd) / 2;
    var paceAdjOVL = (1.0 + opponentPace.ovl) / 2;

    // 2. Recent form adjustment: use ACTUAL per-match kills if available (v3), fall back to aggregated (v2)
    var formMult = 1.0;
    var recentHP = getPlayerRecentKills(player.playerId, 1, 5); // mode 1 = HP
    var recentSND = getPlayerRecentKills(player.playerId, 2, 5); // mode 2 = SnD
    var recentOVL = getPlayerRecentKills(player.playerId, 5, 5); // mode 5 = OVL
    // Use per-match recent form if available (more accurate than aggregated)
    if (recentHP && recentHP.matches >= 3) {
      var recentVsSeason = player.hp.avg > 0 ? (recentHP.avgKills - player.hp.avg) / player.hp.avg : 0;
      formMult = 1.0 + Math.max(-0.075, Math.min(0.075, recentVsSeason)); // Clamp ±7.5%
    } else if (player.recentForm && player.recentForm.trend === 'hot') {
      formMult = 1.0 + Math.min(player.recentForm.momentum, 15) / 200;
    } else if (player.recentForm && player.recentForm.trend === 'cold') {
      formMult = 1.0 + Math.max(player.recentForm.momentum, -15) / 200;
    }

    // 3. H2H adjustment: v3 uses PLAYER-LEVEL kill data vs specific opponent
    var h2hMult = 1.0;
    var h2hHP = null, h2hSND = null, h2hOVL = null;
    var h2hMultHP = 1.0, h2hMultSND = 1.0, h2hMultOVL = 1.0;
    if (opponentTeam) {
      // v3: per-player, per-mode kills vs this specific opponent
      h2hHP = getPlayerH2HKills(player.playerId, opponentTeam.id, 1);
      h2hSND = getPlayerH2HKills(player.playerId, opponentTeam.id, 2);
      h2hOVL = getPlayerH2HKills(player.playerId, opponentTeam.id, 5);

      // If we have H2H data, blend it with season avg (60% H2H, 40% season)
      if (h2hHP && h2hHP.matches >= 2 && player.hp.avg > 0) {
        var h2hRatio = h2hHP.avgKills / player.hp.avg;
        h2hMultHP = 0.4 + 0.6 * h2hRatio; // Weighted: 60% H2H actual, 40% season
      }
      if (h2hSND && h2hSND.matches >= 2 && player.snd.avg > 0) {
        var h2hRatio = h2hSND.avgKills / player.snd.avg;
        h2hMultSND = 0.4 + 0.6 * h2hRatio;
      }
      if (h2hOVL && h2hOVL.matches >= 2) {
        var mode3Avg = player.ovl.games > player.ctl.games ? player.ovl.avg : player.ctl.avg;
        if (mode3Avg > 0) {
          var h2hRatio = h2hOVL.avgKills / mode3Avg;
          h2hMultOVL = 0.4 + 0.6 * h2hRatio;
        }
      }

      // Fall back to team-level H2H if no player-level data
      if (!h2hHP && h2h && h2h.length >= 2) {
        var h2hWins = h2h.filter(function(m) { return m.t1Score > m.t2Score; }).length;
        var h2hWinPct = h2hWins / h2h.length;
        h2hMult = 0.95 + (h2hWinPct * 0.1);
        h2hMultHP = h2hMult; h2hMultSND = h2hMult; h2hMultOVL = h2hMult;
      }
    }

    // 4. v3: Team map win rate adjustment — if opponent is strong/weak on the likely map
    var mapWinAdj = 1.0;
    if (opponentTeam && teamMapWinRates[opponentTeam.id]) {
      var oppMaps = teamMapWinRates[opponentTeam.id];
      // Count total win/loss across all HP maps to gauge overall mode strength
      var hpWins = 0, hpLosses = 0;
      for (var mk in oppMaps) {
        if (mk.includes('_1')) { hpWins += oppMaps[mk].wins; hpLosses += oppMaps[mk].losses; }
      }
      if (hpWins + hpLosses >= 3) {
        var oppHPwinPct = hpWins / (hpWins + hpLosses);
        // If opponent wins 70% of HP maps, your kills might be lower; if 30%, higher
        mapWinAdj = 1.0 + (0.5 - oppHPwinPct) * 0.15; // ±7.5% range
      }
    }

    // Combined adjustment multipliers (per-mode for v3 accuracy)
    var adjHP = paceAdjHP * formMult * h2hMultHP * mapWinAdj;
    var adjSND = paceAdjSND * formMult * h2hMultSND;
    var adjOVL = paceAdjOVL * formMult * h2hMultOVL;

    // ---- PROP GENERATION ----

    // Map 1: Hardpoint kills
    if (player.hp.games >= 3) {
      // v3: Use actual H2H stddev if available, else fall back to aggregated
      var hpStddev = (h2hHP && h2hHP.stddev > 0) ? h2hHP.stddev : (recentHP && recentHP.stddev > 0 ? recentHP.stddev : player.hp.stddev);
      var adjustedAvg = +(player.hp.avg * adjHP).toFixed(1);
      var line = Math.round(adjustedAvg * 2) / 2;
      props.push({
        market: 'map1_kills',
        label: 'Map 1 Kills (HP)',
        line: line,
        avg: player.hp.avg,
        adjustedAvg: adjustedAvg,
        games: player.hp.games,
        edge: calculateEdgeV2(adjustedAvg, line, 'hp', hpStddev, player.hp.games),
        suggestion: adjustedAvg > line + 1.0 ? 'OVER' : adjustedAvg < line - 1.0 ? 'UNDER' : null,
        bpRating: player.bpRating.hp,
        form: recentHP ? recentHP.trend : (player.recentForm ? player.recentForm.trend : 'neutral'),
        paceAdj: +(paceAdjHP).toFixed(3),
        h2hAdj: +(h2hMultHP).toFixed(3),
        h2hData: h2hHP ? { avg: h2hHP.avgKills, matches: h2hHP.matches, recent: h2hHP.recentKills } : null,
        recentKills: recentHP ? recentHP.kills : null,
      });
    }

    // Map 2: Search & Destroy kills
    if (player.snd.games >= 3) {
      var sndStddev = (h2hSND && h2hSND.stddev > 0) ? h2hSND.stddev : (recentSND && recentSND.stddev > 0 ? recentSND.stddev : player.snd.stddev);
      var adjustedAvg = +(player.snd.avg * adjSND).toFixed(1);
      var line = Math.round(adjustedAvg * 2) / 2;
      props.push({
        market: 'map2_kills',
        label: 'Map 2 Kills (SnD)',
        line: line,
        avg: player.snd.avg,
        adjustedAvg: adjustedAvg,
        games: player.snd.games,
        edge: calculateEdgeV2(adjustedAvg, line, 'snd', sndStddev, player.snd.games),
        suggestion: adjustedAvg > line + 0.5 ? 'OVER' : adjustedAvg < line - 0.5 ? 'UNDER' : null,
        bpRating: player.bpRating.snd,
        avgPerRound: player.snd.avgPerRound,
        form: recentSND ? recentSND.trend : (player.recentForm ? player.recentForm.trend : 'neutral'),
        h2hAdj: +(h2hMultSND).toFixed(3),
        h2hData: h2hSND ? { avg: h2hSND.avgKills, matches: h2hSND.matches, recent: h2hSND.recentKills } : null,
      });
    }

    // Map 3: Overload or Control kills
    var mode3 = player.ovl.games > player.ctl.games ? player.ovl : player.ctl;
    var mode3Label = player.ovl.games > player.ctl.games ? 'Overload' : 'Control';
    var mode3Key = player.ovl.games > player.ctl.games ? 'ovl' : 'ctl';
    var mode3BPR = mode3Key === 'ovl' ? player.bpRating.ovl : player.bpRating.ctl;
    if (mode3.games >= 3) {
      var ovlStddev = (h2hOVL && h2hOVL.stddev > 0) ? h2hOVL.stddev : (recentOVL && recentOVL.stddev > 0 ? recentOVL.stddev : mode3.stddev || 0);
      var adjustedAvg = +(mode3.avg * adjOVL).toFixed(1);
      var line = Math.round(adjustedAvg * 2) / 2;
      props.push({
        market: 'map3_kills',
        label: 'Map 3 Kills (' + mode3Label + ')',
        line: line,
        avg: mode3.avg,
        adjustedAvg: adjustedAvg,
        games: mode3.games,
        edge: calculateEdgeV2(adjustedAvg, line, mode3Key, ovlStddev, mode3.games),
        bpRating: mode3BPR,
        form: recentOVL ? recentOVL.trend : (player.recentForm ? player.recentForm.trend : 'neutral'),
        h2hAdj: +(h2hMultOVL).toFixed(3),
        h2hData: h2hOVL ? { avg: h2hOVL.avgKills, matches: h2hOVL.matches, recent: h2hOVL.recentKills } : null,
      });
    }

    // Total kills Maps 1-3
    var totalAvg = (player.hp.avg * adjHP) + (player.snd.avg * adjSND) + (mode3.avg * adjOVL);
    if (player.hp.games >= 3 && player.snd.games >= 3) {
      var line = Math.round(totalAvg * 2) / 2;
      // v3: Use real stddev from match data if available
      var hpStd = (recentHP && recentHP.stddev > 0) ? recentHP.stddev : (player.hp.stddev || 4);
      var sndStd = (recentSND && recentSND.stddev > 0) ? recentSND.stddev : (player.snd.stddev || 2);
      var ovlStd = (recentOVL && recentOVL.stddev > 0) ? recentOVL.stddev : (mode3.stddev || 3);
      var combinedStd = Math.sqrt(Math.pow(hpStd, 2) + Math.pow(sndStd, 2) + Math.pow(ovlStd, 2));
      props.push({
        market: 'total_kills',
        label: 'Total Kills (Maps 1-3)',
        line: line,
        avg: +(player.hp.avg + player.snd.avg + mode3.avg).toFixed(1),
        adjustedAvg: +totalAvg.toFixed(1),
        games: Math.min(player.hp.games, player.snd.games),
        edge: calculateEdgeV2(totalAvg, line, 'total', combinedStd, Math.min(player.hp.games, player.snd.games)),
      });
    }

    // Series K/D
    if (player.totalGames >= 5) {
      props.push({
        market: 'series_kd',
        label: 'Series K/D',
        line: Math.round(player.kd * 20) / 20,
        avg: player.kd,
        games: player.totalGames,
        edge: calculateEdgeV2(player.kd, Math.round(player.kd * 20) / 20, 'kd', 0.15, player.totalGames),
        matchWinPct: player.matchWinPct,
      });
    }

    // Map 1 Damage (new prop type!)
    if (player.hp.games >= 3 && player.hp.damagePerMap > 0) {
      var dmgLine = Math.round(player.hp.damagePerMap / 100) * 100;
      props.push({
        market: 'map1_damage',
        label: 'Map 1 Damage (HP)',
        line: dmgLine,
        avg: player.hp.damagePerMap,
        adjustedAvg: +(player.hp.damagePerMap * adjHP).toFixed(0),
        games: player.hp.games,
        edge: calculateEdgeV2(player.hp.damagePerMap * adjHP, dmgLine, 'damage', player.hp.damagePerMap * 0.15, player.hp.games),
      });
    }

    return {
      player: player.tag,
      playerId: player.playerId,
      team: player.teamAbbr,
      teamName: player.teamName,
      headshot: player.headshot,
      kd: player.kd,
      bpRating: player.bpRating,
      recentForm: player.recentForm,
      matchWinPct: player.matchWinPct,
      mapWinPct: player.mapWinPct,
      firstBloods: player.firstBloods,
      clutchTotal: (player.clutch1v1 || 0) + (player.clutch1v2 || 0) + (player.clutch1v3 || 0),
      props: props,
    };
  }

  return {
    team1: {
      name: t1 ? t1.name : team1Name,
      abbr: t1 ? t1.abbr : '???',
      pace: t1Pace,
      players: team1Players.map(function(p) { return buildPlayerProps(p, t2, t2Pace); }),
    },
    team2: {
      name: t2 ? t2.name : team2Name,
      abbr: t2 ? t2.abbr : '???',
      pace: t2Pace,
      players: team2Players.map(function(p) { return buildPlayerProps(p, t1, t1Pace); }),
    },
    h2hRecord: h2h ? { matches: h2h.length, t1Wins: h2h.filter(function(m) { return m.t1Score > m.t2Score; }).length } : null,
    lastUpdated: lastScraped,
  };
}

// ============================================================
// ENHANCED EDGE CALCULATION (v2)
// Uses actual player variance + sample size for smarter confidence
// ============================================================
function calculateEdgeV2(adjustedAvg, line, mode, playerStddev, sampleSize) {
  // Use player's actual stddev if available, else fall back to mode defaults
  var defaultStddev = { hp: 5.5, snd: 2.0, ctl: 4.5, ovl: 4.0, total: 7.0, kd: 0.15, damage: 400 };
  var stddev = playerStddev > 0 ? playerStddev : (defaultStddev[mode] || 4.0);

  var diff = adjustedAvg - line;
  var absDiff = Math.abs(diff);
  var zScore = absDiff / stddev;

  // Sample size adjustment: more games = more confidence
  // With 3 games, we're less confident than with 30 games
  var sampleBonus = Math.min(10, Math.max(0, (sampleSize - 3) * 0.8));

  // Base confidence from z-score
  var baseConf = Math.round(50 + 50 * (1 - Math.exp(-zScore * 1.5)));

  // Combine base confidence + sample size bonus
  var confidence = Math.min(99, baseConf + sampleBonus);

  // Consistency rating: low stddev = more predictable
  var consistencyRating = stddev < (defaultStddev[mode] || 4) * 0.7 ? 'very_consistent'
    : stddev < (defaultStddev[mode] || 4) ? 'consistent'
    : stddev < (defaultStddev[mode] || 4) * 1.5 ? 'variable'
    : 'volatile';

  return {
    direction: diff > 0 ? 'OVER' : 'UNDER',
    confidence: confidence,
    diff: +diff.toFixed(1),
    zScore: +zScore.toFixed(2),
    stddev: +stddev.toFixed(2),
    consistency: consistencyRating,
    sampleSize: sampleSize,
  };
}

// ============================================================
// API: Get cached stats
// ============================================================
function getCachedStats() {
  var totalMatchKills = 0;
  for (var pid in playerMatchKills) totalMatchKills += playerMatchKills[pid].length;
  return {
    players: Object.values(playerStatsCache),
    lastUpdated: lastScraped,
    teamCount: CDL_TEAMS.length,
    teamPace: teamPaceCache,
    h2hAvailable: matchHistoryCache._h2h ? Object.keys(matchHistoryCache._h2h).length : 0,
    // v3 data
    matchScoreboards: recentMatchIds.length,
    playerMatchKillEntries: totalMatchKills,
    teamMapWinRates: Object.keys(teamMapWinRates).length,
    mapPickHistoryTeams: Object.keys(mapPickHistory).length,
    version: 'v3',
  };
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  scrapeCDLStats: scrapeCDLStats,
  scrapePlayerStats: scrapePlayerStats,
  scrapeMatchHistory: scrapeMatchHistory,
  scrapeMatchScoreboards: scrapeMatchScoreboards,
  generateProps: generateProps,
  getCachedStats: getCachedStats,
  getPlayerH2HKills: getPlayerH2HKills,
  getPlayerRecentKills: getPlayerRecentKills,
  getTeamMapPreferences: getTeamMapPreferences,
  CDL_TEAMS: CDL_TEAMS,
  CDL_TEAM_MAP: CDL_TEAM_MAP,
  matchTeam: matchTeam,
  computeTeamPace: computeTeamPace,
};
