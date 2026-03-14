const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "API request failed");
  }
  return res.json();
}

export const api = {
  // Sports data
  getScores: (sport) => apiFetch(`/sports/scores/${sport}`),
  getStandings: (sport) => apiFetch(`/sports/standings/${sport}`),
  getGame: (sport, gameId) => apiFetch(`/sports/game/${sport}/${gameId}`),
  getTeam: (sport, teamId) => apiFetch(`/sports/team/${sport}/${teamId}`),
  searchPlayer: (query) => apiFetch(`/sports/search/player?q=${encodeURIComponent(query)}`),
  getLeagues: () => apiFetch("/sports/leagues"),

  // Odds
  getOdds: (sport) => apiFetch(`/odds/${sport}`),

  // AI Predictions
  predictGame: (sport, gameId) =>
    apiFetch("/predictions/game", {
      method: "POST",
      body: JSON.stringify({ sport, gameId }),
    }),
  predictPlayer: (playerName, sport, opponent) =>
    apiFetch("/predictions/player", {
      method: "POST",
      body: JSON.stringify({ playerName, sport, opponent }),
    }),

  // CDL Esports
  getCDLMatches: () => apiFetch("/cdl/matches"),
  getCDLStandings: () => apiFetch("/cdl/standings"),
  getCDLPlayers: (query) => apiFetch(`/cdl/players?q=${encodeURIComponent(query)}`),

  // Health
  health: () => apiFetch("/health"),
};
