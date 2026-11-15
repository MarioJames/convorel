// Package mcp serves the four 0.9 functions over an MCP stdio session.
package mcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"

	"github.com/MarioJames/convorel/internal/workspace"
)

// param describes one strictly validated JSON-schema property and, at the same
// time, one command-line option understood by exec.
type param struct {
	Name     string
	Type     string
	Enum     []string
	Min      *int
	Max      *int
	MinLen   *int
	MaxLen   *int
	Default  any
	Required bool
}

func intPtr(value int) *int { return &value }

func stringParam(name string) param { return param{Name: name, Type: "string", Required: true} }
func optionalStringParam(name string, maxLen int) param {
	return param{Name: name, Type: "string", MaxLen: intPtr(maxLen)}
}
func intParam(name string, min, max int, def any, required bool) param {
	return param{Name: name, Type: "integer", Min: intPtr(min), Max: intPtr(max), Default: def, Required: required}
}

func (p param) schema() map[string]any {
	out := map[string]any{"type": p.Type}
	if len(p.Enum) > 0 {
		values := make([]any, len(p.Enum))
		for i, value := range p.Enum {
			values[i] = value
		}
		out["enum"] = values
	}
	if p.Min != nil {
		out["minimum"] = *p.Min
	}
	if p.Max != nil {
		out["maximum"] = *p.Max
	}
	if p.MinLen != nil {
		out["minLength"] = *p.MinLen
	}
	if p.MaxLen != nil {
		out["maxLength"] = *p.MaxLen
	}
	if p.Default != nil {
		out["default"] = p.Default
	}
	return out
}

// inputSchema renders a strict object schema with the properties in contract
// order (encoding/json sorts map keys but order is not semantic).
func inputSchema(params []param) map[string]any {
	properties := map[string]any{}
	required := []string{}
	for _, p := range params {
		properties[p.Name] = p.schema()
		if p.Required {
			required = append(required, p.Name)
		}
	}
	out := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		out["required"] = required
	}
	return out
}

func schemaJSON(params []param) string {
	encoded, _ := json.Marshal(inputSchema(params))
	return string(encoded)
}

var errInvalidArguments = errors.New("INVALID_ARGUMENTS")

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", errInvalidArguments, fmt.Sprintf(format, args...))
}

func invalidArguments(err error) bool { return errors.Is(err, errInvalidArguments) }

// parseObject validates raw tool arguments strictly against params.
func parseObject(raw json.RawMessage, params []param) (map[string]any, error) {
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, invalid("expected an object")
	}
	values := map[string]json.RawMessage{}
	if len(trimmed) > 0 {
		if err := json.Unmarshal(trimmed, &values); err != nil {
			return nil, invalid("expected an object")
		}
		if values == nil {
			return nil, invalid("expected an object")
		}
	}
	known := map[string]bool{}
	for _, p := range params {
		known[p.Name] = true
	}
	for key := range values {
		if !known[key] {
			return nil, invalid("unknown argument %q", key)
		}
	}
	out := map[string]any{}
	for _, p := range params {
		rawValue, ok := values[p.Name]
		if !ok {
			if p.Default != nil {
				out[p.Name] = p.Default
				continue
			}
			if p.Required {
				return nil, invalid("missing argument %q", p.Name)
			}
			continue
		}
		switch p.Type {
		case "string":
			var value string
			if err := json.Unmarshal(rawValue, &value); err != nil {
				return nil, invalid("%s must be a string", p.Name)
			}
			if len(p.Enum) > 0 {
				allowed := false
				for _, candidate := range p.Enum {
					if value == candidate {
						allowed = true
					}
				}
				if !allowed {
					return nil, invalid("%s is not an allowed value", p.Name)
				}
			}
			if p.MaxLen != nil && len(value) > *p.MaxLen {
				return nil, invalid("%s is too long", p.Name)
			}
			if p.MinLen != nil && len(value) < *p.MinLen {
				return nil, invalid("%s is too short", p.Name)
			}
			out[p.Name] = value
		case "integer":
			var number json.Number
			if err := json.Unmarshal(rawValue, &number); err != nil {
				return nil, invalid("%s must be an integer", p.Name)
			}
			// JSON numbers are IEEE doubles to callers; accept 1.0 and 1e2 like
			// the 0.9 Number() path, but never a fractional value.
			parsed, err := strconv.ParseFloat(number.String(), 64)
			if err != nil || math.Trunc(parsed) != parsed || math.Abs(parsed) > 1<<53 {
				return nil, invalid("%s must be an integer", p.Name)
			}
			value := int64(parsed)
			if p.Min != nil && int(value) < *p.Min {
				return nil, invalid("%s is below the minimum", p.Name)
			}
			if p.Max != nil && int(value) > *p.Max {
				return nil, invalid("%s is above the maximum", p.Name)
			}
			out[p.Name] = int(value)
		default:
			return nil, invalid("unsupported schema type")
		}
	}
	return out, nil
}

// commandArgs converts string command tokens to the operation's typed values.
func commandArgs(params []param, args map[string]string) (map[string]any, error) {
	known := map[string]bool{}
	for _, p := range params {
		known[p.Name] = true
	}
	for key := range args {
		if !known[key] {
			return nil, invalid("unknown argument %q", key)
		}
	}
	values := map[string]any{}
	for _, p := range params {
		value, ok := args[p.Name]
		if !ok {
			if p.Default != nil {
				values[p.Name] = p.Default
				continue
			}
			if p.Required {
				return nil, invalid("missing argument %q", p.Name)
			}
			continue
		}
		if p.Type == "integer" {
			parsed, err := strconv.ParseFloat(value, 64)
			if err != nil || math.Trunc(parsed) != parsed || math.Abs(parsed) > 1<<53 {
				return nil, invalid("%s must be an integer", p.Name)
			}
			number := int64(parsed)
			if p.Min != nil && int(number) < *p.Min {
				return nil, invalid("%s is below the minimum", p.Name)
			}
			if p.Max != nil && int(number) > *p.Max {
				return nil, invalid("%s is above the maximum", p.Name)
			}
			values[p.Name] = int(number)
			continue
		}
		if len(p.Enum) > 0 {
			allowed := false
			for _, candidate := range p.Enum {
				if value == candidate {
					allowed = true
				}
			}
			if !allowed {
				return nil, invalid("%s is not an allowed value", p.Name)
			}
		}
		if p.MaxLen != nil && len(value) > *p.MaxLen {
			return nil, invalid("%s is too long", p.Name)
		}
		if p.MinLen != nil && len(value) < *p.MinLen {
			return nil, invalid("%s is too short", p.Name)
		}
		values[p.Name] = value
	}
	return values, nil
}

// errorCode mirrors the 0.9 MCP error mapping.
func errorCode(err error) string {
	if err == nil {
		return ""
	}
	if invalidArguments(err) {
		return "INVALID_ARGUMENTS"
	}
	if code := workspace.Code(err); code != "" {
		return code
	}
	code := workspace.CodeOrMapped(err)
	if code != "" {
		return code
	}
	return "TOOL_FAILED"
}
