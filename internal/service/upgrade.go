package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/MarioJames/convorel/internal/config"
)

var releaseVersion = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$`)

type Manifest struct {
	Version string `json:"version"`
	Archive string `json:"archive"`
	SHA256  string `json:"sha256"`
	URL     string `json:"url"`
}

func Platform() (string, error) {
	arch := runtime.GOARCH
	if arch == "amd64" {
		arch = "x64"
	}
	if runtime.GOOS != "linux" || (arch != "x64" && arch != "arm64") {
		return "", errors.New("PLATFORM_UNSUPPORTED")
	}
	return "linux-" + arch, nil
}
func fetch(ctx context.Context, source string, limit int64) ([]byte, error) {
	req, e := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if e != nil {
		return nil, e
	}
	client := &http.Client{Timeout: 120 * time.Second}
	resp, e := client.Do(req)
	if e != nil {
		return nil, e
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("RELEASE_FETCH_FAILED: HTTP %d", resp.StatusCode)
	}
	b, e := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if e == nil && int64(len(b)) > limit {
		return nil, errors.New("RELEASE_TOO_LARGE")
	}
	return b, e
}

// ReleaseManifest resolves latest through the checksums, without a release API call.
func ReleaseManifest(ctx context.Context, base, requested string) (Manifest, error) {
	var m Manifest
	requested = strings.TrimPrefix(requested, "v")
	ref := "latest/download"
	if requested != "" && requested != "latest" {
		if !releaseVersion.MatchString(requested) {
			return m, errors.New("VERSION_INVALID")
		}
		ref = "download/v" + requested
	}
	platform, e := Platform()
	if e != nil {
		return m, e
	}
	b, e := fetch(ctx, strings.TrimRight(base, "/")+"/"+ref+"/sha256sums.txt", 1<<20)
	if e != nil {
		return m, e
	}
	count := 0
	for _, line := range strings.Split(string(b), "\n") {
		if !strings.HasSuffix(line, "-"+platform+".tar.gz") {
			continue
		}
		count++
		fields := strings.Fields(line)
		if len(fields) != 2 || len(fields[0]) != 64 {
			return m, errors.New("MANIFEST_INVALID")
		}
		digest, e := hex.DecodeString(fields[0])
		if e != nil || len(digest) != 32 {
			return m, errors.New("MANIFEST_INVALID")
		}
		file := fields[1]
		version := strings.TrimSuffix(strings.TrimPrefix(file, "convorel-"), "-"+platform+".tar.gz")
		if !strings.HasPrefix(file, "convorel-") || !releaseVersion.MatchString(version) {
			return m, errors.New("MANIFEST_INVALID")
		}
		if requested != "" && requested != "latest" && requested != version {
			return m, errors.New("VERSION_MISMATCH")
		}
		m = Manifest{Version: version, Archive: file, SHA256: fields[0], URL: strings.TrimRight(base, "/") + "/" + ref + "/" + file}
	}
	if count != 1 {
		return m, errors.New("MANIFEST_INVALID: expected one platform artifact")
	}
	return m, nil
}

type Layout struct {
	InstallDir string
	BinDir     string `json:"binDir"`
	Current    string
	Version    int `json:"version"`
}

func InstallLayout(executable string) (Layout, error) {
	var l Layout
	executable, e := filepath.EvalSymlinks(executable)
	if e != nil {
		return l, e
	}
	current := filepath.Dir(filepath.Dir(executable))
	versions := filepath.Dir(current)
	root := filepath.Dir(versions)
	if filepath.Base(executable) != "convorel" || filepath.Base(filepath.Dir(executable)) != "bin" || filepath.Base(versions) != "versions" {
		return l, errors.New("UPGRADE_LAYOUT_UNKNOWN")
	}
	b, e := os.ReadFile(filepath.Join(root, "layout.json"))
	if e != nil {
		return l, e
	}
	if e = json.Unmarshal(b, &l); e != nil {
		return l, e
	}
	link, e := filepath.EvalSymlinks(filepath.Join(l.BinDir, "convorel"))
	if e != nil || link != executable || !filepath.IsAbs(l.BinDir) || l.Version != 1 {
		return l, errors.New("UPGRADE_LAYOUT_UNKNOWN")
	}
	l.Current = current
	l.InstallDir = root
	return l, nil
}
func Upgrade(ctx context.Context, requested string, p config.Paths) (any, error) {
	executable, e := os.Executable()
	if e != nil {
		return nil, e
	}
	layout, e := InstallLayout(executable)
	if e != nil {
		return nil, e
	}
	pref, e := config.ReadPreferences(p)
	if e != nil {
		return nil, e
	}
	base := pref.Values["release.baseUrl"]
	if base == "" {
		base = "https://github.com/MarioJames/convorel/releases"
	}
	m, e := ReleaseManifest(ctx, base, requested)
	if e != nil {
		return nil, e
	}
	if (requested == "" || requested == "latest") && m.Version == Version {
		return map[string]any{"upgraded": false, "version": Version, "upToDate": true}, nil
	}
	if installerText == "" {
		return nil, errors.New("UPGRADE_SOURCE_CHECKOUT: build with scripts/build.sh")
	}
	stage, e := os.MkdirTemp("", "convorel-upgrade-*")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(stage)
	archive, e := fetch(ctx, m.URL, 256<<20)
	if e != nil {
		return nil, e
	}
	digest := sha256.Sum256(archive)
	if hex.EncodeToString(digest[:]) != m.SHA256 {
		return nil, errors.New("CHECKSUM_MISMATCH")
	}
	if e = os.WriteFile(filepath.Join(stage, m.Archive), archive, 0600); e != nil {
		return nil, e
	}
	if e = os.WriteFile(filepath.Join(stage, "sha256sums.txt"), []byte(m.SHA256+"  "+m.Archive+"\n"), 0600); e != nil {
		return nil, e
	}
	cmd := exec.CommandContext(ctx, "bash", "-c", installerText, "convorel-install", "--version", m.Version, "--prefix", layout.InstallDir, "--bin-dir", layout.BinDir, "--dist-dir", stage)
	out, e := cmd.CombinedOutput()
	if e != nil {
		return nil, fmt.Errorf("UPGRADE_FAILED: %s: %w", strings.TrimSpace(string(out)), e)
	}
	return map[string]any{"upgraded": true, "version": m.Version, "previousVersion": Version, "retained": layout.Current, "skills": "installed skills are preserved; review changes before reinstalling"}, nil
}

// VersionCheck reports update availability without changing the installation.
func VersionCheck(ctx context.Context, p config.Paths) (any, error) {
	pref, e := config.ReadPreferences(p)
	if e != nil {
		return nil, e
	}
	base := pref.Values["release.baseUrl"]
	if base == "" {
		base = "https://github.com/MarioJames/convorel/releases"
	}
	latest, e := ReleaseManifest(ctx, base, "")
	if e != nil {
		return nil, e
	}
	return map[string]any{"version": Version, "latest": latest.Version, "upToDate": Version == latest.Version}, nil
}
