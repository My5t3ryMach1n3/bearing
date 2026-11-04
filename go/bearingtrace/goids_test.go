package bearingtrace

import "testing"

func TestGoidsFromTheStack(t *testing.T) {
	id, parent := goids()
	if id == 0 || parent == 0 {
		t.Fatalf("got %d, %d; want both set for a test's goroutine", id, parent)
	}
	done := make(chan [2]uint64)
	go func() {
		child, childParent := goids()
		done <- [2]uint64{child, childParent}
	}()
	if got := <-done; got[1] != id || got[0] == id {
		t.Fatalf("child got %v, want a new ID with parent %d", got, id)
	}
}

func TestCriterion(t *testing.T) {
	for _, c := range []struct{ name, tag, want string }{
		{"TestReminders/#3/AC1_sends_an_SMS", "#<issue>/AC<n>", "#3/AC1"},
		{"TestReminders/#12/AC10", "#<issue>/AC<n>", "#12/AC10"},
		{"TestReminders/AC2_of_#3_waits", "AC<n> of #<issue>", "AC2 of #3"},
		{"TestReminders/[#3/AC1]", "[#<issue>/AC<n>]", "[#3/AC1]"},
		{"TestReminders/[#3/AC1", "[#<issue>/AC<n>]", ""},
		{"TestReminders/#3/ACx", "#<issue>/AC<n>", ""},
		{"TestFormat", "#<issue>/AC<n>", ""},
	} {
		if got := criterion(c.name, parseTag(c.tag)); got != c.want {
			t.Errorf("criterion(%q, %q) = %q, want %q", c.name, c.tag, got, c.want)
		}
	}
}
