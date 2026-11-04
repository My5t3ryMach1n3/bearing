// Package schedule holds reminders until 24 hours before each appointment.
package schedule

import (
	"sync"
	"time"

	"chairside.example/reminder-worker/internal/sms"
	"chairside.example/reminder-worker/internal/store"
)

type Appointment struct {
	ID      string    `json:"id"`
	Patient string    `json:"patient"`
	Phone   string    `json:"phone"`
	Clinic  string    `json:"clinic"`
	Start   time.Time `json:"start"`
}

type Scheduler struct {
	now     func() time.Time
	sender  *sms.Sender
	store   *store.Store
	mu      sync.Mutex
	pending []Appointment
}

func New(now func() time.Time, sender *sms.Sender, store *store.Store) *Scheduler {
	return &Scheduler{now: now, sender: sender, store: store}
}

func (s *Scheduler) Schedule(a Appointment) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pending = append(s.pending, a)
}

// RunDue sends every reminder whose appointment starts within 24 hours, once.
func (s *Scheduler) RunDue() int {
	s.mu.Lock()
	due, rest := split(s.pending, s.now().Add(24*time.Hour))
	s.pending = rest
	s.mu.Unlock()
	sent := 0
	for _, a := range due {
		if s.store.WasSent(a.ID) {
			continue
		}
		err := s.sender.Send(sms.Reminder{
			Appointment: a.ID, Patient: a.Patient, Phone: a.Phone, Clinic: a.Clinic,
			Start: a.Start.Format("Mon 2 Jan 15:04"),
		})
		if err == nil {
			s.store.MarkSent(a.ID)
			sent++
		}
	}
	return sent
}

func split(pending []Appointment, until time.Time) (due, rest []Appointment) {
	for _, a := range pending {
		if a.Start.After(until) {
			rest = append(rest, a)
		} else {
			due = append(due, a)
		}
	}
	return due, rest
}
