package conversation

import (
	"context"
	"github.com/MarioJames/convorel/internal/store"
	"testing"
)

func TestProvisionalConversationIdentityIsNotPersisted(t *testing.T) {
	ctx := context.Background()
	st, err := store.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	task, err := st.CreateTask(ctx, store.Task{Version: 1, ID: "provisional", CurrentRun: "run", Runs: []store.Run{{ID: "run", RequestID: "initial", InputHash: "hash", State: store.Prepared}}})
	if err != nil {
		t.Fatal(err)
	}
	engine := &Engine{ctx: ctx, opts: Options{Store: st}}
	// Provisional IDs cannot bind a URL even if they appear in the browser.
	if err = engine.bindURL(task, "local-chatgpt:fixture", nil); err != nil {
		t.Fatal(err)
	}
	task, err = st.GetTask(ctx, task.ID)
	if err != nil || task.URL != "" {
		t.Fatalf("provisional URL persisted: %q %v", task.URL, err)
	}
}
