package service

import "github.com/zhming0/dsh-yawn/runner/terminal"

// TerminalHandler serves this sandbox's interactive terminals over the same
// tunnel as the rest of the runner's RPCs.
//
// The feature itself lives in runner/terminal; this and the registration in
// main are the whole of its footprint in this package.
func (s *Service) TerminalHandler() *terminal.Handler {
	return terminal.New(terminal.Options{Environment: s.environment})
}
