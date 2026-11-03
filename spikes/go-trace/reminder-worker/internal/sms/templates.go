package sms

import "fmt"

func Format(r Reminder) string {
	return fmt.Sprintf("Hi %s, a reminder of your appointment at %s on %s.", r.Patient, r.Clinic, r.Start)
}

// Not reached by any criterion: the surplus check should flag it.
func FormatWelsh(r Reminder) string {
	return fmt.Sprintf("Helo %s, nodyn atgoffa am eich apwyntiad yn %s ar %s.", r.Patient, r.Clinic, r.Start)
}

func shorten(s string) string {
	if len(s) > 160 {
		return s[:160]
	}
	return s
}
