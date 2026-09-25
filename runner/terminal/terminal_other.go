//go:build !linux

package terminal

import (
	"errors"
	"os"
	"syscall"
	"time"

	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
)

// Every released runner sandbox is a Linux image, and the PTY contract this
// service implements is Linux-specific (controlling terminals, TIOCGPGRP,
// TIOCSIG). These stubs keep the module buildable on other development
// platforms; a terminal request refuses loudly instead of half-working.

var errTerminalUnsupported = errors.New("interactive terminals require a Linux runner")

func startTerminal(_ *v1.TerminalStart, _ []string, _ time.Duration) (*terminalSession, error) {
	return nil, errTerminalUnsupported
}

func setPTYSize(_ *os.File, _, _ int) error {
	return errTerminalUnsupported
}

func ptyForeground(_ *os.File) (int, bool) {
	return 0, false
}

func signalPTYGroup(_ int, _ syscall.Signal) error {
	return errTerminalUnsupported
}

func terminatePTYGroup(_ int, _ syscall.Signal) error {
	return errTerminalUnsupported
}
