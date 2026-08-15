# domain — invariants to check in review

- `decide` and `apply` stay pure: no Effect, no IO, no clock, no randomness. Time and ids arrive on `DecideEnv`.
- Refusals are thrown `InvalidCommand` / `PolicyViolation`; repeating an already-true state returns `[]`, never an error.
- No authorization in the decider — middleware owns `hasPermission`; the decider only asks "does this make sense given the state".
- Policy refusals from 05 hold: `just-bash` unselectable at >1 member; a routine on a bot with a member-scoped connection pins `runAs`.
- Organization commands never produce events here — they delegate to Better Auth and the decider rejects them loudly.
- Secret values never enter an event; only name and a 4-char hint.
- The visible assistant message is keyed `(turnId, stepIndex, sequence)`, last-writer-wins — eve retries steps under fresh `meta.id`s.
- Replaced timeline items keep their `seq`; only new items advance it. Reasoning projects a token count, never text.
- `apply` mutates the model in place (hot path) but is deterministic on `(model, event)`; persistence belongs to the caller.
- **A new field on an existing event is optional on decode.** The log is permanent and every fold re-reads it, so a required field added today makes every row written before today unreadable — and an unreadable row takes down every command on its aggregate. Give it a decoding default that is honest about not having been measured.
- An aggregate is exactly the events its fold consumes (`AGGREGATE_EVENTS`, beside the folds in `state.ts`). Adding a tag to a fold means adding it there; anything else is a decision made against a state that is missing it. Widening the set beyond the fold is worse: it puts unrelated traffic in the version, and the org aggregate then conflicts with every turn in the organization.
