"""Knows which slots are free, and is the only code that reserves one."""

from __future__ import annotations

from app.repository import AppointmentRepository, Slot


class SlotTaken(Exception):
    pass


class AvailabilityService:
    def __init__(self, repository: AppointmentRepository):
        self._repository = repository

    def free_slots(self) -> list[Slot]:
        booked = self._repository.booked_slot_ids()
        return [slot for slot in self._repository.slots() if slot.id not in booked]

    def is_free(self, slot_id: str) -> bool:
        return slot_id not in self._repository.booked_slot_ids()
