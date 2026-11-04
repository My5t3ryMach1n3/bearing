"""Applies booking rules."""

from __future__ import annotations

from app.availability import AvailabilityService, SlotTaken
from app.repository import Appointment, AppointmentRepository


class BookingService:
    def __init__(self, availability: AvailabilityService, repository: AppointmentRepository):
        self._availability = availability
        self._repository = repository

    def book(self, slot_id: str, patient: str) -> Appointment:
        appointment = self._repository.insert(slot_id, patient)
        if appointment is None:
            raise SlotTaken(slot_id)
        return appointment

    def get(self, appointment_id: str) -> Appointment | None:
        return self._repository.get(appointment_id)
