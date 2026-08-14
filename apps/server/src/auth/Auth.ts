import {
	InvalidCommand,
	StorageUnavailable,
	Unauthenticated,
} from "@evie/contracts/errors";
import { OrgId, type TeamId, UserId } from "@evie/contracts/ids";
import {
	Invitation,
	Member,
	MemberRole,
	type Permission,
	Team,
} from "@evie/contracts/org";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { Context, Effect, Layer, Schema } from "effect";
import { EvieConfig } from "../config.ts";
import { Db } from "../db/Db.ts";
import {
	EvieKyselyDialect,
	type SharedSqlExecutor,
} from "../db/kysely-dialect.ts";
import type { Actor } from "../domain/state.ts";
import { ensureLocalOwner, makeClaimTokens } from "./claim.ts";
import {
	createEvieAuth,
	deriveBaseURL,
	type EvieAuth,
	loadOrCreateAuthSecret,
	roleHasPermission,
} from "./instance.ts";

/**
 * The Effect face of Better Auth. Everything session- and org-shaped that the
 * RPC layer needs goes through here; nothing else in the server imports
 * `better-auth` directly.
 *
 * Layer order at boot: `Db.layer` under this, and Evie's `MigrationsLive`
 * after it -- this layer runs Better Auth's `getMigrations()` at construction,
 * which the spec pins to run before Evie's own migrator.
 */

export interface InvitationInput {
	readonly email: string;
	readonly role: MemberRole;
	readonly teamId?: TeamId;
}

export interface OrgMembers {
	readonly members: ReadonlyArray<Member>;
	readonly invitations: ReadonlyArray<Invitation>;
	readonly teams: ReadonlyArray<Team>;
}

export interface AuthShape {
	/** The raw instance, for mounting `auth.handler` on the HTTP router. */
	readonly instance: EvieAuth;
	/** Better Auth's schema diff-and-apply. Idempotent; also runs at layer build. */
	readonly runMigrations: Effect.Effect<void, StorageUnavailable>;
	/**
	 * Session cookie or bearer token -> the member this request acts as, with
	 * the active organization resolved (and lazily set, for a fresh login that
	 * has not picked one). Never trusts an org id from a payload.
	 */
	readonly resolveActor: (
		headers: Headers,
	) => Effect.Effect<Actor, Unauthenticated>;
	/**
	 * The RPC middleware's gate, and the scheduler's for run-as members -- which
	 * is why it takes an `Actor`, not request headers: a routine dispatch has no
	 * request. Same `ac`/roles objects the HTTP endpoints check against.
	 */
	readonly hasPermission: (
		actor: Actor,
		permission: Permission,
	) => Effect.Effect<boolean>;
	/**
	 * A shareable invite link (no SMTP in a self-hosted environment). Better
	 * Auth still binds the invitation to the email and expires it.
	 */
	readonly invitationUrl: (
		headers: Headers,
		input: InvitationInput,
	) => Effect.Effect<string, Unauthenticated | InvalidCommand>;
	readonly setActiveOrg: (
		headers: Headers,
		orgId: OrgId,
	) => Effect.Effect<void, Unauthenticated | InvalidCommand>;
	/** The `org.members` RPC's read: members with team ids, invitations, teams. */
	readonly members: (
		headers: Headers,
	) => Effect.Effect<OrgMembers, Unauthenticated | InvalidCommand>;
	readonly claim: {
		/** First boot of local mode: owner + personal org. Later boots find, not create. */
		readonly ensureLocalOwner: Effect.Effect<UserId, StorageUnavailable>;
		/** Mint the one-time token the launcher puts in `/?claim=<token>`. */
		readonly mint: (userId: UserId) => { token: string; expiresAt: number };
	};
}

const decodeUserId = Schema.decodeUnknownSync(UserId);
const decodeOrgId = Schema.decodeUnknownSync(OrgId);
const decodeRole = Schema.decodeUnknownSync(MemberRole);
const decodeMember = Schema.decodeUnknownSync(Member);
const decodeInvitation = Schema.decodeUnknownSync(Invitation);
const decodeTeam = Schema.decodeUnknownSync(Team);

const millis = (value: Date | string | number): number =>
	new Date(value).getTime();

/**
 * Better Auth's typed refusals become typed Evie errors; anything else
 * (driver failure, bug) stays a defect rather than masquerading as a 401.
 */
const authApiError = (error: unknown): Unauthenticated | InvalidCommand =>
	error instanceof APIError && error.status === "UNAUTHORIZED"
		? new Unauthenticated()
		: new InvalidCommand({
				reason: error instanceof APIError ? error.message : String(error),
			});

const make = Effect.gen(function* () {
	const config = yield* EvieConfig;
	const db = yield* Db;

	// Better Auth is promise-shaped, Db is Effect-shaped; this is the one bridge.
	// retryLocked because auth writes contend with the event log for the single
	// write lock, and Better Auth has no idea what a busy timeout is.
	const executor: SharedSqlExecutor = {
		executeRaw: (sqlText, params) =>
			Effect.runPromise(db.retryLocked(db.executeRaw(sqlText, params))),
	};

	const claimTokens = makeClaimTokens();
	const auth = createEvieAuth({
		config,
		dialect: new EvieKyselyDialect(executor),
		secret: loadOrCreateAuthSecret(config.home),
		claimTokens,
	});
	const baseURL = deriveBaseURL(config);

	const runMigrations = Effect.tryPromise({
		try: async () => {
			const { runMigrations: run } = await getMigrations(auth.options);
			await run();
		},
		catch: (error) =>
			new StorageUnavailable({
				reason: `Better Auth migrations failed: ${String(error)}`,
			}),
	});

	// Auth tables exist before anything depending on this layer runs -- and
	// before Evie's own migrator, per 05 "Two migration owners on one file".
	yield* runMigrations;

	const resolveActor: AuthShape["resolveActor"] = Effect.fn(
		"Auth.resolveActor",
	)(function* (headers: Headers) {
		const session = yield* Effect.promise(() =>
			auth.api.getSession({ headers }),
		);
		if (!session) return yield* new Unauthenticated();
		const userId = session.user.id;

		let orgId = session.session.activeOrganizationId;
		if (!orgId) {
			// A fresh credential login has no active org yet. Adopt the first
			// membership rather than failing -- the common case is exactly one.
			const orgs = yield* Effect.promise(() =>
				auth.api.listOrganizations({ headers }),
			);
			const first = orgs[0];
			if (!first) return yield* new Unauthenticated();
			yield* Effect.promise(() =>
				auth.api.setActiveOrganization({
					headers,
					body: { organizationId: first.id },
				}),
			);
			orgId = first.id;
		}

		// One local read instead of a second session round trip; resolveActor
		// runs on every RPC. A vanished membership is a stale session: 401.
		const rows = yield* Effect.orDie(
			db.execute(
				`select "role" from "member" where "organizationId" = ? and "userId" = ?`,
				[orgId, userId],
			),
		);
		const role = rows[0]?.role;
		if (typeof role !== "string") return yield* new Unauthenticated();

		return {
			userId: decodeUserId(userId),
			orgId: decodeOrgId(orgId),
			role: decodeRole(role),
		} satisfies Actor;
	});

	const hasPermission: AuthShape["hasPermission"] = (actor, permission) =>
		Effect.sync(() => roleHasPermission(actor.role, permission));

	const invitationUrl: AuthShape["invitationUrl"] = Effect.fn(
		"Auth.invitationUrl",
	)(function* (headers: Headers, input: InvitationInput) {
		const invitation = yield* Effect.tryPromise({
			try: () =>
				auth.api.createInvitation({
					headers,
					body: {
						email: input.email,
						role: input.role,
						...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
					},
				}),
			catch: authApiError,
		});
		return `${baseURL}/accept-invite/${invitation.id}`;
	});

	const setActiveOrg: AuthShape["setActiveOrg"] = Effect.fn(
		"Auth.setActiveOrg",
	)(function* (headers: Headers, orgId: OrgId) {
		yield* Effect.tryPromise({
			try: () =>
				auth.api.setActiveOrganization({
					headers,
					body: { organizationId: orgId },
				}),
			catch: authApiError,
		});
	});

	const members: AuthShape["members"] = Effect.fn("Auth.members")(function* (
		headers: Headers,
	) {
		const full = yield* Effect.tryPromise({
			try: () => auth.api.getFullOrganization({ headers }),
			catch: authApiError,
		});
		if (!full) return yield* new Unauthenticated();

		// Team membership in one org-wide query, not one per member.
		const teamRows = yield* Effect.orDie(
			db.execute(
				`select tm."userId" as user_id, tm."teamId" as team_id
         from "teamMember" tm join "team" t on t."id" = tm."teamId"
         where t."organizationId" = ?`,
				[full.id],
			),
		);
		const teamsByUser = new Map<string, Array<string>>();
		for (const row of teamRows) {
			const userId = String(row.user_id);
			const list = teamsByUser.get(userId) ?? [];
			list.push(String(row.team_id));
			teamsByUser.set(userId, list);
		}

		return {
			members: full.members.map((m) =>
				decodeMember({
					userId: m.userId,
					name: m.user.name,
					email: m.user.email,
					image: m.user.image ?? null,
					role: m.role,
					teamIds: teamsByUser.get(m.userId) ?? [],
					joinedAt: millis(m.createdAt),
				}),
			),
			invitations: full.invitations.map((i) =>
				decodeInvitation({
					id: i.id,
					email: i.email,
					role: i.role ?? "member",
					teamId: "teamId" in i && i.teamId ? i.teamId : null,
					status: i.status,
					expiresAt: millis(i.expiresAt),
					invitedBy: i.inviterId,
				}),
			),
			teams: (full.teams ?? []).map((t) =>
				decodeTeam({ id: t.id, name: t.name, createdAt: millis(t.createdAt) }),
			),
		} satisfies OrgMembers;
	});

	const firstUserId = () =>
		Effect.runPromise(
			Effect.map(
				db.execute(`select "id" from "user" order by "createdAt" asc limit 1`),
				(rows) => {
					const id = rows[0]?.id;
					return typeof id === "string" ? id : null;
				},
			),
		);

	const claim: AuthShape["claim"] = {
		ensureLocalOwner: Effect.fn("Auth.ensureLocalOwner")(function* () {
			const id = yield* Effect.tryPromise({
				try: () => ensureLocalOwner(auth, { firstUserId }),
				catch: (error) =>
					new StorageUnavailable({
						reason: `local owner bootstrap failed: ${String(error)}`,
					}),
			});
			return decodeUserId(id);
		})(),
		mint: (userId) => claimTokens.mint(userId),
	};

	return {
		instance: auth,
		runMigrations,
		resolveActor,
		hasPermission,
		invitationUrl,
		setActiveOrg,
		members,
		claim,
	} satisfies AuthShape;
});

export class Auth extends Context.Service<Auth, AuthShape>()("Auth") {
	static readonly layer = Layer.effect(Auth, make);
}
