# Docs

Split by audience, because the same sentence cannot serve all three.

| Directory | Who reads it | Voice |
| --- | --- | --- |
| [`user/`](./user) | People running Evie | Shipped product. "Your bot's computer", never "the sandbox backend". No repo paths, no tooling, no phase numbers. |
| [`internals/`](./internals) | People changing Evie | Architecture, adapters, contracts. Links into source. New vocabulary goes in [`internals/glossary.md`](./internals/glossary.md). |
| [`operations/`](./operations) | People keeping an environment alive | Runbooks. Every one starts from a symptom and ends with a verification step. |

The design that predates the code is in [`specs/`](../specs) and stays there.
Specs settle what to build; these docs describe what exists. When they
disagree, the code is right and one of them is stale — fix it in the same PR.

## Adding to these

`AGENTS.md` makes this an obligation, not a courtesy: a behaviour change a user
would notice belongs in `user/` before the PR lands. The test is whether someone
who has never read the diff could have predicted the new behaviour.
