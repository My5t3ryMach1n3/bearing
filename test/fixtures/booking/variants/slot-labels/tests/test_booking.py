import pytest
from fastapi.testclient import TestClient

from app.availability import AvailabilityService
from app.booking import BookingService
from app.repository import AppointmentRepository, Slot
from app.routes import create_app

SLOTS = [
    Slot("s1", "dr-okafor", "2026-11-10T09:00"),
    Slot("s2", "dr-okafor", "2026-11-10T09:30"),
]


@pytest.fixture
def client():
    repository = AppointmentRepository(SLOTS)
    availability = AvailabilityService(repository)
    return TestClient(create_app(BookingService(availability, repository), availability))


@pytest.mark.req("#1/AC1")
def test_lists_every_open_slot(client):
    response = client.get("/slots")
    assert [slot["id"] for slot in response.json()] == ["s1", "s2"]
    assert response.json()[0]["label"] == "2026-11-10 at 09:00 with dr-okafor"


@pytest.mark.req("#1/AC2")
def test_confirms_a_booking(client):
    booked = client.post("/appointments", json={"slot_id": "s1", "patient": "p1"})
    assert booked.status_code == 201
    assert client.get(f"/appointments/{booked.json()['id']}").json()["slot_id"] == "s1"


@pytest.mark.req("#5/AC1")
def test_refuses_a_slot_already_booked(client):
    client.post("/appointments", json={"slot_id": "s1", "patient": "p1"})
    assert client.post("/appointments", json={"slot_id": "s1", "patient": "p2"}).status_code == 409


@pytest.mark.req("#5/AC2")
def test_the_first_patient_keeps_the_slot(client):
    first = client.post("/appointments", json={"slot_id": "s2", "patient": "p1"}).json()
    client.post("/appointments", json={"slot_id": "s2", "patient": "p2"})
    assert client.get(f"/appointments/{first['id']}").json()["patient"] == "p1"
