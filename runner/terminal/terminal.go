// Package terminal serves one sandbox's interactive terminals.
//
// It stands alone on purpose: the RPC lives in its own proto file, the runner's
// service package only wires this one up, and the control plane keeps its half
// in one folder, so deleting those removes the feature and nothing else.
package terminal

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
)

// Options is what a terminal needs from the runner that owns it.
type Options struct {
	// Environment resolves the environment for one command: the sandbox base,
	// the secrets the control plane pushed, then the request's own overrides.
	Environment func(extra map[string]string) []string
}

// Handler serves TerminalService over the runner's tunnel.
type Handler struct {
	environment func(extra map[string]string) []string
}

// New returns the terminal handler for one sandbox.
func New(options Options) *Handler {
	return &Handler{environment: options.Environment}
}

// invalidArgument reports a request the terminal cannot start.
func invalidArgument(err error) error {
	return connect.NewError(connect.CodeInvalidArgument, err)
}

// envValue returns the value env declares for name, or "" when it declares
// none. It is local so this package needs nothing from the service package.
func envValue(env []string, name string) string {
	for _, entry := range env {
		if value, ok := strings.CutPrefix(entry, name+"="); ok {
			return value
		}
	}
	return ""
}

const (
	// Output chunk size for the terminal stream: large enough that RPC framing
	// is noise, small enough that echo is not delayed behind a full buffer of
	// scrollback.
	terminalChunkSize = 32 << 10
	// How many responses the sender may queue before the PTY reader waits.
	terminalEventBuffer = 64
	// TERM-to-KILL grace when a start omits one, and the bounded second wait
	// after SIGKILL for a member that ignored it.
	terminalDefaultGrace = 2 * time.Second
	// Poll interval of the termination ladder's quiescence check.
	terminalQuiescePoll = 20 * time.Millisecond
	// Refused when the terminal shell itself is the foreground group: killing
	// it that way leaves the session without its owner, so callers terminate
	// the session instead.
	terminalKillSignal = "SIGKILL"
)

// Signals the terminal control accepts by name, kept member-identical to
// `SubprocessTerminalSignal` in @deepseek-ai/dsh-subprocess.
var terminalSignals = map[string]syscall.Signal{
	"SIGINT":  syscall.SIGINT,
	"SIGTERM": syscall.SIGTERM,
	"SIGKILL": syscall.SIGKILL,
	"SIGTSTP": syscall.SIGTSTP,
	"SIGHUP":  syscall.SIGHUP,
}

// Terminal runs one interactive terminal session over a bidirectional stream:
// the first request allocates a PTY and starts the command as its session
// leader, later requests write input, resize, query the foreground process
// group or shell activity, and signal that group, while responses carry the
// child's output and one final exit status.
//
// The stream ends when the client ends its half: either it terminates the
// session, or it answers the `closed` event that reports the top-level command
// reaped and no process holding the PTY any more. Terminating runs the
// provider's TERM-to-KILL ladder over the session's process group and then
// closes the master, which hangs up whatever remains; the ladder is a no-op on
// a terminal that already finished. A member that keeps the PTY open after the
// top-level command exits keeps the stream open until the client terminates
// it.
func (h *Handler) Terminal(ctx context.Context, stream *connect.BidiStream[v1.TerminalRequest, v1.TerminalResponse]) error {
	start, err := receiveTerminalStart(stream)
	if err != nil {
		return err
	}
	if len(start.GetArgv()) == 0 {
		return invalidArgument(errors.New("argv is required"))
	}
	if start.GetRows() < 1 || start.GetCols() < 1 {
		return invalidArgument(errors.New("terminal rows and cols must be positive"))
	}
	grace := terminalDefaultGrace
	if start.GetGraceMs() > 0 {
		grace = time.Duration(start.GetGraceMs()) * time.Millisecond
	}
	environment := h.environment(start.GetEnv())
	if envValue(environment, "TERM") == "" && start.GetTerminalType() != "" {
		environment = append(environment, "TERM="+start.GetTerminalType())
	}
	session, err := startTerminal(start, environment, grace)
	if err != nil {
		return invalidArgument(err)
	}
	defer session.close()

	events := newTerminalEvents()
	// One sender owns the response half; it drains the sink until the handler
	// closes it, so no producer can block on a dead stream.
	sendFailure := make(chan error, 1)
	go func() {
		var failure error
		for event := range events.channel() {
			if failure != nil {
				continue
			}
			if err := stream.Send(event); err != nil {
				failure = err
			}
		}
		sendFailure <- failure
	}()

	events.send(&v1.TerminalResponse{Event: &v1.TerminalResponse_Started{Started: &v1.TerminalStarted{Pid: int64(session.pid)}}})

	outputDone := make(chan struct{})
	go func() {
		defer close(outputDone)
		buffer := make([]byte, terminalChunkSize)
		for {
			count, readErr := session.read(buffer)
			if count > 0 {
				chunk := make([]byte, count)
				copy(chunk, buffer[:count])
				events.send(&v1.TerminalResponse{Event: &v1.TerminalResponse_Output{Output: chunk}})
			}
			if readErr != nil {
				return
			}
		}
	}()

	// Exactly one goroutine sends the exit status, so the stream closes only
	// after that response is queued.
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		session.wait()
		events.send(&v1.TerminalResponse{Event: &v1.TerminalResponse_Exited{Exited: session.outcome()}})
	}()

	// The session owns nothing once the command is reaped and no process holds
	// the PTY. Tell the client, which answers by ending its half of the
	// request stream: a handler that returns while a request body is still
	// open resets the HTTP/2 stream, and the client would see a transport
	// failure instead of a finished terminal.
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		<-exited
		<-outputDone
		events.send(&v1.TerminalResponse{Event: &v1.TerminalResponse_Closed{Closed: &v1.TerminalClosed{}}})
	}()

	controlsDone := make(chan error, 1)
	go func() {
		controlsDone <- receiveTerminalControls(stream, session, events)
	}()

	// The client ends its half either when it terminates the session or in
	// answer to the closed event; both mean every remaining session member
	// goes, and the ladder is a no-op on a terminal that already finished.
	receiveErr := <-controlsDone
	session.terminate()
	session.wait()
	<-exited
	<-outputDone
	<-closed
	events.close()
	if failure := <-sendFailure; failure != nil {
		return failure
	}
	if receiveErr != nil {
		return receiveErr
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return nil
}

// receiveTerminalStart reads the mandatory first request. Anything before it
// is a protocol violation, not a terminal to interpret.
func receiveTerminalStart(stream *connect.BidiStream[v1.TerminalRequest, v1.TerminalResponse]) (*v1.TerminalStart, error) {
	for {
		message, err := stream.Receive()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, invalidArgument(errors.New("no terminal start"))
			}
			return nil, err
		}
		if start := message.GetStart(); start != nil {
			return start, nil
		}
	}
}

// receiveTerminalControls applies every control until the client half ends.
// A nil error means the client closed its half: the caller must then terminate
// the session. Query and signal controls always answer, in control order, so
// the client can pair replies without correlation ids.
func receiveTerminalControls(
	stream *connect.BidiStream[v1.TerminalRequest, v1.TerminalResponse],
	session *terminalSession,
	events *terminalEvents,
) error {
	for {
		message, err := stream.Receive()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		switch control := message.GetControl().(type) {
		case *v1.TerminalRequest_Input:
			if _, err := session.write(control.Input); err != nil {
				return err
			}
		case *v1.TerminalRequest_Resize:
			if err := session.resize(int(control.Resize.GetCols()), int(control.Resize.GetRows())); err != nil {
				return err
			}
		case *v1.TerminalRequest_Query:
			events.send(session.answer(control.Query))
		case *v1.TerminalRequest_Signal:
			events.send(&v1.TerminalResponse{Event: &v1.TerminalResponse_Signaled{Signaled: int32(session.signal(control.Signal))}})
		}
	}
}

// terminalEvents is the response queue shared by the output pump, the exit
// watcher, and the control loop. Sends after close are dropped, which is what
// lets the handler finish while a control read may still be in flight.
type terminalEvents struct {
	mu     sync.Mutex
	closed bool
	events chan *v1.TerminalResponse
}

func newTerminalEvents() *terminalEvents {
	return &terminalEvents{events: make(chan *v1.TerminalResponse, terminalEventBuffer)}
}

func (e *terminalEvents) channel() <-chan *v1.TerminalResponse {
	return e.events
}

func (e *terminalEvents) send(event *v1.TerminalResponse) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.events <- event
}

func (e *terminalEvents) close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	e.closed = true
	close(e.events)
}

// terminalSession is one PTY-backed command and every session member that
// still holds the terminal.
type terminalSession struct {
	pid    int
	master *os.File
	cmd    *exec.Cmd
	grace  time.Duration

	waitOnce   sync.Once
	exited     chan struct{}
	outcomeVal *v1.TerminalExited

	terminateOnce sync.Once
	closeOnce     sync.Once
	// Set by the output pump once the master reports the last slave closed.
	masterGone atomic.Bool
}

// read delivers bytes the session wrote. An error means the last process
// holding the terminal is gone: on Linux the master read then fails with EIO.
func (t *terminalSession) read(buffer []byte) (int, error) {
	count, err := t.master.Read(buffer)
	if err != nil {
		t.masterGone.Store(true)
	}
	return count, err
}

func (t *terminalSession) write(data []byte) (int, error) {
	return t.master.Write(data)
}

func (t *terminalSession) resize(cols, rows int) error {
	if cols < 1 || rows < 1 {
		return errors.New("terminal cols and rows must be positive")
	}
	return setPTYSize(t.master, cols, rows)
}

func (t *terminalSession) foreground() (int, bool) {
	return ptyForeground(t.master)
}

// answer replies to one query. Every query produces exactly one response, so
// an unrecognized kind still answers and the reply order stays aligned.
func (t *terminalSession) answer(query *v1.TerminalQuery) *v1.TerminalResponse {
	if query.GetKind() == v1.TerminalQueryKind_TERMINAL_QUERY_KIND_FOREGROUND {
		pgid, ok := t.foreground()
		return &v1.TerminalResponse{Event: &v1.TerminalResponse_Foreground{Foreground: &v1.TerminalForeground{
			Present:        ok,
			ProcessGroupId: int32(pgid),
		}}}
	}
	return &v1.TerminalResponse{Event: &v1.TerminalResponse_Activity{Activity: &v1.TerminalActivity{State: t.activity()}}}
}

// activity reports what this provider can prove. Idle needs the terminal to be
// gone; a foreground group other than the shell proves busy work; a shell
// waiting at its prompt is unknown, because proving a prompt needs shell
// integration this runner does not have.
func (t *terminalSession) activity() v1.TerminalActivityState {
	if t.masterGone.Load() {
		return v1.TerminalActivityState_TERMINAL_ACTIVITY_STATE_IDLE
	}
	if pgid, ok := t.foreground(); ok && pgid != t.pid {
		return v1.TerminalActivityState_TERMINAL_ACTIVITY_STATE_BUSY
	}
	return v1.TerminalActivityState_TERMINAL_ACTIVITY_STATE_UNKNOWN
}

// signal delivers one named signal to the current foreground group and answers
// that group's id, or zero when no group received it. Delivery goes through
// kill(2) rather than TIOCSIG: the terminal driver only accepts the signals it
// can generate itself, so SIGTERM and SIGKILL would fail there. SIGKILL of the
// terminal shell itself is refused: kill the session instead.
func (t *terminalSession) signal(name string) int {
	signal, ok := terminalSignals[name]
	if !ok {
		return 0
	}
	pgid, ok := t.foreground()
	if !ok {
		return 0
	}
	if name == terminalKillSignal && pgid == t.pid {
		return 0
	}
	if err := signalPTYGroup(pgid, signal); err != nil {
		return 0
	}
	return pgid
}

// wait blocks until the top-level command has been reaped.
func (t *terminalSession) wait() {
	t.waitOnce.Do(func() {
		commandError := t.cmd.Wait()
		outcome := v1.TerminalExited{}
		if commandError != nil {
			var exitError *exec.ExitError
			if errors.As(commandError, &exitError) {
				outcome.ExitCode = int32(exitError.ExitCode())
				if status, ok := exitError.Sys().(syscall.WaitStatus); ok && status.Signaled() {
					outcome.Signal = status.Signal().String()
				}
			} else {
				// The command never ran to a status; report the conventional
				// failure code the exec path uses for the same situation.
				outcome.ExitCode = -1
			}
		}
		t.outcomeVal = &outcome
		close(t.exited)
	})
}

func (t *terminalSession) outcome() *v1.TerminalExited {
	<-t.exited
	return t.outcomeVal
}

// terminate runs the provider's TERM-to-KILL ladder over the session and waits
// for it to become quiescent, then closes the master. Closing the master
// unblocks the output pump and hangs up every remaining member.
func (t *terminalSession) terminate() {
	t.terminateOnce.Do(func() {
		_ = terminatePTYGroup(t.pid, syscall.SIGTERM)
		if !t.waitQuiescent(t.grace) {
			_ = terminatePTYGroup(t.pid, syscall.SIGKILL)
			t.waitQuiescent(terminalDefaultGrace)
		}
		t.close()
	})
}

// waitQuiescent reports whether the command was reaped and no process holds
// the terminal before the bounded wait elapses.
func (t *terminalSession) waitQuiescent(limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for {
		select {
		case <-t.exited:
			if t.masterGone.Load() {
				return true
			}
		default:
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(terminalQuiescePoll)
	}
}

func (t *terminalSession) close() {
	t.closeOnce.Do(func() {
		_ = t.master.Close()
	})
}
