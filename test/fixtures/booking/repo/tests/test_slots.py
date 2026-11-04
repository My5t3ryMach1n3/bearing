import pytest

from app.availability import AvailabilityService
from app.repository import AppointmentRepository, Slot


def test_a_booked_slot_is_not_free():
    repository = AppointmentRepository([Slot("s1", "dr-okafor", "2026-11-10T09:00")])
    repository.insert("s1", "p1")
    assert AvailabilityService(repository).free_slots() == []


@pytest.mark.skip(reason="clinician calendars come with #2")
def test_skipped():
    pass
