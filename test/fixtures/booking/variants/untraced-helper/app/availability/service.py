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

    def nearest_free_slots(self, slot_id: str, limit: int = 3) -> list[Slot]:
        """The free slots closest in time to one that's taken, to offer instead."""
        slots = self._repository.slots()
        taken = next((slot for slot in slots if slot.id == slot_id), None)
        if taken is None:
            return []
        return sorted((slot for slot in self.free_slots()), key=lambda slot: abs(_minutes(slot.start) - _minutes(taken.start)))[:limit]

    def reserve(self, slot_id: str, patient: str) -> Appointment:
        """Books the slot for the patient, or raises SlotTaken if someone already has it."""
        appointment = self._repository.insert(slot_id, patient)
        if appointment is None:
            raise SlotTaken(slot_id)
        return appointment


def _minutes(start: str) -> int:
    hours, minutes = start.split("T")[1].split(":")
    return int(hours) * 60 + int(minutes)
