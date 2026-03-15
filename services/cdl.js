const axios = require("axios");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 120 }); // 2 min cache

const PANDA_BASE = "https://api.pandascore.co";

// CDL team logos/colors for UI
const CDL_TEAMS = {
  "OpTic Texas": { color: "#92C951", abbr: "OPT" },
  "Atlanta FaZe": { color: "#E43D30", abbr: "FAZ" },
  "FaZe Vegas": { color: "#E43D30", abbr: "FAZ" },
  "LA Thieves": { color: "#FF0046", abbr: "LAT" },
  "Los Angeles Guerrillas M8": { color: "#60269E", abbr: "LAG" },
  "Toronto Ultra": { color: "#773DBD", abbr: "TOR" },
  "Toronto KOI": { color: "#773DBD", abbr: "TOR" },
  "New York Subliners": { color: "#171C38", abbr: "NYS" },
  "Cloud9 New York": { color: "#009EE2", abbr: "C9" },
  "Seattle Surge": { color: "#00B2A9", abbr: "SEA" },
  "Vancouver Surge": { color: "#00B2A9", abbr: "VAN" },
  "Boston Breach": { color: "#02FF6E", abbr: "BOS" },
  "Minnesota RØKKR": { color: "#351F67", abbr: "MIN" },
  "G2 Minnesota": { color: "#351F67", abbr: "G2M" },
  "Las Vegas Legion": { color: "#0DB881", abbr: "LVL" },
  "London Royal Ravens": { color: "#171D3A", abbr: "LDN" },
  "Carolina Royal Ravens": { color: "#171D3A", abbr: "CAR" },
  "Florida Mutineers": { color: "#2AECDF", abbr: "FLA" },
  "Miami Heretics": { color: "#FF6200", abbr: "MIA" },
  "Paris Gentle Mates": { color: "#9B59B6", abbr: "GM" },
  "Riyadh Falcons": { color: "#C0A062", abbr: "RIY" },
};

function getHeaders() {
  const key = process.env.PANDASCORE_API_KEY;
  if (!key) return null;
  return { Authorization: `Bearer ${key}` };
}

/**
 * Get upcoming & running CDL matches
 */
async function getCDLMatches() {
  const cacheKey = "cdl_matches";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const headers = getHeaders();
  if (!headers) {
    return { available: false, message: "PandaScore API key not configured. Add PANDASCORE_API_KEY to enable CDL data." };
  }

  try {
    // Fetch running + upcoming + recent past matches
    const [running, upcoming, past] = await Promise.all([
      axios.get(`${PANDA_BASE}/codmw/matches/running`, {
        headers, timeout: 10000,
        params: { "page[size]": 10 },
      }).catch(() => ({ data: [] })),
      axios.get(`${PANDA_BASE}/codmw/matches/upcoming`, {
        headers, timeout: 10000,
        params: { "page[size]": 10 },
      }).catch(() => ({ data: [] })),
      axios.get(`${PANDA_BASE}/codmw/matches/past`, {
        headers, timeout: 10000,
        params: { "page[size]": 10, sort: "-scheduled_at" },
      }).catch(() => ({ data: [] })),
    ]);

    const formatMatch = (match, status) => {
      const opponents = match.opponents || [];
      const results = match.results || [];
      const team1 = opponents[0]?.opponent;
      const team2 = opponents[1]?.opponent;

      return {
        id: match.id,
        name: match.name,
        status, // "live", "upcoming", "completed"
        scheduledAt: match.scheduled_at || match.begin_at,
        league: match.league?.name,
        serie: match.serie?.full_name,
        tournament: match.tournament?.name,
        bestOf: match.number_of_games,
        streams: match.streams_list?.slice(0, 2).map(s => ({
          language: s.language,
          url: s.raw_url,
        })),
        team1: team1 ? {
          id: team1.id,
          name: team1.name,
          logo: team1.image_url,
          acronym: team1.acronym || CDL_TEAMS[team1.name]?.abbr,
          color: CDL_TEAMS[team1.name]?.color || "#38bdf8",
          score: results[0]?.score,
        } : null,
        team2: team2 ? {
          id: team2.id,
          name: team2.name,
          logo: team2.image_url,
          acronym: team2.acronym || CDL_TEAMS[team2.name]?.abbr,
          color: CDL_TEAMS[team2.name]?.color || "#ef4444",
          score: results[1]?.score,
        } : null,
        winner: match.winner?.name || null,
        games: (match.games || []).map(g => ({
          id: g.id,
          status: g.status,
          map: g.map?.name,
          winner: g.winner?.name,
        })),
      };
    };

    const matches = [
      ...running.data.map(m => formatMatch(m, "live")),
      ...upcoming.data.map(m => formatMatch(m, "upcoming")),
      ...past.data.map(m => formatMatch(m, "completed")),
    ];

    const result = {
      available: true,
      matches,
      liveCount: running.data.length,
      upcomingCount: upcoming.data.length,
      recentCount: past.data.length,
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error("PandaScore CDL matches error:", err.message);
    return { available: false, message: "Failed to fetch CDL data" };
  }
}

/**
 * Get CDL standings / rankings
 */
async function getCDLStandings() {
  const cacheKey = "cdl_standings";
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const headers = getHeaders();
  if (!headers) {
    return { available: false, message: "PandaScore API key not configured" };
  }

  try {
    // Step 1: Find running CDL tournaments
    let tournaments = [];

    try {
      const { data } = await axios.get(`${PANDA_BASE}/codmw/tournaments/running`, { headers, timeout: 10000 });
      tournaments = data || [];
    } catch {}

    // Fallback: try upcoming
    if (!tournaments.length) {
      try {
        const { data } = await axios.get(`${PANDA_BASE}/codmw/tournaments/upcoming`, { headers, timeout: 10000, params: { "page[size]": 5, sort: "begin_at" } });
        tournaments = data || [];
      } catch {}
    }

    // Fallback: try recent past
    if (!tournaments.length) {
      try {
        const { data } = await axios.get(`${PANDA_BASE}/codmw/tournaments/past`, { headers, timeout: 10000, params: { "page[size]": 5, sort: "-end_at" } });
        tournaments = data || [];
      } catch {}
    }

    if (!tournaments.length) {
      // Final fallback: build standings from match results
      return await buildStandingsFromMatches(headers);
    }

    // Step 2: Get standings — use GENERIC /tournaments/{id}/standings (NOT /codmw/tournaments/{id}/standings)
    const tournament = tournaments.find(t =>
      t.league?.name?.includes("Call of Duty") || t.serie?.full_name?.includes("CDL")
    ) || tournaments[0];

    let standings = [];
    try {
      const { data } = await axios.get(`${PANDA_BASE}/tournaments/${tournament.id}/standings`, { headers, timeout: 10000 });
      standings = data || [];
    } catch (err) {
      console.error("CDL tournament standings 404, falling back to match results:", err.message);
      return await buildStandingsFromMatches(headers);
    }

    if (!standings.length) {
      return await buildStandingsFromMatches(headers);
    }

    const result = {
      available: true,
      standings: standings.map(s => ({
        rank: s.rank,
        team: {
          id: s.team?.id,
          name: s.team?.name,
          logo: s.team?.image_url,
          acronym: s.team?.acronym || CDL_TEAMS[s.team?.name]?.abbr,
          color: CDL_TEAMS[s.team?.name]?.color,
        },
        wins: s.wins || s.team_wins || 0,
        losses: s.losses || s.team_losses || 0,
        ties: s.ties || 0,
      })),
    };

    cache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error("PandaScore CDL standings error:", err.message);
    return await buildStandingsFromMatches(headers);
  }
}

/**
 * Fallback: Build CDL standings from recent match results
 */
async function buildStandingsFromMatches(headers) {
  try {
    const hdr = headers || getHeaders();
    if (!hdr) return { available: false, message: "PandaScore API key not configured" };

    const { data: matches } = await axios.get(`${PANDA_BASE}/codmw/matches/past`, {
      headers: hdr, timeout: 10000,
      params: { "page[size]": 50, sort: "-scheduled_at" },
    });

    const teamStats = {};
    for (const match of matches || []) {
      if (!match.opponents || match.opponents.length < 2) continue;
      for (const opp of match.opponents) {
        const team = opp.opponent;
        if (!teamStats[team.id]) {
          teamStats[team.id] = { id: team.id, name: team.name, logo: team.image_url, acronym: team.acronym, wins: 0, losses: 0 };
        }
      }
      if (match.winner?.id) {
        if (teamStats[match.winner.id]) teamStats[match.winner.id].wins++;
        for (const opp of match.opponents) {
          if (opp.opponent.id !== match.winner.id && teamStats[opp.opponent.id]) {
            teamStats[opp.opponent.id].losses++;
          }
        }
      }
    }

    const standings = Object.values(teamStats)
      .sort((a, b) => b.wins - a.wins)
      .map((t, i) => ({
        rank: i + 1,
        team: { id: t.id, name: t.name, logo: t.logo, acronym: t.acronym || CDL_TEAMS[t.name]?.abbr, color: CDL_TEAMS[t.name]?.color },
        wins: t.wins, losses: t.losses, ties: 0,
      }));

    const result = { available: true, standings };
    cache.set("cdl_standings", result);
    return result;
  } catch (err) {
    console.error("CDL fallback standings error:", err.message);
    return { available: false, message: "Failed to build CDL standings" };
  }
}

/**
 * Get CDL player stats
 */
async function getCDLPlayers(query) {
  const headers = getHeaders();
  if (!headers) {
    return { available: false, message: "PandaScore API key not configured" };
  }

  try {
    const { data } = await axios.get(`${PANDA_BASE}/codmw/players`, {
      headers, timeout: 10000,
      params: { "search[name]": query, "page[size]": 5 },
    });

    return {
      available: true,
      players: data.map(p => ({
        id: p.id,
        name: p.name,
        firstName: p.first_name,
        lastName: p.last_name,
        image: p.image_url,
        role: p.role,
        team: p.current_team ? {
          id: p.current_team.id,
          name: p.current_team.name,
          logo: p.current_team.image_url,
        } : null,
        nationality: p.nationality,
      })),
    };
  } catch (err) {
    console.error("PandaScore CDL player search error:", err.message);
    return { available: false, message: "Failed to search players" };
  }
}

module.exports = { getCDLMatches, getCDLStandings, getCDLPlayers, CDL_TEAMS };
