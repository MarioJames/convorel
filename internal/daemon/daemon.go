// Package daemon hosts the single writer and command registry.
package daemon

import (
	"context"
	"errors"
	"github.com/MarioJames/convorel/internal/rpc"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// Result lets a successful JSON payload carry a pending or failed outcome.
type Result struct {
	Value    any
	ExitCode int
}
type Handler func(context.Context, rpc.Request) (any, error)
type StreamHandler func(context.Context, rpc.Request, func(any) error) (any, error)
type Server struct {
	mu          sync.RWMutex
	handlers    map[string]Handler
	streams     map[string]StreamHandler
	listener    net.Listener
	cancel      context.CancelFunc
	stateLock   *os.File
	connections map[net.Conn]struct{}
	wg          sync.WaitGroup
}

func New() *Server {
	s := &Server{handlers: map[string]Handler{}, streams: map[string]StreamHandler{}, connections: map[net.Conn]struct{}{}}
	s.Register("ping", func(context.Context, rpc.Request) (any, error) {
		return map[string]any{"ok": true, "version": rpc.Version}, nil
	})
	s.Register("version", func(context.Context, rpc.Request) (any, error) { return map[string]any{"version": rpc.Version}, nil })
	return s
}
func (s *Server) Register(name string, h Handler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.handlers[name] = h
}
func (s *Server) RegisterStream(name string, h StreamHandler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.streams[name] = h
}
func (s *Server) Dispatch(ctx context.Context, r rpc.Request) rpc.Response {
	s.mu.RLock()
	h := s.handlers[r.Command]
	s.mu.RUnlock()
	if h == nil {
		return rpc.ErrorResponse(rpc.NewError("UNKNOWN_COMMAND", r.Command))
	}
	v, e := h(ctx, r)
	if e != nil {
		return rpc.ErrorResponse(e)
	}
	return response(r.ID, v)
}

// Listen elects this server as the single daemon for stateDir by taking a
// non-blocking exclusive flock on the state directory itself. The election
// creates no lock file; the kernel releases the lock when the process dies.
// Holding the lock proves no other daemon owns stateDir, so a socket path left
// behind by a hard kill is stale and can be replaced.
func (s *Server) Listen(stateDir string) error {
	if e := os.MkdirAll(stateDir, 0700); e != nil {
		return e
	}
	if e := os.Chmod(stateDir, 0700); e != nil {
		return e
	}
	lock, e := os.Open(stateDir)
	if e != nil {
		return e
	}
	for {
		e = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if e != syscall.EINTR {
			break
		}
	}
	if e != nil {
		_ = lock.Close()
		if errors.Is(e, syscall.EWOULDBLOCK) || errors.Is(e, syscall.EAGAIN) {
			return rpc.NewError("DAEMON_ALREADY_RUNNING", stateDir)
		}
		return e
	}
	path := filepath.Join(stateDir, "convorel.sock")
	if e = os.Remove(path); e != nil && !errors.Is(e, os.ErrNotExist) {
		_ = lock.Close()
		return e
	}
	l, e := net.Listen("unix", path)
	if e != nil {
		_ = lock.Close()
		return e
	}
	if e = os.Chmod(path, 0600); e != nil {
		_ = l.Close()
		_ = lock.Close()
		return e
	}
	s.mu.Lock()
	s.listener = l
	s.stateLock = lock
	s.mu.Unlock()
	return nil
}
func (s *Server) Serve(ctx context.Context) error {
	if s.listener == nil {
		return errors.New("daemon: Listen must precede Serve")
	}
	ctx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	s.cancel = cancel
	s.mu.Unlock()
	defer cancel()
	stop := context.AfterFunc(ctx, func() {
		_ = s.listener.Close()
		s.mu.Lock()
		for c := range s.connections {
			_ = c.Close()
		}
		s.mu.Unlock()
	})
	defer stop()
	defer s.wg.Wait()
	for {
		c, e := s.listener.Accept()
		if e != nil {
			if ctx.Err() != nil {
				return nil
			}
			return e
		}
		s.mu.Lock()
		if ctx.Err() != nil {
			s.mu.Unlock()
			c.Close()
			return nil
		}
		s.connections[c] = struct{}{}
		s.mu.Unlock()
		s.wg.Add(1)
		go s.handle(ctx, c)
	}
}
func (s *Server) Close() error {
	s.mu.RLock()
	cancel := s.cancel
	listener := s.listener
	lock := s.stateLock
	s.mu.RUnlock()
	if cancel != nil {
		cancel()
	}
	var first error
	// Close the listener first: it unlinks the socket while the state lock is
	// still held, so a successor cannot bind the path and then lose it to us.
	if listener != nil {
		if e := listener.Close(); e != nil && !errors.Is(e, net.ErrClosed) {
			first = e
		}
	}
	if lock != nil {
		if e := lock.Close(); e != nil && !errors.Is(e, os.ErrClosed) && first == nil {
			first = e
		}
	}
	return first
}
func (s *Server) handle(root context.Context, c net.Conn) {
	defer s.wg.Done()
	defer c.Close()
	defer func() { s.mu.Lock(); delete(s.connections, c); s.mu.Unlock() }()
	_ = c.SetReadDeadline(time.Now().Add(rpc.DefaultTimeout))
	var req rpc.Request
	if e := rpc.Read(rpc.Reader(c), &req); e != nil {
		code := "INVALID_REQUEST"
		if errors.Is(e, rpc.ErrFrameTooLarge) {
			code = "RPC_FRAME_TOO_LARGE"
		}
		_ = rpc.Write(c, rpc.ErrorResponse(rpc.NewError(code, e.Error())))
		return
	}
	deadline := req.Deadline
	if deadline.IsZero() {
		deadline = time.Now().Add(rpc.DefaultTimeout)
	}
	ctx, cancel := context.WithDeadline(root, deadline)
	defer cancel()
	_ = c.SetWriteDeadline(deadline)
	s.mu.RLock()
	h := s.streams[req.Command]
	s.mu.RUnlock()
	var res rpc.Response
	if h != nil && req.Stream {
		v, e := h(ctx, req, func(v any) error { return rpc.Write(c, rpc.Response{ID: req.ID, Result: v, Done: false}) })
		if e != nil {
			res = rpc.ErrorResponse(e)
		} else {
			res = response(req.ID, v)
		}
	} else {
		res = s.Dispatch(ctx, req)
	}
	res.ID = req.ID
	_ = rpc.Write(c, res)
}

func response(id string, v any) rpc.Response {
	code := 0
	if result, ok := v.(Result); ok {
		v = result.Value
		code = result.ExitCode
	}
	return rpc.Response{ID: id, Result: v, ExitCode: code, Done: true}
}
