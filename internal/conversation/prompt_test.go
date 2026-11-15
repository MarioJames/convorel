package conversation

import (
	"crypto/sha256"
	"fmt"
	"testing"
)

func TestPromptMatchesLegacyGuidance(t *testing.T) {
	legacy := Context("/tmp/project").Instructions
	// The 0.9 guidance is frozen by its content hash, independently of removed sources.
	if got := fmt.Sprintf("%x", sha256.Sum256([]byte(legacy))); got != "7489e01224be156797fbc94b41584fe979c20c5aa1437022ca6f63001d26c048" {
		t.Fatalf("guidance snapshot changed: %s", got)
	}
	marker := "[CONVOREL:run]"
	input := "\nVerbatim < & > \" input\n  spaces\n"
	workspace := "/tmp/<&>/项目/\u2028\u2029"
	expected := marker + "\n\n# Convorel task context v1\n\nLocal workspace: \"" + workspace + "\"\n\n" + legacy + "\n\n# Task request (verbatim)\n\n" + input
	if actual := RenderPrompt(marker, input, Context(workspace)); actual != expected {
		t.Fatalf("rendered prompt differs:\n%q\n%q", actual, expected)
	}
}
