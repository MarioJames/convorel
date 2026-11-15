package archive

import (
	"context"
	"errors"
	"strings"

	"github.com/MarioJames/convorel/internal/store"
	"modernc.org/sqlite"
)

// Notice reports an archive outcome beside a run result. It is deliberately not
// an error: a rejected write, a full disk or a missing capture must never look
// like a delivery, completion or retry problem to the caller.
type Notice struct {
	Status   string `json:"status"`
	Error    string `json:"error,omitempty"`
	Runs     int    `json:"runs,omitempty"`
	Versions int    `json:"versions,omitempty"`
	Gaps     []Gap  `json:"gaps,omitempty"`
	Stats    *Stats `json:"stats,omitempty"`
}

// Failure converts an archive error into a failed notice. SQLite failures keep a
// distinct prefix so an operator can tell storage from projection problems.
func Failure(err error) Notice {
	if err == nil {
		return Notice{Status: "failed", Error: "ARCHIVE_FAILED"}
	}
	prefix := "ARCHIVE_FAILED: "
	var sqliteErr *sqlite.Error
	if errors.As(err, &sqliteErr) || strings.Contains(err.Error(), "SQLITE") {
		prefix = "SQLITE: "
	}
	return Notice{Status: "failed", Error: prefix + truncateNotice(err.Error())}
}

// Unavailable reports that no archive is open. It is a reporting outcome; the
// engine must not treat it as a reason to change run state or resend.
func Unavailable(err error) Notice {
	message := "ARCHIVE_MISSING"
	if err != nil {
		message = truncateNotice(err.Error())
	}
	return Notice{Status: "unavailable", Error: message}
}

// PublishNotice projects one task and turns every failure into a notice. This is
// the engine-facing recorder: delivery/completion decisions must ignore the
// returned status entirely.
func (a *Archive) PublishNotice(ctx context.Context, task store.Task, taskFileHash string) Notice {
	result, err := a.Publish(ctx, task, taskFileHash)
	if err != nil {
		return Failure(err)
	}
	notice := Notice{
		Status:   "stored",
		Runs:     result.Runs,
		Versions: result.Versions,
		Gaps:     result.Gaps,
	}
	if len(result.Gaps) > 0 {
		notice.Status = "partial"
	}
	if stats, err := a.Stats(ctx); err == nil {
		notice.Stats = &stats
	}
	return notice
}
