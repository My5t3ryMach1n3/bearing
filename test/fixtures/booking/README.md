# Booking fixture

Chairside's booking API from the [worked example](https://claude.ai/code/artifact/4b47956a-6da1-4208-a2cf-df0dd14c2e04), cut down to two requirements, for the Python adapter ([#28](https://github.com/My5t3ryMach1n3/bearing/issues/28)). It plays the part the [basket fixture](../basket/README.md) plays for TypeScript and the [reminders fixture](../reminders/README.md) plays for Go: a FastAPI app with a known target, so the real checks can run on real traces.

| Path | What it is |
| --- | --- |
| `issues.json` | Requirements #1, "Book an open slot", and #5, "Never book one slot twice", with two criteria each |
| `repo/` | The clean repo: what main looks like |
| `workspace.json` | `repo/architecture/workspace.dsl` as the pinned Structurizr exports it |
| `variants/<name>/` | Seeded branches, as files laid over `repo/` |

## The repo

- `architecture/workspace.dsl` is the approved target. It has four components in the booking API container, each with a `bearing.path` under `app/`, and a dynamic view for each requirement. Booking always goes through the availability service's `reserve()`, the only code that takes a slot.
- `app/` has one package per component. Each package's `__init__.py` re-exports from a module inside it, so imports have to be followed to the file that declares what they use. Routes are module-level functions on an `APIRouter`, one of them async, and take the services through `Depends`.
- `tests/test_booking.py` has one test per criterion, each tagged with a `@pytest.mark.req("#5/AC1")` marker, and drives the app through FastAPI's `TestClient`. `tests/test_slots.py` has an untagged unit test and a skipped test, neither of which counts as evidence.
- `pyproject.toml` puts the repo root on pytest's `pythonpath`, which is also where Bearing resolves absolute imports from. `.bearing/config.yaml` lists one Python project at the repo root and runs `python3 -m pytest -q`.

## Variants

Each variant is a branch that implements an issue and passes its own tests, with an honest claims file except where the claim is what's wrong.

| Variant | What it does | What should catch it |
| --- | --- | --- |
| `slot-labels` | Labels each open slot with its day, time and clinician | Nothing: every check passes |
| `routes-read-repository` | The appointment route reads the repository itself. Its claim says nothing structural changed | Claim and Boundaries: an undeclared `bookingRoutes -> appointmentRepository`. Trace paths too, since #1/AC2's trace makes the call |
| `slot-check-in-route` | The worked example's "right boundaries, wrong place": the route checks the slot is free, then the booking service inserts the appointment itself | Trace paths only: every call is declared and every test passes, but #5's tests never take `bookingService -> availabilityService` |
| `untraced-helper` | Adds a method to find the nearest free slots that nothing calls | Surplus (advisory): `AvailabilityService.nearest_free_slots` is never reached by a tagged test |

`copyBooking()` and `bookingRepo()` in [`test/booking.ts`](../../booking.ts) copy the repo, lay a variant over it and commit it on a branch. [`test/python.test.ts`](../../python.test.ts) runs `bearing test` and the checks on each.
