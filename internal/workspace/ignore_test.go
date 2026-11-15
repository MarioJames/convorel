package workspace

import "testing"

func TestIgnoreMatcherGitignoreSemantics(t *testing.T) {
	policy := parseIgnore(stringsJoin(
		"# comment",
		"",
		".env",
		".env.*",
		"*.pem",
		"private/",
		"/root-only.txt",
		"docs/**/generated.md",
		"!keep.pem",
		"space\\ name.txt",
	))
	cases := []struct {
		path  string
		isDir bool
		want  bool
	}{
		{".env", false, true},
		{"nested/.env", false, true},
		{".env.local", false, true},
		{"nested/.env.production", false, true},
		{"secret.pem", false, true},
		{"nested/secret.pem", false, true},
		{"keep.pem", false, false},
		{"private", true, true},
		{"private/file.ts", false, true},
		{"nested/private/file.ts", false, true},
		{"root-only.txt", false, true},
		{"nested/root-only.txt", false, false},
		{"docs/generated.md", false, true},
		{"docs/a/b/generated.md", false, true},
		{"docs/a/b/other.md", false, false},
		{"space name.txt", false, true},
		{"public.ts", false, false},
	}
	for _, test := range cases {
		if got := policy.ignored(test.path, test.isDir); got != test.want {
			t.Errorf("ignored(%q, %v) = %v, want %v", test.path, test.isDir, got, test.want)
		}
	}
}

func TestIgnoreMatcherCannotReincludeChildrenOfExcludedDirectory(t *testing.T) {
	policy := parseIgnore("build/\n!build/keep.ts\n")
	if !policy.ignored("build/keep.ts", false) {
		t.Fatal("negation re-included a child of an excluded directory")
	}
	if policy.ignored("dist/keep.ts", false) {
		t.Fatal("unrelated path ignored")
	}
}

func TestIgnoreMatcherBOMAndCRLF(t *testing.T) {
	policy := parseIgnore("\uFEFFprivate.txt\r\n# 注释\r\n")
	if !policy.ignored("private.txt", false) {
		t.Fatal("BOM policy line not applied")
	}
	if policy.ignored("public.txt", false) {
		t.Fatal("comment applied as a rule")
	}
}

func TestHardExclusionsCoverCredentialNames(t *testing.T) {
	for _, path := range []string{
		".env", ".env.production", "secret.pem", "server.key", "deploy.p12", "store.pfx",
		"trust.jks", "app.keystore", "id_rsa", "id_ed25519.pub", "id_ecdsa", "id_dsa",
		".ssh/config", ".aws/credentials", ".gnupg/key", ".npmrc", ".netrc", "_netrc",
		".git-credentials", "login.keychain", "credentials.json", "service-account-x.json",
		"secrets.json", "cookies.sqlite", "Cookies", ".git/config", "node_modules/x.js",
		"dist/app.js", "build/out.js", ".next/cache", ".cache/x", ".venv/bin/python",
		"venv/bin/python", "coverage/lcov.info", "target/debug/app", ".convorel/state",
	} {
		if !hard.ignored(path, false) && !hard.ignored(path, true) {
			t.Errorf("%q is not hard-excluded", path)
		}
	}
	for _, path := range []string{"src/main.ts", "docs/readme.md", "package.json", "go.mod", ".gitignore", "build.ts"} {
		if hard.ignored(path, false) || hard.ignored(path, true) {
			t.Errorf("%q is unexpectedly hard-excluded", path)
		}
	}
}

func TestPathMatcherBehaviour(t *testing.T) {
	cases := []struct {
		pattern string
		path    string
		want    bool
	}{
		{"*.ts", "src/a.ts", true},
		{"*.ts", "src/a.js", false},
		{"src/*.ts", "src/a.ts", true},
		{"src/*.ts", "src/deep/a.ts", false},
		{"**/*.sql", "migrations/001.sql", true},
		{"**/*.sql", "db/migrations/001.sql", true},
		{"**/migrations/*.sql", "db/migrations/001.sql", true},
		{"{a,b}.txt", "a.txt", true},
		{"{a,b}.txt", "b.txt", true},
		{"{a,b}.txt", "c.txt", false},
		{"file?.md", "file1.md", true},
		{"file[0-9].md", "file7.md", true},
		{"file[0-9].md", "filex.md", false},
	}
	for _, test := range cases {
		matcher, err := PathMatcher(test.pattern)
		if err != nil {
			t.Fatalf("pattern %q: %v", test.pattern, err)
		}
		if got := matcher(test.path); got != test.want {
			t.Errorf("%q matches %q = %v, want %v", test.pattern, test.path, got, test.want)
		}
	}
	for _, pattern := range []string{"", "/abs", "../up", "a\\b", "a\x00b"} {
		if _, err := PathMatcher(pattern); err == nil {
			t.Errorf("pattern %q accepted", pattern)
		}
	}
}

func stringsJoin(lines ...string) string {
	out := ""
	for i, line := range lines {
		if i > 0 {
			out += "\n"
		}
		out += line
	}
	return out
}
