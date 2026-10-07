from app.main import SCHEDULE_INTENT, extract_candidates


def test_deadline_candidate_retains_context_for_human_review():
    candidates = extract_candidates("Students must pay the exam fee on or before 15 October 2026 to avoid a late fee.")
    assert len(candidates) == 1
    assert candidates[0]["date_text"] == "15 October 2026"
    assert candidates[0]["looks_like_deadline"] is True
    assert "on or before" in candidates[0]["evidence"]


def test_event_date_is_not_automatically_marked_as_deadline():
    candidates = extract_candidates("The seminar will be held on 15 October 2026.")
    assert candidates[0]["looks_like_deadline"] is False


def test_schedule_intent_recognizes_student_timetable_questions_only():
    assert SCHEDULE_INTENT.search("When is my next DBMS class?")
    assert SCHEDULE_INTENT.search("What classes do I have tomorrow?")
    assert not SCHEDULE_INTENT.search("How many classes can I miss before attendance drops?")
