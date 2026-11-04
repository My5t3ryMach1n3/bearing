"""Stores slots and appointments. In-memory here; Postgres in production, where an exclusion constraint on the
appointment's slot does what the lock does."""

from __future__ import annotations

import itertools
import threading
from dataclasses import dataclass


@dataclass(frozen=True)
class Slot:
    id: str
    clinician: str
    start: str


@dataclass(frozen=True)
class Appointment:
    id: str
    slot_id: str
    patient: str


class AppointmentRepository:
    def __init__(self, slots: list[Slot]):
        self._slots = list(slots)
        self._appointments: dict[str, Appointment] = {}
        self._ids = itertools.count(1)
        self._lock = threading.Lock()

    def slots(self) -> list[Slot]:
        return list(self._slots)

    def booked_slot_ids(self) -> set[str]:
        with self._lock:
            return {appointment.slot_id for appointment in self._appointments.values()}

    def insert(self, slot_id: str, patient: str) -> Appointment | None:
        """Adds an appointment, or returns None if the slot already has one."""
        with self._lock:
            if any(appointment.slot_id == slot_id for appointment in self._appointments.values()):
                return None
            appointment = Appointment(f"a{next(self._ids)}", slot_id, patient)
            self._appointments[appointment.id] = appointment
            return appointment

    def get(self, appointment_id: str) -> Appointment | None:
        with self._lock:
            return self._appointments.get(appointment_id)
