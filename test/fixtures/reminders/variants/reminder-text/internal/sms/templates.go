package sms

import "fmt"

func Format(r Reminder) string {
	return shorten(fmt.Sprintf("Hi %s, a reminder of your appointment at %s on %s. Reply STOP to opt out.", r.Patient, r.Clinic, r.Start))
}

// Not exported, so not traced: only what other components can call is.
func shorten(s string) string {
	if len(s) > 160 {
		return s[:160]
	}
	return s
}
