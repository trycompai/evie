import type {
	ConnectionConfig,
	CreateBotInput,
	NetworkPolicy,
	ReasoningEffort,
	SandboxBackend,
} from "@evie/contracts/bot";
import type { Command } from "@evie/contracts/commands";
import type {
	BlobId,
	BotId,
	ConnectionId,
	RoutineId,
	ThreadId,
	TurnId,
	UserId,
} from "@evie/contracts/ids";
import type { MemberRole } from "@evie/contracts/org";
import type { Receipt } from "@evie/contracts/rpc";
import type { EvieClient } from "./client.ts";

/**
 * Named senders over the one `command` RPC.
 *
 * The wire has a single command endpoint so the handshake, the actor
 * resolution, and the permission check cannot be forgotten on a new call. The
 * ergonomics people actually want -- `commands.snoozeThread(id, until)` --
 * belong here, where they cost a line each and nothing on the wire.
 *
 * Ids are the branded types from `@evie/contracts/ids`, not `string`. Callers
 * already hold branded ids because they came out of a decoded `Bot` or
 * `Thread`, so this costs nothing and it is the only thing standing between
 * `archiveBot(threadId)` and a very confusing afternoon.
 *
 * Every one returns a `Receipt`. The change itself arrives through the
 * subscription the client already holds: rendering an optimistic result *and* a
 * subscribed one means two code paths that can disagree about what happened,
 * and the one that is wrong is always the optimistic one.
 */

/**
 * A key the server folds on, so a retry after a dropped socket is the same
 * message rather than a second one. `randomUUID` because this runs in a browser
 * and a ULID's sortability buys nothing for a key nobody orders by.
 */
const idempotencyKey = (): string => globalThis.crypto.randomUUID();

export function makeCommands(client: EvieClient) {
	const send = (command: Command): Promise<Receipt> =>
		client.rpc((c) => c["command"]({ command }));

	return {
		send,

		/* --- bots ----------------------------------------------------------- */
		createBot: (input: CreateBotInput) => send({ _tag: "CreateBot", input }),
		renameBot: (botId: BotId, name: string, description?: string | null) =>
			send({ _tag: "RenameBot", botId, name, description }),
		archiveBot: (botId: BotId) => send({ _tag: "ArchiveBot", botId }),
		unarchiveBot: (botId: BotId) => send({ _tag: "UnarchiveBot", botId }),
		setModel: (
			botId: BotId,
			model: string,
			reasoning?: ReasoningEffort | null,
		) => send({ _tag: "SetModel", botId, model, reasoning }),
		setSandboxBackend: (botId: BotId, backend: SandboxBackend) =>
			send({ _tag: "SetSandboxBackend", botId, backend }),
		setNetworkPolicy: (botId: BotId, policy: NetworkPolicy) =>
			send({ _tag: "SetNetworkPolicy", botId, policy }),
		setInstructions: (botId: BotId, instructions: string) =>
			send({ _tag: "SetInstructions", botId, instructions }),

		/* --- threads and turns ---------------------------------------------- */
		openThread: (participants: readonly BotId[], title?: string) =>
			send({ _tag: "OpenThread", participants, title }),
		sendMessage: (
			threadId: ThreadId,
			text: string,
			options?: {
				readonly mentions?: readonly BotId[];
				readonly attachments?: readonly BlobId[];
			},
		) =>
			send({
				_tag: "SendMessage",
				threadId,
				text,
				mentions: options?.mentions ?? [],
				attachments: options?.attachments ?? [],
				idempotencyKey: idempotencyKey(),
			}),
		cancelTurn: (threadId: ThreadId, turnId: TurnId) =>
			send({ _tag: "CancelTurn", threadId, turnId }),
		answerInput: (
			threadId: ThreadId,
			requestId: string,
			optionId: string | null,
			options?: {
				readonly text?: string;
				readonly scope?: "once" | "always" | "never";
			},
		) =>
			send({ _tag: "AnswerInput", threadId, requestId, optionId, ...options }),
		compactSession: (threadId: ThreadId, botId: BotId) =>
			send({ _tag: "CompactSession", threadId, botId }),
		clearSession: (threadId: ThreadId, botId: BotId) =>
			send({ _tag: "ClearSession", threadId, botId }),
		snoozeThread: (threadId: ThreadId, until: number) =>
			send({ _tag: "SnoozeThread", threadId, until }),
		unsnoozeThread: (threadId: ThreadId) =>
			send({ _tag: "UnsnoozeThread", threadId }),
		archiveThread: (threadId: ThreadId) =>
			send({ _tag: "ArchiveThread", threadId }),
		unarchiveThread: (threadId: ThreadId) =>
			send({ _tag: "UnarchiveThread", threadId }),
		renameThread: (threadId: ThreadId, title: string | null) =>
			send({ _tag: "RenameThread", threadId, title }),

		/* --- routines --------------------------------------------------------- */
		createRoutine: (
			botId: BotId,
			input: {
				readonly name: string;
				/** 5-field cron. The decider rejects anything else. */
				readonly cron: string;
				/** IANA zone. Pass the viewer's own; never let the server guess. */
				readonly tz: string;
				readonly prompt: string;
				readonly threadId?: ThreadId;
				readonly runAs?: UserId;
			},
		) => send({ _tag: "CreateRoutine", botId, ...input }),
		setRoutineEnabled: (
			botId: BotId,
			routineId: RoutineId,
			enabled: boolean,
		) => send({ _tag: "SetRoutineEnabled", botId, routineId, enabled }),
		setRoutineRunAs: (
			botId: BotId,
			routineId: RoutineId,
			runAs: UserId | null,
		) => send({ _tag: "SetRoutineRunAs", botId, routineId, runAs }),
		deleteRoutine: (botId: BotId, routineId: RoutineId) =>
			send({ _tag: "DeleteRoutine", botId, routineId }),

		/* --- connections ----------------------------------------------------- */
		connectService: (
			botId: BotId,
			input: {
				readonly name: string;
				readonly kind: "mcp" | "openapi";
				readonly scope: "org" | "member";
				readonly config: ConnectionConfig;
				readonly authKind: "none" | "token" | "interactive";
			},
		) => send({ _tag: "ConnectService", botId, ...input }),
		disconnectService: (botId: BotId, connectionId: ConnectionId) =>
			send({ _tag: "DisconnectService", botId, connectionId }),
		linkMyGrant: (botId: BotId, connectionId: ConnectionId, token?: string) =>
			send({ _tag: "LinkMyGrant", botId, connectionId, token }),
		revokeGrant: (
			botId: BotId,
			connectionId: ConnectionId,
			userId: UserId | null,
		) => send({ _tag: "RevokeGrant", botId, connectionId, userId }),

		/* --- secrets ---------------------------------------------------------- */
		setSecret: (
			scope: "org" | "bot" | "user",
			name: string,
			value: string,
			botId?: BotId,
		) => send({ _tag: "SetSecret", scope, name, value, botId }),
		removeSecret: (
			scope: "org" | "bot" | "user",
			name: string,
			botId?: BotId,
		) => send({ _tag: "RemoveSecret", scope, name, botId }),

		/* --- organization ------------------------------------------------------ */
		inviteMember: (email: string, role: MemberRole, teamId?: never) =>
			send({ _tag: "InviteMember", email, role, teamId }),
		revokeInvitation: (invitationId: string) =>
			send({ _tag: "RevokeInvitation", invitationId }),
		setMemberRole: (userId: UserId, role: MemberRole) =>
			send({ _tag: "SetMemberRole", userId, role }),
		removeMember: (userId: UserId) => send({ _tag: "RemoveMember", userId }),
		setActiveOrg: (orgId: string) => send({ _tag: "SetActiveOrg", orgId }),
	};
}

export type Commands = ReturnType<typeof makeCommands>;
