package sms

import "fmt"

func Format(r Reminder) string {
	return shorten(fmt.Sprintf("Hi %s, a reminder of your appointment at %s on %s.", r.Patient, r.Clinic, r.Start))
}

// FormatWelsh is for clinics in Wales. Nothing sends it yet.
func FormatWelsh(r Reminder) string {
	return shorten(fmt.Sprintf("Helo %s, nodyn atgoffa am eich apwyntiad yn %s ar %s.", r.Patient, r.Clinic, r.Start))
}

// Not exported, so not traced: only what other components can call is.
func shorten(s string) string {
	if len(s) > 160 {
		return s[:160]
	}
	return s
}
