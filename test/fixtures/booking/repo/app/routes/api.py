"""The HTTP API."""

from __future__ import annotations

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from pydantic import BaseModel

from app.availability import AvailabilityService, SlotTaken
from app.booking import BookingService

router = APIRouter()


class BookingRequest(BaseModel):
    slot_id: str
    patient: str


def _availability(request: Request) -> AvailabilityService:
    return request.app.state.availability


def _booking(request: Request) -> BookingService:
    return request.app.state.booking


@router.get("/slots")
async def list_slots(availability: AvailabilityService = Depends(_availability)) -> list[dict]:
    return [{"id": slot.id, "clinician": slot.clinician, "start": slot.start} for slot in availability.free_slots()]


@router.post("/appointments", status_code=201)
def book(body: BookingRequest, booking: BookingService = Depends(_booking)) -> dict:
    try:
        appointment = booking.book(body.slot_id, body.patient)
    except SlotTaken:
        raise HTTPException(409, "Slot taken") from None
    return {"id": appointment.id, "slot_id": appointment.slot_id, "patient": appointment.patient}


@router.get("/appointments/{appointment_id}")
def get_appointment(appointment_id: str, booking: BookingService = Depends(_booking)) -> dict:
    appointment = booking.get(appointment_id)
    if appointment is None:
        raise HTTPException(404, "No such appointment")
    return {"id": appointment.id, "slot_id": appointment.slot_id, "patient": appointment.patient}


def create_app(booking: BookingService, availability: AvailabilityService) -> FastAPI:
    app = FastAPI(title="Chairside booking API")
    app.state.booking = booking
    app.state.availability = availability
    app.include_router(router)
    return app
