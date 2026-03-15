const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || "API request failed");
  }
  return res.json();
}

export const api = {
  getScores: (sport) => apiFetch(`/sports/scores/${sport}`),
  getStandings: (sport) => apiFetch(`/sports/standings/${sport}`),
  getGame: (sport, gameId) => apiFetch(`/sports/game/${sport}/${gameId}`),
  getOdds: (sport) => apiFetch(`/odds/${sport}`),
  predictGame: (sport, gameId) => apiFetch("/predictions/game", { method: "POST", body: JSON.stringify({ sport, gameId }) }),
  predictPlayer: (playerName, sport, opponent) => apiFetch("/predictions/player", { method: "POST", body: JSON.stringify({ playerName, sport, opponent }) }),
  getProps: (sport, market) => apiFetch(`/props/${sport}${market ? `?market=${market}` : ""}`),
  getDailyPicks: (sport) => apiFetch(`/props/${sport}/picks`),
  getPickHistory: () => apiFetch("/props/history/all"),
  getCDLMatches: () => apiFetch("/cdl/matches"),
  getCDLStandings: () => apiFetch("/cdl/standings"),

  // Live
  getLiveGames: (sport) => apiFetch(`/live/${sport}/games`),
  getLiveBox: (sport, eventId) => apiFetch(`/live/${sport}/box/${eventId}`),
  getLivePlayer: (sport, name, market) => apiFetch(`/live/${sport}/player?name=${encodeURIComponent(name)}&market=${market || ""}`),
  gradePicks: (sport, picks) => apiFetch(`/live/${sport}/grade`, { method: "POST", body: JSON.stringify({ picks }) }),

  health: () => apiFetch("/health"),
};
