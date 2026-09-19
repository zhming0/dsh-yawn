package service

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
	"github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1/yawnv1connect"
)

// A full proxied exchange over the real handler and client, the same shape
// the tunnel drives: head, body chunks, response head, response chunks.
func TestHttpProxyRoundTrip(t *testing.T) {
	type served struct {
		method, target string
		headers        http.Header
		body           string
	}
	got := make(chan served, 1)
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got <- served{method: r.Method, target: r.URL.RequestURI(), headers: r.Header.Clone(), body: string(body)}
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Add("Set-Cookie", "a=1")
		w.Header().Add("Set-Cookie", "b=2")
		w.WriteHeader(http.StatusTeapot)
		_, _ = w.Write([]byte("hello from the sandbox"))
	}))
	defer origin.Close()
	port := portOf(t, origin)

	s := New("box")
	mux := http.NewServeMux()
	mux.Handle(yawnv1connect.NewRunnerServiceHandler(s))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	client := yawnv1connect.NewRunnerServiceClient(server.Client(), server.URL)

	proxy := func(head *v1.HttpProxyRequestHead, body ...[]byte) (int, http.Header, string) {
		stream := client.HttpProxy(context.Background())
		if err := stream.Send(&v1.HttpProxyRequest{Part: &v1.HttpProxyRequest_Head{Head: head}}); err != nil {
			t.Fatal(err)
		}
		for _, chunk := range body {
			if err := stream.Send(&v1.HttpProxyRequest{Part: &v1.HttpProxyRequest_Body{Body: chunk}}); err != nil {
				t.Fatal(err)
			}
		}
		if err := stream.CloseRequest(); err != nil {
			t.Fatal(err)
		}
		status := 0
		headers := http.Header{}
		var chunks []string
		for {
			message, err := stream.Receive()
			if err != nil {
				if !errors.Is(err, io.EOF) {
					t.Fatal(err)
				}
				break
			}
			switch part := message.GetPart().(type) {
			case *v1.HttpProxyResponse_Head:
				status = int(part.Head.GetStatus())
				for _, header := range part.Head.GetHeaders() {
					headers.Add(header.GetName(), header.GetValue())
				}
			case *v1.HttpProxyResponse_Body:
				chunks = append(chunks, string(part.Body))
			}
		}
		return status, headers, strings.Join(chunks, "")
	}

	headersIn := []*v1.HttpProxyHeader{
		{Name: "Host", Value: "dsh.example.com"},
		{Name: "content-type", Value: "text/plain"},
		{Name: "Connection", Value: "keep-alive"},
	}
	status, headers, body := proxy(&v1.HttpProxyRequestHead{
		Method:  http.MethodPost,
		Target:  "/app/echo?q=1",
		Port:    int32(port),
		Headers: headersIn,
	}, []byte("one "), []byte("two"))
	if status != http.StatusTeapot {
		t.Fatalf("status = %d", status)
	}
	if headers.Get("Content-Type") != "text/plain" {
		t.Fatalf("content type = %q", headers.Get("Content-Type"))
	}
	if len(headers.Values("Set-Cookie")) != 2 {
		t.Fatalf("set-cookie = %v", headers.Values("Set-Cookie"))
	}
	if body != "hello from the sandbox" {
		t.Fatalf("body = %q", body)
	}
	saw := <-got
	if saw.method != http.MethodPost || saw.target != "/app/echo?q=1" {
		t.Fatalf("origin saw %s %s", saw.method, saw.target)
	}
	if saw.body != "one two" {
		t.Fatalf("origin body = %q", saw.body)
	}
	if saw.headers.Get("Content-Type") != "text/plain" {
		t.Fatalf("origin content type = %q", saw.headers.Get("Content-Type"))
	}
	if saw.headers.Get("Connection") != "" || saw.headers.Get("Host") != "" {
		t.Fatalf("hop-by-hop headers reached the origin: %v", saw.headers)
	}

	// A GET with no body chunks still relays.
	if status, _, body = proxy(&v1.HttpProxyRequestHead{Method: http.MethodGet, Target: "/", Port: int32(port)}); status != http.StatusTeapot || body != "hello from the sandbox" {
		t.Fatalf("get: status = %d body = %q", status, body)
	}
}

func TestHttpProxyPassesRedirectsThrough(t *testing.T) {
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Location", "/login")
		w.WriteHeader(http.StatusSeeOther)
	}))
	defer origin.Close()

	s := New("box")
	mux := http.NewServeMux()
	mux.Handle(yawnv1connect.NewRunnerServiceHandler(s))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	client := yawnv1connect.NewRunnerServiceClient(server.Client(), server.URL)

	stream := client.HttpProxy(context.Background())
	if err := stream.Send(&v1.HttpProxyRequest{Part: &v1.HttpProxyRequest_Head{Head: &v1.HttpProxyRequestHead{
		Method: http.MethodGet, Target: "/", Port: int32(portOf(t, origin)),
	}}}); err != nil {
		t.Fatal(err)
	}
	if err := stream.CloseRequest(); err != nil {
		t.Fatal(err)
	}
	head := (*v1.HttpProxyResponseHead)(nil)
	for {
		message, err := stream.Receive()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				t.Fatal(err)
			}
			break
		}
		if h := message.GetHead(); h != nil {
			head = h
		}
	}
	if head.GetStatus() != http.StatusSeeOther {
		t.Fatalf("redirect status = %d", head.GetStatus())
	}
	// Headers arrive in map order, so find the one that matters by name.
	if location := headerValue(head.GetHeaders(), "Location"); location != "/login" {
		t.Fatalf("redirect location = %q (%+v)", location, head)
	}
}

func TestHttpProxyNothingListening(t *testing.T) {
	s := New("box")
	mux := http.NewServeMux()
	mux.Handle(yawnv1connect.NewRunnerServiceHandler(s))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	client := yawnv1connect.NewRunnerServiceClient(server.Client(), server.URL)

	// Port 1 has no listener on the loopback in test environments.
	stream := client.HttpProxy(context.Background())
	if err := stream.Send(&v1.HttpProxyRequest{Part: &v1.HttpProxyRequest_Head{Head: &v1.HttpProxyRequestHead{
		Method: http.MethodGet, Target: "/", Port: 1,
	}}}); err != nil {
		t.Fatal(err)
	}
	if err := stream.CloseRequest(); err != nil {
		t.Fatal(err)
	}
	var streamError error
	for {
		_, err := stream.Receive()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				streamError = err
			}
			break
		}
	}
	if connect.CodeOf(streamError) != connect.CodeUnavailable {
		t.Fatalf("code = %v (%v)", connect.CodeOf(streamError), streamError)
	}
}

func TestHttpProxyValidatesTheHead(t *testing.T) {
	s := New("box")
	mux := http.NewServeMux()
	mux.Handle(yawnv1connect.NewRunnerServiceHandler(s))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	client := yawnv1connect.NewRunnerServiceClient(server.Client(), server.URL)

	cases := []struct {
		name string
		head *v1.HttpProxyRequestHead
		code connect.Code
	}{
		{"zero port", &v1.HttpProxyRequestHead{Method: http.MethodGet, Target: "/"}, connect.CodeInvalidArgument},
		{"port over 65535", &v1.HttpProxyRequestHead{Method: http.MethodGet, Target: "/", Port: 65536}, connect.CodeInvalidArgument},
		{"target without slash", &v1.HttpProxyRequestHead{Method: http.MethodGet, Target: "http://elsewhere/", Port: 80}, connect.CodeInvalidArgument},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			stream := client.HttpProxy(context.Background())
			if err := stream.Send(&v1.HttpProxyRequest{Part: &v1.HttpProxyRequest_Head{Head: c.head}}); err != nil {
				t.Fatal(err)
			}
			if err := stream.CloseRequest(); err != nil {
				t.Fatal(err)
			}
			var streamError error
			for {
				_, err := stream.Receive()
				if err != nil {
					if !errors.Is(err, io.EOF) {
						streamError = err
					}
					break
				}
			}
			if connect.CodeOf(streamError) != c.code {
				t.Fatalf("code = %v (%v)", connect.CodeOf(streamError), streamError)
			}
		})
	}
}

func headerValue(headers []*v1.HttpProxyHeader, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.GetName(), name) {
			return header.GetValue()
		}
	}
	return ""
}

func portOf(t *testing.T, server *httptest.Server) int {
	t.Helper()
	_, port, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	number, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	return number
}
