package cli_test

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/MarioJames/convorel/internal/cli"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

func TestStrictParsing(t *testing.T) {
	for _, args := range [][]string{{"ask", "--id", "task", "--prompt", "OK", "--bogus"}, {"wait", "--id", "task", "--config-dir", "wrong"}, {"wait", "--id", "task", "--timeout-seconds", "0"}, {"ask", "--id", "task", "--prompt", "OK", "--prompt-stdin"}, {"ask", "--id", "task", "--prompt", "OK", "--effort", "6"}, {"service", "wat"}} {
		if _, e := cli.Parse(args); e == nil {
			t.Errorf("accepted %v", args)
		}
	}
	v, e := cli.Parse([]string{"ask", "--id", "task", "--prompt-stdin", "--effort=1"})
	if e != nil || v.Params["request-id"] != "initial" || v.Params["prompt-stdin"] != "true" {
		t.Fatalf("parse: %+v %v", v, e)
	}
	v, e = cli.Parse([]string{"config", "set", "model", "--literal"})
	if e != nil || v.Params["value"] != "--literal" {
		t.Fatalf("literal config value: %+v %v", v, e)
	}
}
func TestJSONOutputAndNamingDoesNotChangeCompletion(t *testing.T) {
	root := t.TempDir()
	for _, args := range [][]string{{"version"}, {"--help"}, {"wait", "--unknown"}} {
		var b bytes.Buffer
		full := append([]string{"--config-dir", filepath.Join(root, "config"), "--state-dir", filepath.Join(root, "state")}, args...)
		code := cli.Run(context.Background(), full, strings.NewReader(""), &b)
		d := json.NewDecoder(&b)
		var v any
		if e := d.Decode(&v); e != nil {
			t.Fatal(e)
		}
		if e := d.Decode(&v); e != io.EOF {
			t.Fatalf("stdout has more than one document: %v", e)
		}
		if args[0] == "wait" {
			if code != 1 {
				t.Fatalf("error exit: %d", code)
			}
			if v.(map[string]any)["code"] != "UNKNOWN_FLAG" {
				t.Fatalf("unstable error: %v", v)
			}
		} else if code != 0 {
			t.Fatalf("success exit: %d", code)
		}
	}
	if cli.ExitForPhase("complete") != 0 {
		t.Fatal("complete reply must succeed independent of naming")
	}
}
