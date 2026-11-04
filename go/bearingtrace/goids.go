package bearingtrace

import (
	"bytes"
	"runtime"
	"strconv"
)

// goids returns the calling goroutine's ID and the ID of the goroutine that started it, 0 for the main goroutine.
//
// This version reads them from the goroutine's stack trace, which costs microseconds a call and more the deeper
// the stack. Where it can, `bearing-go overlay` replaces this file with one that reads them from the runtime
// directly (see rewrite.FastGoids); it can't when the toolchain is one the go command downloaded into the module
// cache, which Go 1.25 and later won't let an overlay change.
func goids() (id, parent uint64) {
	buf := make([]byte, 4096)
	for {
		n := runtime.Stack(buf, false)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	// "goroutine 7 [running]:\n…\ncreated by main.f in goroutine 1\n\t…"
	id = number(buf[len("goroutine "):])
	if at := bytes.LastIndex(buf, []byte(" in goroutine ")); at >= 0 {
		parent = number(buf[at+len(" in goroutine "):])
	}
	return id, parent
}

func number(b []byte) uint64 {
	end := 0
	for end < len(b) && b[end] >= '0' && b[end] <= '9' {
		end++
	}
	n, _ := strconv.ParseUint(string(b[:end]), 10, 64)
	return n
}
