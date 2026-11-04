package sms

import "testing"

// A unit test with no criterion tag: its calls never count as evidence.
func TestFormat(t *testing.T) {
	got := Format(Reminder{Patient: "Ana", Clinic: "Leeds", Start: "Tue 3 Nov 09:00"})
	if got != "Hi Ana, a reminder of your appointment at Leeds on Tue 3 Nov 09:00. Reply STOP to opt out." {
		t.Fatal(got)
	}
}

func TestSkipped(t *testing.T) { t.Skip("shows a skipped record") }
