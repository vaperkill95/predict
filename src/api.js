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
  searchPlayer: (query) => apiFetch(`/sports/search/player?q=${encodeURIComponent(query)}`),

  // Odds
  getOdds: (sport) => apiFetch(`/odds/${sport}`),

  // AI Predictions
  predictGame: (sport, gameId) =>
    apiFetch("/predictions/game", { method: "POST", body: JSON.stringify({ sport, gameId }) }),
  predictPlayer: (playerName, sport, opponent) =>
    apiFetch("/predictions/player", { method: "POST", body: JSON.stringify({ playerName, sport, opponent }) }),

  // Player Props (NEW)
  getProps: (sport, market) => apiFetch(`/props/${sport}${market ? `?market=${market}` : ""}`),
  getDailyPicks: (sport) => apiFetch(`/props/${sport}/picks`),
  getPropMarkets: (sport) => apiFetch(`/props/${sport}/markets`),

  // CDL
  getCDLMatches: () => apiFetch("/cdl/matches"),
  getCDLStandings: () => apiFetch("/cdl/standings"),
  getCDLPlayers: (query) => apiFetch(`/cdl/players?q=${encodeURIComponent(query)}`),

  health: () => apiFetch("/health"),
};
