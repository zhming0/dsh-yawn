package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-yawn/runner/gen/dsh/yawn/v1"
)

// Servers started by session commands share the runner's network namespace,
// so the sandbox's loopback is this process's loopback and nothing else.
const proxyLoopback = "127.0.0.1"

// The request body is collected before the sandbox server is contacted, so a
// preview upload is capped like every other buffered transfer between the
// host and a sandbox. Responses stream; this cap is requests only.
const maxProxyRequestBody = int64(32 << 20)

// Body chunk size for the streamed response. Large enough that framing
// overhead is noise, small enough that the tunnel keeps flowing frame-by-frame
// under a slow browser connection.
const proxyChunkSize = 64 << 10

// proxyClient is shared by every proxied request; the default transport
// already pools loopback connections.
var proxyClient = &http.Client{
	// The browser follows redirects, not the proxy: passing a 3xx through
	// leaves Location exactly where the sandbox server sent it.
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// Headers not copied in either direction: hop-by-hop headers describe the
// connection of one hop, and lengths are the relay's to state, since the
// bytes it moves are re-chunked by the RPC framing underneath.
var proxyHopByHopHeaders = []string{
	"Connection",
	"Content-Length",
	"Expect",
	"Host",
	"Keep-Idle",
	"Keep-Alive",
	"Proxy-Connection",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

// HttpProxy relays one browser request to a server on the sandbox's loopback.
// The whole request is read before the server is contacted — connect handler
// streams need not be safe for concurrent use, so Receive and Send never
// overlap — while the response is relayed as it arrives.
func (s *Service) HttpProxy(ctx context.Context, stream *connect.BidiStream[v1.HttpProxyRequest, v1.HttpProxyResponse]) error {
	head, err := receiveProxyHead(stream)
	if err != nil {
		return err
	}
	if head.GetPort() < 1 || head.GetPort() > 65535 {
		return cerr(connect.CodeInvalidArgument, errors.New("port must be between 1 and 65535"))
	}
	if !strings.HasPrefix(head.GetTarget(), "/") {
		return cerr(connect.CodeInvalidArgument, errors.New("target must start with /"))
	}
	body, err := receiveProxyBody(stream)
	if err != nil {
		return err
	}

	request, err := http.NewRequestWithContext(
		ctx,
		head.GetMethod(),
		"http://"+net.JoinHostPort(proxyLoopback, strconv.Itoa(int(head.GetPort())))+head.GetTarget(),
		bytes.NewReader(body),
	)
	if err != nil {
		return cerr(connect.CodeInvalidArgument, err)
	}
	request.ContentLength = int64(len(body))
	for _, header := range head.GetHeaders() {
		name := http.CanonicalHeaderKey(header.GetName())
		if skipProxyHeader(name) {
			continue
		}
		request.Header.Add(name, header.GetValue())
	}

	response, err := proxyClient.Do(request)
	if err != nil {
		// Nothing listening is the common failure: the server the session
		// started is gone or was never started.
		return cerr(connect.CodeUnavailable, err)
	}
	defer func() { _ = response.Body.Close() }()

	reply := &v1.HttpProxyResponseHead{Status: int32(response.StatusCode)}
	for name, values := range response.Header {
		if skipProxyHeader(name) {
			continue
		}
		for _, value := range values {
			reply.Headers = append(reply.Headers, &v1.HttpProxyHeader{Name: name, Value: value})
		}
	}
	if err := stream.Send(&v1.HttpProxyResponse{Part: &v1.HttpProxyResponse_Head{Head: reply}}); err != nil {
		return err
	}

	// A HEAD response carries headers only; its body reads as empty.
	buffer := make([]byte, proxyChunkSize)
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			chunk := make([]byte, count)
			copy(chunk, buffer[:count])
			if err := stream.Send(&v1.HttpProxyResponse{Part: &v1.HttpProxyResponse_Body{Body: chunk}}); err != nil {
				return err
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) && ctx.Err() == nil {
				return cerr(connect.CodeInternal, readErr)
			}
			break
		}
	}
	return nil
}

// receiveProxyHead reads messages until the head arrives; anything else first
// is a protocol violation, not a request to interpret.
func receiveProxyHead(stream *connect.BidiStream[v1.HttpProxyRequest, v1.HttpProxyResponse]) (*v1.HttpProxyRequestHead, error) {
	for {
		message, err := stream.Receive()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil, cerr(connect.CodeInvalidArgument, errors.New("no request head"))
			}
			return nil, err
		}
		if head := message.GetHead(); head != nil {
			return head, nil
		}
	}
}

// receiveProxyBody collects the body chunks that follow the head, up to the
// buffered-transfer cap.
func receiveProxyBody(stream *connect.BidiStream[v1.HttpProxyRequest, v1.HttpProxyResponse]) ([]byte, error) {
	var body []byte
	for {
		message, err := stream.Receive()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return body, nil
			}
			return nil, err
		}
		if chunk := message.GetBody(); chunk != nil {
			if int64(len(body)+len(chunk)) > maxProxyRequestBody {
				return nil, cerr(connect.CodeResourceExhausted, errors.New("preview request body exceeds 32 MiB"))
			}
			body = append(body, chunk...)
		}
	}
}

func skipProxyHeader(name string) bool {
	for _, hop := range proxyHopByHopHeaders {
		if strings.EqualFold(name, hop) {
			return true
		}
	}
	return false
}
