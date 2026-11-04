"""Applies booking rules."""

from __future__ import annotations

from app.availability import AvailabilityService
from app.repository import Appointment, AppointmentRepository


class BookingService:
    def __init__(self, availability: AvailabilityService, repository: AppointmentRepository):
        self._availability = availability
        self._repository = repository

    def book(self, slot_id: str, patient: str) -> Appointment:
        return self._availability.reserve(slot_id, patient)

    def get(self, appointment_id: str) -> Appointment | None:
        return self._repository.get(appointment_id)
