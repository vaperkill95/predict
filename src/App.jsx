import { useState, useEffect, useCallback } from "react";
import { api } from "./api";

// ─── Constants ───
const SPORTS = [
  { key: "nba", label: "NBA", icon: "🏀", color: "#E35205" },
  { key: "nfl", label: "NFL", icon: "🏈", color: "#013369" },
  { key: "mlb", label: "MLB", icon: "⚾", color: "#CE1141" },
  { key: "nhl", label: "NHL", icon: "🏒", color: "#009BDF" },
  { key: "epl", label: "EPL", icon: "⚽", color: "#3D195B" },
  { key: "la_liga", label: "La Liga", icon: "⚽", color: "#EE8707" },
  { key: "ncaamb", label: "NCAAM", icon: "🏀", color: "#0A2240" },
  { key: "ncaafb", label: "NCAAF", icon: "🏈", color: "#1B5E20" },
  { key: "cdl", label: "CDL", icon: "🎮", color: "#92C951" },
];

const TABS = [
  { key: "live", label: "Live & Upcoming", icon: "⚡" },
  { key: "predict", label: "Game Predictor", icon: "🎯" },
  { key: "player", label: "Player Projections", icon: "📊" },
  { key: "standings", label: "Standings", icon: "🏆" },
];

// ─── Utility Components ───
function Spinner({ size = 20, color = "var(--accent)" }) {
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        border: `2px solid ${color}30`, borderTopColor: color,
        animation: "spin 0.8s linear infinite",
      }}
    />
  );
}

function Shimmer({ w = "100%", h = 18 }) {
  return <div className="shimmer" style={{ width: w, height: h, borderRadius: 6 }} />;
}

function Badge({ children, color = "var(--accent)" }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      background: `${color}18`, color, border: `1px solid ${color}40`,
      borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700,
      fontFamily: "var(--font-mono)",
    }}>
      {children}
    </span>
  );
}

function StatusDot({ status }) {
  const color = status === "STATUS_IN_PROGRESS" ? "var(--red)" :
    status === "STATUS_FINAL" ? "var(--text-muted)" : "var(--green)";
  return (
    <span style={{
      width: 8, height: 8, borderRadius: "50%", background: color,
      display: "inline-block",
      animation: status === "STATUS_IN_PROGRESS" ? "pulse 2s infinite" : "none",
      boxShadow: status === "STATUS_IN_PROGRESS" ? `0 0 8px ${color}` : "none",
    }} />
  );
}

function Card({ children, style = {}, onClick, hoverable = false }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: "var(--bg-card)", borderRadius: 14,
        border: `1px solid ${hovered && hoverable ? "var(--accent)" : "var(--border)"}`,
        padding: 20, transition: "all 0.25s ease",
        cursor: onClick ? "pointer" : "default",
        transform: hovered && hoverable ? "translateY(-2px)" : "none",
        boxShadow: hovered && hoverable ? "0 8px 30px rgba(0,0,0,0.3)" : "none",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function WinBar({ away, home, awayProb, homeProb }) {
  return (
    <div style={{ width: "100%", marginTop: 10 }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        fontSize: 11, fontFamily: "var(--font-mono)", marginBottom: 4,
        color: "var(--text-muted)",
      }}>
        <span>{away} <b style={{ color: "var(--text-primary)" }}>{awayProb?.toFixed(1)}%</b></span>
        <span><b style={{ color: "var(--text-primary)" }}>{homeProb?.toFixed(1)}%</b> {home}</span>
      </div>
      <div style={{
        display: "flex", height: 6, borderRadius: 3, overflow: "hidden",
        background: "var(--bg-deep)",
      }}>
        <div style={{
          width: `${awayProb || 50}%`,
          background: "linear-gradient(90deg, #f43f5e, #fb7185)",
          transition: "width 0.8s cubic-bezier(.4,0,.2,1)",
        }} />
        <div style={{
          width: `${homeProb || 50}%`,
          background: "linear-gradient(90deg, #38bdf8, #2dd4bf)",
          transition: "width 0.8s cubic-bezier(.4,0,.2,1)",
        }} />
      </div>
    </div>
  );
}

function EmptyState({ icon, title, subtitle }) {
  return (
    <div style={{ textAlign: "center", padding: "60px 20px" }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>{icon}</div>
      <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, marginBottom: 8 }}>{title}</h3>
      <p style={{ color: "var(--text-muted)", fontSize: 13, maxWidth: 400, margin: "0 auto", lineHeight: 1.6 }}>{subtitle}</p>
    </div>
  );
}

// ─── Game Card ───
function GameCard({ game, accent, onPredict }) {
  const isLive = game.status?.type === "STATUS_IN_PROGRESS";
  const isFinal = game.status?.type === "STATUS_FINAL";
  const isScheduled = game.status?.type === "STATUS_SCHEDULED";

  const gameTime = new Date(game.date).toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true,
  });

  return (
    <Card hoverable onClick={() => onPredict?.(game)}>
      {/* Status row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <StatusDot status={game.status?.type} />
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
            {isLive ? game.status?.displayClock || "LIVE" :
              isFinal ? "FINAL" : gameTime}
          </span>
        </div>
        {game.broadcast && (
          <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-dim)", background: "var(--bg-deep)", padding: "2px 6px", borderRadius: 4 }}>
            {game.broadcast}
          </span>
        )}
      </div>

      {/* Teams */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {[game.away, game.home].map((team, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {team.logo && <img src={team.logo} alt="" style={{ width: 28, height: 28, objectFit: "contain" }} />}
              <div>
                <div style={{
                  fontSize: 14, fontFamily: "var(--font-display)", fontWeight: 700,
                  color: team.winner ? "var(--text-primary)" : (isFinal ? "var(--text-muted)" : "var(--text-primary)"),
                }}>
                  {team.name || team.abbreviation}
                </div>
                {team.record && (
                  <div style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                    {team.record}
                  </div>
                )}
              </div>
            </div>
            <div style={{
              fontSize: 22, fontFamily: "var(--font-mono)", fontWeight: 700,
              color: team.winner ? "var(--text-primary)" : (isFinal ? "var(--text-muted)" : "var(--text-primary)"),
            }}>
              {team.score !== null ? team.score : "–"}
            </div>
          </div>
        ))}
      </div>

      {/* Odds */}
      {game.odds && (
        <div style={{
          marginTop: 12, padding: "8px 10px", borderRadius: 8,
          background: "var(--bg-deep)", fontSize: 11,
          fontFamily: "var(--font-mono)", color: "var(--text-muted)",
          display: "flex", justifyContent: "space-between",
        }}>
          <span>{game.odds.spread}</span>
          <span>O/U {game.odds.overUnder}</span>
        </div>
      )}

      {/* Predict CTA */}
      {!isFinal && (
        <button style={{
          marginTop: 12, width: "100%", padding: "8px 0",
          background: `${accent}15`, border: `1px solid ${accent}30`,
          borderRadius: 8, color: accent, fontSize: 12,
          fontWeight: 700, fontFamily: "var(--font-display)",
        }}>
          🎯 AI Predict
        </button>
      )}
    </Card>
  );
}

// ─── Prediction Panel ───
function PredictionPanel({ prediction, loading, accent }) {
  if (loading) {
    return (
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <Spinner size={24} color={accent} />
          <span style={{ fontSize: 14, color: "var(--text-secondary)", fontFamily: "var(--font-display)" }}>
            Running AI analysis...
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Shimmer h={20} /><Shimmer h={14} w="80%" /><Shimmer h={14} w="65%" />
          <Shimmer h={40} /><Shimmer h={14} w="90%" />
        </div>
      </Card>
    );
  }

  if (!prediction) return null;
  const pred = prediction.prediction;
  if (!pred) return null;

  return (
    <Card style={{ marginBottom: 24, border: `1px solid ${accent}30`, background: `${accent}05` }} className="fade-up">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 20 }}>🧠</span>
        <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>AI Prediction</h3>
        {pred.confidence > 0 && (
          <Badge color={pred.confidence >= 70 ? "var(--green)" : pred.confidence >= 50 ? "var(--amber)" : "var(--red)"}>
            {pred.confidence}% confidence
          </Badge>
        )}
      </div>

      {pred.fallback ? (
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
          {pred.keyFactors?.map((f, i) => <p key={i} style={{ marginBottom: 4 }}>{f}</p>)}
        </div>
      ) : (
        <>
          {/* Win probability */}
          {pred.homeWinProb && (
            <WinBar
              away={pred.awayTeam} home={pred.homeTeam}
              awayProb={pred.awayWinProb} homeProb={pred.homeWinProb}
            />
          )}

          {/* Predicted score */}
          {pred.predictedScore && (
            <div style={{
              display: "flex", justifyContent: "center", gap: 24,
              margin: "18px 0", padding: 16, borderRadius: 10,
              background: "var(--bg-deep)",
            }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>{pred.awayTeam}</div>
                <div style={{ fontSize: 28, fontFamily: "var(--font-mono)", fontWeight: 700 }}>{pred.predictedScore.away}</div>
              </div>
              <div style={{ fontSize: 20, color: "var(--text-dim)", alignSelf: "center" }}>—</div>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 4 }}>{pred.homeTeam}</div>
                <div style={{ fontSize: 28, fontFamily: "var(--font-mono)", fontWeight: 700 }}>{pred.predictedScore.home}</div>
              </div>
            </div>
          )}

          {/* Key factors */}
          {pred.keyFactors?.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h4 style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>
                Key Factors
              </h4>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {pred.keyFactors.map((f, i) => (
                  <div key={i} style={{ fontSize: 13, color: "var(--text-secondary)", display: "flex", gap: 8 }}>
                    <span style={{ color: accent }}>▸</span> {f}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Hot take */}
          {pred.hotTake && (
            <div style={{
              marginTop: 16, padding: "12px 14px", borderRadius: 10,
              background: `${accent}10`, border: `1px solid ${accent}20`,
              fontSize: 13, color: "var(--text-primary)", fontStyle: "italic",
            }}>
              🔥 {pred.hotTake}
            </div>
          )}

          {/* Players to watch */}
          {pred.playersToWatch && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
              {Object.entries(pred.playersToWatch).map(([side, p]) => (
                <div key={side} style={{
                  padding: 10, borderRadius: 8, background: "var(--bg-deep)",
                  fontSize: 12,
                }}>
                  <div style={{ fontWeight: 700, color: "var(--text-primary)", marginBottom: 2 }}>{p.name}</div>
                  <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{p.reason}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ─── Player Projection Panel ───
function PlayerPanel({ result, loading }) {
  if (loading) {
    return (
      <Card style={{ marginTop: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <Spinner />
          <span style={{ fontSize: 14, color: "var(--text-secondary)" }}>Generating player projection...</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Shimmer h={20} /><Shimmer h={14} w="70%" /><Shimmer h={60} /><Shimmer h={14} w="85%" />
        </div>
      </Card>
    );
  }

  if (!result) return null;
  const pred = result.prediction;

  if (pred?.available === false) {
    return (
      <Card style={{ marginTop: 20 }}>
        <p style={{ color: "var(--text-muted)", fontSize: 13 }}>{pred.message}</p>
      </Card>
    );
  }

  return (
    <Card style={{ marginTop: 20 }} className="fade-up">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        <span style={{ fontSize: 20 }}>📈</span>
        <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16 }}>
          {pred?.player || result.playerName} — Projection
        </h3>
        {pred?.overallConfidence && (
          <Badge color={pred.overallConfidence >= 70 ? "var(--green)" : "var(--amber)"}>
            {pred.overallConfidence}% confidence
          </Badge>
        )}
      </div>

      {/* Stat projections */}
      {pred?.projection && (
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 10, marginBottom: 16,
        }}>
          {Object.entries(pred.projection).map(([stat, data]) => (
            <div key={stat} style={{
              background: "var(--bg-deep)", borderRadius: 10, padding: 14,
              textAlign: "center",
            }}>
              <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginBottom: 6, textTransform: "uppercase" }}>
                {stat.replace(/_/g, " ")}
              </div>
              <div style={{ fontSize: 24, fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                {typeof data === "object" ? data.value : data}
              </div>
              {data.range && (
                <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginTop: 4 }}>
                  Range: {data.range[0]}–{data.range[1]}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {pred?.narrative && (
        <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, marginBottom: 12 }}>
          {pred.narrative}
        </p>
      )}

      {pred?.bestProp && (
        <div style={{
          padding: "12px 14px", borderRadius: 10,
          background: "var(--green)10", border: "1px solid var(--green)30",
          fontSize: 13,
        }}>
          💰 <b>Best Prop:</b> {pred.bestProp.stat} {pred.bestProp.pick} {pred.bestProp.line}
          {pred.bestProp.confidence && <span style={{ color: "var(--text-muted)" }}> ({pred.bestProp.confidence}% conf)</span>}
        </div>
      )}
    </Card>
  );
}

// ─── Standings Table ───
function StandingsView({ standings, loading, accent }) {
  if (loading) {
    return (
      <div className="fade-up" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {Array.from({ length: 8 }).map((_, i) => <Shimmer key={i} h={40} />)}
      </div>
    );
  }

  if (!standings?.groups?.length) {
    return <EmptyState icon="🏆" title="No standings available" subtitle="Standings data is not available for this sport right now." />;
  }

  return (
    <div className="fade-up" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {standings.groups.map((group) => (
        <div key={group.name}>
          <h3 style={{
            fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14,
            color: "var(--text-secondary)", marginBottom: 10, paddingBottom: 8,
            borderBottom: "1px solid var(--border)",
          }}>
            {group.name}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {group.teams?.map((team, i) => (
              <div key={team.id || i} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 12px", borderRadius: 8,
                background: i % 2 === 0 ? "var(--bg-card)" : "transparent",
              }}>
                <span style={{ width: 24, fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text-dim)", textAlign: "center" }}>
                  {i + 1}
                </span>
                {team.logo && <img src={team.logo} alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />}
                <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{team.name}</span>
                <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {team.stats?.W && team.stats?.L ? `${team.stats.W}-${team.stats.L}` :
                    team.stats?.GP ? `${team.stats.GP} GP` :
                      Object.values(team.stats || {}).slice(0, 3).join(" · ")}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Main App ───
export default function App() {
  const [sport, setSport] = useState("nba");
  const [tab, setTab] = useState("live");
  const [scores, setScores] = useState(null);
  const [standings, setStandings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [predicting, setPredicting] = useState(false);
  const [playerQuery, setPlayerQuery] = useState("");
  const [playerResult, setPlayerResult] = useState(null);
  const [playerLoading, setPlayerLoading] = useState(false);
  const [time, setTime] = useState(new Date());

  const sportMeta = SPORTS.find((s) => s.key === sport);
  const accent = sportMeta?.color || "#38bdf8";

  // Clock
  useEffect(() => {
    const i = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(i);
  }, []);

  // Fetch data on sport/tab change
  useEffect(() => {
    setError(null);
    setPrediction(null);
    setPlayerResult(null);

    if (tab === "live" || tab === "predict") {
      setLoading(true);
      setScores(null);
      if (sport === "cdl") {
        api.getCDLMatches()
          .then((data) => {
            if (!data.available) {
              setError(data.message);
              return;
            }
            // Transform CDL matches into the same shape as ESPN scores
            const games = data.matches.map((m) => ({
              id: String(m.id),
              name: m.name,
              shortName: m.team1 && m.team2 ? `${m.team1.acronym || m.team1.name} vs ${m.team2.acronym || m.team2.name}` : m.name,
              date: m.scheduledAt,
              status: {
                type: m.status === "live" ? "STATUS_IN_PROGRESS" : m.status === "completed" ? "STATUS_FINAL" : "STATUS_SCHEDULED",
                detail: m.status,
                displayClock: m.status === "live" ? "LIVE" : "",
                completed: m.status === "completed",
              },
              home: m.team2 ? {
                id: m.team2.id, name: m.team2.name, abbreviation: m.team2.acronym,
                logo: m.team2.logo, score: m.team2.score, record: null, winner: m.winner === m.team2.name,
              } : { name: "TBD", score: null },
              away: m.team1 ? {
                id: m.team1.id, name: m.team1.name, abbreviation: m.team1.acronym,
                logo: m.team1.logo, score: m.team1.score, record: null, winner: m.winner === m.team1.name,
              } : { name: "TBD", score: null },
              odds: null,
              venue: m.tournament,
              broadcast: m.streams?.[0]?.url ? "Watch Live" : m.league,
            }));
            setScores({ sport: "cdl", games, count: games.length });
          })
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false));
      } else {
        api.getScores(sport)
          .then(setScores)
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false));
      }
    }

    if (tab === "standings") {
      setLoading(true);
      setStandings(null);
      if (sport === "cdl") {
        api.getCDLStandings()
          .then((data) => {
            if (!data.available) {
              setError(data.message);
              return;
            }
            setStandings({
              sport: "cdl",
              groups: [{
                name: "CDL 2026 Standings",
                teams: data.standings.map((s) => ({
                  id: s.team?.id,
                  name: s.team?.name,
                  abbreviation: s.team?.acronym,
                  logo: s.team?.logo,
                  stats: { W: String(s.wins || 0), L: String(s.losses || 0) },
                })),
              }],
            });
          })
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false));
      } else {
        api.getStandings(sport)
          .then(setStandings)
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false));
      }
    }
  }, [sport, tab]);

  // Predict game
  const handlePredict = useCallback(async (game) => {
    setPredicting(true);
    setPrediction(null);
    try {
      const result = await api.predictGame(sport, game.id);
      setPrediction(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setPredicting(false);
    }
  }, [sport]);

  // Player projection
  const handlePlayerPredict = useCallback(async () => {
    if (!playerQuery.trim()) return;
    setPlayerLoading(true);
    setPlayerResult(null);
    try {
      const result = await api.predictPlayer(playerQuery, sport);
      setPlayerResult(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlayerLoading(false);
    }
  }, [playerQuery, sport]);

  return (
    <div style={{ minHeight: "100vh", position: "relative", overflow: "hidden" }}>
      {/* Dot grid bg */}
      <div style={{
        position: "fixed", inset: 0, zIndex: 0, opacity: 0.03,
        backgroundImage: `radial-gradient(${accent} 1px, transparent 1px)`,
        backgroundSize: "28px 28px", pointerEvents: "none",
      }} />
      {/* Glow */}
      <div style={{
        position: "fixed", top: -250, right: -250, width: 700, height: 700,
        background: `radial-gradient(circle, ${accent}12, transparent 70%)`,
        zIndex: 0, pointerEvents: "none",
      }} />

      {/* ─── HEADER ─── */}
      <header style={{
        position: "relative", zIndex: 10,
        padding: "24px 28px 0",
        display: "flex", alignItems: "flex-end", justifyContent: "space-between",
        flexWrap: "wrap", gap: 16,
      }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div style={{
              width: 38, height: 38, borderRadius: 10,
              background: `linear-gradient(135deg, ${accent}, ${accent}88)`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 20, color: "#fff",
              boxShadow: `0 4px 24px ${accent}50`,
            }}>⟁</div>
            <h1 style={{
              fontFamily: "var(--font-display)", fontWeight: 900,
              fontSize: 28, letterSpacing: "-0.03em",
              background: `linear-gradient(135deg, #f1f5f9, ${accent})`,
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            }}>ORACLE</h1>
            <span style={{
              fontSize: 9, fontFamily: "var(--font-mono)",
              background: `${accent}22`, color: accent, padding: "3px 8px",
              borderRadius: 4, fontWeight: 700, letterSpacing: 1.5,
              border: `1px solid ${accent}33`,
            }}>AI SPORTS ENGINE</span>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {time.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", year: "numeric" })}
            {" · "}
            {time.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </p>
        </div>

        {/* Sport pills */}
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {SPORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSport(s.key)}
              style={{
                background: sport === s.key ? `${s.color}28` : "var(--bg-card)",
                border: `1px solid ${sport === s.key ? s.color : "var(--border)"}`,
                color: sport === s.key ? "#f1f5f9" : "var(--text-muted)",
                padding: "6px 12px", borderRadius: 8,
                fontSize: 12, fontWeight: 600,
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              <span style={{ fontSize: 14 }}>{s.icon}</span> {s.label}
            </button>
          ))}
        </div>
      </header>

      {/* ─── TABS ─── */}
      <nav style={{
        position: "relative", zIndex: 10,
        padding: "18px 28px 0",
        display: "flex", gap: 3,
        borderBottom: "1px solid var(--border)",
      }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: tab === t.key ? "var(--bg-elevated)" : "transparent",
              border: "none",
              borderBottom: tab === t.key ? `2px solid ${accent}` : "2px solid transparent",
              color: tab === t.key ? "var(--text-primary)" : "var(--text-muted)",
              padding: "10px 16px", fontSize: 13, fontWeight: 600,
              display: "flex", alignItems: "center", gap: 6,
              borderRadius: "8px 8px 0 0",
            }}
          >
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>

      {/* ─── MAIN ─── */}
      <main style={{ position: "relative", zIndex: 10, padding: "24px 28px 60px", maxWidth: 1200, margin: "0 auto" }}>

        {/* Error */}
        {error && (
          <div className="fade-up" style={{
            padding: "12px 16px", borderRadius: 10, marginBottom: 20,
            background: "var(--red)12", border: "1px solid var(--red)30",
            color: "var(--red)", fontSize: 13,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span>⚠️ {error}</span>
            <button onClick={() => setError(null)} style={{
              background: "none", border: "none", color: "var(--red)", fontSize: 16,
            }}>✕</button>
          </div>
        )}

        {/* ═══ LIVE TAB ═══ */}
        {tab === "live" && (
          <div className="fade-up">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--red)", animation: "pulse 2s infinite" }} />
              <span style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                {scores?.count || 0} {sportMeta?.label} games today
              </span>
            </div>

            {loading ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                {Array.from({ length: 4 }).map((_, i) => (
                  <Card key={i}><Shimmer h={16} w="40%" /><div style={{ height: 8 }} /><Shimmer h={24} /><div style={{ height: 6 }} /><Shimmer h={24} /><div style={{ height: 10 }} /><Shimmer h={32} /></Card>
                ))}
              </div>
            ) : scores?.games?.length > 0 ? (
              <>
                {/* Prediction panel (if user clicked a game) */}
                <PredictionPanel prediction={prediction} loading={predicting} accent={accent} />

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                  {scores.games.map((game) => (
                    <GameCard key={game.id} game={game} accent={accent} onPredict={handlePredict} />
                  ))}
                </div>
              </>
            ) : (
              <EmptyState icon={sportMeta?.icon} title={`No ${sportMeta?.label} games today`} subtitle="Check back later or switch to a different sport." />
            )}
          </div>
        )}

        {/* ═══ PREDICT TAB ═══ */}
        {tab === "predict" && (
          <div className="fade-up">
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, marginBottom: 6 }}>
              🎯 AI Game Predictor
            </h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
              Select a game below to run full AI analysis with spread, over/under, and player props.
            </p>

            <PredictionPanel prediction={prediction} loading={predicting} accent={accent} />

            {loading ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                {Array.from({ length: 4 }).map((_, i) => (
                  <Card key={i}><Shimmer h={16} w="40%" /><div style={{ height: 8 }} /><Shimmer h={24} /><div style={{ height: 6 }} /><Shimmer h={24} /></Card>
                ))}
              </div>
            ) : scores?.games?.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
                {scores.games.map((game) => (
                  <GameCard key={game.id} game={game} accent={accent} onPredict={handlePredict} />
                ))}
              </div>
            ) : (
              <EmptyState icon="🎯" title="No games to predict" subtitle="No upcoming games found for this sport right now." />
            )}
          </div>
        )}

        {/* ═══ PLAYER TAB ═══ */}
        {tab === "player" && (
          <div className="fade-up">
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 20, marginBottom: 6 }}>
              📊 Player Stat Projections
            </h2>
            <p style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
              Enter any {sportMeta?.label} player name to get an AI-powered stat line projection.
            </p>

            <div style={{ display: "flex", gap: 10, marginBottom: 20, maxWidth: 500 }}>
              <input
                type="text"
                placeholder={`e.g. "LeBron James", "Patrick Mahomes"...`}
                value={playerQuery}
                onChange={(e) => setPlayerQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handlePlayerPredict()}
                style={{
                  flex: 1, padding: "12px 16px", borderRadius: 10,
                  background: "var(--bg-card)", border: "1px solid var(--border)",
                  color: "var(--text-primary)", fontSize: 14,
                  outline: "none",
                }}
              />
              <button
                onClick={handlePlayerPredict}
                disabled={playerLoading || !playerQuery.trim()}
                style={{
                  padding: "12px 24px", borderRadius: 10,
                  background: accent, border: "none",
                  color: "#fff", fontSize: 14, fontWeight: 700,
                  opacity: playerLoading || !playerQuery.trim() ? 0.5 : 1,
                  display: "flex", alignItems: "center", gap: 8,
                }}
              >
                {playerLoading ? <Spinner size={16} color="#fff" /> : "📈"} Project
              </button>
            </div>

            <PlayerPanel result={playerResult} loading={playerLoading} />

            {!playerResult && !playerLoading && (
              <Card>
                <EmptyState
                  icon="🔍"
                  title="Search for a player"
                  subtitle="Type a player name above and hit Enter or click Project to generate an AI stat line prediction."
                />
              </Card>
            )}
          </div>
        )}

        {/* ═══ STANDINGS TAB ═══ */}
        {tab === "standings" && (
          <div className="fade-up">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
              <span style={{ fontSize: 20 }}>🏆</span>
              <span style={{ fontSize: 14, fontFamily: "var(--font-display)", fontWeight: 700 }}>
                {sportMeta?.label} Standings
              </span>
            </div>
            <StandingsView standings={standings} loading={loading} accent={accent} />
          </div>
        )}

        {/* ─── Disclaimer ─── */}
        <div style={{
          marginTop: 40, padding: 14, borderRadius: 10,
          background: "var(--bg-card)", border: "1px solid var(--border)",
          fontSize: 11, color: "var(--text-dim)", fontFamily: "var(--font-mono)",
          textAlign: "center",
        }}>
          ⚠️ Predictions are AI-generated analysis for entertainment purposes only. Not financial or gambling advice. Always gamble responsibly.
        </div>
      </main>
    </div>
  );
}
