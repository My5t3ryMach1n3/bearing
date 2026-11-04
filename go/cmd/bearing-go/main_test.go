package main

import "testing"

func TestOverlayable(t *testing.T) {
	for _, c := range []struct {
		name string
		t    toolchain
		want bool
	}{
		{"installed", toolchain{goroot: "/usr/local/go", gomodcache: "/home/a/go/pkg/mod", minor: 26}, true},
		{"downloaded before 1.25", toolchain{goroot: "/home/a/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.24.9.linux-amd64",
			gomodcache: "/home/a/go/pkg/mod", minor: 24}, true},
		{"downloaded", toolchain{goroot: "/home/a/go/pkg/mod/golang.org/toolchain@v0.0.1-go1.25.3.linux-amd64",
			gomodcache: "/home/a/go/pkg/mod", minor: 25}, false},
		{"downloaded development build", toolchain{goroot: "/home/a/go/pkg/mod/golang.org/toolchain@x",
			gomodcache: "/home/a/go/pkg/mod"}, false},
		{"beside the module cache", toolchain{goroot: "/home/a/go/pkg/modules/go", gomodcache: "/home/a/go/pkg/mod",
			minor: 26}, true},
	} {
		if got := c.t.overlayable(); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}
