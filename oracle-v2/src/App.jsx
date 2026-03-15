import { useState, useEffect, useCallback } from "react";
import { api } from "./api";

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
  { key: "props", label: "Player Props", icon: "📋" },
  { key: "picks", label: "Top Picks", icon: "🔥" },
  { key: "live", label: "Scores", icon: "⚡" },
  { key: "predict", label: "Predictor", icon: "🎯" },
  { key: "standings", label: "Standings", icon: "🏆" },
];

// ─── Utility Components ───
function Spinner({ size = 18, color = "var(--accent)" }) {
  return <div style={{ width: size, height: size, borderRadius: "50%", border: `2px solid ${color}30`, borderTopColor: color, animation: "spin 0.8s linear infinite" }} />;
}

function Shimmer({ w = "100%", h = 18 }) {
  return <div className="shimmer" style={{ width: w, height: h, borderRadius: 6 }} />;
}

function Badge({ children, color = "var(--accent)", bg }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      background: bg || `${color}15`, color, border: `1px solid ${color}35`,
      borderRadius: 6, padding: "3px 8px", fontSize: 11, fontWeight: 700,
      fontFamily: "var(--font-mono)",
    }}>{children}</span>
  );
}

function Card({ children, style = {}, onClick, hoverable }) {
  const [h, setH] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{
        background: "var(--bg-card)", borderRadius: 12,
        border: `1px solid ${h && hoverable ? "var(--accent)" : "var(--border)"}`,
        padding: 16, transition: "all .2s", cursor: onClick ? "pointer" : "default",
        transform: h && hoverable ? "translateY(-1px)" : "none", ...style,
      }}>{children}</div>
  );
}

function EmptyState({ icon, title, sub }) {
  return (
    <div style={{ textAlign: "center", padding: "50px 20px" }}>
      <div style={{ fontSize: 42, marginBottom: 10 }}>{icon}</div>
      <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, marginBottom: 6 }}>{title}</h3>
      <p style={{ color: "var(--text-muted)", fontSize: 12, maxWidth: 400, margin: "0 auto" }}>{sub}</p>
    </div>
  );
}

// ─── Prop Row Component (PickFinder-style) ───
function PropRow({ prop, accent }) {
  const [expanded, setExpanded] = useState(false);
  const confColor = prop.hasEdge ? "var(--green)" : "var(--text-muted)";

  return (
    <div style={{
      background: "var(--bg-card)", borderRadius: 10,
      border: `1px solid ${prop.hasEdge ? "var(--green)20" : "var(--border)"}`,
      marginBottom: 6, overflow: "hidden",
      transition: "all .2s",
    }}>
      {/* Main row */}
      <div onClick={() => setExpanded(!expanded)} style={{
        display: "grid", gridTemplateColumns: "1fr auto auto auto auto",
        alignItems: "center", gap: 12, padding: "12px 14px", cursor: "pointer",
      }}>
        {/* Player + game */}
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{prop.player}</div>
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
            {prop.game} · <span style={{ color: accent }}>{prop.marketLabel}</span>
          </div>
        </div>

        {/* Consensus line */}
        <div style={{ textAlign: "center", minWidth: 55 }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>LINE</div>
          <div style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)" }}>
            {prop.consensusLine || "–"}
          </div>
        </div>

        {/* Best Over */}
        <div style={{ textAlign: "center", minWidth: 80 }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>OVER</div>
          {prop.bestOver ? (
            <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--green)" }}>
              {prop.bestOver.point} <span style={{ fontSize: 11, opacity: 0.7 }}>({prop.bestOver.price > 0 ? "+" : ""}{prop.bestOver.price})</span>
            </div>
          ) : <div style={{ fontSize: 12, color: "var(--text-dim)" }}>–</div>}
        </div>

        {/* Best Under */}
        <div style={{ textAlign: "center", minWidth: 80 }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>UNDER</div>
          {prop.bestUnder ? (
            <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--red)" }}>
              {prop.bestUnder.point} <span style={{ fontSize: 11, opacity: 0.7 }}>({prop.bestUnder.price > 0 ? "+" : ""}{prop.bestUnder.price})</span>
            </div>
          ) : <div style={{ fontSize: 12, color: "var(--text-dim)" }}>–</div>}
        </div>

        {/* Books + edge */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Badge color="var(--text-muted)">{prop.bookCount} books</Badge>
          {prop.hasEdge && <Badge color="var(--green)">EDGE</Badge>}
          <span style={{ fontSize: 12, color: "var(--text-dim)", transform: expanded ? "rotate(180deg)" : "none", transition: "transform .2s" }}>▾</span>
        </div>
      </div>

      {/* Expanded: all books */}
      {expanded && (
        <div style={{ padding: "0 14px 14px", borderTop: "1px solid var(--border)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 6, marginTop: 10 }}>
            {prop.books.map((b, i) => (
              <div key={i} style={{
                background: "var(--bg-deep)", borderRadius: 8, padding: "8px 10px",
                fontSize: 12, fontFamily: "var(--font-mono)",
              }}>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 4 }}>{b.name}</div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  {b.over && (
                    <span style={{ color: "var(--green)" }}>
                      O {b.over.point} <span style={{ opacity: 0.6 }}>({b.over.price > 0 ? "+" : ""}{b.over.price})</span>
                    </span>
                  )}
                  {b.under && (
                    <span style={{ color: "var(--red)" }}>
                      U {b.under.point} <span style={{ opacity: 0.6 }}>({b.under.price > 0 ? "+" : ""}{b.under.price})</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Daily Pick Card ───
function PickCard({ pick }) {
  const isOver = pick.pick === "OVER";
  const color = isOver ? "var(--green)" : "var(--red)";
  const confColor = pick.confidence >= 75 ? "var(--green)" : pick.confidence >= 55 ? "var(--amber)" : "var(--red)";

  return (
    <Card style={{ border: `1px solid ${color}25`, background: `${color}05` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-display)" }}>{pick.player}</div>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{pick.market}</div>
        </div>
        <Badge color={confColor}>{pick.confidence}%</Badge>
      </div>

      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "10px 12px",
        background: "var(--bg-deep)", borderRadius: 8, marginBottom: 10,
      }}>
        <div style={{
          padding: "4px 12px", borderRadius: 6, fontWeight: 700,
          fontSize: 13, fontFamily: "var(--font-mono)",
          background: `${color}20`, color, border: `1px solid ${color}40`,
        }}>
          {pick.pick}
        </div>
        <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--font-mono)" }}>{pick.line}</div>
        {pick.bestOdds && (
          <div style={{ fontSize: 13, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
            {pick.bestOdds}
          </div>
        )}
        {pick.bestBook && (
          <div style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: "auto" }}>@ {pick.bestBook}</div>
        )}
      </div>

      <p style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>{pick.reasoning}</p>
      {pick.edge && (
        <div style={{ fontSize: 11, color: "var(--green)", marginTop: 6, fontFamily: "var(--font-mono)" }}>
          💡 {pick.edge}
        </div>
      )}
    </Card>
  );
}

// ─── Game Card (reused from v1) ───
function GameCard({ game, accent, onPredict }) {
  const isLive = game.status?.type === "STATUS_IN_PROGRESS";
  const isFinal = game.status?.type === "STATUS_FINAL";
  const gameTime = new Date(game.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  return (
    <Card hoverable onClick={() => onPredict?.(game)}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{
            width: 7, height: 7, borderRadius: "50%",
            background: isLive ? "var(--red)" : isFinal ? "var(--text-dim)" : "var(--green)",
            animation: isLive ? "pulse 2s infinite" : "none",
          }} />
          <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
            {isLive ? game.status?.displayClock || "LIVE" : isFinal ? "FINAL" : gameTime}
          </span>
        </div>
        {game.broadcast && <span style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-dim)", background: "var(--bg-deep)", padding: "2px 6px", borderRadius: 4 }}>{game.broadcast}</span>}
      </div>
      {[game.away, game.home].map((team, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: i === 0 ? 8 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {team.logo && <img src={team.logo} alt="" style={{ width: 24, height: 24, objectFit: "contain" }} />}
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: team.winner ? "var(--text-primary)" : isFinal ? "var(--text-muted)" : "var(--text-primary)" }}>{team.name || team.abbreviation}</div>
              {team.record && <div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{team.record}</div>}
            </div>
          </div>
          <div style={{ fontSize: 20, fontFamily: "var(--font-mono)", fontWeight: 700, color: team.winner ? "var(--text-primary)" : isFinal ? "var(--text-muted)" : "var(--text-primary)" }}>
            {team.score !== null ? team.score : "–"}
          </div>
        </div>
      ))}
      {!isFinal && <button style={{ marginTop: 10, width: "100%", padding: "7px 0", background: `${accent}15`, border: `1px solid ${accent}30`, borderRadius: 8, color: accent, fontSize: 12, fontWeight: 700 }}>🎯 AI Predict</button>}
    </Card>
  );
}

// ─── Prediction Panel ───
function PredictionPanel({ prediction, loading, accent }) {
  if (loading) return <Card style={{ marginBottom: 16 }}><div style={{ display: "flex", alignItems: "center", gap: 10 }}><Spinner color={accent} /><span style={{ fontSize: 13, color: "var(--text-secondary)" }}>Running AI analysis...</span></div><div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}><Shimmer h={20} /><Shimmer h={14} w="70%" /><Shimmer h={40} /></div></Card>;
  if (!prediction?.prediction) return null;
  const p = prediction.prediction;

  return (
    <Card style={{ marginBottom: 20, border: `1px solid ${accent}30` }} className="fade-up">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <span style={{ fontSize: 18 }}>🧠</span>
        <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15 }}>AI Prediction</h3>
        {p.confidence > 0 && <Badge color={p.confidence >= 70 ? "var(--green)" : "var(--amber)"}>{p.confidence}%</Badge>}
      </div>
      {p.fallback ? (
        <div style={{ color: "var(--text-muted)", fontSize: 12 }}>{p.keyFactors?.map((f, i) => <p key={i} style={{ marginBottom: 4 }}>{f}</p>)}</div>
      ) : (
        <>
          {p.predictedScore && (
            <div style={{ display: "flex", justifyContent: "center", gap: 20, margin: "14px 0", padding: 14, borderRadius: 8, background: "var(--bg-deep)" }}>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{p.awayTeam}</div><div style={{ fontSize: 24, fontFamily: "var(--font-mono)", fontWeight: 700 }}>{p.predictedScore.away}</div></div>
              <div style={{ fontSize: 18, color: "var(--text-dim)", alignSelf: "center" }}>—</div>
              <div style={{ textAlign: "center" }}><div style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{p.homeTeam}</div><div style={{ fontSize: 24, fontFamily: "var(--font-mono)", fontWeight: 700 }}>{p.predictedScore.home}</div></div>
            </div>
          )}
          {p.keyFactors?.map((f, i) => <div key={i} style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 3 }}><span style={{ color: accent }}>▸</span> {f}</div>)}
          {p.hotTake && <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8, background: `${accent}10`, fontSize: 12, fontStyle: "italic" }}>🔥 {p.hotTake}</div>}
        </>
      )}
    </Card>
  );
}

// ─── Main App ───
export default function App() {
  const [sport, setSport] = useState("nba");
  const [tab, setTab] = useState("props");
  const [scores, setScores] = useState(null);
  const [standings, setStandings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [predicting, setPredicting] = useState(false);
  const [props, setProps] = useState(null);
  const [propsLoading, setPropsLoading] = useState(false);
  const [picks, setPicks] = useState(null);
  const [picksLoading, setPicksLoading] = useState(false);
  const [marketFilter, setMarketFilter] = useState(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [time, setTime] = useState(new Date());

  const sportMeta = SPORTS.find((s) => s.key === sport);
  const accent = sportMeta?.color || "#38bdf8";
  const isCDL = sport === "cdl";

  useEffect(() => { const i = setInterval(() => setTime(new Date()), 1000); return () => clearInterval(i); }, []);

  // Fetch data on sport/tab change
  useEffect(() => {
    setError(null);
    setPrediction(null);

    if (tab === "props") {
      if (isCDL) return; // No props for CDL
      setPropsLoading(true);
      setProps(null);
      api.getProps(sport, marketFilter)
        .then(setProps)
        .catch((err) => setError(err.message))
        .finally(() => setPropsLoading(false));
    }

    if (tab === "picks") {
      if (isCDL) return;
      setPicksLoading(true);
      setPicks(null);
      api.getDailyPicks(sport)
        .then(setPicks)
        .catch((err) => setError(err.message))
        .finally(() => setPicksLoading(false));
    }

    if (tab === "live" || tab === "predict") {
      setLoading(true);
      setScores(null);
      if (isCDL) {
        api.getCDLMatches()
          .then((data) => {
            if (!data.available) { setError(data.message); return; }
            const games = data.matches.map((m) => ({
              id: String(m.id), name: m.name, date: m.scheduledAt,
              shortName: m.team1 && m.team2 ? `${m.team1.acronym || m.team1.name} vs ${m.team2.acronym || m.team2.name}` : m.name,
              status: { type: m.status === "live" ? "STATUS_IN_PROGRESS" : m.status === "completed" ? "STATUS_FINAL" : "STATUS_SCHEDULED", displayClock: m.status === "live" ? "LIVE" : "", completed: m.status === "completed" },
              home: m.team2 ? { id: m.team2.id, name: m.team2.name, abbreviation: m.team2.acronym, logo: m.team2.logo, score: m.team2.score, winner: m.winner === m.team2.name } : { name: "TBD", score: null },
              away: m.team1 ? { id: m.team1.id, name: m.team1.name, abbreviation: m.team1.acronym, logo: m.team1.logo, score: m.team1.score, winner: m.winner === m.team1.name } : { name: "TBD", score: null },
              venue: m.tournament, broadcast: m.league,
            }));
            setScores({ sport: "cdl", games, count: games.length });
          })
          .catch((err) => setError(err.message))
          .finally(() => setLoading(false));
      } else {
        api.getScores(sport).then(setScores).catch((err) => setError(err.message)).finally(() => setLoading(false));
      }
    }

    if (tab === "standings") {
      setLoading(true);
      setStandings(null);
      if (isCDL) {
        api.getCDLStandings().then((data) => {
          if (!data.available) { setError(data.message); return; }
          setStandings({ sport: "cdl", groups: [{ name: "CDL 2026", teams: data.standings.map(s => ({ id: s.team?.id, name: s.team?.name, logo: s.team?.logo, stats: { W: String(s.wins || 0), L: String(s.losses || 0) } })) }] });
        }).catch((err) => setError(err.message)).finally(() => setLoading(false));
      } else {
        api.getStandings(sport).then(setStandings).catch((err) => setError(err.message)).finally(() => setLoading(false));
      }
    }
  }, [sport, tab, marketFilter]);

  const handlePredict = useCallback(async (game) => {
    setPredicting(true); setPrediction(null);
    try { setPrediction(await api.predictGame(sport, game.id)); } catch (err) { setError(err.message); }
    finally { setPredicting(false); }
  }, [sport]);

  // Filter props by search
  const filteredProps = props?.props?.filter(p =>
    !searchFilter || p.player.toLowerCase().includes(searchFilter.toLowerCase())
  ) || [];

  return (
    <div style={{ minHeight: "100vh", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, opacity: 0.03, backgroundImage: `radial-gradient(${accent} 1px, transparent 1px)`, backgroundSize: "28px 28px", pointerEvents: "none" }} />
      <div style={{ position: "fixed", top: -250, right: -250, width: 700, height: 700, background: `radial-gradient(circle, ${accent}12, transparent 70%)`, zIndex: 0, pointerEvents: "none" }} />

      {/* ─── HEADER ─── */}
      <header style={{ position: "relative", zIndex: 10, padding: "20px 24px 0", display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: `linear-gradient(135deg, ${accent}, ${accent}88)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#fff", boxShadow: `0 4px 20px ${accent}50` }}>⟁</div>
            <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, letterSpacing: "-0.03em", background: `linear-gradient(135deg, #f1f5f9, ${accent})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>ORACLE</h1>
            <span style={{ fontSize: 8, fontFamily: "var(--font-mono)", background: `${accent}22`, color: accent, padding: "2px 7px", borderRadius: 4, fontWeight: 700, letterSpacing: 1.5, border: `1px solid ${accent}33` }}>v2</span>
          </div>
          <p style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
            {time.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · {time.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {SPORTS.map((s) => (
            <button key={s.key} onClick={() => { setSport(s.key); setMarketFilter(null); setSearchFilter(""); }}
              style={{
                background: sport === s.key ? `${s.color}28` : "var(--bg-card)", border: `1px solid ${sport === s.key ? s.color : "var(--border)"}`,
                color: sport === s.key ? "#f1f5f9" : "var(--text-muted)", padding: "5px 10px", borderRadius: 7, fontSize: 11, fontWeight: 600,
                display: "flex", alignItems: "center", gap: 4,
              }}>
              <span style={{ fontSize: 13 }}>{s.icon}</span> {s.label}
            </button>
          ))}
        </div>
      </header>

      {/* ─── TABS ─── */}
      <nav style={{ position: "relative", zIndex: 10, padding: "14px 24px 0", display: "flex", gap: 2, borderBottom: "1px solid var(--border)", overflowX: "auto" }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              background: tab === t.key ? "var(--bg-elevated)" : "transparent", border: "none",
              borderBottom: tab === t.key ? `2px solid ${accent}` : "2px solid transparent",
              color: tab === t.key ? "var(--text-primary)" : "var(--text-muted)",
              padding: "8px 14px", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", gap: 5, borderRadius: "6px 6px 0 0", whiteSpace: "nowrap",
            }}>
            <span>{t.icon}</span> {t.label}
          </button>
        ))}
      </nav>

      {/* ─── MAIN ─── */}
      <main style={{ position: "relative", zIndex: 10, padding: "20px 24px 50px", maxWidth: 1200, margin: "0 auto" }}>
        {error && (
          <div className="fade-up" style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 16, background: "#ef444412", border: "1px solid #ef444430", color: "var(--red)", fontSize: 12, display: "flex", justifyContent: "space-between" }}>
            <span>⚠️ {error}</span>
            <button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--red)", fontSize: 14 }}>✕</button>
          </div>
        )}

        {/* ═══ PLAYER PROPS TAB ═══ */}
        {tab === "props" && (
          <div className="fade-up">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 16 }}>
              <div>
                <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, display: "flex", alignItems: "center", gap: 6 }}>
                  📋 Player Props <Badge color={accent}>{filteredProps.length}</Badge>
                </h2>
                <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  Lines compared across sportsbooks · Click any row to see all books
                </p>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  placeholder="Search player..."
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  style={{ padding: "7px 12px", borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 12, width: 160, outline: "none" }}
                />
              </div>
            </div>

            {isCDL ? (
              <EmptyState icon="🎮" title="CDL Props Coming Soon" sub="Player props aren't available for esports yet. Check the Scores tab for CDL matches." />
            ) : propsLoading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{Array.from({ length: 8 }).map((_, i) => <Shimmer key={i} h={52} />)}</div>
            ) : filteredProps.length > 0 ? (
              <div>{filteredProps.map((p, i) => <PropRow key={i} prop={p} accent={accent} />)}</div>
            ) : props?.available === false ? (
              <EmptyState icon="🔑" title="API Key Needed" sub={props.message} />
            ) : (
              <EmptyState icon="📋" title="No props available" sub={`No player props found for ${sportMeta?.label} right now. Try another sport or check back closer to game time.`} />
            )}
          </div>
        )}

        {/* ═══ TOP PICKS TAB ═══ */}
        {tab === "picks" && (
          <div className="fade-up">
            <div style={{ marginBottom: 16 }}>
              <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, display: "flex", alignItems: "center", gap: 6 }}>
                🔥 AI Top Picks
              </h2>
              <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                AI-curated best bets based on line analysis, edges, and matchup data
              </p>
            </div>

            {isCDL ? (
              <EmptyState icon="🎮" title="CDL Picks Coming Soon" sub="AI picks aren't available for esports yet." />
            ) : picksLoading ? (
              <Card><div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}><Spinner color={accent} /><span style={{ fontSize: 13, color: "var(--text-secondary)" }}>AI is analyzing today's props board...</span></div><div style={{ display: "flex", flexDirection: "column", gap: 8 }}><Shimmer h={80} /><Shimmer h={80} /><Shimmer h={80} /></div></Card>
            ) : picks?.picks?.length > 0 ? (
              <>
                {picks.summary && (
                  <Card style={{ marginBottom: 16, border: `1px solid ${accent}20` }}>
                    <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>📊 {picks.summary}</p>
                  </Card>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
                  {picks.picks.map((pick, i) => <PickCard key={i} pick={pick} />)}
                </div>
              </>
            ) : picks?.available === false ? (
              <EmptyState icon="🔑" title="Setup Required" sub={picks.message} />
            ) : (
              <EmptyState icon="🔥" title="No picks yet" sub="AI picks require player props data. Make sure your Odds API is configured and games are scheduled." />
            )}
          </div>
        )}

        {/* ═══ SCORES TAB ═══ */}
        {tab === "live" && (
          <div className="fade-up">
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--red)", animation: "pulse 2s infinite" }} />
              <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>
                {scores?.count || 0} {sportMeta?.label} games
              </span>
            </div>
            <PredictionPanel prediction={prediction} loading={predicting} accent={accent} />
            {loading ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                {Array.from({ length: 4 }).map((_, i) => <Card key={i}><Shimmer h={14} w="40%" /><div style={{ height: 6 }} /><Shimmer h={20} /><div style={{ height: 4 }} /><Shimmer h={20} /></Card>)}
              </div>
            ) : scores?.games?.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                {scores.games.map((g) => <GameCard key={g.id} game={g} accent={accent} onPredict={handlePredict} />)}
              </div>
            ) : (
              <EmptyState icon={sportMeta?.icon} title={`No ${sportMeta?.label} games`} sub="Check back later or switch sports." />
            )}
          </div>
        )}

        {/* ═══ PREDICTOR TAB ═══ */}
        {tab === "predict" && (
          <div className="fade-up">
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, marginBottom: 14 }}>🎯 Game Predictor</h2>
            <PredictionPanel prediction={prediction} loading={predicting} accent={accent} />
            {loading ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                {Array.from({ length: 4 }).map((_, i) => <Card key={i}><Shimmer h={14} w="40%" /><div style={{ height: 6 }} /><Shimmer h={20} /><div style={{ height: 4 }} /><Shimmer h={20} /></Card>)}
              </div>
            ) : scores?.games?.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 10 }}>
                {scores.games.map((g) => <GameCard key={g.id} game={g} accent={accent} onPredict={handlePredict} />)}
              </div>
            ) : (
              <EmptyState icon="🎯" title="No games to predict" sub="No upcoming games found." />
            )}
          </div>
        )}

        {/* ═══ STANDINGS TAB ═══ */}
        {tab === "standings" && (
          <div className="fade-up">
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 18, marginBottom: 14 }}>🏆 {sportMeta?.label} Standings</h2>
            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{Array.from({ length: 8 }).map((_, i) => <Shimmer key={i} h={36} />)}</div>
            ) : standings?.groups?.length > 0 ? (
              standings.groups.map((group) => (
                <div key={group.name} style={{ marginBottom: 20 }}>
                  <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, color: "var(--text-secondary)", marginBottom: 8, paddingBottom: 6, borderBottom: "1px solid var(--border)" }}>{group.name}</h3>
                  {group.teams?.map((team, i) => (
                    <div key={team.id || i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, background: i % 2 === 0 ? "var(--bg-card)" : "transparent" }}>
                      <span style={{ width: 22, fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-dim)", textAlign: "center" }}>{i + 1}</span>
                      {team.logo && <img src={team.logo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />}
                      <span style={{ flex: 1, fontSize: 12, fontWeight: 600 }}>{team.name}</span>
                      <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                        {team.stats?.W && team.stats?.L ? `${team.stats.W}-${team.stats.L}` : Object.values(team.stats || {}).slice(0, 3).join(" · ")}
                      </span>
                    </div>
                  ))}
                </div>
              ))
            ) : (
              <EmptyState icon="🏆" title="No standings" sub="Standings not available for this sport." />
            )}
          </div>
        )}

        {/* Disclaimer */}
        <div style={{ marginTop: 32, padding: 12, borderRadius: 8, background: "var(--bg-card)", border: "1px solid var(--border)", fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", textAlign: "center" }}>
          ⚠️ For entertainment & research only. Not financial or gambling advice. Always gamble responsibly.
        </div>
      </main>
    </div>
  );
}
