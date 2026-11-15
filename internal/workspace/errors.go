// Package workspace implements the guarded read-only file and Git surface
// shared by every MCP tool.
package workspace

import (
	"errors"
	"fmt"
	"io/fs"
	"strings"
)

// Error is a stable, caller-visible failure code. Upper-case codes are part of
// the 0.9 contract and are returned verbatim as MCP tool error content.
type Error struct {
	Code   string
	Detail string
}

func (e *Error) Error() string {
	if e.Detail == "" {
		return e.Code
	}
	return e.Code + ": " + e.Detail
}

// Fail returns an Error with a stable code and no detail.
func Fail(code string) error { return &Error{Code: code} }

// Failf returns an Error with a stable code and optional diagnostic detail.
func Failf(code, format string, args ...any) error {
	detail := ""
	if format != "" {
		detail = fmt.Sprintf(format, args...)
	}
	return &Error{Code: code, Detail: detail}
}

// Invalid reports an argument or range problem. The MCP surface maps it to the
// INVALID_ARGUMENTS code used by the 0.9 schema validation.
func Invalid(format string, args ...any) error {
	return &Error{Code: "INVALID_ARGUMENTS", Detail: fmt.Sprintf(format, args...)}
}

// Code returns the stable code carried by err, or "" when err has none.
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// HasCode reports whether err carries the given stable code.
func HasCode(err error, code string) bool { return Code(err) == code }

// Integer validates an integer range and returns the same code as 0.9.
func Integer(n, min, max int) (int, error) {
	if n < min || n > max {
		return n, Failf("INVALID_RANGE", "%d outside %d..%d", n, min, max)
	}
	return n, nil
}

// CodeOrMapped mirrors the 0.9 mapping: upper-case errors pass through, missing
// files become FILE_NOT_FOUND and everything else is TOOL_FAILED.
func CodeOrMapped(err error) string {
	if err == nil {
		return ""
	}
	if code := Code(err); code != "" {
		return code
	}
	if errors.Is(err, fs.ErrNotExist) {
		return "FILE_NOT_FOUND"
	}
	message := err.Error()
	if message != "" && isUpperCode(message) {
		return message
	}
	return "TOOL_FAILED"
}

func isUpperCode(s string) bool {
	for _, r := range s {
		if !(r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_') {
			return false
		}
	}
	return !strings.ContainsAny(s, " \t\n")
}
