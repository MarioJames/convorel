package cli_test

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/MarioJames/convorel/internal/cli"
)

func TestLocalDoctorOfflineAndMalformedPreferences(t *testing.T) {
	root := t.TempDir()
	args := []string{"--config-dir", filepath.Join(root, "config"), "--state-dir", filepath.Join(root, "state"), "doctor", "--local"}
	var out bytes.Buffer
	if code := cli.Run(context.Background(), args, strings.NewReader(""), &out); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	var result struct {
		OK     bool `json:"ok"`
		Checks struct {
			Configured bool `json:"configured"`
		} `json:"checks"`
	}
	if err := json.Unmarshal(out.Bytes(), &result); err != nil || !result.OK || result.Checks.Configured {
		t.Fatalf("result %s: %v", out.String(), err)
	}
	// No daemon/socket/state or browser is required, even before setup.
	if _, err := os.Stat(filepath.Join(root, "state")); !os.IsNotExist(err) {
		t.Fatalf("local doctor created state: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "config"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config/preferences.json"), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if code := cli.Run(context.Background(), args, strings.NewReader(""), &out); code != 1 || !strings.Contains(out.String(), "PREFERENCES_READ_FAILED") {
		t.Fatalf("bad preferences exit %d: %s", code, out.String())
	}
}
