package workspace

import (
	"regexp"
	"strings"
)

// PathMatcher compiles a bounded glob. Patterns without '/' match basenames at
// any depth, matching the 0.9 discovery contract.
func PathMatcher(pattern string) (func(string) bool, error) {
	if pattern == "" || len(pattern) > 200 || strings.ContainsRune(pattern, 0) ||
		strings.Contains(pattern, "\\") || strings.HasPrefix(pattern, "/") {
		return nil, Fail("INVALID_PATTERN")
	}
	for _, segment := range strings.Split(pattern, "/") {
		if segment == ".." {
			return nil, Fail("INVALID_PATTERN")
		}
	}
	body, err := globPattern(pattern)
	if err != nil {
		return nil, Fail("INVALID_PATTERN")
	}
	re, err := regexp.Compile("^" + body + "$")
	if err != nil {
		return nil, Fail("INVALID_PATTERN")
	}
	slash := strings.Contains(pattern, "/")
	return func(path string) bool {
		subject := path
		if !slash {
			if at := strings.LastIndexByte(path, '/'); at >= 0 {
				subject = path[at+1:]
			}
		}
		return re.MatchString(subject)
	}, nil
}

func globPattern(pattern string) (string, error) {
	var b strings.Builder
	runes := []rune(pattern)
	for i := 0; i < len(runes); i++ {
		switch r := runes[i]; r {
		case '*':
			if i+1 < len(runes) && runes[i+1] == '*' {
				i++
				if i+1 < len(runes) && runes[i+1] == '/' {
					i++
					b.WriteString("(?:[^/]+/)*")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '[':
			class, next, ok := globClass(runes, i)
			if !ok {
				return "", errMalformedPattern
			}
			b.WriteString(class)
			i = next
		case '{':
			end := -1
			for j := i + 1; j < len(runes); j++ {
				if runes[j] == '}' {
					end = j
					break
				}
			}
			if end < 0 {
				b.WriteString(`\{`)
				continue
			}
			alternatives := strings.Split(string(runes[i+1:end]), ",")
			if len(alternatives) == 1 {
				b.WriteString(`\{`)
				continue
			}
			parts := make([]string, 0, len(alternatives))
			for _, alternative := range alternatives {
				part, err := globPattern(alternative)
				if err != nil {
					return "", err
				}
				parts = append(parts, part)
			}
			b.WriteString("(?:" + strings.Join(parts, "|") + ")")
			i = end
		case '\\':
			if i+1 < len(runes) {
				i++
				b.WriteString(regexp.QuoteMeta(string(runes[i])))
			} else {
				b.WriteString(`\\`)
			}
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	return b.String(), nil
}

func globClass(runes []rune, start int) (string, int, bool) {
	var b strings.Builder
	b.WriteByte('[')
	i := start + 1
	if i < len(runes) && (runes[i] == '!' || runes[i] == '^') {
		b.WriteByte('^')
		i++
	}
	if i < len(runes) && runes[i] == ']' {
		b.WriteString(`\]`)
		i++
	}
	for ; i < len(runes); i++ {
		switch r := runes[i]; r {
		case ']':
			b.WriteByte(']')
			return b.String(), i, true
		case '\\':
			if i+1 < len(runes) {
				i++
				b.WriteString(regexp.QuoteMeta(string(runes[i])))
				continue
			}
			b.WriteString(`\\`)
		case '[', '^':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	return "", start, false
}
