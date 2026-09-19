package service

import (
	"slices"
	"testing"
)

// The shape of /proc/net/tcp and /proc/net/tcp6, including rows that must not
// become preview candidates: established connections, a UDP socket (which
// lives in /proc/net/udp, but a malformed row guards the parser anyway), the
// header, and a truncated line.
const procNetTCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27183 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27184 1 0000000000000000 100 0 0 10 0
   2: 0100007F:0BB8 0100007F:9C4E 01 00000000:00000000 00:00000000 00000000  1000        0 27185 1 0000000000000000 20 4 30 10 -1
   3: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 27186 1 0000000000000000 100 0 0 10 0
   4: 00000000:0000 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27187 1 0000000000000000 100 0 0 10 0
   5: 0100007F:0050 00000000:0000 0A
`

const procNetTCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 27188 1 0000000000000000 100 0 0 10 0
`

func TestParseListeningPorts(t *testing.T) {
	got := parseListeningPorts([]byte(procNetTCP), []byte(procNetTCP6))
	// LISTEN rows only, ascending and deduplicated: 22 (0016), 80 (0050),
	// 3000 (0BB8), 8080 (1F90), 8081 (1F91). Port 0 is not a target, and the
	// established row and the header contribute nothing.
	want := []int32{22, 80, 3000, 8080, 8081}
	if !slices.Equal(got, want) {
		t.Fatalf("ports = %v, want %v", got, want)
	}
}

func TestParseListeningPortsWithoutProcNet(t *testing.T) {
	if got := parseListeningPorts(); len(got) != 0 {
		t.Fatalf("ports = %v, want none", got)
	}
}

func TestWithoutPortDropsOnlyTheHealthListener(t *testing.T) {
	ports := parseListeningPorts([]byte(procNetTCP))
	kept := withoutPort(ports, 8080)
	if slices.Contains(kept, 8080) {
		t.Fatalf("health port survived: %v", kept)
	}
	if !slices.Contains(kept, 3000) {
		t.Fatalf("session port missing: %v", kept)
	}
	if withoutPort(ports, 0)[0] != 22 {
		t.Fatalf("excluding an absent port changed the list: %v", withoutPort(ports, 0))
	}
}

func TestHealthPortDefaults(t *testing.T) {
	t.Setenv("ADDR", "")
	if got := healthPort(); got != 8080 {
		t.Fatalf("default health port = %d", got)
	}
	t.Setenv("ADDR", "127.0.0.1:9000")
	if got := healthPort(); got != 9000 {
		t.Fatalf("configured health port = %d", got)
	}
	t.Setenv("ADDR", "not-an-address")
	if got := healthPort(); got != 0 {
		t.Fatalf("unparseable health port = %d", got)
	}
}
