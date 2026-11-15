package workspace

import (
	"bytes"
	"encoding/json"
	"unicode/utf16"
)

// TextChunk returns a byte-budgeted fragment of text. Offsets count UTF-16 code
// units, matching the 0.9 contract (JavaScript string length).
func TextChunk(text string, offset, budget int) (string, *int, error) {
	if _, err := Integer(offset, 0, utf16Length(text)); err != nil {
		return "", nil, Fail("INVALID_OFFSET")
	}
	if budget < 2 {
		return "", nil, Fail("RESPONSE_TOO_LARGE")
	}
	units := utf16.Encode([]rune(text))
	if offset > 0 && offset < len(units) && isLowSurrogate(units[offset]) && isHighSurrogate(units[offset-1]) {
		return "", nil, Fail("INVALID_OFFSET")
	}
	low, high := offset, len(units)
	for low < high {
		middle := (low + high + 1) / 2
		if jsonBytes(string(utf16.Decode(units[offset:middle]))) <= budget {
			low = middle
		} else {
			high = middle - 1
		}
	}
	if low < len(units) && low > offset && isHighSurrogate(units[low-1]) {
		low--
	}
	if low == offset && low < len(units) {
		return "", nil, Fail("RESPONSE_TOO_LARGE")
	}
	var next *int
	if low < len(units) {
		value := low
		next = &value
	}
	return string(utf16.Decode(units[offset:low])), next, nil
}

// UTF16Length counts UTF-16 code units, which is what 0.9 reports for offsets
// and patch lengths.
func UTF16Length(text string) int { return utf16Length(text) }

func utf16Length(text string) int {
	n := 0
	for _, r := range text {
		if r > 0xffff {
			n += 2
		} else {
			n++
		}
	}
	return n
}

func isHighSurrogate(r uint16) bool { return r >= 0xd800 && r <= 0xdbff }
func isLowSurrogate(r uint16) bool  { return r >= 0xdc00 && r <= 0xdfff }

// JSONSize reports the byte length of the JSON encoding of value using
// JSON.stringify-compatible escaping (no HTML escaping).
func JSONSize(value any) int {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return 0
	}
	return buffer.Len() - 1
}

// SliceUTF16 returns at most length UTF-16 code units starting at start, never
// splitting a surrogate pair. The boolean reports whether text was truncated.
func SliceUTF16(text string, start, length int) (string, bool) {
	units := utf16.Encode([]rune(text))
	if start < 0 {
		start = 0
	}
	if start > len(units) {
		start = len(units)
	}
	if length < 0 {
		length = 0
	}
	end := start + length
	if end > len(units) {
		end = len(units)
	}
	if end < len(units) && end > start && isHighSurrogate(units[end-1]) {
		end--
	}
	return string(utf16.Decode(units[start:end])), end < len(units)
}
