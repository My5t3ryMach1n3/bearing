package integration

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"chairside.example/reminder-worker/internal/consumer"
	"chairside.example/reminder-worker/internal/schedule"
	"chairside.example/reminder-worker/internal/sms"
	"chairside.example/reminder-worker/internal/store"
)

// fakeQueue stands in for SQS: it hands out its messages once, then blocks until ctx is done.
type fakeQueue struct {
	mu       sync.Mutex
	messages []consumer.Message
	drained  chan struct{}
}

func (q *fakeQueue) Receive(ctx context.Context) ([]consumer.Message, error) {
	q.mu.Lock()
	m := q.messages
	q.messages = nil
	q.mu.Unlock()
	if m != nil {
		return m, nil
	}
	select {
	case q.drained <- struct{}{}:
	default:
	}
	<-ctx.Done()
	return nil, nil
}

// fakeTwilio stands in for Twilio.
type fakeTwilio struct {
	mu   sync.Mutex
	sent []string
}

func (t *fakeTwilio) Post(to, body string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.sent = append(t.sent, to)
	return nil
}

func confirmed(t *testing.T, a schedule.Appointment) consumer.Message {
	body, err := json.Marshal(a)
	if err != nil {
		t.Fatal(err)
	}
	return consumer.Message{Type: "appointment.confirmed", Body: body}
}

type worker struct {
	twilio    *fakeTwilio
	scheduler *schedule.Scheduler
}

// start runs the consumer in its own goroutine, as the worker's main does, and waits until it has drained the queue.
func start(t *testing.T, now time.Time, messages ...consumer.Message) worker {
	twilio := &fakeTwilio{}
	scheduler := schedule.New(func() time.Time { return now }, sms.NewSender(twilio), store.New())
	queue := &fakeQueue{messages: messages, drained: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	done := consumer.New(queue, scheduler).Run(ctx)
	<-queue.drained
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})
	return worker{twilio, scheduler}
}

func TestReminders(t *testing.T) {
	now := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)
	appointment := schedule.Appointment{
		ID: "a1", Patient: "Ana", Phone: "+447700900001", Clinic: "Leeds", Start: now.Add(23 * time.Hour),
	}

	t.Run("#3/AC1 sends an SMS 24 hours before the appointment", func(t *testing.T) {
		w := start(t, now, confirmed(t, appointment))
		if sent := w.scheduler.RunDue(); sent != 1 {
			t.Fatalf("sent %d reminders, want 1", sent)
		}
	})

	t.Run("#3/AC2 waits until 24 hours before", func(t *testing.T) {
		later := appointment
		later.Start = now.Add(48 * time.Hour)
		w := start(t, now, confirmed(t, later))
		if sent := w.scheduler.RunDue(); sent != 0 {
			t.Fatalf("sent %d reminders, want 0", sent)
		}
	})

	t.Run("#3/AC3 sends each reminder once", func(t *testing.T) {
		w := start(t, now, confirmed(t, appointment), confirmed(t, appointment))
		w.scheduler.RunDue()
		if len(w.twilio.sent) != 1 {
			t.Fatalf("sent %d messages, want 1", len(w.twilio.sent))
		}
	})
}
