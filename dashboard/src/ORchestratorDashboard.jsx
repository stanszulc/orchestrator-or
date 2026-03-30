import { useState, useEffect, useCallback } from "react";

// ── Config ───────────────────────────────────────────────────────────────────
const MCP_URL = "http://92.5.14.76:8001/optimize";

// ── Mock FHIR patients (10 pacjentów) ────────────────────────────────────────
const FHIR_PATIENTS = [
  { patient_id:"P001", name:"Kowalski J.",    procedure:"Appendectomy",    duration_p50:58,  risk:"Standard" },
  { patient_id:"P002", name:"Nowak M.",       procedure:"Cholecystectomy", duration_p50:72,  risk:"High"     },
  { patient_id:"P003", name:"Wiśniewska K.", procedure:"Hernia Repair",   duration_p50:50,  risk:"Low"      },
  { patient_id:"P004", name:"Dąbrowski T.",  procedure:"Major Surgery",   duration_p50:148, risk:"High"     },
  { patient_id:"P005", name:"Lewandowska A.",procedure:"Appendectomy",    duration_p50:55,  risk:"Low"      },
  { patient_id:"P006", name:"Wójcik P.",     procedure:"Colectomy",       duration_p50:95,  risk:"High"     },
  { patient_id:"P007", name:"Kamińska E.",   procedure:"Cholecystectomy", duration_p50:68,  risk:"Standard" },
  { patient_id:"P008", name:"Kowalczyk R.",  procedure:"Hernia Repair",   duration_p50:48,  risk:"Low"      },
  { patient_id:"P009", name:"Zielińska B.",  procedure:"Nephrectomy",     duration_p50:110, risk:"High"     },
  { patient_id:"P010", name:"Szymański M.",  procedure:"Major Surgery",   duration_p50:155, risk:"High"     },
];

// ── Colors ───────────────────────────────────────────────────────────────────
const PROC_COLORS = {
  Appendectomy:    "#e07b39",
  Cholecystectomy: "#4a9eff",
  "Hernia Repair": "#a78bfa",
  "Major Surgery": "#ff2244",
  Colectomy:       "#6bcb77",
  Nephrectomy:     "#e0c039",
};

const RISK_COLOR = r => r === "High" ? "#ff2244" : r === "Standard" ? "#ff9f43" : "#6bcb77";
const RISK_LABEL = r => r === "High" ? "HIGH"    : r === "Standard" ? "MED"     : "LOW";

// ── Time helpers ─────────────────────────────────────────────────────────────
const timeToMin = t => { const [h,m] = t.split(":").map(Number); return h*60+m; };
const minToTime = m => `${String(Math.floor(m/60)%24).padStart(2,"0")}:${String(m%60).padStart(2,"0")}`;

const OR_START = timeToMin("07:30");
const OR_END   = timeToMin("15:30");
const DAY_W    = OR_END - OR_START + 30;
const px       = (min, width) => ((min - OR_START) / DAY_W) * width;

// ── KPICard ──────────────────────────────────────────────────────────────────
function KPICard({ value, label, color, sub }) {
  return (
    <div style={{ background:"#111118", border:`1px solid ${color}33`,
      borderTop:`2px solid ${color}`, borderRadius:10, padding:"16px 18px" }}>
      <div style={{ fontFamily:"'JetBrains Mono',monospace", fontSize:24,
        fontWeight:700, color, lineHeight:1 }}>{value}</div>
      <div style={{ fontSize:10, color:"#555", letterSpacing:"0.12em",
        textTransform:"uppercase", marginTop:6 }}>{label}</div>
      {sub && <div style={{ fontSize:10, color:"#444", marginTop:3,
        fontFamily:"'JetBrains Mono',monospace" }}>{sub}</div>}
    </div>
  );
}

// ── GanttBar ─────────────────────────────────────────────────────────────────
function GanttBar({ op, width }) {
  const color  = PROC_COLORS[op.procedure] ?? "#888";
  const riskC  = RISK_COLOR(op.risk);
  const startM = timeToMin(op.start);
  const endM   = timeToMin(op.end);
  const L = px(startM, width);
  const W = Math.max(((endM - startM) / DAY_W) * width, 6);
  const bufFrac = op.buffer_minutes / op.scheduled_minutes;

  return (
    <div style={{ position:"relative", height:36, marginBottom:4 }}>
      <div style={{ position:"absolute", left:Math.max(L-6,0), top:"50%",
        transform:"translateY(-50%)", width:4, height:24,
        background:riskC, borderRadius:2, opacity:0.9 }} />
      <div title={`${op.patient_id} · ${op.procedure} · ${op.start}–${op.end} · +${op.buffer_minutes}' buffer`}
        style={{ position:"absolute", left:L, width:W, top:4, height:28,
          background:`${color}22`, border:`1.5px solid ${color}`,
          borderRadius:5, overflow:"hidden" }}>
        {bufFrac > 0 && (
          <div style={{ position:"absolute", right:0, top:0,
            width:`${bufFrac*100}%`, height:"100%",
            background:"#00d4ff22", borderLeft:"1px dashed #00d4ff66" }} />
        )}
        <span style={{ position:"absolute", left:6, top:"50%",
          transform:"translateY(-50%)", fontSize:9,
          fontFamily:"'JetBrains Mono',monospace",
          color:`${color}cc`, whiteSpace:"nowrap", fontWeight:600 }}>
          {op.patient_id} · {Math.round(endM-startM)}'
        </span>
      </div>
    </div>
  );
}

// ── TimeAxis ─────────────────────────────────────────────────────────────────
function TimeAxis({ width }) {
  const hours = [];
  for (let m = OR_START; m <= OR_END; m += 60) hours.push(m);
  return (
    <div style={{ position:"relative", height:20, marginBottom:4 }}>
      {hours.map(m => (
        <span key={m} style={{ position:"absolute", left:px(m,width),
          transform:"translateX(-50%)", fontSize:9, color:"#444",
          fontFamily:"'JetBrains Mono',monospace" }}>{minToTime(m)}</span>
      ))}
    </div>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function ORchestratorDashboard() {
  const [gamma, setGamma]           = useState(0.5);
  const [schedule, setSchedule]     = useState([]);
  const [rejected, setRejected]     = useState([]);
  const [summary, setSummary]       = useState(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState(null);
  const [selectedId, setSelectedId] = useState(null);

  const GANTT_W = 560;

  const fetchSchedule = useCallback(async (g) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(MCP_URL, {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          patients: FHIR_PATIENTS,
          gamma: g,
          or_capacity_minutes: 480,
          start_time: "07:30",
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const withNames = data.schedule.map(op => ({
        ...op,
        name: FHIR_PATIENTS.find(p => p.patient_id === op.patient_id)?.name ?? op.patient_id,
      }));
      setSchedule(withNames);
      setRejected(data.rejected ?? []);
      setSummary(data.summary);
    } catch(e) {
      setError(`Błąd połączenia z MCP: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSchedule(gamma); }, []);

  const lastEndM  = schedule.length ? timeToMin(schedule.at(-1).end) : OR_END;
  const overtime  = lastEndM > OR_END;
  const totalBuf  = schedule.reduce((a,o) => a + (o.buffer_minutes ?? 0), 0).toFixed(1);
  const selected  = schedule.find(o => o.patient_id === selectedId);

  return (
    <div style={{ minHeight:"100vh", background:"#0a0a0f", color:"#ddd",
      fontFamily:"'Syne',sans-serif", padding:"28px 24px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:4px;height:4px}
        ::-webkit-scrollbar-thumb{background:#2a2a38;border-radius:3px}
        @keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
        .fade-in{animation:fadeIn 0.3s ease forwards}
        .row-hover:hover{background:#16161f!important;cursor:pointer}
      `}</style>

      {/* Header */}
      <div style={{ marginBottom:20 }}>
        <div style={{ fontSize:10, letterSpacing:"0.22em", color:"#333",
          textTransform:"uppercase", fontFamily:"'JetBrains Mono',monospace", marginBottom:6 }}>
          ORchestrator · MIT Robust Scheduling · FHIR R4 · MCP live
        </div>
        <div style={{ display:"flex", alignItems:"baseline", gap:16, flexWrap:"wrap" }}>
          <h1 style={{ margin:0, fontSize:22, fontWeight:700, color:"#f0ede8",
            letterSpacing:"-0.03em" }}>OR Dashboard</h1>
          <span style={{ fontSize:11, color:"#444", fontFamily:"'JetBrains Mono',monospace" }}>
            {FHIR_PATIENTS.length} pacjentów FHIR · agent: 92.5.14.76:8001
          </span>
          {loading && <span style={{ fontSize:10, color:"#00d4ff",
            fontFamily:"'JetBrains Mono',monospace" }}>⟳ ładowanie...</span>}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ background:"#ff224418", border:"1px solid #ff224466",
          borderRadius:8, padding:"10px 16px", marginBottom:14,
          fontSize:11, color:"#ff6b6b", fontFamily:"'JetBrains Mono',monospace" }}>
          ⚠ {error}
          <button onClick={() => fetchSchedule(gamma)} style={{ marginLeft:12,
            background:"transparent", border:"1px solid #ff6b6b", color:"#ff6b6b",
            borderRadius:4, padding:"2px 10px", cursor:"pointer", fontSize:10 }}>Retry</button>
        </div>
      )}

      {/* KPI */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:10, marginBottom:18 }}>
        <KPICard value={summary ? `${summary.utilization_percent}%` : "—"}
          label="Wykorzystanie" color="#6bcb77" sub="480 min capacity" />
        <KPICard value={schedule.length ? schedule.at(-1).end : "—"}
          label="Koniec dnia" color={overtime ? "#ff6b6b" : "#6bcb77"}
          sub={overtime ? "⚠ nadgodziny" : "✓ na czas"} />
        <KPICard value={`${schedule.length}/${FHIR_PATIENTS.length}`}
          label="OTCR" color="#e0c039" sub="op. zaplanowanych" />
        <KPICard value={`+${totalBuf}'`} label="Bufor Γ łącznie"
          color="#00d4ff" sub={`Γ = ${gamma.toFixed(1)}`} />
        <KPICard value={`${rejected.length}`} label="Odrzucone"
          color={rejected.length > 0 ? "#ff9f43" : "#6bcb77"} sub="capacity exceeded" />
      </div>

      {/* Γ Slider */}
      <div style={{ background:"#111118", border:"1px solid #00d4ff33",
        borderRadius:10, padding:"16px 20px", marginBottom:14,
        display:"flex", alignItems:"center", gap:20, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontSize:10, color:"#00d4ff", letterSpacing:"0.12em",
            textTransform:"uppercase", fontFamily:"'JetBrains Mono',monospace", marginBottom:2 }}>
            MIT Robust Scheduling · Denton et al.
          </div>
          <div style={{ fontSize:10, color:"#444", fontFamily:"'JetBrains Mono',monospace" }}>
            buffer = Γ × σ × √P50 · per patient risk
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:12, flex:1, minWidth:200 }}>
          <span style={{ fontSize:11, color:"#555" }}>Γ =</span>
          <input type="range" min={0} max={3} step={0.1} value={gamma}
            onChange={e => setGamma(parseFloat(e.target.value))}
            style={{ flex:1, accentColor:"#00d4ff", cursor:"pointer", height:4 }} />
          <span style={{ fontSize:22, fontWeight:700, color:"#00d4ff",
            fontFamily:"'JetBrains Mono',monospace", minWidth:40 }}>{gamma.toFixed(1)}</span>
        </div>
        <button onClick={() => fetchSchedule(gamma)} disabled={loading} style={{
          padding:"8px 20px",
          background: loading ? "#1a1a24" : "linear-gradient(135deg,#00d4ff,#0099cc)",
          color: loading ? "#555" : "#000", border:"none", borderRadius:8,
          fontSize:12, fontWeight:700, cursor: loading ? "not-allowed" : "pointer",
          fontFamily:"'Syne',sans-serif" }}>
          {loading ? "⟳ liczę..." : "▶ Przelicz"}
        </button>
        {schedule.length > 0 && (
          <div style={{ display:"flex", gap:3, alignItems:"flex-end" }}>
            {schedule.map(op => {
              const color = PROC_COLORS[op.procedure] ?? "#888";
              const maxBuf = Math.max(...schedule.map(o => o.buffer_minutes ?? 0), 1);
              const h = Math.max(4, ((op.buffer_minutes ?? 0) / maxBuf) * 36);
              return (
                <div key={op.patient_id} title={`${op.patient_id} +${op.buffer_minutes}'`}
                  style={{ width:13, height:h, background:"#00d4ff44",
                    border:"1px solid #00d4ff88", borderRadius:2, position:"relative" }}>
                  <div style={{ position:"absolute", bottom:0, width:"100%",
                    height:`${(op.duration_p50/op.scheduled_minutes)*100}%`,
                    background:`${color}55`, borderRadius:2 }} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Gantt + Lista */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 280px", gap:12 }}>
        <div style={{ background:"#111118", border:"1px solid #1e1e2a",
          borderRadius:10, padding:"18px 20px" }}>
          <div style={{ fontSize:10, letterSpacing:"0.1em", color:"#444",
            textTransform:"uppercase", fontFamily:"'JetBrains Mono',monospace", marginBottom:12 }}>
            Harmonogram · Gantt · Γ={gamma.toFixed(1)} · MCP live
          </div>
          {schedule.length === 0 && !loading ? (
            <div style={{ color:"#333", fontFamily:"'JetBrains Mono',monospace",
              fontSize:11, padding:"20px 0" }}>
              {error ? "Brak danych — sprawdź połączenie z MCP" : "Kliknij ▶ Przelicz"}
            </div>
          ) : (
            <div style={{ overflowX:"auto" }}>
              <div style={{ minWidth:700 }}>
                <div style={{ display:"grid", gridTemplateColumns:"130px 1fr" }}>
                  <div /><TimeAxis width={GANTT_W} />
                </div>
                <div style={{ position:"relative" }}>
                  <div style={{ position:"absolute", left:130+px(OR_END,GANTT_W),
                    top:0, bottom:0, width:1, background:"#ff224433", zIndex:1 }} />
                  {schedule.map(op => {
                    const isSelected = op.patient_id === selectedId;
                    return (
                      <div key={op.patient_id} className="row-hover"
                        onClick={() => setSelectedId(isSelected ? null : op.patient_id)}
                        style={{ display:"grid", gridTemplateColumns:"130px 1fr",
                          alignItems:"center", borderRadius:6, padding:"0 4px",
                          background: isSelected ? "#1a1a2a" : "transparent",
                          transition:"background 0.15s" }}>
                        <div style={{ paddingRight:8, paddingLeft:2 }}>
                          <div style={{ fontSize:11, fontWeight:600,
                            color: isSelected ? "#f0ede8" : "#777" }}>{op.name}</div>
                          <div style={{ fontSize:9, fontFamily:"'JetBrains Mono',monospace",
                            color: PROC_COLORS[op.procedure] ?? "#555" }}>
                            {op.patient_id} · {op.risk}
                          </div>
                        </div>
                        <GanttBar op={op} width={GANTT_W} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <div style={{ display:"flex", gap:14, marginTop:10, flexWrap:"wrap" }}>
            {[["#00d4ff","Γ buffer"],["#ff2244","HIGH risk"],["#ff9f43","MED risk"],["#6bcb77","LOW risk"]].map(([c,l]) => (
              <div key={l} style={{ display:"flex", alignItems:"center", gap:5 }}>
                <div style={{ width:10, height:10, background:`${c}44`,
                  border:`1px solid ${c}`, borderRadius:2 }} />
                <span style={{ fontSize:9, color:"#555",
                  fontFamily:"'JetBrains Mono',monospace" }}>{l}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Patient list */}
        <div style={{ background:"#111118", border:"1px solid #1e1e2a",
          borderRadius:10, padding:"18px 16px", overflowY:"auto", maxHeight:560 }}>
          <div style={{ fontSize:10, letterSpacing:"0.1em", color:"#444",
            textTransform:"uppercase", fontFamily:"'JetBrains Mono',monospace", marginBottom:12 }}>
            Pacjenci · FHIR R4
          </div>
          {schedule.map(op => {
            const isSelected = op.patient_id === selectedId;
            const color = PROC_COLORS[op.procedure] ?? "#888";
            const riskC = RISK_COLOR(op.risk);
            return (
              <div key={op.patient_id} className="row-hover"
                onClick={() => setSelectedId(isSelected ? null : op.patient_id)}
                style={{ padding:"10px", borderRadius:7, marginBottom:5,
                  border:`1px solid ${isSelected ? color+"66" : "#1e1e2a"}`,
                  background: isSelected ? `${color}0d` : "transparent",
                  transition:"all 0.15s" }}>
                <div style={{ display:"flex", justifyContent:"space-between",
                  alignItems:"flex-start", marginBottom:4 }}>
                  <div>
                    <div style={{ fontSize:12, fontWeight:600,
                      color: isSelected ? "#f0ede8" : "#aaa" }}>{op.name}</div>
                    <div style={{ fontSize:9, color:"#555",
                      fontFamily:"'JetBrains Mono',monospace" }}>{op.patient_id}</div>
                  </div>
                  <div style={{ fontSize:9, fontWeight:700, color:riskC,
                    background:`${riskC}18`, border:`1px solid ${riskC}44`,
                    borderRadius:4, padding:"2px 6px",
                    fontFamily:"'JetBrains Mono',monospace" }}>
                    {RISK_LABEL(op.risk)}
                  </div>
                </div>
                <div style={{ fontSize:10, color, fontFamily:"'JetBrains Mono',monospace",
                  marginBottom:3 }}>{op.procedure}</div>
                <div style={{ display:"flex", gap:8, fontSize:9,
                  fontFamily:"'JetBrains Mono',monospace", color:"#555" }}>
                  <span>{op.start}–{op.end}</span>
                  <span style={{ color:"#00d4ff" }}>+{op.buffer_minutes}'</span>
                </div>
              </div>
            );
          })}
          {rejected.length > 0 && (
            <div style={{ marginTop:8, borderTop:"1px solid #1e1e2a", paddingTop:8 }}>
              <div style={{ fontSize:9, color:"#ff9f43", letterSpacing:"0.1em",
                textTransform:"uppercase", fontFamily:"'JetBrains Mono',monospace", marginBottom:6 }}>
                Odrzucone ({rejected.length})
              </div>
              {rejected.map(op => (
                <div key={op.patient_id} style={{ fontSize:10, color:"#444",
                  fontFamily:"'JetBrains Mono',monospace", marginBottom:3 }}>
                  {op.patient_id} — {op.reason}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selected && (
        <div className="fade-in" style={{ marginTop:12, background:"#111118",
          border:`1px solid ${PROC_COLORS[selected.procedure]??"#444"}55`,
          borderLeft:`3px solid ${PROC_COLORS[selected.procedure]??"#e07b39"}`,
          borderRadius:10, padding:"16px 20px",
          display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:14 }}>
          {[
            { label:"Pacjent",    value:selected.name },
            { label:"Procedura",  value:selected.procedure, color:PROC_COLORS[selected.procedure] },
            { label:"Start–Koniec", value:`${selected.start}–${selected.end}`, mono:true },
            { label:"Γ buffer",   value:`+${selected.buffer_minutes}'`, mono:true, color:"#00d4ff" },
            { label:"Overrun",    value:selected.overrun_probability, mono:true,
              color: selected.overrun_probability==="15%"?"#ff9f43":"#6bcb77" },
          ].map(f => (
            <div key={f.label}>
              <div style={{ fontSize:9, color:"#444", textTransform:"uppercase",
                letterSpacing:"0.1em", marginBottom:3,
                fontFamily:"'JetBrains Mono',monospace" }}>{f.label}</div>
              <div style={{ fontSize: f.mono?14:13, fontWeight:600,
                color: f.color??"#ccc",
                fontFamily: f.mono?"'JetBrains Mono',monospace":"'Syne',sans-serif" }}>
                {f.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer */}
      <div style={{ marginTop:24, paddingTop:12, borderTop:"1px solid #1e1e2a",
        display:"flex", justifyContent:"space-between", alignItems:"center",
        fontSize:10, color:"#333", fontFamily:"'JetBrains Mono',monospace" }}>
        <span>© 2025 <span style={{ color:"#e07b39" }}>Stanisław Szulc</span> · ORchestrator · Agents Assemble Hackathon</span>
        <span>MCP: 92.5.14.76:8001 · FHIR R4 · MIT Robust Scheduling</span>
      </div>
    </div>
  );
}
