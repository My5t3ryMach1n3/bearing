// Package consumer reads appointment events off the SQS queue.
package consumer

import (
	"context"
	"encoding/json"

	"chairside.example/reminder-worker/internal/schedule"
)

type Message struct {
	Type string          `json:"type"`
	Body json.RawMessage `json:"body"`
}

// Queue is SQS ReceiveMessage.
type Queue interface {
	Receive(ctx context.Context) ([]Message, error)
}

type Consumer struct {
	queue     Queue
	scheduler *schedule.Scheduler
}

func New(queue Queue, scheduler *schedule.Scheduler) *Consumer {
	return &Consumer{queue: queue, scheduler: scheduler}
}

// Run polls until ctx is done, in its own goroutine.
func (c *Consumer) Run(ctx context.Context) <-chan error {
	done := make(chan error, 1)
	go func() {
		for ctx.Err() == nil {
			if err := c.Poll(ctx); err != nil {
				done <- err
				return
			}
		}
		done <- nil
	}()
	return done
}

func (c *Consumer) Poll(ctx context.Context) error {
	messages, err := c.queue.Receive(ctx)
	if err != nil {
		return err
	}
	for _, m := range messages {
		if m.Type != "appointment.confirmed" {
			continue
		}
		var a schedule.Appointment
		if err := json.Unmarshal(m.Body, &a); err != nil {
			return err
		}
		c.scheduler.Schedule(a)
	}
	return nil
}
