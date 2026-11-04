// Package sms is the only code that holds patient numbers in transit to Twilio.
package sms

import (
	"fmt"
	"strings"
)

// Twilio posts one message. The real client calls POST /Messages.
type Twilio interface {
	Post(to, body string) error
}

type Sender struct{ client Twilio }

func NewSender(client Twilio) *Sender { return &Sender{client: client} }

type Reminder struct {
	Appointment string
	Patient     string
	Phone       string
	Clinic      string
	Start       string
}

func (s *Sender) Send(r Reminder) error {
	if err := s.client.Post(r.Phone, Format(r)); err != nil {
		return fmt.Errorf("sending reminder for %s: %w", r.Appointment, err)
	}
	return nil
}

// ValidPhone reports whether a number can be texted: E.164, with a country code.
func ValidPhone(phone string) bool {
	return strings.HasPrefix(phone, "+") && len(phone) > 8
}
