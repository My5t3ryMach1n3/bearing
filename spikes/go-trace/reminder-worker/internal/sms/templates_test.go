package sms

import "testing"

func TestFormat(t *testing.T) {
	got := Format(Reminder{Patient: "Ana", Clinic: "Leeds", Start: "Tue 3 Nov 09:00"})
	if got != "Hi Ana, a reminder of your appointment at Leeds on Tue 3 Nov 09:00." {
		t.Fatal(got)
	}
}

func TestSkipped(t *testing.T) { t.Skip("shows a skipped record") }

// Measures the hook's cost per traced call: Format is traced, shorten is not.
func BenchmarkFormat(b *testing.B) {
	r := Reminder{Patient: "Ana", Clinic: "Leeds", Start: "Tue 3 Nov 09:00"}
	for i := 0; i < b.N; i++ {
		Format(r)
	}
}

// The runtime reads the goroutine's stack on every call, so cost grows with stack depth. This calls Format from 50
// frames down, a typical depth inside an HTTP handler or an SQS consumer.
func BenchmarkFormatDeep(b *testing.B) {
	r := Reminder{Patient: "Ana", Clinic: "Leeds", Start: "Tue 3 Nov 09:00"}
	var deep func(int)
	deep = func(n int) {
		if n > 0 {
			deep(n - 1)
			return
		}
		for i := 0; i < b.N; i++ {
			Format(r)
		}
	}
	deep(50)
}
