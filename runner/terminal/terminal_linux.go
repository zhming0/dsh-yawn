//go:build linux

package terminal

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
)

// startTerminal allocates a PTY and starts argv as its session leader with the
// slave as the controlling terminal, so the command runs interactively: the
// line discipline owns signal generation, the foreground process group, and
// the window size. The master is opened non-blocking and wrapped with
// os.NewFile, which puts it on Go's poller: reads then unblock on close instead
// of stranding the pump goroutine.
func startTerminal(start *v1.TerminalStart, environment []string, grace time.Duration) (*terminalSession, error) {
	master, slave, err := openPTY()
	if err != nil {
		return nil, err
	}
	if err := setPTYSize(master, int(start.GetCols()), int(start.GetRows())); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, err
	}
	argv := start.GetArgv()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = start.GetCwd()
	cmd.Env = environment
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	// Ctty names a descriptor in the child: the slave is index 0 of its
	// stdio, so the child gets the PTY as fd 0 and as its controlling
	// terminal.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0}
	if err := cmd.Start(); err != nil {
		_ = master.Close()
		_ = slave.Close()
		return nil, err
	}
	// The child holds its own duplicate; the parent's would keep the last
	// slave open and hide the master's end of the session.
	_ = slave.Close()
	return &terminalSession{
		pid:    cmd.Process.Pid,
		master: master,
		cmd:    cmd,
		grace:  grace,
		exited: make(chan struct{}),
	}, nil
}

// openPTY returns the master and slave ends of a new pseudo-terminal by
// opening the multiplexer and its numbered slave.
func openPTY() (*os.File, *os.File, error) {
	fd, err := unix.Open("/dev/ptmx", unix.O_RDWR|unix.O_NOCTTY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, fmt.Errorf("open /dev/ptmx: %w", err)
	}
	master := os.NewFile(uintptr(fd), "/dev/ptmx")
	// Recent kernels hand out unlocked masters; unlocking is still required
	// by the documented interface and harmless when it is already done.
	if err := unix.IoctlSetPointerInt(fd, unix.TIOCSPTLCK, 0); err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("unlock pty: %w", err)
	}
	number, err := unix.IoctlGetInt(fd, unix.TIOCGPTN)
	if err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("read pty number: %w", err)
	}
	slave, err := os.OpenFile(fmt.Sprintf("/dev/pts/%d", number), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		_ = master.Close()
		return nil, nil, fmt.Errorf("open pty slave: %w", err)
	}
	return master, slave, nil
}

func setPTYSize(master *os.File, cols, rows int) error {
	return unix.IoctlSetWinsize(int(master.Fd()), unix.TIOCSWINSZ, &unix.Winsize{Row: uint16(rows), Col: uint16(cols)})
}

func ptyForeground(master *os.File) (int, bool) {
	pgid, err := unix.IoctlGetInt(int(master.Fd()), unix.TIOCGPGRP)
	return pgid, err == nil && pgid > 0
}

// signalPTYGroup signals one resolved foreground process group.
func signalPTYGroup(pgid int, signal syscall.Signal) error {
	return unix.Kill(-pgid, signal)
}

// terminatePTYGroup signals every process in the session leader's group.
// Members that left the group escape this range; closing the master hangs up
// whatever still holds the terminal.
func terminatePTYGroup(pid int, signal syscall.Signal) error {
	return unix.Kill(-pid, signal)
}
