//go:build ignore

// This build helper creates an overlay, leaving generated asset sources outside the checkout.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 2 {
		return fmt.Errorf("usage: go run scripts/build-assets.go TEMP_DIR")
	}
	root, e := os.Getwd()
	if e != nil {
		return e
	}
	out := os.Args[1]
	installer, e := os.ReadFile("install.sh")
	if e != nil {
		return e
	}
	files := map[string]string{}
	source := filepath.Join("skills", "chatgpt-review")
	e = filepath.WalkDir(source, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if d.IsDir() {
			return nil
		}
		if !d.Type().IsRegular() {
			return fmt.Errorf("unsafe skill asset %s", path)
		}
		b, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		rel, e := filepath.Rel(source, path)
		if e != nil {
			return e
		}
		files[filepath.ToSlash(rel)] = string(b)
		return nil
	})
	if e != nil {
		return e
	}
	keys := make([]string, 0, len(files))
	for k := range files {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sourceText strings.Builder
	sourceText.WriteString("package service\nfunc init() {\ninstallerText = " + strconv.Quote(string(installer)) + "\nskillFiles = map[string]string{\n")
	for _, k := range keys {
		sourceText.WriteString(strconv.Quote(k) + ":" + strconv.Quote(files[k]) + ",\n")
	}
	sourceText.WriteString("}\n}\n")
	generated := filepath.Join(out, "bundle_generated.go")
	if e = os.WriteFile(generated, []byte(sourceText.String()), 0600); e != nil {
		return e
	}
	overlay, e := json.Marshal(map[string]any{"Replace": map[string]string{filepath.Join(root, "internal/service/bundle_generated.go"): generated}})
	if e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(out, "overlay.json"), overlay, 0600)
}
