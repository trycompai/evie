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
