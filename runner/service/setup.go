package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
)

// aptCacheLimitBytes bounds the .deb cache the workspace volume carries. The
// cache only changes how long a setup takes, never what it produces, so the
// cap trades wake speed for volume space.
const aptCacheLimitBytes = 2 << 30

// setupErrorTailBytes bounds how much of a failed command's output a setup
// error quotes. The command's streams still reach the runner's own logs in
// full; this is only what a caller sees, and a failing install can print more
// than an error needs.
const setupErrorTailBytes = 4 << 10

func (s *Service) run(ctx context.Context, dir string, argv ...string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir, cmd.Env = dir, s.environment(nil)
	cmd.SysProcAttr = processGroup()
	stdout := &tailBuffer{limit: setupErrorTailBytes}
	stderr := &tailBuffer{limit: setupErrorTailBytes}
	// Writers make os/exec copy through pipes, and Wait drains those pipes
	// before returning. A process the setup command left behind can hold them
	// open, so bound that drain: the command itself has already exited.
	cmd.Stdout = io.MultiWriter(os.Stdout, stdout)
	cmd.Stderr = io.MultiWriter(os.Stderr, stderr)
	cmd.WaitDelay = execPipeDrainGrace
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("%s: %w", commandLabel(argv), err)
	}
	var commandError error
	done := make(chan struct{})
	go func() {
		commandError = cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
		// ErrWaitDelay means the command exited successfully and only a
		// process it left behind kept a pipe open past the grace.
		if commandError == nil || errors.Is(commandError, exec.ErrWaitDelay) {
			return nil
		}
		return commandFailure(argv, commandError, stdout.String(), stderr.String())
	case <-ctx.Done():
		terminateProcessGroup(cmd.Process.Pid, done)
		return ctx.Err()
	}
}

// commandLabel names a setup command in an error without repeating its
// arguments, which can carry a repository URL or a credential.
func commandLabel(argv []string) string {
	if argv[0] == "git" && len(argv) > 1 {
		return "git " + argv[1]
	}
	base := filepath.Base(argv[0])
	parent := filepath.Base(filepath.Dir(argv[0]))
	if parent == "." || parent == string(filepath.Separator) {
		return base
	}
	return parent + "/" + base
}

// commandFailure reports a setup command that exited unsuccessfully, naming
// the command and quoting the end of what it printed. Without the output the
// caller sees only "exit status 1" and cannot tell a stale lockfile from an
// unreachable host.
func commandFailure(argv []string, err error, stdout, stderr string) error {
	sections := make([]string, 0, 2)
	for _, section := range []struct{ name, text string }{
		{"stdout", strings.TrimSpace(stdout)},
		{"stderr", strings.TrimSpace(stderr)},
	} {
		if section.text != "" {
			sections = append(sections, section.name+":\n"+section.text)
		}
	}
	if len(sections) == 0 {
		return fmt.Errorf("%s: %w", commandLabel(argv), err)
	}
	return fmt.Errorf("%s: %w\n%s", commandLabel(argv), err, strings.Join(sections, "\n"))
}

// tailBuffer keeps the last limit bytes written to it. limit must be positive.
type tailBuffer struct {
	limit         int
	data          []byte
	startsMidLine bool
}

func (b *tailBuffer) Write(chunk []byte) (int, error) {
	if len(chunk) > b.limit {
		// The whole window now comes from this chunk, so the byte before it
		// decides whether the window begins at a line boundary.
		b.startsMidLine = b.limit > 0 && chunk[len(chunk)-b.limit-1] != '\n'
		b.data = append(b.data[:0], chunk[len(chunk)-b.limit:]...)
		return len(chunk), nil
	}
	b.data = append(b.data, chunk...)
	if excess := len(b.data) - b.limit; excess > 0 {
		// The window now begins after the dropped bytes, so the byte just
		// dropped decides whether it begins mid-line.
		b.startsMidLine = b.data[excess-1] != '\n'
		copy(b.data, b.data[excess:])
		b.data = b.data[:b.limit]
	}
	return len(chunk), nil
}

// String returns the kept bytes. When the cut left a partial first line, it is
// dropped so the text starts at a line boundary; a window with no line
// boundary left is returned whole, since dropping it would lose everything.
func (b *tailBuffer) String() string {
	text := string(b.data)
	if b.startsMidLine {
		if cut := strings.IndexByte(text, '\n'); cut >= 0 {
			text = text[cut+1:]
		}
	}
	return text
}

// markerPath is the durable record that this machine ran the repository's
// setup. It sits on the machine's own filesystem, not on the workspace volume:
// a rebuilt machine has no marker and so runs setup again, while a machine
// that stayed alive keeps the marker and skips setup. Nothing trusts the
// marker beyond that — a repository can run its own setup by hand anyway.
func (s *Service) markerPath() string {
	return filepath.Join(s.stateDir, "setup-done")
}

// aptCacheDir mirrors Dir::Cache::Archives in the image's
// /etc/apt/apt.conf.d/90-dsh-yawn. It sits beside the checkout on the workspace
// volume, so a machine rebuilt around that volume re-installs the same
// packages without downloading them again.
func (s *Service) aptCacheDir() string {
	return filepath.Join(s.volumeRoot, ".dsh-yawn", "apt-cache")
}

// setupHookPath resolves a repository's `.agents/setup` hook and returns it
// only when it exists and is executable. It runs once per machine, which may
// be long after the checkout was made, so it must be safe to re-run.
func setupHookPath(workspace string) (string, bool) {
	path := filepath.Join(workspace, ".agents", "setup")
	info, err := os.Stat(path)
	if err != nil || info.Mode()&0111 == 0 {
		return "", false
	}
	return path, true
}

func (s *Service) Setup(ctx context.Context, request *connect.Request[v1.SetupRequest]) (*connect.Response[v1.SetupResponse], error) {
	workspace := request.Msg.Workspace
	if workspace == "" {
		workspace = defaultWorkspace
	}
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		return nil, cerr(connect.CodeInvalidArgument, err)
	}
	if err := os.MkdirAll(workspace, 0755); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	marker := s.markerPath()
	unlock := s.lock(marker)
	defer unlock()
	// The state directory belongs to the runner image and the machine it runs
	// on. Creating it here fails before any hook runs if the machine cannot
	// record that setup completed.
	if err := os.MkdirAll(s.stateDir, 0755); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	if err := s.run(ctx, workspace, "git", "config", "--global", "credential.helper", "!dsh-yawn-runner git-credential"); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}

	// A present marker means this machine already ran setup. The workspace and
	// the home directory keep what setup made, and a rebuilt machine has no
	// marker, so there is nothing to re-run here.
	if _, markerError := os.Stat(marker); markerError == nil {
		return connect.NewResponse(&v1.SetupResponse{Ran: false}), nil
	} else if !os.IsNotExist(markerError) {
		return nil, cerr(connect.CodeInternal, markerError)
	}

	// The marker used to live in the repository's .git, on the workspace
	// volume. A workspace that predates the move still carries one; it decided
	// nothing here, and removing it keeps a rolled-back image from acting on a
	// stale record.
	legacyMarker := filepath.Join(workspace, ".git", ".agents-setup-done")
	if err := os.Remove(legacyMarker); err != nil && !os.IsNotExist(err) {
		return nil, cerr(connect.CodeInternal, err)
	}

	// A repository's setup may install system packages, and apt downloads the
	// .deb files into the workspace volume. A fresh volume has neither the
	// cache directory nor apt's partial directory under it.
	if err := os.MkdirAll(filepath.Join(s.aptCacheDir(), "partial"), 0755); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}

	// New machine: initialize the repository if needed, then run setup.
	_, gitError := os.Stat(filepath.Join(workspace, ".git"))
	if gitError != nil && !os.IsNotExist(gitError) {
		return nil, cerr(connect.CodeInternal, gitError)
	}
	cloned := false
	// Without a repository URL the workspace is never cloned into: it starts
	// empty and keeps whatever the session puts there, across wakes too.
	if os.IsNotExist(gitError) && request.Msg.RepositoryUrl != "" {
		entries, readError := os.ReadDir(workspace)
		if readError != nil {
			return nil, cerr(connect.CodeInternal, readError)
		}
		if len(entries) != 0 {
			return nil, cerr(connect.CodeFailedPrecondition, errors.New("workspace is not empty"))
		}
		if err := s.run(ctx, filepath.Dir(workspace), "git", "clone", request.Msg.RepositoryUrl, workspace); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
		cloned = true
	}
	// Only move the checkout to the requested revision on a fresh clone. A
	// pre-initialized workspace must not have its working tree reset by a
	// revision it did not just request.
	if cloned && request.Msg.Revision != "" {
		if err := s.run(ctx, workspace, "git", "checkout", request.Msg.Revision); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
	}
	// Only a repository's own hook runs. Without one the workspace holds what
	// the session wrote, and a file it happened to name `.agents/setup` is not
	// setup.
	if path, ok := setupHookPath(workspace); ok && request.Msg.RepositoryUrl != "" {
		if err := s.run(ctx, workspace, path); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
	}
	// The marker is written only after setup succeeded, so a failed setup runs
	// again on the next start instead of being remembered as done.
	if err := atomicWrite(marker, []byte("complete\n"), 0644); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	s.trimAptCache(ctx)
	return connect.NewResponse(&v1.SetupResponse{Ran: true}), nil
}

// trimAptCache drops the .deb files the configured sources no longer offer,
// then clears the cache outright when it is still over the cap. Every failure
// is ignored: the cache only changes how long a setup takes, so a machine
// whose cache could not be trimmed still has a working setup.
func (s *Service) trimAptCache(ctx context.Context) {
	cache := s.aptCacheDir()
	debs, err := filepath.Glob(filepath.Join(cache, "*.deb"))
	if err != nil || len(debs) == 0 {
		return
	}
	_ = s.run(ctx, s.volumeRoot, "sudo", "-n", "apt-get", "-qq", "autoclean")
	cached, err := directoryBytes(cache)
	if err == nil && cached > aptCacheLimitBytes {
		_ = s.run(ctx, s.volumeRoot, "sudo", "-n", "apt-get", "-qq", "clean")
	}
}

// directoryBytes is the total size of the regular files under root.
func directoryBytes(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, walkError error) error {
		if walkError != nil {
			return walkError
		}
		if entry.IsDir() {
			return nil
		}
		info, infoError := entry.Info()
		if infoError != nil {
			return infoError
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	return total, err
}

func processGroup() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
