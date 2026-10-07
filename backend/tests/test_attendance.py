from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_attendance_reaches_target_with_minimum_future_classes():
    response = client.post("/api/attendance", json={"attended": 18, "total": 24, "target_percent": 75})
    assert response.status_code == 200
    assert response.json() == {"current_percent": 75.0, "target_percent": 75.0, "classes_to_attend": 0}


def test_attendance_rounds_up_required_classes():
    response = client.post("/api/attendance", json={"attended": 15, "total": 24, "target_percent": 75})
    assert response.status_code == 200
    assert response.json()["classes_to_attend"] == 12


def test_attendance_rejects_impossible_counts():
    response = client.post("/api/attendance", json={"attended": 25, "total": 24, "target_percent": 75})
    assert response.status_code == 422
