# Campus Assistant — AI College Chatbot

A focused college assistant prototype for verified campus Q&A, timetable lookups, deterministic attendance calculations, and administrator-reviewed PDF notice summaries/deadline candidates.

## What is implemented

- Next.js App Router and TypeScript student dashboard.
- Supabase Auth email/password sign-in and PostgreSQL schema with RLS.
- Python FastAPI service for source-grounded Q&A, timetable intent routing, attendance calculations, and protected notice upload/review APIs.
- Full-text search over approved notice passages. If an LLM API key is not configured, Q&A returns the matching approved passage as an extractive answer.
- PDF text extraction with page references. Scanned PDFs are reported as unsupported rather than silently summarized.
- Extractive notice summary and date candidates remain pending until an administrator verifies them.
- Optional timetable and notice seed data is synthetic and explicitly marked demo-only. Replace it with verified college information before real use.

## Requirements

- Node.js 20.9 or newer and pnpm/npm.
- Python 3.10 or newer.
- A Supabase project. The app cannot load live data until its schema is applied and environment variables are set.
- Optional OpenAI-compatible chat API credentials for generated answers. No key is needed for extractive passage responses or deterministic attendance.

## Setup

1. Create a Supabase project and apply `supabase/migrations/202610060001_initial_schema.sql` using the Supabase CLI or SQL Editor.
2. In Supabase Authentication, create an administrator account. After confirming its user ID, set its profile role to `admin` from the SQL Editor:

   ```sql
   update public.profiles set role = 'admin' where id = 'VERIFIED_AUTH_USER_UUID';
   ```

3. Copy `.env.example` to `.env.local` in the repository root and fill the public Supabase URL and publishable/anon key. Put the service role key only in `backend/.env`; never expose it to the browser.
4. Copy `backend/.env.example` to `backend/.env`, set Supabase URL, anon key, and service-role key. The API’s service credential is server-only; authenticated identity and admin role are checked before protected operations.
5. Optionally apply `supabase/seed.sql` for the clearly synthetic demo records. Do not present them as official college information.
6. Install and run the frontend:

   ```powershell
   pnpm install
   pnpm dev
   ```

7. Install and run the backend in another terminal:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r backend\requirements.txt
   uvicorn app.main:app --app-dir backend --reload --port 8000
   ```

8. Open `http://localhost:3000`. API health is available at `http://localhost:8000/health`.

Set `NEXT_PUBLIC_API_URL` in root `.env.local` to the FastAPI URL if it differs from `http://localhost:8000`. Set `ALLOWED_ORIGINS` in `backend/.env` to the frontend origin.

## Add verified information

- College Q&A searches text chunks belonging to notices whose status and chunk approval status are both `published`. Add records only from permitted institutional material.
- Timetable rows must include the real or explicitly synthetic branch, year, semester, section, weekday, start/end times, course, and room fields. Students should fill their profile cohort fields before asking for personalized classes.
- Administrators upload selectable-text PDFs. The extracted first paragraph is a *candidate summary*, not authoritative. Candidate dates and evidence are surfaced for human review. No candidate deadline is published automatically.
- Scanned PDFs/OCR, broad syllabus uploads, automated reminders, and production identity federation are not implemented in this MVP.

## Development checks

Frontend:

```powershell
pnpm lint
pnpm build
```

Backend:

```powershell
pip install -r backend\requirements.txt
pytest backend\tests
```

Database migrations should be reviewed and applied to a non-production Supabase project first. Configure the first administrator manually through a trusted operator. Never commit `.env` files.

## Known limitations

- This is a prototype; no college data, production deployment, institutional approval, or external integration is bundled.
- Full-text search is a basic lexical retrieval baseline. Telugu and Romanized Telugu retrieval have not been validated.
- A configured LLM is optional. Answers can be extractive and less conversational without one.
- Date recognition supports a limited set of English formats and needs manual verification. Relative dates, Telugu dates, tables, and OCR are not handled reliably.
- Admin review currently asks the reviewer to confirm a candidate date in ISO `YYYY-MM-DD` form. Verify it against the original notice before publishing.
- No real student attendance information is stored.
