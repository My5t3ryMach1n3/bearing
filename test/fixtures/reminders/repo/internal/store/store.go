// Package store records which reminders have been sent.
package store

import "sync"

type Store struct {
	mu   sync.Mutex
	sent map[string]bool
}

func New() *Store { return &Store{sent: map[string]bool{}} }

func (s *Store) MarkSent(appointment string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent[appointment] = true
}

func (s *Store) WasSent(appointment string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sent[appointment]
}
