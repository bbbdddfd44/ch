import { useCallback, useState, useMemo, useEffect } from "react";
import { MapPin, CalendarDays, RefreshCw, Search, Building2, Users, Armchair, CircleCheck, CircleX, Zap, Filter, ChevronLeft, ChevronRight, Clock, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import "@/styles/takamol.css";

const DIVISIONS = ["Dhaka", "Chattogram", "Rajshahi", "Khulna", "Barishal", "Rangpur", "Mymensingh", "Sylhet"];

/* ═══ Calendar Component ═══ */
function MiniCalendar({ year, month, availableDates, onDateClick, selectedDate }: {
  year: number; month: number; availableDates: string[]; onDateClick: (d: string) => void; selectedDate: string;
}) {
  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dayNames = ["Su","Mo","Tu","We","Th","Fr","Sa"];
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  return (
    <div style={{ border: "1px solid var(--tk-glass-border)", borderRadius: 10, overflow: "hidden", background: "rgba(0,0,0,0.15)" }}>
      <div style={{ padding: "10px 14px", background: "rgba(255,255,255,0.03)", borderBottom: "1px solid var(--tk-glass-border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>{monthNames[month]} {year}</span>
        <span style={{ fontSize: 11, color: "var(--tk-muted)" }}>{availableDates.length} dates</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, padding: 8 }}>
        {dayNames.map(d => (
          <div key={d} style={{ textAlign: "center", fontSize: 10, color: "var(--tk-muted)", padding: "4px 0", fontWeight: 600 }}>{d}</div>
        ))}
        {cells.map((day, i) => {
          if (day === null) return <div key={`e${i}`} />;
          const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const isAvailable = availableDates.includes(dateStr);
          const isToday = dateStr === todayStr;
          const isSelected = dateStr === selectedDate;
          const isPast = new Date(dateStr) < new Date(todayStr);
          return (
            <div
              key={`d${i}`}
              onClick={() => isAvailable && onDateClick(dateStr)}
              style={{
                textAlign: "center", padding: "6px 2px", borderRadius: 6, fontSize: 12, fontWeight: isAvailable ? 700 : 400,
                cursor: isAvailable ? "pointer" : "default",
                background: isSelected ? "var(--tk-gold)" : isAvailable ? "rgba(45,212,191,0.12)" : "transparent",
                color: isSelected ? "#0b1230" : isAvailable ? "var(--tk-teal)" : isPast ? "rgba(255,255,255,0.15)" : "var(--tk-text)",
                border: isToday ? "1px solid var(--tk-gold)" : "1px solid transparent",
                transition: "all 0.15s",
              }}
              title={isAvailable ? `${dateStr} — available` : dateStr}
            >
              {day}
              {isAvailable && <div style={{ width: 4, height: 4, borderRadius: "50%", background: isSelected ? "#0b1230" : "var(--tk-teal)", margin: "2px auto 0" }} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═══ Occupations Full List ═══ */
function OccupationsFullList({ data }: { data: any }) {
  const [search, setSearch] = useState("");
  const occupations = useMemo(() => {
    const raw = data?.occupations || (Array.isArray(data) ? data : []);
    if (!search.trim()) return raw;
    const q = search.toLowerCase();
    return raw.filter((o: any) =>
      String(o.english_name || o.name || "").toLowerCase().includes(q) ||
      String(o.category_name || "").toLowerCase().includes(q) ||
      String(o.occupation_key || "").includes(q)
    );
  }, [data, search]);

  const totalCount = data?.occupations?.length || data?.count || (Array.isArray(data) ? data.length : 0);
  const grouped = useMemo(() => {
    const map = new Map<string, any[]>();
    occupations.forEach((o: any) => {
      const cat = o.category_name || "Uncategorized";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(o);
    });
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [occupations]);

  return (
    <section className="tk-card tk-booking-card" style={{ border: "1px solid var(--tk-glass-border)" }}>
      <div className="tk-step-heading" style={{ marginBottom: 12 }}>
        <span>02</span>
        <div><p className="tk-eyebrow">RESULT</p><strong>{occupations.length} / {totalCount} Occupations by Category</strong></div>
      </div>

      <div className="tk-field" style={{ marginBottom: 16 }}>
        <label><Filter size={13} /> Search</label>
        <input type="text" placeholder="Search name, category, or code..." value={search} onChange={e => setSearch(e.target.value)} style={{ width: "100%" }} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))", gap: 12 }}>
        {grouped.map(([cat, items]) => (
          <div key={cat} style={{ border: "1px solid var(--tk-glass-border)", borderRadius: 10, overflow: "hidden" }}>
            <div style={{
              padding: "10px 14px", background: "linear-gradient(135deg, rgba(240,200,105,0.08), rgba(45,212,191,0.06))",
              borderBottom: "1px solid var(--tk-glass-border)", display: "flex", justifyContent: "space-between", alignItems: "center",
            }}>
              <span style={{ fontWeight: 700, fontSize: 12 }}>{cat}</span>
              <span style={{ fontSize: 11, color: "var(--tk-gold)", fontWeight: 700, background: "rgba(240,200,105,0.12)", padding: "2px 8px", borderRadius: 10 }}>{items.length}</span>
            </div>
            <div style={{ padding: "2px 0" }}>
              {items.map((o: any, i: number) => (
                <div key={o.id || i} style={{
                  padding: "6px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12,
                  borderBottom: i < items.length - 1 ? "1px solid rgba(255,255,255,0.03)" : "none",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--tk-teal)", flexShrink: 0 }} />
                    <span>{o.english_name || o.name}</span>
                  </div>
                  <span style={{ fontFamily: "monospace", fontSize: 10, color: "var(--tk-muted)" }}>{o.occupation_key || o.id}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ═══ Main Page ═══ */
export default function T2HubLivePage() {
  const [division, setDivision] = useState("Rajshahi");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [examDate, setExamDate] = useState("2026-09-12");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [rawJson, setRawJson] = useState<string | null>(null);
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calYear, setCalYear] = useState(new Date().getFullYear());
  const [allOccupations, setAllOccupations] = useState<any[]>([]);
  const [loadingOccupations, setLoadingOccupations] = useState(true);

  useEffect(() => {
    api("/booking-data/occupations?per_page=1000").then((data) => {
      const occs = data?.occupations || (Array.isArray(data) ? data : []);
      setAllOccupations(occs);
      if (occs.length > 0 && categoryId === "") setCategoryId(occs[0].id || "");
    }).catch(() => {}).finally(() => setLoadingOccupations(false));
  }, []);

  useEffect(() => {
    if (!categoryId) return;
    setLoading(true); setError(null);
    api(`/booking-data/exam-available-dates?category_id=${categoryId}&city=${encodeURIComponent(division)}`)
      .then((data) => { setResult({ type: "available-dates", data }); setRawJson(JSON.stringify(data, null, 2)); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [division, categoryId]);

  const categories = useMemo(() => {
    const map = new Map<number, { id: number; name: string; count: number }>();
    allOccupations.forEach((o) => {
      const catId = o.id ?? o.category_id;
      const catName = o.category_name || `Category ${catId}`;
      if (!catId) return;
      if (map.has(catId)) { map.get(catId)!.count++; } else { map.set(catId, { id: catId, name: catName, count: 1 }); }
    });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [allOccupations]);

  const fetchTestCenters = useCallback(async () => {
    setLoading(true); setError(null); setResult(null); setRawJson(null);
    try {
      const data = await api(`/booking-data/test-centers?city=${encodeURIComponent(division)}`);
      setResult({ type: "test-centers", data });
      setRawJson(JSON.stringify(data, null, 2));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [division]);

  const fetchPaccSessions = useCallback(async () => {
    setLoading(true); setError(null); setResult(null); setRawJson(null);
    try {
      const data = await api(`/booking-data/pacc-exam-sessions?category_id=${categoryId}&city=${encodeURIComponent(division)}&exam_date=${examDate}`);
      setResult({ type: "pacc-sessions", data });
      setRawJson(JSON.stringify(data, null, 2));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [division, categoryId, examDate]);

  const fetchPaccSessionsForDate = useCallback(async (date: string) => {
    setLoading(true); setError(null); setResult(null); setRawJson(null);
    try {
      const data = await api(`/booking-data/pacc-exam-sessions?category_id=${categoryId}&city=${encodeURIComponent(division)}&exam_date=${date}`);
      setResult({ type: "pacc-sessions", data });
      setRawJson(JSON.stringify(data, null, 2));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [division, categoryId]);

  const fetchAvailableDates = useCallback(async () => {
    setLoading(true); setError(null); setResult(null); setRawJson(null);
    try {
      const data = await api(`/booking-data/exam-available-dates?category_id=${categoryId}&city=${encodeURIComponent(division)}`);
      setResult({ type: "available-dates", data });
      setRawJson(JSON.stringify(data, null, 2));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [division, categoryId]);

  const fetchOccupations = useCallback(async () => {
    setLoading(true); setError(null); setResult(null); setRawJson(null);
    try {
      const data = await api(`/booking-data/occupations?per_page=1000`);
      setResult({ type: "occupations", data });
      setRawJson(JSON.stringify(data, null, 2));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const fetchSessionStatus = useCallback(async () => {
    setLoading(true); setError(null); setResult(null); setRawJson(null);
    try {
      const data = await api(`/booking-data/session-status`);
      setResult({ type: "session-status", data });
      setRawJson(JSON.stringify(data, null, 2));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const sessions = result?.type === "pacc-sessions" ? result.data?.sessions || [] : [];
  const sites = result?.type === "pacc-sessions" ? result.data?.sites || [] : [];
  const totalSeats = sessions.reduce((sum: number, s: any) => sum + (s.available_seats || 0), 0);
  const uniqueCenters = [...new Set(sessions.map((s: any) => s.center_name || s.test_center_name))];

  const availableDates = useMemo(() => {
    if (result?.type !== "available-dates") return [];
    const raw = result.data;
    const list = raw?.available_dates || raw?.dates || raw?.data || (Array.isArray(raw) ? raw : []);
    const set = new Set<string>();
    list.forEach((d: any) => {
      const date = typeof d === "string" ? d : d?.start_date_in_browser_time_zone || d?.date || d?.exam_date || "";
      if (date) set.add(date);
    });
    return [...set].sort();
  }, [result]);

  return (
    <div className="tk-shell" style={{ padding: 0 }}>
      <header className="tk-topbar">
        <div className="tk-brand">
          <span className="tk-logo" style={{
            background: "linear-gradient(135deg, #f0c869, #d4a437)",
            color: "#0b1230", fontSize: 16, fontWeight: 900, letterSpacing: "-0.02em",
          }}>FD</span>
          <div>
            <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: "0.04em" }}>FLYDURONTO.COM</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="tk-badge tk-badge--ok" style={{ fontSize: 11 }}><span className="tk-dot tk-dot--ok" />No auth</span>
          <a href="/takamol/booking" style={{ fontSize: 12, color: "var(--tk-gold)", textDecoration: "none" }}>Booking →</a>
        </div>
      </header>

      <main className="tk-container">
        {error && <div className="tk-msg tk-msg--error" style={{ borderRadius: 10 }}>{error}</div>}

        {/* ── Controls ── */}
        <section className="tk-card tk-booking-card" style={{ border: "1px solid var(--tk-glass-border)" }}>
          <div className="tk-step-heading" style={{ marginBottom: 16 }}><span>01</span><div><p className="tk-eyebrow">QUERY</p><strong>Exam Data</strong></div></div>
          <div className="tk-grid tk-grid-3">
            <div className="tk-field"><label><MapPin size={13} /> Division</label>
              <select value={division} onChange={e => setDivision(e.target.value)}>{DIVISIONS.map(d => <option key={d} value={d}>{d}</option>)}</select>
            </div>
            <div className="tk-field"><label><Building2 size={13} /> Category</label>
              <select value={categoryId} onChange={e => setCategoryId(Number(e.target.value))} disabled={loadingOccupations}>
                {loadingOccupations ? <option value="">Loading categories...</option> :
                 categories.map(c => <option key={c.id} value={c.id}>{c.name} ({c.count})</option>)}
              </select>
            </div>
            <div className="tk-field"><label><CalendarDays size={13} /> Exam Date</label>
              <input type="date" value={examDate} onChange={e => setExamDate(e.target.value)} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
            <button className="tk-btn tk-btn--gold" onClick={fetchPaccSessions} disabled={loading}><Zap size={14} /> Find Sessions</button>
            <button className="tk-btn" onClick={fetchTestCenters} disabled={loading}><MapPin size={14} /> All Centers</button>
            <button className="tk-btn" onClick={fetchOccupations} disabled={loading}><Search size={14} /> Occupations</button>
          </div>
        </section>

        {loading && (
          <div className="tk-card tk-booking-card" style={{ textAlign: "center", padding: 48 }}>
            <span className="tk-spinner" style={{ width: 28, height: 28 }} />
          </div>
        )}

        {/* ── Sessions Summary + Calendar ── */}
        {result?.type === "pacc-sessions" && !loading && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
              {[
                { label: "Centers", value: uniqueCenters.length, icon: Building2, color: "var(--tk-info)" },
                { label: "Sessions", value: sessions.length, icon: Users, color: "var(--tk-gold)" },
                { label: "Total Seats", value: totalSeats, icon: Armchair, color: totalSeats > 0 ? "var(--tk-success)" : "var(--tk-danger)" },
                { label: "Available", value: sessions.filter((s: any) => (s.available_seats || 0) > 0).length, icon: CircleCheck, color: "var(--tk-teal)" },
              ].map((stat) => (
                <div key={stat.label} className="tk-card" style={{ padding: "16px 18px", border: "1px solid var(--tk-glass-border)", display: "flex", alignItems: "center", gap: 14 }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: `${stat.color}15`, display: "grid", placeItems: "center" }}><stat.icon size={18} style={{ color: stat.color }} /></div>
                  <div><p style={{ fontSize: 22, fontWeight: 800, color: stat.color, lineHeight: 1 }}>{stat.value}</p><p style={{ fontSize: 11, color: "var(--tk-muted)", marginTop: 2 }}>{stat.label}</p></div>
                </div>
              ))}
            </div>

            {uniqueCenters.map((centerName) => {
              const centerSessions = sessions.filter((s: any) => (s.center_name || s.test_center_name) === centerName);
              const centerSeats = centerSessions.reduce((sum: number, s: any) => sum + (s.available_seats || 0), 0);
              const centerCity = centerSessions[0]?.center_city || centerSessions[0]?.site_city || "";
              return (
                <section key={String(centerName)} className="tk-card tk-booking-card" style={{ border: "1px solid var(--tk-glass-border)", overflow: "hidden" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", background: "rgba(255,255,255,0.02)", borderBottom: "1px solid var(--tk-glass-border)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 36, height: 36, borderRadius: 8, background: "linear-gradient(135deg, var(--tk-gold), var(--tk-gold-deep))", display: "grid", placeItems: "center", color: "#0b1230", fontWeight: 900, fontSize: 14 }}>{String(centerName).charAt(0)}</div>
                      <div><p style={{ fontWeight: 700, fontSize: 14 }}>{centerName}</p><p style={{ fontSize: 11, color: "var(--tk-muted)" }}>{centerCity} · {division}</p></div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div style={{ background: `${seatColor(centerSeats)}22`, color: seatColor(centerSeats), border: `1px solid ${seatColor(centerSeats)}44`, borderRadius: 20, padding: "4px 14px", fontWeight: 800, fontSize: 14 }}>{centerSeats} seats</div>
                      <span style={{ fontSize: 11, color: "var(--tk-muted)" }}>{centerSessions.length} session(s)</span>
                    </div>
                  </div>
                  <div>
                    {centerSessions.map((s: any, idx: number) => {
                      const seats = s.available_seats || 0;
                      return (
                        <div key={s.id || idx} style={{ display: "grid", gridTemplateColumns: "1fr 120px 100px 120px 180px", alignItems: "center", padding: "10px 18px", borderBottom: idx < centerSessions.length - 1 ? "1px solid var(--tk-glass-border)" : "none", fontSize: 13 }}>
                          <div><span style={{ color: "var(--tk-muted)" }}>Exam:</span> <strong>{s.start_at_in_tc_time_zone || s.exam_date || "—"}</strong></div>
                          <div><span style={{ color: "var(--tk-muted)" }}>Status:</span> <span style={{ color: s.status === "scheduled" ? "var(--tk-success)" : "var(--tk-muted)", fontWeight: 600 }}>{s.status}</span></div>
                          <div style={{ display: "inline-flex", alignItems: "center", gap: 5, background: `${seatColor(seats)}22`, color: seatColor(seats), border: `1px solid ${seatColor(seats)}44`, borderRadius: 6, padding: "3px 10px", fontWeight: 800, fontSize: 13, width: "fit-content" }}>
                            {seats > 0 ? <CircleCheck size={13} /> : <CircleX size={13} />} {seats} seats
                          </div>
                          <div><span style={{ color: "var(--tk-muted)" }}>Category:</span> <span style={{ fontSize: 11 }}>{s.category?.english_name || "—"}</span></div>
                          <div style={{ fontFamily: "monospace", fontSize: 10, color: "var(--tk-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.session_id || s.id}>{String(s.session_id || s.id).substring(0, 30)}...</div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </>
        )}

        {/* ── Available Dates Calendar ── */}
        {result?.type === "available-dates" && !loading && (
          <section className="tk-card tk-booking-card" style={{ border: "1px solid var(--tk-glass-border)" }}>
            <div className="tk-step-heading" style={{ marginBottom: 12 }}><span>02</span><div><p className="tk-eyebrow">CALENDAR</p><strong>Available Exam Dates — {division}</strong></div></div>

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <button className="tk-btn" style={{ padding: "6px 10px" }} onClick={() => { setCalMonth(m => m === 0 ? 11 : m - 1); if (calMonth === 0) setCalYear(y => y - 1); }}><ChevronLeft size={16} /></button>
              <span style={{ fontWeight: 700, fontSize: 14, minWidth: 160, textAlign: "center" }}>{["January","February","March","April","May","June","July","August","September","October","November","December"][calMonth]} {calYear}</span>
              <button className="tk-btn" style={{ padding: "6px 10px" }} onClick={() => { setCalMonth(m => m === 11 ? 0 : m + 1); if (calMonth === 11) setCalYear(y => y + 1); }}><ChevronRight size={16} /></button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <MiniCalendar year={calYear} month={calMonth} availableDates={availableDates} onDateClick={(d) => { setExamDate(d); setCalMonth(new Date(d).getMonth()); setCalYear(new Date(d).getFullYear()); fetchPaccSessionsForDate(d); }} selectedDate={examDate} />
              <div>
                <p style={{ fontSize: 12, color: "var(--tk-muted)", marginBottom: 8 }}><Clock size={13} style={{ verticalAlign: -2 }} /> Available dates ({availableDates.length})</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 280, overflow: "auto" }}>
                  {availableDates.sort().map((d) => (
                    <div key={d} onClick={() => setExamDate(d)} style={{
                      padding: "6px 12px", borderRadius: 8, fontSize: 12, cursor: "pointer", fontWeight: 600,
                      background: d === examDate ? "var(--tk-gold)" : "rgba(45,212,191,0.1)",
                      color: d === examDate ? "#0b1230" : "var(--tk-teal)",
                      border: `1px solid ${d === examDate ? "var(--tk-gold)" : "rgba(45,212,191,0.3)"}`,
                    }}>{d}</div>
                  ))}
                </div>
                {availableDates.length > 0 && (
                  <div style={{ marginTop: 16 }}>
                    <p style={{ fontSize: 12, color: "var(--tk-muted)", marginBottom: 8 }}>Selected: <strong style={{ color: "var(--tk-gold)" }}>{examDate || "none"}</strong></p>
                    <p style={{ fontSize: 11, color: "var(--tk-teal)" }}>Click any available date to load sessions</p>
                  </div>
                )}
              </div>
            </div>
          </section>
        )}

        {/* ── Test Centers ── */}
        {result?.type === "test-centers" && !loading && result.data?.sites && (
          <section className="tk-card tk-booking-card" style={{ border: "1px solid var(--tk-glass-border)" }}>
            <div className="tk-step-heading" style={{ marginBottom: 12 }}><span>02</span><div><p className="tk-eyebrow">RESULT</p><strong>{result.data.sites.length} Test Centers in {division}</strong></div></div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 10 }}>
              {result.data.sites.map((s: any) => (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", border: "1px solid var(--tk-glass-border)", borderRadius: 10, background: "rgba(255,255,255,0.02)" }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: "var(--tk-glass-border)", display: "grid", placeItems: "center", fontFamily: "monospace", fontWeight: 800, fontSize: 13, color: "var(--tk-gold)" }}>{s.id}</div>
                  <div style={{ flex: 1, minWidth: 0 }}><p style={{ fontWeight: 600, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.name}</p><p style={{ fontSize: 11, color: "var(--tk-muted)" }}>{s.city} · {s.division}</p></div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Session Status ── */}
        {result?.type === "session-status" && !loading && (
          <section className="tk-card tk-booking-card" style={{ border: "1px solid var(--tk-glass-border)" }}>
            <div className="tk-step-heading" style={{ marginBottom: 12 }}><span>02</span><div><p className="tk-eyebrow">HEALTH</p><strong>Session Status</strong></div></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {[
                { label: "Encryption Key", ok: result.data?.env?.hasKey, detail: result.data?.env?.hasKey ? `${result.data.env.keyLen} chars` : "missing" },
                { label: "Session Cookie", ok: result.data?.env?.hasCookie, detail: result.data?.env?.hasCookie ? `${result.data.env.cookieLen} chars` : "missing" },
                { label: "Overall Status", ok: result.data?.status === "ok", detail: result.data?.status },
              ].map((item) => (
                <div key={item.label} style={{ padding: "14px 16px", border: `1px solid ${item.ok ? "var(--tk-success)" : "var(--tk-danger)"}33`, borderRadius: 10, background: `${item.ok ? "var(--tk-success)" : "var(--tk-danger)"}08` }}>
                  <p style={{ fontSize: 11, color: "var(--tk-muted)", marginBottom: 4 }}>{item.label}</p>
                  <p style={{ fontWeight: 700, color: item.ok ? "var(--tk-success)" : "var(--tk-danger)", fontSize: 15 }}>{item.ok ? "✓" : "✗"} {item.detail}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* ── Occupations ── */}
        {result?.type === "occupations" && !loading && <OccupationsFullList data={result.data} />}
      </main>
    </div>
  );
}

function seatColor(n: number) {
  if (n >= 20) return "var(--tk-success)";
  if (n >= 10) return "var(--tk-gold)";
  if (n > 0) return "#f97316";
  return "var(--tk-danger)";
}
