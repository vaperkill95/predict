import { useState, useEffect, useCallback } from "react";
import { api } from "./api";
import CDLPropsTab from "./CDLPropsTab";
import { LineMovementChip, BiggestMovesPanel } from "./LineMovement";

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
  { key: "history", label: "History", icon: "📈" },
  { key: "live", label: "Scores", icon: "⚡" },
  { key: "predict", label: "Predictor", icon: "🎯" },
  { key: "standings", label: "Standings", icon: "🏆" },
];

const MARKET_LABELS = {
  player_points: "Points", player_rebounds: "Rebounds", player_assists: "Assists",
  player_threes: "3PT", player_points_rebounds_assists: "PRA",
  player_pass_yds: "Pass Yds", player_pass_tds: "Pass TD", player_rush_yds: "Rush Yds",
  player_receptions: "Rec", player_reception_yds: "Rec Yds", player_anytime_td: "Any TD",
  batter_hits: "Hits", batter_total_bases: "Bases", pitcher_strikeouts: "K's",
  batter_home_runs: "HR", batter_rbis: "RBI",
  player_goals: "Goals", player_shots_on_goal: "SOG",
};

const MARKET_OPTIONS = {
  nba: ["player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists"],
  nfl: ["player_pass_yds", "player_pass_tds", "player_rush_yds", "player_receptions", "player_reception_yds", "player_anytime_td"],
  mlb: ["batter_hits", "batter_total_bases", "pitcher_strikeouts", "batter_home_runs", "batter_rbis"],
  nhl: ["player_points", "player_goals", "player_assists", "player_shots_on_goal"],
  ncaamb: ["player_points", "player_rebounds", "player_assists"],
  ncaafb: ["player_pass_yds", "player_rush_yds", "player_reception_yds"],
};

// ─── Components ───
function Spinner({ size = 16, color = "var(--accent)" }) {
  return <div style={{ width: size, height: size, borderRadius: "50%", border: `2px solid ${color}30`, borderTopColor: color, animation: "spin 0.8s linear infinite", flexShrink: 0 }} />;
}
function Shimmer({ w = "100%", h = 16 }) {
  return <div className="shimmer" style={{ width: w, height: h, borderRadius: 5 }} />;
}
function Badge({ children, color = "var(--accent)" }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 3, background: `${color}14`, color, border: `1px solid ${color}30`, borderRadius: 5, padding: "2px 7px", fontSize: 10, fontWeight: 700, fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>{children}</span>;
}
function Card({ children, style = {}, onClick, glow }) {
  const [h, setH] = useState(false);
  return (
    <div onClick={onClick} onMouseEnter={() => setH(true)} onMouseLeave={() => setH(false)}
      style={{ background: "var(--bg-card)", borderRadius: 10, border: `1px solid ${h && onClick ? "var(--accent)40" : glow || "var(--border)"}`, padding: 14, transition: "all .15s", cursor: onClick ? "pointer" : "default", ...style }}>
      {children}
    </div>
  );
}
function Empty({ icon, title, sub }) {
  return <div style={{ textAlign: "center", padding: "44px 16px" }}><div style={{ fontSize: 36, marginBottom: 8, opacity: 0.7 }}>{icon}</div><h3 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{title}</h3><p style={{ color: "var(--text-dim)", fontSize: 11, maxWidth: 360, margin: "0 auto", lineHeight: 1.5 }}>{sub}</p></div>;
}

// ─── Prop Row with Demon/Goblin + Pick Builder ───
function PropRow({ prop, accent, onAddPick, isInBuilder, sport: propSport }) {
  const [open, setOpen] = useState(false);
  const isDemon = prop.lineType === "demon";
  const isGoblin = prop.lineType === "goblin";
  const borderColor = isDemon ? "#f59e0b30" : isGoblin ? "#8b5cf630" : prop.hasEdge ? "var(--green)18" : "var(--border)";

  return (
    <div style={{ background: "var(--bg-card)", borderRadius: 8, border: `1px solid ${borderColor}`, marginBottom: 4, overflow: "hidden", position: "relative" }}>
      {/* Demon/Goblin accent stripe */}
      {(isDemon || isGoblin) && <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: isDemon ? "#f59e0b" : "#8b5cf6" }} />}

      <div className="prop-row-grid" onClick={() => setOpen(!open)} style={{ display: "grid", gridTemplateColumns: "1fr 60px 90px 90px auto", alignItems: "center", gap: 10, padding: "10px 12px", cursor: "pointer" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{prop.player}</span>
            {isDemon && <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 5px", borderRadius: 3, background: "#f59e0b", color: "#000", letterSpacing: 0.5 }}>DEMON</span>}
            {isGoblin && <span style={{ fontSize: 8, fontWeight: 800, padding: "1px 5px", borderRadius: 3, background: "#8b5cf6", color: "#fff", letterSpacing: 0.5 }}>GOBLIN</span>}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {prop.game} · <span style={{ color: accent }}>{prop.marketLabel}</span>
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>LINE</div>
          <div style={{ fontSize: 15, fontWeight: 700, fontFamily: "var(--font-mono)" }}>{prop.consensusLine || "–"}</div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>OVER</div>
          {prop.bestOver ? <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--green)" }}>{prop.bestOver.point} <span style={{ fontSize: 10, opacity: 0.6 }}>({prop.bestOver.price > 0 ? "+" : ""}{prop.bestOver.price})</span></div> : <span style={{ color: "var(--text-dim)", fontSize: 11 }}>–</span>}
        </div>
        <div className="under-col" style={{ textAlign: "center" }}>
          <div style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>UNDER</div>
          {prop.bestUnder ? <div style={{ fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--red)" }}>{prop.bestUnder.point} <span style={{ fontSize: 10, opacity: 0.6 }}>({prop.bestUnder.price > 0 ? "+" : ""}{prop.bestUnder.price})</span></div> : <span style={{ color: "var(--text-dim)", fontSize: 11 }}>–</span>}
        </div>
        <div className="books-col" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <Badge color="var(--text-muted)">{prop.bookCount}</Badge>
          {prop.hasEdge && <Badge color="var(--green)">EDGE</Badge>}
          <span style={{ fontSize: 10, color: "var(--text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s", marginLeft: 2 }}>▾</span>
        </div>
      </div>

      {open && (
        <div style={{ padding: "0 12px 10px", borderTop: "1px solid var(--border)" }}>
          {/* Line Movement */}
          <LineMovementChip player={prop.player} market={prop.market} sport={propSport} gameId={prop.gameId} />

          {/* Add to pick builder buttons */}
          <div style={{ display: "flex", gap: 6, marginTop: 8, marginBottom: 8 }}>
            <button onClick={(e) => { e.stopPropagation(); onAddPick?.(prop, "OVER"); }}
              style={{ flex: 1, padding: "6px 0", borderRadius: 5, fontSize: 11, fontWeight: 700, background: isInBuilder?.over ? "var(--green)" : "var(--green)15", border: `1px solid var(--green)40`, color: isInBuilder?.over ? "#000" : "var(--green)", cursor: "pointer" }}>
              {isInBuilder?.over ? "✓ OVER Added" : "+ Add OVER"}
            </button>
            <button onClick={(e) => { e.stopPropagation(); onAddPick?.(prop, "UNDER"); }}
              style={{ flex: 1, padding: "6px 0", borderRadius: 5, fontSize: 11, fontWeight: 700, background: isInBuilder?.under ? "var(--red)" : "var(--red)15", border: `1px solid var(--red)40`, color: isInBuilder?.under ? "#fff" : "var(--red)", cursor: "pointer" }}>
              {isInBuilder?.under ? "✓ UNDER Added" : "+ Add UNDER"}
            </button>
          </div>

          <div className="prop-expanded-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 4 }}>
            {prop.books.map((b, i) => (
              <div key={i} style={{ background: "var(--bg-deep)", borderRadius: 6, padding: "6px 8px", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                <div style={{ fontSize: 9, color: "var(--text-dim)", marginBottom: 3, fontWeight: 700 }}>{b.name}</div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  {b.over && <span style={{ color: "var(--green)" }}>O {b.over.point} ({b.over.price > 0 ? "+" : ""}{b.over.price})</span>}
                  {b.under && <span style={{ color: "var(--red)" }}>U {b.under.point} ({b.under.price > 0 ? "+" : ""}{b.under.price})</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Pick Card with Live Tracking ───
function PickCard({ pick, liveData }) {
  const isOver = pick.pick === "OVER";
  const c = isOver ? "var(--green)" : "var(--red)";
  const cc = pick.confidence >= 75 ? "var(--green)" : pick.confidence >= 55 ? "var(--amber)" : "var(--red)";

  // Live tracking state
  const live = liveData?.[pick.player];
  const hasLive = live?.found;
  const currentVal = live?.relevantStat?.value;
  const line = pick.line;
  const pct = hasLive && currentVal != null && line ? Math.min(Math.round((currentVal / line) * 100), 200) : null;
  const onPace = hasLive && currentVal != null;
  const isTracking = hasLive && live.gameStatus?.isLive;
  const isFinalGame = hasLive && live.gameStatus?.isFinal;

  // Determine result color
  let resultColor = null;
  let resultLabel = null;
  if (isFinalGame && currentVal != null) {
    const hit = isOver ? currentVal > line : currentVal < line;
    resultColor = hit ? "var(--green)" : "var(--red)";
    resultLabel = hit ? "HIT ✓" : "MISS ✗";
  }

  return (
    <Card glow={resultColor ? `${resultColor}25` : `${c}20`}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "var(--font-display)" }}>{pick.player}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 1 }}>{pick.market}</div>
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {isTracking && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--red)", animation: "pulse 2s infinite" }} />}
          {resultLabel ? <Badge color={resultColor}>{resultLabel}</Badge> : <Badge color={cc}>{pick.confidence}%</Badge>}
        </div>
      </div>

      {/* Line + current stat */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: "var(--bg-deep)", borderRadius: 6, marginBottom: 8 }}>
        <span style={{ padding: "3px 10px", borderRadius: 5, fontWeight: 700, fontSize: 12, fontFamily: "var(--font-mono)", background: `${c}18`, color: c, border: `1px solid ${c}35` }}>{pick.pick}</span>
        <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--font-mono)" }}>{pick.line}</span>
        {onPace && (
          <>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>│</span>
            <span style={{ fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", color: (isOver ? currentVal > line : currentVal < line) ? "var(--green)" : (isOver ? currentVal < line * 0.6 : currentVal > line * 0.8) ? "var(--red)" : "var(--amber)" }}>
              {currentVal}
            </span>
            <span style={{ fontSize: 10, color: "var(--text-dim)" }}>current</span>
          </>
        )}
        {!onPace && pick.bestOdds && <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{pick.bestOdds}</span>}
        {pick.bestBook && <span style={{ fontSize: 10, color: "var(--text-dim)", marginLeft: "auto" }}>@ {pick.bestBook}</span>}
      </div>

      {/* Progress bar for live picks */}
      {onPace && pct != null && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--text-dim)", marginBottom: 3 }}>
            <span>{currentVal} / {line}</span>
            <span>{isTracking ? `${live.gameStatus?.clock || ""} ${live.gameStatus?.period ? `Q${live.gameStatus.period}` : ""}` : isFinalGame ? "FINAL" : ""}</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: "var(--border)", overflow: "hidden" }}>
            <div style={{
              width: `${Math.min(pct, 100)}%`, height: "100%", borderRadius: 2,
              background: pct >= 100 ? "var(--green)" : pct >= 70 ? "var(--amber)" : "var(--red)",
              transition: "width 0.5s ease",
            }} />
          </div>
        </div>
      )}

      <p style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5 }}>{pick.reasoning}</p>
      {pick.keyStats && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
          {Object.entries(pick.keyStats).filter(([,v]) => v).map(([k, v]) => (
            <span key={k} style={{ fontSize: 9, fontFamily: "var(--font-mono)", padding: "2px 6px", borderRadius: 4, background: "var(--bg-deep)", color: "var(--text-muted)", border: "1px solid var(--border)" }}>
              {k.replace(/([A-Z])/g, " $1").trim()}: <span style={{ color: "var(--text-secondary)", fontWeight: 700 }}>{v}</span>
            </span>
          ))}
        </div>
      )}
      {pick.edge && <div style={{ fontSize: 10, color: "var(--green)", marginTop: 5, fontFamily: "var(--font-mono)" }}>💡 {pick.edge}</div>}
    </Card>
  );
}

// ─── Game Card ───
function GameCard({ game, accent, onPredict }) {
  const isLive = game.status?.type === "STATUS_IN_PROGRESS";
  const isFinal = game.status?.type === "STATUS_FINAL";
  const t = new Date(game.date).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return (
    <Card onClick={() => onPredict?.(game)} style={{ cursor: "pointer" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 6, height: 6, borderRadius: "50%", background: isLive ? "var(--red)" : isFinal ? "var(--text-dim)" : "var(--green)", animation: isLive ? "pulse 2s infinite" : "none" }} />
          <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{isLive ? game.status?.displayClock || "LIVE" : isFinal ? "FINAL" : t}</span>
        </div>
        {game.broadcast && <span style={{ fontSize: 8, fontFamily: "var(--font-mono)", color: "var(--text-dim)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 3 }}>{game.broadcast}</span>}
      </div>
      {[game.away, game.home].map((tm, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: i === 0 ? 6 : 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            {tm.logo && <img src={tm.logo} alt="" style={{ width: 22, height: 22, objectFit: "contain" }} />}
            <span style={{ fontSize: 12, fontWeight: 700, color: tm.winner ? "var(--text-primary)" : isFinal ? "var(--text-muted)" : "var(--text-primary)" }}>{tm.name || tm.abbreviation}</span>
          </div>
          <span style={{ fontSize: 18, fontFamily: "var(--font-mono)", fontWeight: 700, color: tm.winner ? "var(--text-primary)" : isFinal ? "var(--text-muted)" : "var(--text-primary)" }}>{tm.score !== null ? tm.score : "–"}</span>
        </div>
      ))}
      {!isFinal && <button style={{ marginTop: 8, width: "100%", padding: "6px 0", background: `${accent}12`, border: `1px solid ${accent}25`, borderRadius: 6, color: accent, fontSize: 11, fontWeight: 700 }}>🎯 AI Predict</button>}
    </Card>
  );
}

// ─── Prediction Panel ───
function PredPanel({ prediction: pr, loading, accent }) {
  if (loading) return <Card style={{ marginBottom: 14 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Spinner color={accent} /><span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Running AI analysis...</span></div><div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}><Shimmer h={18} /><Shimmer h={12} w="65%" /><Shimmer h={36} /></div></Card>;
  if (!pr?.prediction) return null;
  const p = pr.prediction;
  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${accent}30` }} className="fade-up">
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <span style={{ fontSize: 16 }}>🧠</span>
        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14 }}>AI Prediction</span>
        {p.confidence > 0 && <Badge color={p.confidence >= 70 ? "var(--green)" : "var(--amber)"}>{p.confidence}%</Badge>}
      </div>
      {p.fallback ? <div style={{ color: "var(--text-muted)", fontSize: 11 }}>{p.keyFactors?.map((f, i) => <p key={i} style={{ marginBottom: 3 }}>{f}</p>)}</div> : (
        <>
          {p.predictedScore && (
            <div style={{ display: "flex", justifyContent: "center", gap: 18, margin: "10px 0", padding: 12, borderRadius: 6, background: "var(--bg-deep)" }}>
              {[{t: p.awayTeam, s: p.predictedScore.away}, {t: null, s: "—"}, {t: p.homeTeam, s: p.predictedScore.home}].map((x, i) => (
                <div key={i} style={{ textAlign: "center" }}>{x.t && <div style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>{x.t}</div>}<div style={{ fontSize: x.t ? 22 : 16, fontFamily: "var(--font-mono)", fontWeight: 700, color: x.t ? "var(--text-primary)" : "var(--text-dim)" }}>{x.s}</div></div>
              ))}
            </div>
          )}
          {p.keyFactors?.map((f, i) => <div key={i} style={{ fontSize: 11, color: "var(--text-secondary)", marginBottom: 2 }}><span style={{ color: accent }}>▸</span> {f}</div>)}
          {p.hotTake && <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 6, background: `${accent}08`, fontSize: 11, fontStyle: "italic" }}>🔥 {p.hotTake}</div>}
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
  const [history, setHistory] = useState(null);
  const [marketFilter, setMarketFilter] = useState(null);
  const [searchFilter, setSearchFilter] = useState("");
  const [lineTypeFilter, setLineTypeFilter] = useState(null); // "demon", "goblin", "edge", or null
  const [pickerPicks, setPickerPicks] = useState([]); // Pick builder selections
  const [showBuilder, setShowBuilder] = useState(false);
  const [time, setTime] = useState(new Date());
  const [liveData, setLiveData] = useState({});
  const [grading, setGrading] = useState(false);

  const meta = SPORTS.find((s) => s.key === sport);
  const accent = meta?.color || "#38bdf8";
  const isCDL = sport === "cdl";
  const markets = MARKET_OPTIONS[sport] || [];

  useEffect(() => { const i = setInterval(() => setTime(new Date()), 30000); return () => clearInterval(i); }, []);

  // Live polling: fetch in-game stats for active picks every 30s
  useEffect(() => {
    if (tab !== "picks" || !picks?.picks?.length || isCDL) return;

    const pollLive = async () => {
      const updates = {};
      for (const pick of picks.picks.slice(0, 8)) {
        try {
          const data = await api.getLivePlayer(sport, pick.player, pick.market ? marketLabelToKey(pick.market) : "");
          if (data?.found) updates[pick.player] = data;
        } catch {} // Silently skip if player not in live game
      }
      if (Object.keys(updates).length) setLiveData(prev => ({ ...prev, ...updates }));
    };

    pollLive(); // Initial fetch
    const interval = setInterval(pollLive, 30000); // Poll every 30s
    return () => clearInterval(interval);
  }, [tab, picks, sport]);

  // Helper: convert market label back to key for API
  function marketLabelToKey(label) {
    const map = { "Points": "player_points", "Rebounds": "player_rebounds", "Assists": "player_assists", "3-Pointers": "player_threes", "Pts+Reb+Ast": "player_points_rebounds_assists", "Pass Yards": "player_pass_yds", "Rush Yards": "player_rush_yds", "Receptions": "player_receptions", "Rec Yards": "player_reception_yds", "Hits": "batter_hits", "Strikeouts": "pitcher_strikeouts", "Goals": "player_goals", "SOG": "player_shots_on_goal" };
    return map[label] || label;
  }

  // Grade picks against final scores
  const handleGrade = async () => {
    if (!picks?.picks?.length) return;
    setGrading(true);
    try {
      const formatted = picks.picks.map(p => ({ player: p.player, market: marketLabelToKey(p.market), line: p.line, pick: p.pick, confidence: p.confidence }));
      const result = await api.gradePicks(sport, formatted);
      if (result?.results?.length) {
        // Update liveData with final results
        const updates = {};
        for (const r of result.results) {
          updates[r.player] = { found: true, relevantStat: { value: r.actual }, gameStatus: { isFinal: true } };
        }
        setLiveData(prev => ({ ...prev, ...updates }));
      }
      // Refresh history
      api.getPickHistory().then(setHistory).catch(() => {});
    } catch (e) { setError(e.message); }
    finally { setGrading(false); }
  };

  useEffect(() => {
    setError(null); setPrediction(null);
    if (tab === "props" && !isCDL) {
      setPropsLoading(true); setProps(null);
      api.getProps(sport, marketFilter).then(setProps).catch(e => setError(e.message)).finally(() => setPropsLoading(false));
    }
    if (tab === "picks" && !isCDL) {
      setPicksLoading(true); setPicks(null);
      api.getDailyPicks(sport).then(setPicks).catch(e => setError(e.message)).finally(() => setPicksLoading(false));
    }
    if (tab === "history") {
      api.getPickHistory().then(setHistory).catch(e => setError(e.message));
    }
    if (tab === "live" || tab === "predict") {
      setLoading(true); setScores(null);
      if (isCDL) {
        api.getCDLMatches().then(data => {
          if (!data.available) { setError(data.message); setLoading(false); return; }
          setScores({ sport: "cdl", count: data.matches.length, games: data.matches.map(m => ({ id: String(m.id), name: m.name, date: m.scheduledAt, status: { type: m.status === "live" ? "STATUS_IN_PROGRESS" : m.status === "completed" ? "STATUS_FINAL" : "STATUS_SCHEDULED", displayClock: m.status === "live" ? "LIVE" : "", completed: m.status === "completed" }, home: m.team2 ? { id: m.team2.id, name: m.team2.name, abbreviation: m.team2.acronym, logo: m.team2.logo, score: m.team2.score, winner: m.winner === m.team2.name } : { name: "TBD", score: null }, away: m.team1 ? { id: m.team1.id, name: m.team1.name, abbreviation: m.team1.acronym, logo: m.team1.logo, score: m.team1.score, winner: m.winner === m.team1.name } : { name: "TBD", score: null }, venue: m.tournament, broadcast: m.league })) });
        }).catch(e => { if (!isCDL) setError(e.message); }).finally(() => setLoading(false));
      } else {
        api.getScores(sport).then(setScores).catch(e => setError(e.message)).finally(() => setLoading(false));
      }
    }
    if (tab === "standings") {
      setLoading(true); setStandings(null);
      if (isCDL) {
        api.getCDLStandings().then(data => { if (!data.available) { setError(data.message); setLoading(false); return; } setStandings({ sport: "cdl", groups: [{ name: "CDL 2026", teams: data.standings.map(s => ({ id: s.team?.id, name: s.team?.name, logo: s.team?.logo, stats: { W: String(s.wins || 0), L: String(s.losses || 0) } })) }] }); }).catch(e => setError(e.message)).finally(() => setLoading(false));
      } else {
        api.getStandings(sport).then(setStandings).catch(e => setError(e.message)).finally(() => setLoading(false));
      }
    }
  }, [sport, tab, marketFilter]);

  const handlePredict = useCallback(async (g) => {
    setPredicting(true); setPrediction(null);
    try { setPrediction(await api.predictGame(sport, g.id)); } catch (e) { setError(e.message); } finally { setPredicting(false); }
  }, [sport]);

  const filtered = (props?.props || []).filter(p => {
    if (searchFilter && !p.player.toLowerCase().includes(searchFilter.toLowerCase())) return false;
    if (lineTypeFilter === "demon" && p.lineType !== "demon") return false;
    if (lineTypeFilter === "goblin" && p.lineType !== "goblin") return false;
    if (lineTypeFilter === "edge" && !p.hasEdge) return false;
    return true;
  });

  // Demon/goblin counts for filter badges
  const demonCount = (props?.props || []).filter(p => p.lineType === "demon").length;
  const goblinCount = (props?.props || []).filter(p => p.lineType === "goblin").length;
  const edgeCount = (props?.props || []).filter(p => p.hasEdge).length;

  // Pick builder functions
  const addToPicker = (prop, side) => {
    const key = `${prop.player}__${prop.market}__${side}`;
    const exists = pickerPicks.find(p => p.key === key);
    if (exists) {
      setPickerPicks(prev => prev.filter(p => p.key !== key));
    } else {
      // Remove opposite side if exists
      const oppositeKey = `${prop.player}__${prop.market}__${side === "OVER" ? "UNDER" : "OVER"}`;
      setPickerPicks(prev => [...prev.filter(p => p.key !== oppositeKey), {
        key, player: prop.player, market: prop.marketLabel, line: prop.consensusLine,
        side, game: prop.game, bestBook: side === "OVER" ? prop.bestOver?.book : prop.bestUnder?.book,
        bestOdds: side === "OVER" ? prop.bestOver?.price : prop.bestUnder?.price,
      }]);
    }
    setShowBuilder(true);
  };

  const getPickerState = (prop) => {
    const overKey = `${prop.player}__${prop.market}__OVER`;
    const underKey = `${prop.player}__${prop.market}__UNDER`;
    return {
      over: pickerPicks.some(p => p.key === overKey),
      under: pickerPicks.some(p => p.key === underKey),
    };
  };

  const removePick = (key) => setPickerPicks(prev => prev.filter(p => p.key !== key));
  const clearPicker = () => { setPickerPicks([]); setShowBuilder(false); };

  return (
    <div style={{ minHeight: "100vh", position: "relative" }}>
      <div style={{ position: "fixed", inset: 0, zIndex: 0, opacity: 0.025, backgroundImage: `radial-gradient(${accent} 1px, transparent 1px)`, backgroundSize: "24px 24px", pointerEvents: "none" }} />

      {/* HEADER */}
      <header className="header" style={{ position: "sticky", top: 0, zIndex: 50, background: "var(--bg-deep)ee", backdropFilter: "blur(12px)", padding: "12px 20px 0", borderBottom: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div style={{ width: 30, height: 30, borderRadius: 7, background: `linear-gradient(135deg, ${accent}, ${accent}88)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, color: "#fff", boxShadow: `0 3px 16px ${accent}40` }}>⟁</div>
            <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 22, letterSpacing: "-0.03em", background: `linear-gradient(135deg, #f1f5f9, ${accent})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>ORACLE</h1>
            <span style={{ fontSize: 8, fontFamily: "var(--font-mono)", background: `${accent}20`, color: accent, padding: "2px 6px", borderRadius: 3, fontWeight: 700, border: `1px solid ${accent}30` }}>v2</span>
          </div>
          <div className="sports-bar" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {SPORTS.map(s => (
              <button key={s.key} onClick={() => { setSport(s.key); setMarketFilter(null); setSearchFilter(""); if (s.key === "cdl" && ["props", "picks"].includes(tab)) setTab("live"); }}
                style={{ background: sport === s.key ? `${s.color}25` : "var(--bg-card)", border: `1px solid ${sport === s.key ? s.color : "var(--border)"}`, color: sport === s.key ? "#f1f5f9" : "var(--text-muted)", padding: "5px 9px", borderRadius: 6, fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", gap: 3 }}>
                <span style={{ fontSize: 12 }}>{s.icon}</span> {s.label}
              </button>
            ))}
          </div>
        </div>
        <nav className="tab-bar" style={{ display: "flex", gap: 1, marginBottom: -1 }}>
          {TABS.filter(t => !isCDL || !["picks"].includes(t.key)).map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ background: tab === t.key ? "var(--bg-elevated)" : "transparent", border: "none", borderBottom: tab === t.key ? `2px solid ${accent}` : "2px solid transparent", color: tab === t.key ? "var(--text-primary)" : "var(--text-muted)", padding: "8px 12px", fontSize: 11, fontWeight: 600, display: "flex", alignItems: "center", gap: 4, borderRadius: "5px 5px 0 0", whiteSpace: "nowrap" }}>
              <span>{t.icon}</span> {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* MAIN */}
      <main className="main-content" style={{ padding: "16px 20px 44px", maxWidth: 1200, margin: "0 auto" }}>
        {error && <div className="fade-up" style={{ padding: "8px 12px", borderRadius: 6, marginBottom: 12, background: "#ef444410", border: "1px solid #ef444425", color: "var(--red)", fontSize: 11, display: "flex", justifyContent: "space-between" }}><span>⚠️ {error}</span><button onClick={() => setError(null)} style={{ background: "none", border: "none", color: "var(--red)", fontSize: 13 }}>✕</button></div>}

        {/* ═══ PLAYER PROPS ═══ */}
        {tab === "props" && (
          <div className="fade-up">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              <div>
                <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 5 }}>
                  📋 Player Props {props?.count > 0 && <Badge color={accent}>{filtered.length}</Badge>}
                </h2>
                <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>Click any row to compare lines across books</p>
              </div>
              <input className="search-bar" placeholder="Search player..." value={searchFilter} onChange={e => setSearchFilter(e.target.value)}
                style={{ padding: "6px 10px", borderRadius: 6, background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-primary)", fontSize: 11, width: 150, outline: "none" }} />
            </div>

            {/* Market filter buttons */}
            {markets.length > 0 && (
              <div className="market-filters" style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
                <button onClick={() => setMarketFilter(null)}
                  style={{ padding: "5px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: !marketFilter ? `${accent}20` : "var(--bg-card)", border: `1px solid ${!marketFilter ? accent : "var(--border)"}`, color: !marketFilter ? accent : "var(--text-muted)" }}>
                  All
                </button>
                {markets.map(m => (
                  <button key={m} onClick={() => setMarketFilter(marketFilter === m ? null : m)}
                    style={{ padding: "5px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: marketFilter === m ? `${accent}20` : "var(--bg-card)", border: `1px solid ${marketFilter === m ? accent : "var(--border)"}`, color: marketFilter === m ? accent : "var(--text-muted)" }}>
                    {MARKET_LABELS[m] || m}
                  </button>
                ))}
              </div>
            )}

            {/* Demon/Goblin/Edge filters */}
            {!isCDL && props?.props?.length > 0 && (
              <div style={{ display: "flex", gap: 4, marginBottom: 12, flexWrap: "wrap" }}>
                <button onClick={() => setLineTypeFilter(lineTypeFilter === "demon" ? null : "demon")}
                  style={{ padding: "5px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: lineTypeFilter === "demon" ? "#f59e0b25" : "var(--bg-card)", border: `1px solid ${lineTypeFilter === "demon" ? "#f59e0b" : "var(--border)"}`, color: lineTypeFilter === "demon" ? "#f59e0b" : "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  🔥 Demons {demonCount > 0 && <span style={{ background: "#f59e0b", color: "#000", borderRadius: 8, padding: "0 5px", fontSize: 9 }}>{demonCount}</span>}
                </button>
                <button onClick={() => setLineTypeFilter(lineTypeFilter === "goblin" ? null : "goblin")}
                  style={{ padding: "5px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: lineTypeFilter === "goblin" ? "#8b5cf625" : "var(--bg-card)", border: `1px solid ${lineTypeFilter === "goblin" ? "#8b5cf6" : "var(--border)"}`, color: lineTypeFilter === "goblin" ? "#8b5cf6" : "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  👹 Goblins {goblinCount > 0 && <span style={{ background: "#8b5cf6", color: "#fff", borderRadius: 8, padding: "0 5px", fontSize: 9 }}>{goblinCount}</span>}
                </button>
                <button onClick={() => setLineTypeFilter(lineTypeFilter === "edge" ? null : "edge")}
                  style={{ padding: "5px 10px", borderRadius: 5, fontSize: 10, fontWeight: 700, background: lineTypeFilter === "edge" ? "var(--green)25" : "var(--bg-card)", border: `1px solid ${lineTypeFilter === "edge" ? "var(--green)" : "var(--border)"}`, color: lineTypeFilter === "edge" ? "var(--green)" : "var(--text-muted)", display: "flex", alignItems: "center", gap: 4 }}>
                  ⚡ Edges {edgeCount > 0 && <span style={{ background: "var(--green)", color: "#000", borderRadius: 8, padding: "0 5px", fontSize: 9 }}>{edgeCount}</span>}
                </button>
                {lineTypeFilter && <button onClick={() => setLineTypeFilter(null)} style={{ padding: "5px 8px", borderRadius: 5, fontSize: 10, background: "transparent", border: "1px solid var(--border)", color: "var(--text-dim)" }}>✕ Clear</button>}
              </div>
            )}

            {/* Biggest Line Moves */}
            {!isCDL && !propsLoading && filtered.length > 0 && <BiggestMovesPanel sport={sport} />}

            {isCDL ? <CDLPropsTab />
              : propsLoading ? <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{Array.from({ length: 6 }).map((_, i) => <Shimmer key={i} h={48} />)}</div>
              : filtered.length > 0 ? <div>{filtered.map((p, i) => <PropRow key={i} prop={p} accent={accent} onAddPick={addToPicker} isInBuilder={getPickerState(p)} sport={sport} />)}</div>
              : props?.available === false ? <Empty icon="🔑" title="API Key Needed" sub={props.message} />
              : <Empty icon="📋" title="No props available" sub={`No props for ${meta?.label} right now. Check back closer to game time.`} />}
          </div>
        )}

        {/* ═══ TOP PICKS ═══ */}
        {tab === "picks" && (
          <div className="fade-up">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              <div>
                <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, display: "flex", alignItems: "center", gap: 6 }}>
                  🔥 AI Top Picks
                  {Object.keys(liveData).length > 0 && <Badge color="var(--red)"><span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--red)", display: "inline-block", animation: "pulse 2s infinite", marginRight: 3 }} />LIVE</Badge>}
                </h2>
                <p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                  {Object.keys(liveData).length > 0 ? "Tracking live stats · Refreshing every 30s" : "AI-curated best bets from today's props board"}
                </p>
              </div>
              {picks?.picks?.length > 0 && (
                <button onClick={handleGrade} disabled={grading}
                  style={{ padding: "6px 14px", borderRadius: 6, fontSize: 11, fontWeight: 700, background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: 5, opacity: grading ? 0.5 : 1 }}>
                  {grading ? <Spinner size={12} /> : "📊"} Grade Picks
                </button>
              )}
            </div>
            {isCDL ? <Empty icon="🎮" title="CDL Picks Coming Soon" sub="AI picks aren't available for esports." />
              : picksLoading ? <Card><div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "30px 0" }}><Spinner size={24} color={accent} /><span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>Analyzing today's board...</span><div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>{["Fetching lines", "Pulling player stats", "Checking matchups", "Running AI analysis"].map((step, i) => <span key={i} style={{ fontSize: 9, fontFamily: "var(--font-mono)", padding: "3px 8px", borderRadius: 4, background: "var(--bg-deep)", color: "var(--text-dim)", border: "1px solid var(--border)", animation: `fadeUp 0.3s ease ${i * 0.5}s both` }}>{step}</span>)}</div><p style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>First load takes ~10s · Cached for 10 minutes after</p></div></Card>
              : picks?.picks?.length > 0 ? (
                <>
                  {picks.summary && <Card style={{ marginBottom: 12, border: `1px solid ${accent}18` }}><p style={{ fontSize: 12, color: "var(--text-secondary)" }}>📊 {picks.summary}</p></Card>}
                  <div className="picks-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
                    {picks.picks.map((p, i) => <PickCard key={i} pick={p} liveData={liveData} />)}
                  </div>
                </>
              ) : picks?.available === false ? <Empty icon="🔑" title="Setup Required" sub={picks.message} />
              : <Empty icon="🔥" title="No picks yet" sub="Picks need props data. Check back when games have lines posted." />}
          </div>
        )}

        {/* ═══ HISTORY ═══ */}
        {tab === "history" && (() => {
          // Filter history by selected sport
          const sportEntries = history?.entries?.filter(e => e.sport === sport) || [];
          const sportPicks = sportEntries.flatMap(e => e.picks);
          const graded = sportPicks.filter(p => p.result);
          const hits = graded.filter(p => p.result === "hit");
          const sportStats = {
            sessions: sportEntries.length,
            totalPicks: sportPicks.length,
            gradedPicks: graded.length,
            hits: hits.length,
            hitRate: graded.length > 0 ? Math.round((hits.length / graded.length) * 1000) / 10 : null,
          };

          return (
          <div className="fade-up">
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>📈 {meta?.label} Pick History</h2>
            <p style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 14 }}>Showing picks for {meta?.label} only</p>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8, marginBottom: 16 }}>
              {[
                { label: "Sessions", value: sportStats.sessions, color: accent },
                { label: "Total Picks", value: sportStats.totalPicks, color: "var(--text-primary)" },
                { label: "Graded", value: sportStats.gradedPicks, color: "var(--amber)" },
                { label: "Hit Rate", value: sportStats.hitRate !== null ? `${sportStats.hitRate}%` : "N/A", color: "var(--green)" },
              ].map((s, i) => (
                <Card key={i} style={{ textAlign: "center", padding: 12 }}>
                  <div style={{ fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--font-mono)", color: s.color }}>{s.value}</div>
                </Card>
              ))}
            </div>

            {sportEntries.length > 0 ? (
              <div className="history-grid" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sportEntries.map((entry, i) => (
                  <Card key={i}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <Badge color={accent}>{entry.sport.toUpperCase()}</Badge>
                        <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{entry.date}</span>
                      </div>
                      <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{entry.picks.length} picks</span>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {entry.picks.map((p, j) => (
                        <div key={j} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 4, background: "var(--bg-deep)", fontSize: 10, fontFamily: "var(--font-mono)" }}>
                          <span style={{ fontWeight: 700 }}>{p.player}</span>
                          <span style={{ color: p.pick === "OVER" ? "var(--green)" : "var(--red)" }}>{p.pick} {p.line}</span>
                          {p.result && <span style={{ color: p.result === "hit" ? "var(--green)" : "var(--red)", fontWeight: 700 }}>{p.result === "hit" ? "✓" : "✗"}</span>}
                          {p.actual != null && <span style={{ color: "var(--text-dim)" }}>({p.actual})</span>}
                        </div>
                      ))}
                    </div>
                  </Card>
                ))}
              </div>
            ) : (
              <Empty icon="📈" title={`No ${meta?.label} history yet`} sub={`Generate AI Top Picks for ${meta?.label} to start tracking. Each session saves automatically.`} />
            )}
          </div>
          );
        })()}

        {/* ═══ SCORES ═══ */}
        {tab === "live" && (
          <div className="fade-up">
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 14 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--red)", animation: "pulse 2s infinite" }} />
              <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-secondary)" }}>{scores?.count || 0} {meta?.label} games</span>
            </div>
            <PredPanel prediction={prediction} loading={predicting} accent={accent} />
            {loading ? <div className="games-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>{Array.from({ length: 4 }).map((_, i) => <Card key={i}><Shimmer h={12} w="35%" /><div style={{ height: 5 }} /><Shimmer h={18} /><div style={{ height: 3 }} /><Shimmer h={18} /></Card>)}</div>
              : scores?.games?.length > 0 ? <div className="games-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>{scores.games.map(g => <GameCard key={g.id} game={g} accent={accent} onPredict={handlePredict} />)}</div>
              : <Empty icon={meta?.icon} title={`No ${meta?.label} games`} sub="Check back later." />}
          </div>
        )}

        {/* ═══ PREDICTOR ═══ */}
        {tab === "predict" && (
          <div className="fade-up">
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, marginBottom: 12 }}>🎯 Game Predictor</h2>
            <PredPanel prediction={prediction} loading={predicting} accent={accent} />
            {loading ? <div className="games-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>{Array.from({ length: 4 }).map((_, i) => <Card key={i}><Shimmer h={12} w="35%" /><div style={{ height: 5 }} /><Shimmer h={18} /><div style={{ height: 3 }} /><Shimmer h={18} /></Card>)}</div>
              : scores?.games?.length > 0 ? <div className="games-grid" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 8 }}>{scores.games.map(g => <GameCard key={g.id} game={g} accent={accent} onPredict={handlePredict} />)}</div>
              : <Empty icon="🎯" title="No games" sub="No upcoming games found." />}
          </div>
        )}

        {/* ═══ STANDINGS ═══ */}
        {tab === "standings" && (
          <div className="fade-up">
            <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, marginBottom: 12 }}>🏆 {meta?.label} Standings</h2>
            {loading ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{Array.from({ length: 6 }).map((_, i) => <Shimmer key={i} h={32} />)}</div>
              : standings?.groups?.length > 0 ? standings.groups.map(g => (
                <div key={g.name} style={{ marginBottom: 16 }}>
                  <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 12, color: "var(--text-secondary)", marginBottom: 6, paddingBottom: 5, borderBottom: "1px solid var(--border)" }}>{g.name}</h3>
                  {g.teams?.map((t, i) => (
                    <div key={t.id || i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 5, background: i % 2 === 0 ? "var(--bg-card)" : "transparent" }}>
                      <span style={{ width: 20, fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-dim)", textAlign: "center" }}>{i + 1}</span>
                      {t.logo && <img src={t.logo} alt="" style={{ width: 20, height: 20, objectFit: "contain" }} />}
                      <span style={{ flex: 1, fontSize: 11, fontWeight: 600 }}>{t.name}</span>
                      <span style={{ fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>{t.stats?.W && t.stats?.L ? `${t.stats.W}-${t.stats.L}` : Object.values(t.stats || {}).slice(0, 3).join(" · ")}</span>
                    </div>
                  ))}
                </div>
              )) : <Empty icon="🏆" title="No standings" sub="Not available for this sport." />}
          </div>
        )}

        <div style={{ marginTop: 28, padding: 10, borderRadius: 6, background: "var(--bg-card)", border: "1px solid var(--border)", fontSize: 9, color: "var(--text-dim)", fontFamily: "var(--font-mono)", textAlign: "center" }}>
          ⚠️ For entertainment & research only. Not financial or gambling advice.
        </div>
      </main>

      {/* ═══ FLOATING PICK BUILDER ═══ */}
      {pickerPicks.length > 0 && (
        <div style={{
          position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 100,
          background: "var(--bg-card)f5", backdropFilter: "blur(16px)",
          borderTop: "1px solid var(--border-bright)",
          padding: showBuilder ? "14px 20px 20px" : "10px 20px",
          transition: "all 0.2s ease",
          maxHeight: showBuilder ? "50vh" : "48px", overflow: "hidden",
        }}>
          {/* Header bar */}
          <div onClick={() => setShowBuilder(!showBuilder)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", marginBottom: showBuilder ? 10 : 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 14 }}>🎫</span>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13 }}>Pick Builder</span>
              <Badge color={accent}>{pickerPicks.length} pick{pickerPicks.length !== 1 ? "s" : ""}</Badge>
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button onClick={(e) => { e.stopPropagation(); clearPicker(); }} style={{ padding: "4px 10px", borderRadius: 5, fontSize: 10, background: "var(--bg-deep)", border: "1px solid var(--border)", color: "var(--text-muted)" }}>Clear All</button>
              <span style={{ fontSize: 12, color: "var(--text-dim)", transform: showBuilder ? "rotate(180deg)" : "none", transition: "transform .15s" }}>▲</span>
            </div>
          </div>

          {/* Expanded picks list */}
          {showBuilder && (
            <div style={{ overflowY: "auto", maxHeight: "35vh" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 12 }}>
                {pickerPicks.map((pick) => (
                  <div key={pick.key} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "8px 10px", borderRadius: 6, background: "var(--bg-deep)",
                    border: `1px solid ${pick.side === "OVER" ? "var(--green)25" : "var(--red)25"}`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
                      <span style={{
                        padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                        fontFamily: "var(--font-mono)",
                        background: pick.side === "OVER" ? "var(--green)18" : "var(--red)18",
                        color: pick.side === "OVER" ? "var(--green)" : "var(--red)",
                      }}>{pick.side}</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pick.player}</div>
                        <div style={{ fontSize: 9, color: "var(--text-dim)" }}>{pick.market} {pick.line} · {pick.game}</div>
                      </div>
                    </div>
                    {pick.bestOdds && <span style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--text-secondary)", marginRight: 8 }}>{pick.bestOdds > 0 ? "+" : ""}{pick.bestOdds}</span>}
                    <button onClick={() => removePick(pick.key)} style={{ background: "none", border: "none", color: "var(--text-dim)", fontSize: 14, padding: "2px 4px" }}>✕</button>
                  </div>
                ))}
              </div>

              {/* Export buttons */}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button onClick={() => {
                  const text = pickerPicks.map(p => `${p.player} — ${p.side} ${p.line} ${p.market}`).join("\n");
                  navigator.clipboard?.writeText(text);
                  alert("Picks copied to clipboard!");
                }} style={{
                  flex: 1, padding: "10px 0", borderRadius: 6, fontSize: 12, fontWeight: 700,
                  background: `${accent}20`, border: `1px solid ${accent}40`, color: accent,
                }}>📋 Copy Picks</button>
                <button onClick={() => {
                  const text = pickerPicks.map(p => `${p.player} ${p.side} ${p.line} ${p.market} @ ${p.bestBook || "Best Book"}`).join("\n");
                  const url = `https://app.prizepicks.com`;
                  window.open(url, "_blank");
                  navigator.clipboard?.writeText(text);
                }} style={{
                  flex: 1, padding: "10px 0", borderRadius: 6, fontSize: 12, fontWeight: 700,
                  background: "#7c3aed20", border: "1px solid #7c3aed40", color: "#a78bfa",
                }}>🎯 Open PrizePicks</button>
                <button onClick={() => {
                  const text = pickerPicks.map(p => `${p.player} ${p.side} ${p.line} ${p.market}`).join("\n");
                  window.open("https://pick6.draftkings.com", "_blank");
                  navigator.clipboard?.writeText(text);
                }} style={{
                  flex: 1, padding: "10px 0", borderRadius: 6, fontSize: 12, fontWeight: 700,
                  background: "#16a34a20", border: "1px solid #16a34a40", color: "#4ade80",
                }}>🏈 Open DraftKings</button>
              </div>

              <p style={{ fontSize: 9, color: "var(--text-dim)", textAlign: "center", marginTop: 8, fontFamily: "var(--font-mono)" }}>
                Picks are copied to clipboard when you open an app — paste them as reference
              </p>
            </div>
          )}
        </div>
      )}

      {/* Bottom padding when builder is open */}
      {pickerPicks.length > 0 && <div style={{ height: showBuilder ? 280 : 48 }} />}
    </div>
  );
}
