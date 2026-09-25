package terminal

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
	"github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1/yawnv1connect"
)

const terminalTestTimeout = 30 * time.Second

// testEnvironment stands in for the runner's own environment. The handler takes
// it as a dependency, so these tests care only that the child gets a usable
// PATH and HOME and that the handler adds the terminal type it was asked for.
func testEnvironment(extra map[string]string) []string {
	environment := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
	}
	for name, value := range extra {
		environment = append(environment, name+"="+value)
	}
	return environment
}

// newTerminalClient serves one terminal handler over an in-process HTTP/2
// server, the way the runner serves it over its tunnel.
func newTerminalClient(t *testing.T) yawnv1connect.TerminalServiceClient {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(yawnv1connect.NewTerminalServiceHandler(New(Options{Environment: testEnvironment})))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return yawnv1connect.NewTerminalServiceClient(server.Client(), server.URL)
}

// terminalTestClient drives one Terminal RPC with a single reader, so tests
// can await one response kind at a time while output accumulates.
type terminalTestClient struct {
	t      *testing.T
	stream *connect.BidiStreamForClient[v1.TerminalRequest, v1.TerminalResponse]
	pid    int
	output strings.Builder
	exit   *v1.TerminalExited
}

func startTerminalClient(t *testing.T, start *v1.TerminalStart) *terminalTestClient {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), terminalTestTimeout)
	t.Cleanup(cancel)
	stream := newTerminalClient(t).Terminal(ctx)
	client := &terminalTestClient{t: t, stream: stream}
	client.send(&v1.TerminalRequest{Control: &v1.TerminalRequest_Start{Start: start}})
	client.pid = int(client.await(func(response *v1.TerminalResponse) bool {
		return response.GetStarted() != nil
	}).GetStarted().GetPid())
	if client.pid <= 0 {
		t.Fatalf("started pid = %d", client.pid)
	}
	return client
}

func (c *terminalTestClient) send(control *v1.TerminalRequest) {
	c.t.Helper()
	if err := c.stream.Send(control); err != nil {
		c.t.Fatalf("send: %v", err)
	}
}

func (c *terminalTestClient) input(data string) {
	c.send(&v1.TerminalRequest{Control: &v1.TerminalRequest_Input{Input: []byte(data)}})
}

// receive reads one response, accumulating output and the exit status.
func (c *terminalTestClient) receive() *v1.TerminalResponse {
	c.t.Helper()
	response, err := c.stream.Receive()
	if err != nil {
		c.t.Fatalf("terminal stream ended before the expected response: %v (output %q)", err, c.output.String())
	}
	c.observe(response)
	return response
}

// await reads responses until match accepts one.
func (c *terminalTestClient) await(match func(*v1.TerminalResponse) bool) *v1.TerminalResponse {
	c.t.Helper()
	for {
		response := c.receive()
		if match(response) {
			return response
		}
	}
}

func (c *terminalTestClient) observe(response *v1.TerminalResponse) {
	if output := response.GetOutput(); output != nil {
		c.output.Write(output)
	}
	if exit := response.GetExited(); exit != nil {
		c.exit = exit
	}
	if response.GetClosed() != nil {
		// The provider reports a finished terminal; the client half answers,
		// which is what lets the handler return without resetting the stream.
		if err := c.stream.CloseRequest(); err != nil {
			c.t.Fatalf("close request after closed: %v", err)
		}
	}
}

// awaitOutput waits for want to appear in the accumulated output. The buffer is
// checked before reading: one response can carry more than the await it
// satisfied — a prompt and the command's own output arrive together often
// enough — and the terminal then stays quiet at its prompt, so blocking on
// another response would hang.
func (c *terminalTestClient) awaitOutput(want string) {
	c.t.Helper()
	for !strings.Contains(c.output.String(), want) {
		c.receive()
	}
}

// closeRequest ends the client half and drains the stream to its end.
func (c *terminalTestClient) closeRequest() *v1.TerminalExited {
	c.t.Helper()
	if err := c.stream.CloseRequest(); err != nil {
		c.t.Fatalf("close request: %v", err)
	}
	return c.drain()
}

// drain reads until the server ends the stream, failing when the exit status
// never arrived.
func (c *terminalTestClient) drain() *v1.TerminalExited {
	c.t.Helper()
	for {
		response, err := c.stream.Receive()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			c.t.Fatalf("terminal stream failed: %v", err)
		}
		c.observe(response)
	}
	if c.exit == nil {
		c.t.Fatalf("terminal stream ended without an exit status (output %q)", c.output.String())
	}
	return c.exit
}

func terminalStart(directory string, argv ...string) *v1.TerminalStart {
	return &v1.TerminalStart{
		Argv:         argv,
		Cwd:          directory,
		Rows:         24,
		Cols:         80,
		TerminalType: "xterm-256color",
		GraceMs:      2000,
	}
}

func TestTerminalEchoesInputAndReportsTheExitStatus(t *testing.T) {
	client := startTerminalClient(t, terminalStart(t.TempDir(), "/bin/bash"))

	client.input("echo terminal-ok\n")
	client.awaitOutput("terminal-ok")

	client.input("exit 7\n")
	exit := client.drain()
	if exit.GetExitCode() != 7 {
		t.Fatalf("exit code = %d, want 7", exit.GetExitCode())
	}
}

func TestTerminalUsesTheRequestedDirectoryAndTerminalType(t *testing.T) {
	directory := t.TempDir()
	client := startTerminalClient(t, terminalStart(directory, "/bin/bash"))

	client.input("pwd; echo TERM=$TERM\n")
	client.awaitOutput(directory)
	client.awaitOutput("TERM=xterm-256color")

	client.input("exit\n")
	client.drain()
}

func TestTerminalResizeReportsTheSizeToTheChild(t *testing.T) {
	client := startTerminalClient(t, terminalStart(t.TempDir(), "/bin/bash"))

	client.send(&v1.TerminalRequest{Control: &v1.TerminalRequest_Resize{Resize: &v1.TerminalResize{Cols: 100, Rows: 40}}})
	client.input("stty size\n")
	client.awaitOutput("40 100")

	client.input("exit\n")
	client.drain()
}

func TestTerminalForegroundQueryAndSignal(t *testing.T) {
	client := startTerminalClient(t, terminalStart(t.TempDir(), "/bin/bash"))
	shellPgid := client.pid

	// At the prompt the foreground group is the shell itself.
	client.send(&v1.TerminalRequest{Control: &v1.TerminalRequest_Query{Query: &v1.TerminalQuery{Kind: v1.TerminalQueryKind_TERMINAL_QUERY_KIND_FOREGROUND}}})
	foreground := client.await(func(response *v1.TerminalResponse) bool {
		return response.GetForeground() != nil
	}).GetForeground()
	if !foreground.GetPresent() || int(foreground.GetProcessGroupId()) != shellPgid {
		t.Fatalf("prompt foreground = %+v, want the shell group %d", foreground, shellPgid)
	}

	// A foreground job takes the terminal; SIGINT through TIOCSIG must reach
	// that job and leave the shell's own exit status alone.
	client.input("sleep 30\n")
	jobPgid := 0
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		client.send(&v1.TerminalRequest{Control: &v1.TerminalRequest_Query{Query: &v1.TerminalQuery{Kind: v1.TerminalQueryKind_TERMINAL_QUERY_KIND_FOREGROUND}}})
		candidate := int(client.await(func(response *v1.TerminalResponse) bool {
			return response.GetForeground() != nil
		}).GetForeground().GetProcessGroupId())
		if candidate != shellPgid {
			jobPgid = candidate
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if jobPgid == 0 {
		t.Fatal("sleep never took the foreground")
	}
	client.send(&v1.TerminalRequest{Control: &v1.TerminalRequest_Signal{Signal: "SIGINT"}})
	signaled := client.await(func(response *v1.TerminalResponse) bool {
		return response.GetSignaled() != 0
	}).GetSignaled()
	if int(signaled) != jobPgid {
		t.Fatalf("signaled group = %d, want the foreground job %d", signaled, jobPgid)
	}
	client.input("echo interrupted=$?\n")
	client.awaitOutput("interrupted=130")

	client.input("exit\n")
	client.drain()
}

func TestTerminalActivityIsUnknownAtThePrompt(t *testing.T) {
	session, err := startTerminal(
		terminalStart(t.TempDir(), "/bin/bash"),
		[]string{"PATH=/usr/local/bin:/usr/bin:/bin", "TERM=xterm-256color"},
		time.Second,
	)
	if err != nil {
		t.Fatal(err)
	}
	defer session.terminate()
	// Drain the master the way the RPC handler does, so termination can
	// observe the session going away instead of waiting out its ladder.
	go func() {
		buffer := make([]byte, 4096)
		for {
			if _, err := session.read(buffer); err != nil {
				return
			}
		}
	}()

	if state := session.activity(); state != v1.TerminalActivityState_TERMINAL_ACTIVITY_STATE_UNKNOWN {
		t.Fatalf("activity at the prompt = %v, want unknown", state)
	}
	// The shell owns the foreground at its prompt, so killing it is refused.
	if pgid := session.signal(terminalKillSignal); pgid != 0 {
		t.Fatalf("SIGKILL of the foreground shell was delivered to %d", pgid)
	}
	// A foreground job makes the session provably busy, and that job is a
	// legitimate SIGKILL target.
	if _, err := session.write([]byte("sleep 30\n")); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for session.activity() != v1.TerminalActivityState_TERMINAL_ACTIVITY_STATE_BUSY {
		if !time.Now().Before(deadline) {
			t.Fatal("activity stayed unknown while a foreground job owned the terminal")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if pgid := session.signal(terminalKillSignal); pgid == 0 {
		t.Fatal("SIGKILL of the foreground job was refused")
	}
}

func TestTerminalTerminateKillsTheSession(t *testing.T) {
	client := startTerminalClient(t, terminalStart(t.TempDir(), "/bin/bash"))
	client.input("sleep 60\n")
	time.Sleep(200 * time.Millisecond)

	exit := client.closeRequest()
	if exit.GetExitCode() == 0 && exit.GetSignal() == "" {
		t.Fatalf("terminated terminal reported a clean exit: %+v", exit)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err := syscall.Kill(-client.pid, 0)
		if err == syscall.ESRCH {
			break
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("terminal session %d still exists after terminate: kill = %v", client.pid, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestTerminalRejectsMissingStartAndEmptyArgv(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), terminalTestTimeout)
	defer cancel()

	stream := newTerminalClient(t).Terminal(ctx)
	if err := stream.Send(&v1.TerminalRequest{Control: &v1.TerminalRequest_Input{Input: []byte("x")}}); err != nil {
		t.Fatal(err)
	}
	if err := stream.CloseRequest(); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Receive(); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("control before start: code = %v, err = %v", connect.CodeOf(err), err)
	}

	stream = newTerminalClient(t).Terminal(ctx)
	if err := stream.Send(&v1.TerminalRequest{Control: &v1.TerminalRequest_Start{Start: terminalStart(t.TempDir())}}); err != nil {
		t.Fatal(err)
	}
	if _, err := stream.Receive(); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty argv: code = %v, err = %v", connect.CodeOf(err), err)
	}
}
