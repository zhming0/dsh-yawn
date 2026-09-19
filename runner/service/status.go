package service

import (
	"context"
	"math"
	"net"
	"os"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
)

// The Sandbox tab's machine facts. Everything here is read from the sandbox
// machine itself, so it holds whatever the backend gave this sandbox: a
// container limit on Docker, a pod's resource limit on Kubernetes. The host
// adds the lifecycle facts it owns around this response.
func (s *Service) SandboxStatus(_ context.Context, _ *connect.Request[v1.SandboxStatusRequest]) (*connect.Response[v1.SandboxStatusResponse], error) {
	workspaceUsed, workspaceTotal := diskUsage(defaultWorkspace)
	filesystemUsed, filesystemTotal := diskUsage("/")
	return connect.NewResponse(&v1.SandboxStatusResponse{
		SandboxId:                s.sandboxID,
		Hostname:                 hostname(),
		OsName:                   osName(),
		KernelVersion:            kernelVersion(),
		Architecture:             runtime.GOARCH,
		CpuCount:                 cpuCount(),
		MemoryTotalBytes:         memoryTotal(),
		WorkspaceDiskUsedBytes:   workspaceUsed,
		WorkspaceDiskTotalBytes:  workspaceTotal,
		FilesystemDiskUsedBytes:  filesystemUsed,
		FilesystemDiskTotalBytes: filesystemTotal,
		UptimeSeconds:            int64(time.Since(s.startedAt).Seconds()),
		ListeningPorts:           listeningPorts(),
	}), nil
}

// Ports the sandbox has a listening TCP socket on, which is where a server the
// session started shows up. The runner's own health listener answers from the
// same namespace; it is infrastructure, not a preview candidate, so it is
// left out.
func listeningPorts() []int32 {
	var sources [][]byte
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		if raw, err := os.ReadFile(path); err == nil {
			sources = append(sources, raw)
		}
	}
	return withoutPort(parseListeningPorts(sources...), healthPort())
}

// The parse is a fact; dropping the runner's own listener is a policy the
// caller decides, which is what makes it testable without a real /proc.
func withoutPort(ports []int32, excluded int) []int32 {
	kept := make([]int32, 0, len(ports))
	for _, port := range ports {
		if int(port) != excluded {
			kept = append(kept, port)
		}
	}
	return kept
}

// The port the health listener binds, from the same ADDR the process reads.
func healthPort() int {
	address := os.Getenv("ADDR")
	if address == "" {
		address = ":8080"
	}
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return 0
	}
	value, err := strconv.Atoi(port)
	if err != nil {
		return 0
	}
	return value
}

// Parse the LISTEN rows of /proc/net/tcp and /proc/net/tcp6, ascending and
// deduplicated. Any machine that does not answer with the expected shape
// contributes nothing rather than an error: this is a hint for the Preview
// tab, not a fact the session depends on.
func parseListeningPorts(sources ...[]byte) []int32 {
	var ports []int32
	for _, raw := range sources {
		for line := range strings.SplitSeq(string(raw), "\n") {
			fields := strings.Fields(line)
			// sl local_address rem_address st ...
			if len(fields) < 4 || fields[3] != "0A" {
				continue
			}
			_, portHex, ok := strings.Cut(fields[1], ":")
			if !ok {
				continue
			}
			port, err := strconv.ParseInt(portHex, 16, 32)
			if err != nil || port < 1 || port > 65535 {
				continue
			}
			ports = append(ports, int32(port))
		}
	}
	slices.Sort(ports)
	return slices.Compact(ports)
}

func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}

// The Linux distribution from os-release, so a Debian runner image and a
// Fedora one do not both read as "linux".
func osName() string {
	raw, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return ""
	}
	for line := range strings.SplitSeq(string(raw), "\n") {
		value, ok := strings.CutPrefix(line, "PRETTY_NAME=")
		if !ok {
			continue
		}
		return strings.Trim(strings.TrimSpace(value), `"`)
	}
	return ""
}

func kernelVersion() string {
	var uname syscall.Utsname
	if err := syscall.Uname(&uname); err != nil {
		return ""
	}
	return charsToString(uname.Release[:])
}

// A Utsname field is an int8 array whose trailing zeroes are padding, not
// content, so it is only ever read up to the first NUL.
func charsToString(chars []int8) string {
	var builder strings.Builder
	for _, char := range chars {
		if char == 0 {
			break
		}
		builder.WriteByte(byte(char))
	}
	return builder.String()
}

// The CPU budget an operator configured, which can be far below the machine's
// core count. Without a quota the count is the process-visible one.
func cpuCount() int32 {
	raw, err := os.ReadFile("/sys/fs/cgroup/cpu.max")
	if err != nil {
		return int32(runtime.NumCPU())
	}
	fields := strings.Fields(string(raw))
	if len(fields) != 2 || fields[0] == "max" {
		return int32(runtime.NumCPU())
	}
	quota, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return int32(runtime.NumCPU())
	}
	period, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil || quota <= 0 || period <= 0 {
		return int32(runtime.NumCPU())
	}
	// cgroup rounds the quota up to whole cores, and so does this.
	return int32(min((quota+period-1)/period, math.MaxInt32))
}

// Memory the sandbox may use: the cgroup limit when one is set, the machine's
// total otherwise. A cgroup reports "max" when it sets no limit.
func memoryTotal() int64 {
	if limit, ok := readInt64File("/sys/fs/cgroup/memory.max"); ok {
		return limit
	}
	return memoryTotalFromProc()
}

func memoryTotalFromProc() int64 {
	raw, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for line := range strings.SplitSeq(string(raw), "\n") {
		rest, ok := strings.CutPrefix(line, "MemTotal:")
		if !ok {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) == 0 {
			return 0
		}
		kilobytes, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			return 0
		}
		return kilobytes * 1024
	}
	return 0
}

func readInt64File(path string) (int64, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	value, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil || value <= 0 {
		return 0, false
	}
	return value, true
}

// Used and total bytes of the filesystem holding path. Zeroes when the
// machine will not answer, which the browser renders as unavailable.
func diskUsage(path string) (used int64, total int64) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0
	}
	blockSize := int64(stat.Bsize)
	total = int64(stat.Blocks) * blockSize
	free := int64(stat.Bfree) * blockSize
	if total < free {
		free = total
	}
	return total - free, total
}
