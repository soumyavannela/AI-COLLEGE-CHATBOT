from __future__ import annotations

import io
import math
import re
from datetime import date, datetime, timedelta, timezone

import httpx
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader

from .config import settings
from .schemas import AttendanceRequest, AttendanceResponse, ChatRequest, ChatResponse, Source
from .services import data, generate_grounded_answer

app = FastAPI(title="Campus Assistant API", version="0.1.0")
app.add_middleware(CORSMiddleware, allow_origins=[x.strip() for x in settings.allowed_origins.split(",") if x.strip()], allow_credentials=True, allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"])


async def authenticated_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Sign in to continue.")
    try:
        return await data.user(authorization.removeprefix("Bearer "))
    except (RuntimeError, PermissionError) as exc:
        raise HTTPException(401, str(exc)) from exc


async def administrator(user: dict = Depends(authenticated_user)) -> dict:
    try:
        role = await data.role_for(user["id"])
    except (RuntimeError, httpx.HTTPError) as exc:
        raise HTTPException(503, str(exc)) from exc
    if role != "admin":
        raise HTTPException(403, "Administrator access is required.")
    return user


@app.get("/health")
async def health():
    return {"status": "ok", "supabase_configured": settings.configured, "llm_configured": bool(settings.openai_api_key)}


SCHEDULE_INTENT = re.compile(r"\b(timetable|schedule|lecture timetable|class timetable)\b|\b(?:what|which|show|list|when|my|next).{0,40}\b(?:classes|class|lectures|periods)\b|\b(?:classes|class|lectures)\b.{0,25}\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I)


@app.post("/api/chat", response_model=ChatResponse)
async def chat(body: ChatRequest, authorization: str | None = Header(default=None)):
    if SCHEDULE_INTENT.search(body.question):
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "Sign in to see your personalized timetable.")
        try:
            user = await data.user(authorization.removeprefix("Bearer "))
        except PermissionError as exc:
            raise HTTPException(401, str(exc)) from exc
        except (RuntimeError, httpx.HTTPError) as exc:
            raise HTTPException(503, "Authentication service is unavailable.") from exc
        try:
            profile = await data.profile_for(user["id"])
        except (RuntimeError, httpx.HTTPError) as exc:
            raise HTTPException(503, str(exc)) from exc
        if not profile or not all(profile.get(field) for field in ("branch", "year", "semester", "section")):
            return ChatResponse(answer="Add your branch, year, semester, and section in your profile to see your personal timetable.", grounded=True)
        today = body.local_date or date.today()
        day_match = re.search(r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", body.question, re.I)
        if re.search(r"\btomorrow\b", body.question, re.I):
            weekday = (today + timedelta(days=1)).strftime("%A")
        elif re.search(r"\btoday\b", body.question, re.I):
            weekday = today.strftime("%A")
        else:
            weekday = day_match.group(1).title() if day_match else today.strftime("%A")
        params = {"select": "starts_at,ends_at,course_name,course_code,room,faculty", "weekday": f"eq.{weekday}", "is_active": "eq.true", "order": "starts_at.asc", "limit": "30"}
        for field, value in profile.items():
            if value is not None:
                params[field] = f"eq.{value}"
        course = re.search(r"\b([A-Z][A-Z0-9_-]{1,14})\s+class\b", body.question, re.I)
        if course:
            term = re.sub(r"[^a-zA-Z0-9_-]", "", course.group(1))
            params["or"] = f"(course_name.ilike.*{term}*,course_code.ilike.*{term}*)"
        try:
            rows = await data.request("GET", "timetable", params=params)
        except (RuntimeError, httpx.HTTPError) as exc:
            raise HTTPException(503, str(exc)) from exc
        if not rows:
            return ChatResponse(answer=f"I don't see any timetable entries for {weekday}. Check that your program and section are set in your profile, or contact your department.", grounded=True)
        lines = [f"{row['starts_at'][:5]}–{row['ends_at'][:5]} · {row['course_name']} ({row['course_code']}) · {row.get('room') or 'room not listed'}" for row in rows]
        return ChatResponse(answer=f"Your classes for {weekday}:\n\n" + "\n".join(lines), grounded=True)
    try:
        passages = await data.search(body.question)
        # Provisional lexical threshold; calibrate it against a labeled campus query set.
        passages = [row for row in (passages or []) if float(row.get("rank") or 0) >= settings.min_retrieval_rank]
        answer = await generate_grounded_answer(body.question, passages or [])
    except (RuntimeError, httpx.HTTPError) as exc:
        raise HTTPException(503, str(exc)) from exc
    sources = [Source(title=row.get("title") or "College information", page=row.get("page_number")) for row in (passages or [])]
    return ChatResponse(answer=answer, sources=sources, grounded=bool(passages))


@app.get("/api/timetable")
async def timetable(weekday: str, branch: str | None = None, year: int | None = None, semester: int | None = None, section: str | None = None, user: dict = Depends(authenticated_user)):
    try:
        profile = await data.profile_for(user["id"])
    except (RuntimeError, httpx.HTTPError) as exc:
        raise HTTPException(503, str(exc)) from exc
    if not profile or not all(profile.get(field) for field in ("branch", "year", "semester", "section")):
        raise HTTPException(409, "Complete your branch, year, semester, and section in your profile first.")
    params = {"select": "id,weekday,starts_at,ends_at,course_name,course_code,room,faculty,branch,year,semester,section", "weekday": f"eq.{weekday.title()}", "is_active": "eq.true", "order": "starts_at.asc", "limit": "30"}
    for field, value in profile.items():
        params[field] = f"eq.{value}"
    try:
        return await data.request("GET", "timetable", params=params)
    except (RuntimeError, httpx.HTTPError) as exc:
        raise HTTPException(503, str(exc)) from exc


@app.post("/api/attendance", response_model=AttendanceResponse)
async def attendance(body: AttendanceRequest):
    if body.attended > body.total:
        raise HTTPException(422, "Attended classes cannot exceed total classes.")
    current = body.attended / body.total * 100
    target = body.target_percent / 100
    needed = 0 if current >= body.target_percent else max(0, math.ceil((target * body.total - body.attended) / (1 - target)))
    return AttendanceResponse(current_percent=round(current, 1), target_percent=body.target_percent, classes_to_attend=needed)


@app.get("/api/admin/notices/pending")
async def pending_notices(user: dict = Depends(administrator)):
    try:
        rows = await data.request("GET", "notices", params={"select": "id,title,summary,candidate_deadline,candidate_evidence,source_path,status,created_at", "status": "eq.pending_review", "order": "created_at.desc", "limit": "50"})
        for row in rows:
            row["file_url"] = await data.signed_notice_url(row["source_path"]) if row.get("source_path") else None
        return rows
    except (RuntimeError, httpx.HTTPError) as exc:
        raise HTTPException(503, str(exc)) from exc


DATE_PATTERN = re.compile(r"\b(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{2,4})|\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{2,4})\b", re.I)
DEADLINE_WORDS = re.compile(r"\b(last date|deadline|on or before|submit by|due date|no later than)\b", re.I)


def extract_candidates(text: str) -> list[dict]:
    candidates = []
    for match in DATE_PATTERN.finditer(text):
        start, end = max(0, match.start() - 100), min(len(text), match.end() + 100)
        evidence = " ".join(text[start:end].split())
        candidates.append({"date_text": match.group(0), "evidence": evidence, "looks_like_deadline": bool(DEADLINE_WORDS.search(evidence))})
    return candidates


@app.post("/api/admin/notices", status_code=201)
async def upload_notice(file: UploadFile = File(...), user: dict = Depends(administrator)):
    if file.content_type != "application/pdf" and not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(415, "Only PDF files are accepted.")
    limit = settings.max_upload_mb * 1024 * 1024
    content = await file.read(limit + 1)
    if len(content) > limit:
        raise HTTPException(413, f"File exceeds the {settings.max_upload_mb} MB upload limit.")
    try:
        reader = PdfReader(io.BytesIO(content), strict=True)
    except Exception as exc:
        raise HTTPException(422, "The PDF could not be read. It may be encrypted or malformed.") from exc
    if len(reader.pages) > 200:
        raise HTTPException(413, "PDFs are limited to 200 pages.")
    pages = [(i + 1, (page.extract_text() or "").strip()) for i, page in enumerate(reader.pages)]
    text = "\n\n".join(page_text for _, page_text in pages).strip()
    if not text:
        raise HTTPException(422, "No selectable text was found. This prototype does not OCR scanned PDFs yet.")
    title = (file.filename or "College notice").removesuffix(".pdf").removesuffix(".PDF")[:180]
    first_paragraph = next((" ".join(p.split()) for p in text.split("\n\n") if len(p.strip()) > 45), " ".join(text.split()))
    candidate_summary = first_paragraph[:420] + ("…" if len(first_paragraph) > 420 else "")
    candidates = extract_candidates(text)
    candidate_deadline = next((item["date_text"] for item in candidates if item["looks_like_deadline"]), None)
    candidate_evidence = next((item["evidence"] for item in candidates if item["looks_like_deadline"]), None)
    notice = None
    source_path = None
    try:
        notice_rows = await data.request("POST", "notices", json={"title": title, "summary": candidate_summary, "candidate_deadline": candidate_deadline, "candidate_evidence": candidate_evidence, "status": "pending_review", "uploaded_by": user["id"]})
        notice = notice_rows[0]
        source_path = await data.store_notice_pdf(notice["id"], content)
        await data.request("PATCH", "notices", params={"id": f"eq.{notice['id']}"}, json={"source_path": source_path})
        chunks = []
        for page_number, page_text in pages:
            if not page_text:
                continue
            for offset in range(0, len(page_text), 900):
                chunk = page_text[offset:offset + 1100].strip()
                if chunk:
                    chunks.append({"notice_id": notice["id"], "title": title, "page_number": page_number, "content": chunk, "approval_status": "pending_review"})
        await data.request("POST", "document_chunks", json=chunks)
        return {"id": notice["id"], "title": title, "summary_candidate": candidate_summary, "deadline_candidate": candidate_deadline, "deadline_evidence": candidate_evidence, "status": notice["status"], "candidate_deadlines": candidates, "page_count": len(pages), "message": "Uploaded for administrator review. Summary and dates are candidates; no deadline is published automatically."}
    except (RuntimeError, httpx.HTTPError) as exc:
        if source_path:
            try:
                await data.remove_notice_pdf(source_path)
            except (RuntimeError, httpx.HTTPError):
                pass
        if notice:
            try:
                await data.request("DELETE", "notices", params={"id": f"eq.{notice['id']}"})
            except (RuntimeError, httpx.HTTPError):
                pass
        raise HTTPException(503, str(exc)) from exc


@app.post("/api/admin/notices/{notice_id}/review")
async def review_notice(notice_id: str, payload: dict, user: dict = Depends(administrator)):
    status = payload.get("status")
    if status not in {"published", "rejected", "archived"}:
        raise HTTPException(422, "Status must be published, rejected, or archived.")
    try:
        updates = {"status": status, "reviewed_by": user["id"], "reviewed_at": datetime.now(timezone.utc).isoformat()}
        if "summary" in payload:
            updates["summary"] = str(payload["summary"])[:1200]
        if payload.get("deadline"):
            try:
                updates["deadline"] = date.fromisoformat(str(payload["deadline"])).isoformat()
            except ValueError as exc:
                raise HTTPException(422, "Deadline must use YYYY-MM-DD.") from exc
        expected_status = "published" if status == "archived" else "pending_review"
        updated = await data.request("PATCH", "notices", params={"id": f"eq.{notice_id}", "status": f"eq.{expected_status}"}, json=updates)
        if not updated:
            raise HTTPException(409, "This notice is no longer in the expected review state.")
        if status != "archived":
            await data.request("PATCH", "document_chunks", params={"notice_id": f"eq.{notice_id}"}, json={"approval_status": status})
        return {"id": notice_id, "status": status}
    except (RuntimeError, httpx.HTTPError) as exc:
        raise HTTPException(503, str(exc)) from exc


@app.patch("/api/admin/notices/{notice_id}")
async def update_published_notice(notice_id: str, payload: dict, user: dict = Depends(administrator)):
    updates = {}
    if "title" in payload:
        title = str(payload["title"]).strip()
        if not title or len(title) > 180:
            raise HTTPException(422, "Title must contain 1–180 characters.")
        updates["title"] = title
    if "summary" in payload:
        updates["summary"] = str(payload["summary"]).strip()[:1200]
    if "deadline" in payload:
        try:
            updates["deadline"] = date.fromisoformat(str(payload["deadline"])).isoformat() if payload["deadline"] else None
        except ValueError as exc:
            raise HTTPException(422, "Deadline must use YYYY-MM-DD or be blank.") from exc
    if not updates:
        raise HTTPException(422, "Provide a title, summary, or deadline to update.")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    try:
        updated = await data.request("PATCH", "notices", params={"id": f"eq.{notice_id}", "status": "eq.published"}, json=updates)
        if not updated:
            raise HTTPException(404, "Published notice not found.")
        if "title" in updates:
            await data.request("PATCH", "document_chunks", params={"notice_id": f"eq.{notice_id}"}, json={"title": updates["title"]})
        return {"id": notice_id, "status": "published", "updated": list(updates.keys())}
    except (RuntimeError, httpx.HTTPError) as exc:
        raise HTTPException(503, str(exc)) from exc
