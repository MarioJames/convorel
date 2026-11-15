package workspace

import (
	"bytes"
	"regexp"
	"strings"
)

type patchSelection struct {
	path    string
	oldPath *string
	oldOID  string
	newOID  string
	status  string
}

var patchMeta = regexp.MustCompile(`^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([ADMRTC])\d*$`)

// selectGitPatch pairs the NUL-delimited raw inventory with patch blocks and
// returns only the exact approved change. Literal pathspecs still expand a
// former file into a new directory; its descendants must never leak into the
// returned patch.
func selectGitPatch(combined []byte, selected patchSelection) ([]byte, error) {
	separator := bytes.Index(combined, []byte{0, 0})
	if separator < 0 {
		return nil, Fail("GIT_INVALID_PATCH")
	}
	rawRows := strings.Split(string(combined[:separator]), "\x00")
	selectedIndex := -1
	rowCount := 0
	for i := 0; i < len(rawRows); {
		meta := patchMeta.FindStringSubmatch(rawRows[i])
		i++
		if meta == nil {
			return nil, Fail("GIT_INVALID_PATCH")
		}
		if i >= len(rawRows) {
			return nil, Fail("GIT_INVALID_PATCH")
		}
		first := rawRows[i]
		i++
		renamed := meta[5] == "R" || meta[5] == "C"
		path := first
		if renamed {
			if i >= len(rawRows) {
				return nil, Fail("GIT_INVALID_PATCH")
			}
			path = rawRows[i]
			i++
		}
		if path == "" {
			return nil, Fail("GIT_INVALID_PATCH")
		}
		oldPath := ""
		if renamed {
			oldPath = first
		}
		matchesOld := selected.oldPath == nil && oldPath == "" || selected.oldPath != nil && oldPath == *selected.oldPath
		if path == selected.path && matchesOld && meta[3] == selected.oldOID && meta[4] == selected.newOID && meta[5] == selected.status {
			selectedIndex = rowCount
		}
		rowCount++
	}
	patches := combined[separator+2:]
	starts := []int{0}
	if !bytes.HasPrefix(patches, []byte("diff --git ")) {
		return nil, Fail("GIT_INVALID_PATCH")
	}
	for p := 0; ; {
		next := bytes.Index(patches[p:], []byte("\ndiff --git "))
		if next < 0 {
			break
		}
		p += next + 1
		starts = append(starts, p)
	}
	if selectedIndex < 0 || len(starts) != rowCount {
		return nil, Fail("GIT_PATCH_SELECTION_CHANGED")
	}
	end := len(patches)
	if selectedIndex+1 < len(starts) {
		end = starts[selectedIndex+1]
	}
	return patches[starts[selectedIndex]:end], nil
}
