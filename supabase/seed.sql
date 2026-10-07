-- Optional synthetic demo records. These are not real college information.
insert into public.timetable (weekday, starts_at, ends_at, course_name, course_code, room, faculty, branch, year, semester, section)
values
  ('Monday', '09:00', '10:00', 'Database Systems (DEMO)', 'DBMS-DEMO', 'Demo Room 1', 'Demo Faculty', 'CSE-DEMO', 2, 4, 'A'),
  ('Wednesday', '11:00', '12:00', 'Computer Networks (DEMO)', 'CN-DEMO', 'Demo Room 2', 'Demo Faculty', 'CSE-DEMO', 2, 4, 'A');

with demo_notice as (
  insert into public.notices (title, summary, status)
  values (
    'DEMO ONLY — Replace with an approved college notice',
    'Synthetic sample record for demonstrating source-grounded answers. It does not describe a real college policy, deadline, or event.',
    'published'
  )
  returning id, title
)
insert into public.document_chunks (notice_id, title, page_number, content, approval_status)
select id, title, 1,
       'DEMO ONLY: This synthetic record exists to demonstrate retrieval and source citations. It is not an official college policy, deadline, or event. Replace this record with information reviewed and approved by your college.',
       'published'
from demo_notice;
