package workspace

import (
	"errors"
	"regexp"
	"strings"
)

// ignorePattern is one gitignore rule. Matching is intentionally fail-closed:
// an unparsable byte sequence becomes a rule that cannot match, and the policy
// reader refuses such files before they reach this type.
type ignorePattern struct {
	negate   bool
	dirOnly  bool
	anchored bool
	re       *regexp.Regexp
}

type ignoreMatcher struct {
	patterns []ignorePattern
	// invalid marks a policy whose syntax could not be represented. Such a
	// policy is treated as deny-all instead of silently weakening the boundary.
	invalid bool
}

var errMalformedPattern = errors.New("MALFORMED_IGNORE_PATTERN")

// parseIgnore follows gitignore syntax: blank lines and comments are skipped,
// '!' negates, a trailing '/' restricts to directories and any other '/' anchors
// the pattern to the policy directory.
func parseIgnore(text string) *ignoreMatcher {
	text = strings.TrimPrefix(text, "\ufeff")
	m := &ignoreMatcher{}
	for _, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		line := strings.TrimSuffix(raw, "\r")
		line = trimUnescapedTrailingSpaces(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		negate := false
		if strings.HasPrefix(line, "!") {
			negate = true
			line = line[1:]
		}
		if line == "" {
			continue
		}
		dirOnly := strings.HasSuffix(line, "/")
		if dirOnly {
			line = strings.TrimSuffix(line, "/")
		}
		anchored := strings.Contains(line, "/")
		line = strings.TrimPrefix(line, "/")
		if line == "" {
			continue
		}
		body, err := globBody(line)
		if err != nil {
			m.invalid = true
			continue
		}
		expr := "^" + body + "$"
		re, err := regexp.Compile(expr)
		if err != nil {
			m.invalid = true
			continue
		}
		m.patterns = append(m.patterns, ignorePattern{negate: negate, dirOnly: dirOnly, anchored: anchored, re: re})
	}
	return m
}

func trimUnescapedTrailingSpaces(s string) string {
	for len(s) > 0 && s[len(s)-1] == ' ' {
		backslashes := 0
		for i := len(s) - 2; i >= 0 && s[i] == '\\'; i-- {
			backslashes++
		}
		if backslashes%2 == 1 {
			break
		}
		s = s[:len(s)-1]
	}
	return s
}

// ignored reports whether rel (relative to the policy directory) is excluded.
// An ignored ancestor ends the search: git cannot re-include a child of an
// excluded directory.
func (m *ignoreMatcher) ignored(rel string, isDir bool) bool {
	if m == nil || rel == "" || rel == "." {
		return false
	}
	if m.invalid {
		return true
	}
	parts := strings.Split(rel, "/")
	ignored := false
	for i := 1; i <= len(parts); i++ {
		candidate := strings.Join(parts[:i], "/")
		candidateIsDir := i < len(parts) || isDir
		for _, p := range m.patterns {
			if p.matches(candidate, candidateIsDir) {
				ignored = !p.negate
			}
		}
		if i < len(parts) && ignored {
			return true
		}
	}
	return ignored
}

func (p ignorePattern) matches(candidate string, isDir bool) bool {
	if p.dirOnly && !isDir {
		return false
	}
	if p.anchored {
		return p.re.MatchString(candidate)
	}
	base := candidate
	if at := strings.LastIndexByte(candidate, '/'); at >= 0 {
		base = candidate[at+1:]
	}
	return p.re.MatchString(base)
}

// globBody converts a gitignore/anchor glob into a regular expression body.
func globBody(pattern string) (string, error) {
	var b strings.Builder
	runes := []rune(pattern)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		switch r {
		case '*':
			if i+1 < len(runes) && runes[i+1] == '*' {
				i++
				// "**/" matches zero or more directories.
				if i+1 < len(runes) && runes[i+1] == '/' {
					i++
					b.WriteString("(?:.*/)?")
				} else {
					b.WriteString(".*")
				}
			} else {
				b.WriteString("[^/]*")
			}
		case '?':
			b.WriteString("[^/]")
		case '[':
			class, next, ok := charClass(runes, i)
			if !ok {
				return "", errMalformedPattern
			}
			b.WriteString(class)
			i = next
		case '\\':
			if i+1 >= len(runes) {
				b.WriteString(`\\`)
				continue
			}
			i++
			b.WriteString(regexp.QuoteMeta(string(runes[i])))
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	return b.String(), nil
}

func charClass(runes []rune, start int) (string, int, bool) {
	var b strings.Builder
	b.WriteByte('[')
	i := start + 1
	if i < len(runes) && (runes[i] == '!' || runes[i] == '^') {
		b.WriteByte('^')
		i++
	}
	// A ']' immediately after the opener is literal in glob syntax.
	if i < len(runes) && runes[i] == ']' {
		b.WriteString(`\]`)
		i++
	}
	for ; i < len(runes); i++ {
		r := runes[i]
		if r == ']' {
			b.WriteByte(']')
			return b.String(), i, true
		}
		if r == '\\' && i+1 < len(runes) {
			i++
			b.WriteString(regexp.QuoteMeta(string(runes[i])))
			continue
		}
		if r == '[' || r == ']' || r == '^' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return "", start, false
}
