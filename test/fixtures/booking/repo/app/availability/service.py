"""Knows which slots are free, and is the only code that reserves one."""

from __future__ import annotations

from app.repository import Appointment, AppointmentRepository, Slot


class SlotTaken(Exception):
    pass


class AvailabilityService:
    def __init__(self, repository: AppointmentRepository):
        self._repository = repository

    def free_slots(self) -> list[Slot]:
        booked = self._repository.booked_slot_ids()
        return [slot for slot in self._repository.slots() if slot.id not in booked]

    def reserve(self, slot_id: str, patient: str) -> Appointment:
        """Books the slot for the patient, or raises SlotTaken if someone already has it."""
        appointment = self._repository.insert(slot_id, patient)
        if appointment is None:
            raise SlotTaken(slot_id)
        return appointment
