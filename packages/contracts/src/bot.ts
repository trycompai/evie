import { Schema } from "effect";
import { BotId, Millis, OrgId, TeamId, UserId } from "./ids.ts";

/**
 * A bot is an eve agent directory owned by an organization. Everything here is
 * a bot-level record the user set, or a fact the supervisor observed.
 */

/**
 * An AI Gateway model id (`anthropic/claude-opus-4.8`), or a direct-provider id
 * once the provider package is installed into the bot. Kept as a string rather
 * than an enum: the gateway's catalog changes weekly and a closed union would
 * mean shipping Evie to add a model.
 */
export const ModelRef = Schema.String.check(Schema.isMinLength(1));
export type ModelRef = typeof ModelRef.Type;

export const ReasoningEffort = Schema.Literals([
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
]);
export type ReasoningEffort = typeof ReasoningEffort.Type;

/**
 * Isolation, weakest to strongest. The ordering is load-bearing: 05's threat
 * model blocks invitations on `just-bash` and blocks moving *to* `just-bash`
 * once a second member exists.
 */
export const SandboxBackend = Schema.Literals([
	"just-bash",
	"docker",
	"microsandbox",
	"vercel",
]);
export type SandboxBackend = typeof SandboxBackend.Type;

/**
 * eve defaults to `allow-all`. Evie defaults to deny-all plus an allow-list,
 * because the sandbox on a laptop sits next to the user's real network.
 *
 * `enforced` is how the UI stays honest: Docker understands only the coarse
 * modes and `just-bash` has no isolation at all, so the Computer pane says so
 * rather than claiming a policy it cannot deliver.
 */
export const NetworkPolicy = Schema.Struct({
	mode: Schema.Literals(["deny-all", "allow-list", "allow-all"]),
	allow: Schema.Array(Schema.String),
	enforced: Schema.Literals(["domain", "coarse", "none"]),
});
export type NetworkPolicy = typeof NetworkPolicy.Type;

export const SandboxConfig = Schema.Struct({
	backend: SandboxBackend,
	network: NetworkPolicy,
});
export type SandboxConfig = typeof SandboxConfig.Type;

/**
 * What the supervisor last observed. `unhealthy` carries the reason and the
 * tail of stderr; three failed starts stop the retry loop rather than
 * retrying forever behind a spinner that means nothing.
 */
export const BotHealth = Schema.Union([
	Schema.Struct({ kind: Schema.tag("idle") }),
	Schema.Struct({ kind: Schema.tag("starting") }),
	Schema.Struct({ kind: Schema.tag("ready") }),
	Schema.Struct({ kind: Schema.tag("busy"), activeTurns: Schema.Int }),
	Schema.Struct({ kind: Schema.tag("restarting"), attempt: Schema.Int }),
	Schema.Struct({
		kind: Schema.tag("unhealthy"),
		reason: Schema.String,
		stderr: Schema.Array(Schema.String),
	}),
]);
export type BotHealth = typeof BotHealth.Type;

/**
 * `dev` runs `eve dev --no-ui` so an instruction edit lands on the next turn
 * with no build step; `built` runs a deterministic artifact. Decision 012.
 */
export const RuntimeMode = Schema.Literals(["dev", "built"]);
export type RuntimeMode = typeof RuntimeMode.Type;

export const Bot = Schema.Struct({
	id: BotId,
	orgId: OrgId,
	/** Null means org-wide. Teams partition visibility; they add no permissions. */
	teamId: Schema.NullOr(TeamId),
	slug: Schema.String,
	name: Schema.String,
	description: Schema.NullOr(Schema.String),
	/** An emoji or a blob id. The design's bot marks are generated from the id. */
	avatar: Schema.NullOr(Schema.String),
	model: ModelRef,
	reasoning: Schema.NullOr(ReasoningEffort),
	runtimeMode: RuntimeMode,
	sandbox: SandboxConfig,
	health: BotHealth,
	createdBy: UserId,
	createdAt: Millis,
	/** Reverse state for archive. Non-null means archived, and reachable. */
	archivedAt: Schema.NullOr(Millis),
});
export type Bot = typeof Bot.Type;

/**
 * `dir` is deliberately absent from `Bot`. The client never needs the bot's
 * path on disk and putting it on the wire would leak the host's directory
 * layout to every member of the organization.
 */

export const CreateBotInput = Schema.Struct({
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
	description: Schema.optional(Schema.String),
	avatar: Schema.optional(Schema.String),
	model: ModelRef,
	reasoning: Schema.optional(ReasoningEffort),
	teamId: Schema.optional(TeamId),
});
export type CreateBotInput = typeof CreateBotInput.Type;
