package rpc

import (
	"bufio"
	"errors"
	"net"
	"strings"
	"testing"
)

func TestReaderBufferIsBounded(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	if size := Reader(client).Size(); size > 64<<10 {
		t.Fatalf("reader allocates %d bytes per connection", size)
	}
}

func TestReadFrameBoundary(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload int
		ok      bool
	}{
		{name: "at limit", payload: 8, ok: true},
		{name: "over limit", payload: 9, ok: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			data := strings.Repeat("x", tc.payload) + "\n"
			frame, err := readFrame(bufio.NewReaderSize(strings.NewReader(data), 4), 8)
			if !tc.ok {
				if !errors.Is(err, ErrFrameTooLarge) {
					t.Fatalf("error = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if string(frame) != data {
				t.Fatalf("frame = %q", frame)
			}
		})
	}
}

func TestReadRejectsOversizeFrame(t *testing.T) {
	data := strings.Repeat("x", MaxFrameBytes+1) + "\n"
	var v any
	err := Read(bufio.NewReaderSize(strings.NewReader(data), readBufferBytes), &v)
	if !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("error = %v", err)
	}
}
