"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase";

type ChatMessage = { role: "assistant" | "user"; content: string; sources?: { title: string; page: number | null }[] };
type Notice = { id: string; title: string; summary: string | null; deadline: string | null; status: string; created_at: string };
type PendingNotice = Pick<Notice, "id" | "title" | "summary" | "status" | "created_at"> & { candidate_deadline: string | null; candidate_evidence: string | null; file_url: string | null };
type ClassRow = { course_name: string; course_code: string; starts_at: string; ends_at: string; room: string | null; faculty: string | null };
type Profile = { display_name: string | null; role: string; branch: string | null; year: number | null; semester: number | null; section: string | null };

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const suggestions = ["What classes do I have today?", "When is the next DBMS class?", "Show the latest notices"];
const weekday = new Intl.DateTimeFormat("en-IN", { weekday: "long" }).format(new Date());

export function Dashboard() {
  const [section, setSection] = useState("Overview");
  const [messages, setMessages] = useState<ChatMessage[]>([{ role: "assistant", content: "Hi! I’m your campus assistant. Ask me about college information, notices, your timetable, or attendance. I’ll show where my answers come from." }]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notices, setNotices] = useState<Notice[]>([]);
  const [pendingNotices, setPendingNotices] = useState<PendingNotice[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [configured, setConfigured] = useState(true);
  const [userEmail, setUserEmail] = useState("");
  const [modal, setModal] = useState<"login" | "attendance" | "upload" | "profile" | null>(null);
  const [profileForm, setProfileForm] = useState({ display_name: "", branch: "", year: "", semester: "", section: "" });
  const [attendance, setAttendance] = useState({ attended: "", total: "", target: "75" });
  const [attendanceResult, setAttendanceResult] = useState("");
  const [attendanceCurrent, setAttendanceCurrent] = useState("—");
  const [uploadFile, setUploadFile] = useState<File | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const client = createClient();
        const { data: auth } = await client.auth.getUser();
        const { data: sessionData } = await client.auth.getSession();
        if (auth.user && alive) setUserEmail(auth.user.email ?? "");
        const { data: prof } = await client.from("profiles").select("display_name,role,branch,year,semester,section").maybeSingle();
        if (alive && prof) setProfile(prof as Profile);
        const { data: noticeData, error: noticeError } = await client.from("notices").select("id,title,summary,deadline,status,created_at").eq("status", "published").order("created_at", { ascending: false }).limit(50);
        if (alive && !noticeError && noticeData) setNotices(noticeData as Notice[]);
        let scheduleQuery = client.from("timetable").select("course_name,course_code,starts_at,ends_at,room,faculty").eq("weekday", weekday).eq("is_active", true).order("starts_at").limit(4);
        if (prof?.branch) scheduleQuery = scheduleQuery.eq("branch", prof.branch);
        if (prof?.year) scheduleQuery = scheduleQuery.eq("year", prof.year);
        if (prof?.semester) scheduleQuery = scheduleQuery.eq("semester", prof.semester);
        if (prof?.section) scheduleQuery = scheduleQuery.eq("section", prof.section);
        const { data: classData, error: classError } = await scheduleQuery;
        if (alive && !classError && classData) setClasses(classData as ClassRow[]);
        if (auth.user && prof?.role === "admin" && sessionData.session) {
          const pendingResponse = await fetch(`${API}/api/admin/notices/pending`, { headers: { Authorization: `Bearer ${sessionData.session.access_token}` } });
          if (pendingResponse.ok && alive) setPendingNotices(await pendingResponse.json() as PendingNotice[]);
        }
      } catch {
        if (alive) setConfigured(false);
      }
    }
    void load();
    return () => { alive = false; };
  }, []);

  const displayName = profile?.display_name || userEmail.split("@")[0] || "Student";
  const todayLabel = useMemo(() => new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long" }).format(new Date()), []);

  async function ask(raw: string) {
    const text = raw.trim();
    if (!text || busy) return;
    setError(""); setQuestion(""); setMessages((current) => [...current, { role: "user", content: text }]); setBusy(true);
    try {
      let authHeader: Record<string, string> = {};
      try { const client = createClient(); const { data } = await client.auth.getSession(); if (data.session) authHeader = { Authorization: `Bearer ${data.session.access_token}` }; } catch { /* public information queries can run without a session */ }
      const localNow = new Date();
      const localDate = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}`;
      const response = await fetch(`${API}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", ...authHeader }, body: JSON.stringify({ question: text, local_date: localDate }) });
      const data = await response.json() as { answer?: string; sources?: ChatMessage["sources"]; detail?: string };
      if (!response.ok) throw new Error(data.detail || "The assistant couldn’t answer right now.");
      setMessages((current) => [...current, { role: "assistant", content: data.answer || "I couldn’t find an answer in the approved college information.", sources: data.sources }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to reach the assistant. Check that the Python API is running.");
      setMessages((current) => [...current, { role: "assistant", content: "I couldn’t reach the assistant service. Your timetable and attendance tools remain available." }]);
    } finally { setBusy(false); }
  }

  async function send(event: FormEvent<HTMLFormElement>) { event.preventDefault(); await ask(question); }
  function navigate(label: string) {
    setSection(label);
    const targets: Record<string, string> = { "Ask campus": "chat", Timetable: "timetable-panel", Notices: "notices-panel", "Admin review": "admin-review" };
    if (label === "Attendance") { setModal("attendance"); return; }
    if (label === "Admin review" && profile?.role !== "admin") { setError("Administrator access is required to review or upload notices."); return; }
    if (label === "Overview") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    document.getElementById(targets[label])?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  async function calculateAttendance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const attended = Number(attendance.attended), total = Number(attendance.total), target = Number(attendance.target);
    if (!Number.isInteger(attended) || !Number.isInteger(total) || attended < 0 || total <= 0 || attended > total || target <= 0 || target >= 100) { setAttendanceResult("Check the values: attended classes must be between zero and total, and target must be 1–99%."); return; }
    try {
      const response = await fetch(`${API}/api/attendance`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ attended, total, target_percent: target }) });
      const result = await response.json() as { current_percent?: number; classes_to_attend?: number; detail?: string };
      if (!response.ok) throw new Error(result.detail || "Could not calculate attendance.");
      const needed = result.classes_to_attend ?? 0;
      setAttendanceCurrent(`${result.current_percent?.toFixed(1)}%`);
      setAttendanceResult(`${result.current_percent?.toFixed(1)}% currently. ${needed === 0 ? "You have already reached your target." : `Attend the next ${needed} classes consecutively to reach ${target}%.`}`);
    } catch (e) { setAttendanceResult(e instanceof Error ? e.message : "Attendance service is unavailable."); }
  }
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget); const email = String(form.get("email")); const password = String(form.get("password"));
    try { const client = createClient(); const { error: authError } = await client.auth.signInWithPassword({ email, password }); if (authError) throw authError; setUserEmail(email); setModal(null); window.location.reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Sign-in failed."); }
  }
  async function signOut() {
    try { const client = createClient(); await client.auth.signOut(); window.location.reload(); }
    catch (e) { setError(e instanceof Error ? e.message : "Sign-out failed."); }
  }
  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    try {
      const client = createClient(); const { data: auth } = await client.auth.getUser();
      if (!auth.user) throw new Error("Sign in before setting up your student profile.");
      const year = Number(profileForm.year), semester = Number(profileForm.semester);
      if (!Number.isInteger(year) || year < 1 || year > 8 || !Number.isInteger(semester) || semester < 1 || semester > 16) throw new Error("Enter a valid year (1–8) and semester (1–16).");
      const update = { display_name: profileForm.display_name.trim() || null, branch: profileForm.branch.trim(), year, semester, section: profileForm.section.trim() };
      const { data, error: saveError } = await client.from("profiles").update(update).eq("id", auth.user.id).select("display_name,role,branch,year,semester,section").single();
      if (saveError) throw saveError;
      setProfile(data as Profile); setModal(null); window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save your profile."); }
  }
  async function uploadNotice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!uploadFile) return;
    setError("");
    try {
      const client = createClient(); const { data } = await client.auth.getSession();
      if (!data.session) { setError("Sign in with an administrator account before uploading."); return; }
      const body = new FormData(); body.append("file", uploadFile);
      const response = await fetch(`${API}/api/admin/notices`, { method: "POST", headers: { Authorization: `Bearer ${data.session.access_token}` }, body });
      const result = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(result.detail || "Upload failed.");
      setModal(null); setUploadFile(null); window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Notice upload failed."); }
  }
  async function reviewNotice(notice: PendingNotice, status: "published" | "rejected") {
    setError("");
    try {
      const client = createClient(); const { data } = await client.auth.getSession();
      if (!data.session) throw new Error("Sign in with an administrator account first.");
      const payload: { status: string; summary?: string; deadline?: string } = { status, summary: notice.summary || "" };
      if (status === "published") {
        const summary = window.prompt("Review or edit the extracted summary before publishing:", notice.summary || "");
        if (summary === null) return;
        payload.summary = summary.trim();
        const hint = notice.candidate_deadline ? `The parser found “${notice.candidate_deadline}”. Verify it against the PDF; enter the confirmed date as YYYY-MM-DD (or leave blank if there is no deadline).` : "Enter a verified deadline in YYYY-MM-DD format, or leave blank if this notice has no deadline.";
        const deadline = window.prompt(hint);
        if (deadline === null) return;
        if (deadline.trim()) payload.deadline = deadline.trim();
      }
      const response = await fetch(`${API}/api/admin/notices/${notice.id}/review`, { method: "POST", headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(result.detail || "Review update failed.");
      setPendingNotices((current) => current.filter((item) => item.id !== notice.id));
      if (status === "published") window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update this notice."); }
  }
  async function managePublishedNotice(notice: Notice, action: "edit" | "archive") {
    setError("");
    try {
      const client = createClient(); const { data } = await client.auth.getSession();
      if (!data.session) throw new Error("Sign in with an administrator account first.");
      let path = "", method = action === "edit" ? "PATCH" : "POST", body: Record<string, string>;
      if (action === "edit") {
        const summary = window.prompt("Edit the notice summary:", notice.summary || "");
        if (summary === null) return;
        const currentDeadline = notice.deadline || "";
        const deadline = window.prompt("Verified deadline in YYYY-MM-DD form, or leave blank to clear it:", currentDeadline);
        if (deadline === null) return;
        path = `${API}/api/admin/notices/${notice.id}`;
        body = { summary, deadline: deadline.trim() };
      } else {
        if (!window.confirm(`Archive “${notice.title}”? Archived notices stop appearing in student answers.`)) return;
        path = `${API}/api/admin/notices/${notice.id}/review`;
        body = { status: "archived" };
      }
      const response = await fetch(path, { method, headers: { Authorization: `Bearer ${data.session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as { detail?: string };
      if (!response.ok) throw new Error(result.detail || "Notice update failed.");
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update this notice."); }
  }

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark">C</div><div><div className="brand-name">campus<span style={{ color: "var(--green)" }}>.</span></div><div className="brand-sub">STUDENT ASSISTANT</div></div></div>
      <div><div className="nav-label">Workspace</div><nav className="nav" aria-label="Main navigation">{[["Overview", "O"], ["Ask campus", "Q"], ["Timetable", "T"], ["Notices", "N"], ["Attendance", "A"], ...(profile?.role === "admin" ? [["Admin review", "R"]] : [])].map(([label, icon]) => <button key={label} className={section === label ? "active" : ""} onClick={() => navigate(label)}><span className="nav-icon">{icon}</span>{label}</button>)}</nav></div>
      <div className="side-bottom"><div className="nav-label">Your account</div><button className="secondary" onClick={() => userEmail ? void signOut() : setModal("login")} style={{ width: "100%" }}>{userEmail ? `Sign out · ${profile?.role || "student"}` : "Sign in"}</button><div className="profile"><div className="avatar">{displayName.slice(0, 1).toUpperCase()}</div><div><strong>{displayName}</strong><small>{profile?.branch ? `${profile.branch}${profile.year ? ` · Year ${profile.year}` : ""}${profile.section ? ` · ${profile.section}` : ""}` : "Campus student"}</small></div></div>{userEmail && <button className="link-btn" style={{ padding: "12px 7px" }} onClick={() => { setProfileForm({ display_name: profile?.display_name || "", branch: profile?.branch || "", year: profile?.year ? String(profile.year) : "", semester: profile?.semester ? String(profile.semester) : "", section: profile?.section || "" }); setModal("profile"); }}>{profile?.branch ? "Edit student profile" : "Set up student profile"}</button>}</div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="crumb">Workspace　/　<span style={{ color: "var(--ink)" }}>{section}</span></div><div className="top-right"><span className="today">{todayLabel}</span><button className="icon-btn" aria-label="Sign in" onClick={() => setModal("login")}>♙</button></div></header>
      <div className="content">
        <div className="welcome"><div><div className="eyebrow">{weekday.toUpperCase()} · CAMPUS AT A GLANCE</div><h1>Good day, {displayName} <span aria-hidden="true">✳</span></h1><p>Your college information, classes, and notices in one place.</p></div><div className="date-chip">▦ &nbsp; {todayLabel}</div></div>
        {!configured && <div className="banner">Connect Supabase to load live notices and timetable data. The assistant API also needs to be running.</div>}
        {error && <div className="banner" role="alert">{error}</div>}
        <div className="grid">
          <section className="card chat-card" id="chat">
            <div className="card-head"><div><div className="card-title">Ask your campus assistant</div><div className="subtle">Answers grounded in reviewed college information</div></div><div className="status"><span className="dot"/> Ready</div></div>
            <div className="chat-body" aria-live="polite">{messages.map((message, index) => <div key={`${index}-${message.role}`} className={`message ${message.role === "user" ? "user" : "bot"}`}>{message.content}{message.sources?.map((source, i) => <span className="source" key={i}>Source: {source.title}{source.page ? ` · page ${source.page}` : ""}</span>)}</div>)}{busy && <div className="message bot loading">Checking approved college sources…</div>}{messages.length === 1 && <div className="suggestions">{suggestions.map((item) => <button key={item} onClick={() => void ask(item)}>{item}</button>)}</div>}</div>
            <form className="chat-form" onSubmit={send}><div className="input-row"><input id="chat-input" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask about college, classes, or notices…" aria-label="Your question" disabled={busy}/><button className="send" aria-label="Send question" disabled={busy || !question.trim()}>↑</button></div><p className="tiny-note">Campus answers cite reviewed sources. Verify important dates with the official notice.</p></form>
          </section>
          <aside className="right-col">
            <div className="card stat-card"><div className="stat-top"><span className="stat-label">Attendance calculator</span><span className="stat-icon">◷</span></div><div className="stat-number">{attendanceCurrent}</div><div className="stat-caption">{attendanceResult || "Enter your class counts to calculate a target"}</div><button className="link-btn" onClick={() => setModal("attendance")} style={{ padding: "10px 0 0" }}>Calculate attendance →</button></div>
            <div className="card stat-card"><div className="stat-top"><span className="stat-label">Upcoming deadlines</span><span className="stat-icon">◷</span></div><div className="stat-number">{notices.filter((n) => n.deadline && n.deadline >= new Date().toISOString().slice(0, 10)).length}</div><div className="stat-caption">Published dates from approved notices</div></div>
            <div className="card section-card" id="timetable-panel"><div className="section-heading"><h2>Today's timetable</h2><span className="subtle">Your section</span></div>{classes.length ? <table className="table"><thead><tr><th>TIME</th><th>CLASS</th><th>ROOM</th></tr></thead><tbody>{classes.map((row, i) => <tr key={`${row.course_code}-${i}`}><td>{row.starts_at.slice(0, 5)}</td><td><span className="course">{row.course_name}</span><br/><span className="room">{row.course_code}</span></td><td><span className="pill">{row.room || "-"}</span></td></tr>)}</tbody></table> : <div className="subtle">No classes published for today. Complete your student profile and connect verified timetable data to see your schedule.</div>}</div>
            <div className="card section-card" id="notices-panel"><div className="section-heading"><h2>Latest notices</h2><span className="subtle">Published notices</span></div>{notices.length ? (profile?.role === "admin" ? notices : notices.slice(0, 4)).map((notice) => <div className="notice" key={notice.id}><div className="notice-date"><b>{new Date(notice.created_at).getDate()}</b><small>{new Intl.DateTimeFormat("en", { month: "short" }).format(new Date(notice.created_at))}</small></div><div><strong>{notice.title}</strong><p>{notice.summary || "Open the notice for more information."}</p>{notice.deadline && <span className="notice-tag">Deadline · {new Date(`${notice.deadline}T00:00:00`).toLocaleDateString("en-IN")}</span>}{profile?.role === "admin" && <div className="admin-controls" style={{ marginTop: 8 }}><button className="secondary" onClick={() => void managePublishedNotice(notice, "edit")}>Edit details</button><button className="secondary" onClick={() => void managePublishedNotice(notice, "archive")}>Archive</button></div>}</div></div>) : <div className="subtle">No published notices yet.</div>}</div>
            {profile?.role === "admin" && <div className="card section-card" id="admin-review"><div className="section-heading"><h2>Notice review queue</h2><button className="link-btn" onClick={() => setModal("upload")}>Upload PDF</button></div>{pendingNotices.length ? <div className="admin-list">{pendingNotices.map((notice) => <div className="admin-row" key={notice.id}><div><b>{notice.title}</b><small>{notice.summary || "No summary extracted."}</small>{notice.candidate_deadline && <small>Candidate date: {notice.candidate_deadline} - verify against notice{notice.candidate_evidence ? ` ("${notice.candidate_evidence}")` : ""}</small>}{notice.file_url && <small><a href={notice.file_url} target="_blank" rel="noreferrer" style={{ color: "var(--green)" }}>Open original PDF</a></small>}</div><div className="admin-controls"><span className="badge pending">Needs review</span><button className="primary" onClick={() => void reviewNotice(notice, "published")}>Review & publish</button><button className="secondary" onClick={() => void reviewNotice(notice, "rejected")}>Reject</button></div></div>)}</div> : <div className="subtle">No notices are waiting for review.</div>}</div>}
            <div className="tool-strip"><button className="tool" onClick={() => setModal("attendance")}><span className="tool-icon">A</span><span className="tool-copy"><b>Attendance</b><span>Plan classes to your target</span></span></button><button className="tool" onClick={() => void ask("What are the important dates in the latest notices?")}><span className="tool-icon">N</span><span className="tool-copy"><b>Notice dates</b><span>Ask about key dates</span></span></button>{profile?.role === "admin" && <button className="tool" onClick={() => setModal("upload")}><span className="tool-icon">+</span><span className="tool-copy"><b>Admin upload</b><span>Review a college notice</span></span></button>}</div>
          </aside>
        </div><p className="footer-note">Campus Assistant · Answers use reviewed institutional sources when available</p>
      </div>
    </main>
    {modal === "login" && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><section className="modal"><h2>Sign in to Campus</h2><p>Use your college account. Administrator permissions are assigned by your system administrator.</p><form onSubmit={signIn}><div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required autoComplete="email"/></div><div className="field"><label htmlFor="password">Password</label><input id="password" name="password" type="password" required autoComplete="current-password"/></div><div className="modal-actions"><button type="button" className="secondary" onClick={() => setModal(null)}>Cancel</button><button className="primary">Sign in</button></div></form></section></div>}
    {modal === "profile" && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><section className="modal"><h2>Your student profile</h2><p>Your cohort details filter timetable answers. These values stay in your college profile and are not stored with attendance calculations.</p><form onSubmit={saveProfile}><div className="field"><label htmlFor="display-name">Display name</label><input id="display-name" value={profileForm.display_name} onChange={(e) => setProfileForm({ ...profileForm, display_name: e.target.value })}/></div><div className="field"><label htmlFor="branch">Branch / programme</label><input id="branch" required value={profileForm.branch} onChange={(e) => setProfileForm({ ...profileForm, branch: e.target.value })} placeholder="For example, CSE"/></div><div className="field"><label htmlFor="year">Year</label><input id="year" type="number" min="1" max="8" required value={profileForm.year} onChange={(e) => setProfileForm({ ...profileForm, year: e.target.value })}/></div><div className="field"><label htmlFor="semester">Semester</label><input id="semester" type="number" min="1" max="16" required value={profileForm.semester} onChange={(e) => setProfileForm({ ...profileForm, semester: e.target.value })}/></div><div className="field"><label htmlFor="section">Section</label><input id="section" required value={profileForm.section} onChange={(e) => setProfileForm({ ...profileForm, section: e.target.value })}/></div><div className="modal-actions"><button type="button" className="secondary" onClick={() => setModal(null)}>Cancel</button><button className="primary">Save profile</button></div></form></section></div>}
    {modal === "attendance" && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><section className="modal"><h2>Attendance calculator</h2><p>Calculations run in the Python service and are not saved. Verify the counting policy with your department.</p><form onSubmit={calculateAttendance}><div className="field"><label htmlFor="attended">Classes attended</label><input id="attended" type="number" min="0" step="1" required value={attendance.attended} onChange={(e) => setAttendance({ ...attendance, attended: e.target.value })}/></div><div className="field"><label htmlFor="total">Total classes held</label><input id="total" type="number" min="1" step="1" required value={attendance.total} onChange={(e) => setAttendance({ ...attendance, total: e.target.value })}/></div><div className="field"><label htmlFor="target">Target percentage</label><input id="target" type="number" min="1" max="99" step="1" required value={attendance.target} onChange={(e) => setAttendance({ ...attendance, target: e.target.value })}/></div>{attendanceResult && <div className="banner" role="status">{attendanceResult}</div>}<div className="modal-actions"><button type="button" className="secondary" onClick={() => setModal(null)}>Close</button><button className="primary">Calculate</button></div></form></section></div>}
    {modal === "upload" && <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}><section className="modal"><h2>Admin notice upload</h2><p>Only administrators can publish notice content. New notices stay pending until their extracted details have been reviewed.</p><form onSubmit={uploadNotice}><div className="field"><label htmlFor="notice-file">Notice PDF (up to 10 MB)</label><input id="notice-file" type="file" accept="application/pdf,.pdf" required onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}/></div><div className="modal-actions"><button type="button" className="secondary" onClick={() => setModal(null)}>Cancel</button><button className="primary" disabled={!uploadFile}>Upload for review</button></div></form></section></div>}
  </div>;
}
