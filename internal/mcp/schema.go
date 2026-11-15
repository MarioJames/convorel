package mcp

// The published output schemas describe the 0.9 top-level envelopes. Nested
// operation results stay open objects because exec multiplexes every internal
// command and each keeps its own evidence contract.
func objectSchema(properties map[string]any, required []string) map[string]any {
	schema := map[string]any{
		"type":                 "object",
		"properties":           properties,
		"additionalProperties": false,
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func openObject() map[string]any { return map[string]any{"type": "object"} }

func capabilitiesOutputSchema() map[string]any {
	return objectSchema(map[string]any{
		"roots":     map[string]any{"type": "array"},
		"mode":      map[string]any{"type": "string"},
		"workspace": map[string]any{},
		"server":    openObject(),
		"execution": openObject(),
		"memory":    openObject(),
		"artifacts": openObject(),
	}, []string{"roots", "mode", "workspace", "server", "execution", "memory", "artifacts"})
}

func execOutputSchema() map[string]any {
	execution := objectSchema(map[string]any{
		"operation": map[string]any{"type": "string"},
		"result":    openObject(),
	}, []string{"operation", "result"})
	return objectSchema(map[string]any{"execution": execution}, []string{"execution"})
}

func artifactOutputSchema() map[string]any {
	artifact := objectSchema(map[string]any{
		"kind":   map[string]any{"type": "string", "enum": []any{"text", "image"}},
		"result": openObject(),
	}, []string{"kind", "result"})
	return objectSchema(map[string]any{"artifact": artifact}, []string{"artifact"})
}

func memoryOutputSchema() map[string]any {
	hit := objectSchema(map[string]any{
		"uri":      map[string]any{"type": "string"},
		"abstract": map[string]any{"type": "string"},
		"score":    map[string]any{"type": []any{"number", "null"}},
	}, []string{"uri", "abstract", "score"})
	return objectSchema(map[string]any{
		"action":     map[string]any{"type": "string", "enum": []any{"search", "read"}},
		"uri":        map[string]any{"type": "string"},
		"content":    map[string]any{"type": []any{"string", "null"}},
		"matches":    map[string]any{"type": "array", "items": hit},
		"observedAt": map[string]any{"type": "string"},
		"note":       map[string]any{"type": "string"},
	}, []string{"action", "uri", "content", "matches", "observedAt", "note"})
}
