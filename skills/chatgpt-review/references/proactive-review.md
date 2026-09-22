# Proactive Pro review

Judge the cost of a wrong decision, its reach, and the strength of available evidence. Topic keywords alone do not justify a remote review. Apply the [review model selection through Convorel](convorel.md#解析-cli-与私有状态) using existing account/project authorization; do not silently fall back to another model or expand the material allowed to leave the machine.

## Trigger at decision points

Initiate by default when:

- Making consequential architecture or technology choices: boundaries, storage, cross-service contracts or critical dependencies whose reversal would be costly.
- A substantial solution has a concrete recommended design and is about to be presented for final confirmation or implemented. Cross-check requirements, alternatives, failure modes and acceptance criteria before calling it final.
- A high-risk implementation is about to proceed: authorization, tenant isolation, data migration, concurrency consistency or irreversible effects. Review the relevant mechanism and recovery path, not merely the feature name.

Initiate when there is concrete evidence of a problem or uncertainty:

- A decision depends on unverified library behavior, runtime semantics or performance assumptions that could change the choice.
- Debugging stalls after attempted fixes, or the proposed root cause contradicts observed behavior. Send the failed hypotheses and observations so the reviewer can challenge the starting assumptions.
- Implementation uncovers a constraint that materially changes the accepted design, boundaries or guarantees.
- A consequential feature is ready for acceptance but independent scrutiny of coverage, failure paths or release evidence could change the go/no-go decision.

For completed development with meaningful architecture constraints or module boundaries, apply [result review](result-review.md) once before delivery: compare the actual outcome against the goal and accepted architecture. This examines implementation drift; it does not default to line-by-line code review or require uploading full test logs.

Do not automatically review routine copy/style changes, small features following an established pattern, or ordinary low-risk local reviews. Explicit requests still apply. Follow an explicit local-only/no-external instruction even at a high-risk gate. Missing product goals require user input; model review cannot decide those goals on the user's behalf.

## Send a reviewable decision

Before choosing the review brief, apply the direction-confirmation rule in SKILL.md. If the user's technical direction is unclear or materially different directions remain possible, explain the alternatives and obtain the user's choice before sending or implementing a direction-dependent plan. An explicit request to explore alternatives authorizes a comparison within the agreed scope, not silently choosing one. Separate confirmed user intent, the local Agent's recommendation, and open questions in the brief. Reviewer agreement cannot supply missing user confirmation.

Prepare a concrete draft before requesting review. Include the goal and constraints, exact project path and known revision, a small map of relevant files, alternatives and recommendation, verified result summaries, assumptions and unresolved questions. For a mechanism/code review, include focused code blocks carrying the decision and explain their significance; the reviewer can retrieve surrounding implementation through read-only MCP. For result review, lead with the goal-to-outcome comparison and provide implementation detail only where needed. Use only authorized, task-relevant material and omit secrets. Supply local verification summaries and their limits, not full logs by default; the remote reviewer must not claim to have run the local tests.

Ask for failure-causing assumptions, concrete counterexamples, simpler established alternatives, and a distinction between verified defects and hypotheses. Request decision-blocking issues separately from optional improvements and ask what experiment would resolve a disagreement. Avoid a generic request for approval.

Use the [Convorel conversation service](convorel.md) to create/reuse the session and manage its lifecycle. Prepare the complete message using [review-prompt.md](review-prompt.md); the service does not own the review strategy. Briefly tell the user which decision warrants review. Continue independent work while the watcher checks every 60 seconds.

## Close the gate without a review loop

Record the decision under review and the input revision/evidence in the existing private requirement record. Before sending, reuse an applicable completed review or continue waiting for its active run. Normally send once per decision version, with follow-ups only for material changes or an unresolved blocker. Completed implementation supplies new evidence for the separate result-review question; an earlier proposal review does not establish that the actual result stayed on course. Minor wording changes and optional suggestions do not start another mutual-review cycle.

When review is a prerequisite for final confirmation, implementation or release, wait for its complete response and resolve decision-blocking findings against local evidence before crossing that gate. The controlling Agent owns the conclusion; agreement between models is not proof. Record accepted/rejected findings with reasons and evidence limits. Once blockers are resolved, proceed without seeking repeated model approval.

If the model, login or watcher is unavailable, report the review as pending/blocked and continue independent work. Do not present an unreviewed gate as passed, silently fall back to another model, or resend a timed-out prompt. The user can explicitly waive the pending review; this does not waive separate testing or action-authorization requirements.
