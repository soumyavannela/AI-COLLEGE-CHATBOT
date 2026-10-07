-- Campus Assistant schema. Apply with Supabase CLI or SQL editor.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  role text not null default 'student' check (role in ('student', 'admin')),
  branch text,
  year smallint check (year between 1 and 8),
  semester smallint check (semester between 1 and 16),
  section text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.create_student_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
for each row execute procedure public.create_student_profile();

create table if not exists public.notices (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text,
  deadline date,
  candidate_deadline text,
  candidate_evidence text,
  source_path text,
  status text not null default 'pending_review' check (status in ('pending_review', 'published', 'rejected', 'archived')),
  uploaded_by uuid references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notices_status_created_idx on public.notices (status, created_at desc);
create index if not exists notices_deadline_idx on public.notices (deadline) where status = 'published';

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  notice_id uuid not null references public.notices(id) on delete cascade,
  title text not null,
  page_number integer check (page_number > 0),
  content text not null,
  approval_status text not null default 'pending_review' check (approval_status in ('pending_review', 'published', 'rejected')),
  search_vector tsvector generated always as (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))) stored,
  created_at timestamptz not null default now()
);
create index if not exists document_chunks_search_idx on public.document_chunks using gin (search_vector);
create index if not exists document_chunks_notice_idx on public.document_chunks (notice_id, page_number);

create table if not exists public.timetable (
  id uuid primary key default gen_random_uuid(),
  weekday text not null check (weekday in ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')),
  starts_at time not null,
  ends_at time not null,
  course_name text not null,
  course_code text not null,
  room text,
  faculty text,
  branch text not null,
  year smallint not null check (year between 1 and 8),
  semester smallint not null check (semester between 1 and 16),
  section text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists timetable_lookup_idx on public.timetable (branch, year, semester, section, weekday, starts_at) where is_active;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('college-notices', 'college-notices', false, 10485760, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.search_approved_chunks(query_text text, result_limit integer default 5)
returns table (id uuid, title text, page_number integer, content text, rank real)
language sql stable security invoker set search_path = '' as $$
  select c.id, c.title, c.page_number, c.content,
         ts_rank(c.search_vector, plainto_tsquery('simple', query_text)) as rank
  from public.document_chunks c
  join public.notices n on n.id = c.notice_id
  where n.status = 'published' and c.approval_status = 'published'
    and c.search_vector @@ plainto_tsquery('simple', query_text)
  order by rank desc, n.created_at desc
  limit greatest(1, least(result_limit, 10));
$$;

alter table public.profiles enable row level security;
alter table public.notices enable row level security;
alter table public.document_chunks enable row level security;
alter table public.timetable enable row level security;

create policy "Users can read own profile" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "Users can update own profile" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy "Anyone can read published notices" on public.notices for select to anon, authenticated using (status = 'published');
create policy "Anyone can read approved document chunks" on public.document_chunks for select to anon, authenticated using (approval_status = 'published');
create policy "Authenticated users can read active timetable" on public.timetable for select to authenticated using (is_active);
revoke all on public.profiles from anon, authenticated;
revoke all on public.notices from anon, authenticated;
grant select (id, title, summary, deadline, status, version, created_at, updated_at) on public.notices to anon, authenticated;
grant select on public.document_chunks, public.timetable to anon, authenticated;
grant select on public.profiles to authenticated;
grant update (display_name, branch, year, semester, section) on public.profiles to authenticated;
grant execute on function public.search_approved_chunks(text, integer) to anon, authenticated;
grant all on public.profiles, public.notices, public.document_chunks, public.timetable to service_role;

-- Admin roles must be granted by a trusted operator using the Supabase dashboard/SQL editor.
-- Example (replace the UUID only after verifying the account): update public.profiles set role='admin' where id='...';
