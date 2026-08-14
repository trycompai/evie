# 05 — Auth, secrets, and remote

## Three auth boundaries, kept separate

Confusing these is how auth bugs happen, so name them:

| Boundary                  | Question it answers                                | Owner                                             |
| ------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| **Client → Evie**         | Who is this person, and what may they do here?     | Better Auth + the `organization` plugin           |
| **Evie → eve runtime**    | Which member is this turn acting as?               | eve route auth (per-turn signed JWT)              |
| **Agent → third party**   | Can this bot act on Notion/Linear/GitHub, as whom? | eve connection auth (`authorization.required`)    |

Only the first is a user-facing login. The second is machine-to-machine on loopback, and it carries
identity — that is what makes the third one able to distinguish *your* Linear from the team's.

## Client → Evie: Better Auth with organizations

**Evie is multi-tenant from the first migration.** An organization owns bots, threads, routines, and
connections; a person is a member of one or more organizations; teams optionally partition bots
inside an organization. Retrofitting `organization_id` onto every table later is exactly the kind of
migration this spec exists to avoid, so it goes in at Phase 0 even though the member-management UI
does not arrive until Phase 2.

```ts
// apps/server/src/auth.ts
import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins/organization";
import { passkey } from "better-auth/plugins/passkey";
import { bearer } from "better-auth/plugins/bearer";

export const auth = betterAuth({
  appName: "Evie",
  // NOT `new DatabaseSync(statePath)`. Better Auth executes through the one connection
  // `Db` owns -- see "One database handle" below.
  database: { dialect: evieKyselyDialect, type: "sqlite" },
  emailAndPassword: { enabled: true },
  plugins: [
    organization({
      teams: { enabled: true, maximumTeams: 20 },
      allowUserToCreateOrganization: true,
      // No SMTP in a self-hosted environment. Invitations are share links, not email.
      invitationExpiresIn: 60 * 60 * 24 * 7,
      cancelPendingInvitationsOnReInvite: true,
      hooks: {
        organization: {
          afterCreate: async ({ organization }) => {
            await provisionOrgHome(organization.id); // userdata/orgs/<id>/
          },
          beforeDelete: async ({ organization }) => {
            await archiveOrgHome(organization.id); // never a silent rm -rf of someone's bots
          },
        },
      },
    }),
    passkey(),
    bearer(),
  ],
  session: {
    expiresIn: mode === "local" ? 60 * 60 * 24 * 30 : 60 * 60 * 24 * 7,
    cookieCache: { enabled: true },
  },
  advanced: { useSecureCookies: isHttps },
  trustedOrigins,
});
```

### One database handle

Better Auth's documented direct-connection drivers are `pg.Pool`, `mysql2`, `better-sqlite3`, and
`bun:sqlite`. **`node:sqlite` is not among them**, so `database: new DatabaseSync(statePath)` cannot
be assumed to work — and reaching for `better-sqlite3` instead would quietly cost us the thing
[03](./03-contracts-and-data.md#sqlite-schema) claims as a benefit: no native module, so Electron
needs no rebuild step. It would also open a *second writer* on `state.sqlite`, which
[02](./02-architecture.md#one-writer-and-why-that-is-a-hard-rule) rules out outright.

So the target is a thin Kysely dialect that executes through the connection `Db` already owns —
roughly sixty lines wrapping `node:sqlite`'s `StatementSync`. **This is a Phase 0 spike with a
decided fallback**, in preference order:

1. **Custom Kysely dialect over `Db`'s connection.** One writer, one driver, no native module.
2. **A separate file, `userdata/auth.sqlite`, with whatever driver Better Auth supports.** Two
   files with one writer each is correct. Evie's rows already reference auth only by `user.id`,
   `organization.id`, and `team.id`, so nothing here needs a cross-file join or a foreign key —
   which is exactly why that constraint was written down before it was needed.

What we will not do is put two write handles on one file. Verify before writing the first migration;
the answer changes where the Better Auth tables live, and moving them later is a data migration.

Notes that matter, from the Better Auth best-practices and organization skills:

- **Plugins are imported from dedicated paths** (`better-auth/plugins/organization`), not the barrel,
  so they tree-shake.
- **`BETTER_AUTH_SECRET` is generated, not demanded.** On first boot Evie writes a 32-byte secret to
  Evie home at 0600 and loads it from there. Asking a desktop user to set an env var would be
  absurd. `BETTER_AUTH_URL` is derived from the bind address and the active connection mode.
- **Two migration owners on one file.** Better Auth's `getMigrations()` runs at boot before Evie's
  `SqliteMigrator`. The organization plugin adds `organization`, `member`, `invitation`, `team`, and
  `teamMember` — re-run after adding any plugin, plugin schemas are not optional.
- **Model names, not table names**, in any config that references them.
- **The active organization lives in the session** and scopes every subsequent call. Evie sets it on
  login and on org switch; every RPC handler reads it rather than trusting an `organizationId` in
  the payload.
- **The last owner cannot be removed or demoted.** Better Auth enforces it; the UI must offer
  ownership transfer before it offers removal, or the button just errors.

### Roles and permissions

Three default roles, with Evie's own permission statements layered on:

| Permission          | owner | admin | member |
| ------------------- | ----- | ----- | ------ |
| `bot:create`        | ✓     | ✓     |        |
| `bot:read`          | ✓     | ✓     | ✓      |
| `bot:update`        | ✓     | ✓     |        |
| `bot:delete`        | ✓     | ✓     |        |
| `thread:read`       | ✓     | ✓     | ✓      |
| `thread:write`      | ✓     | ✓     | ✓      |
| `routine:manage`    | ✓     | ✓     |        |
| `connection:manage` | ✓     | ✓     |        |
| `connection:link`   | ✓     | ✓     | ✓      | *(authorize your own member-scoped credential)* |
| `secret:manage`     | ✓     | ✓     |        |
| `settings:manage`   | ✓     | ✓     |        |
| `member:manage`     | ✓     | ✓     |        |
| `org:delete`        | ✓     |       |        |

Checks run server-side through `auth.api.hasPermission` in the RPC middleware, before the command
reaches the decider. `checkRolePermission` is used **only** to grey out UI — never as the gate.

Custom roles via `dynamicAccessControl` are deliberately not enabled yet. Three roles cover the
"a few people share an Evie box" case, and every extra role is a new thing to get wrong in the
sandbox threat model below.

### Teams

With `teams: { enabled: true }`, a bot may belong to a team (`bot.team_id`) or to the whole
organization (`team_id` null). A member sees org-wide bots plus the bots of teams they are in. That
is the whole feature — teams partition visibility, they do not introduce a second permission system.

### Invitations without an SMTP server

A self-hosted Evie has no mail server, so `sendInvitationEmail` is not the path.
`getInvitationURL({ email, role })` returns a shareable link and deliberately does **not** invoke
the email hook. The owner copies the link into whatever channel the team already uses. The
invitation still binds to the invited email address and still expires.

Evie calls it **server-side**, through `auth.api`, from the RPC handler behind a `member:manage`
check — not `authClient.organization.getInvitationURL` from the browser, which is how it is
documented. Every organization mutation in Evie goes through the same RPC middleware as every other
command, because that middleware is where `hasPermission` runs and where the active organization is
read from the session instead of the payload. An org mutation that bypasses it is an org mutation
nobody authorized.

If an environment does have SMTP configured in Settings, Evie wires `sendInvitationEmail` to it and
the UI offers both.

### Modes

The mode is a property of how the server is bound, not a user setting to get wrong.

| Mode         | Bind                    | Login                                                                                    |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------ |
| `local`      | `127.0.0.1` only        | On first boot Evie creates a user and a personal organization with that user as owner, and mints a **one-time claim token**. The desktop app (or the `npx evie` console line) opens `http://127.0.0.1:<port>/?claim=<token>`; redeeming it exchanges the token for a session cookie. No prompt, no visible org UI. |
| `lan`        | `0.0.0.0`               | Real credentials required. Members join by invitation link. Password, not passkey — see below. |
| `tunnel`     | via Tailscale / relay   | Same as `lan`, plus `useSecureCookies`, the tunnel host in `trustedOrigins`, and passkeys available because the origin is finally secure. |

**Why `local` mode does not just hand a cookie to the first caller.** "First loopback request wins"
sounds harmless on a single-user machine and isn't: every other process on the box can reach
`127.0.0.1`, and so can a page in the user's browser — a site the user happens to be visiting can
fire requests at localhost and race the real client for that cookie. What is behind it is an agent
with a shell in the user's home directory, which makes this the highest-value cookie on the machine.
A one-time token in the URL the launcher itself opens costs one line of UX, closes the race, and is
the pattern Jupyter and VS Code tunnels settled on for exactly this reason. On top of it:
`trustedOrigins` is enforced in every mode, and the token is single-use and expires in 60 seconds.

**Why `lan` mode cannot encourage passkeys.** WebAuthn requires a secure context. Browsers exempt
`localhost` and nothing else, so a phone hitting `http://studio.local:3000` gets no credential API
at all — the passkey button would be dead on the one surface it was recommended for. Passkeys are
therefore offered in `local` (where they add little) and `tunnel` (where TLS makes them real), and
the LAN path is password plus the `bearer` plugin for paired devices. If we want passkeys on the
LAN later, the honest route is a real certificate for the LAN hostname, not a wish.

The personal organization in `local` mode is not a special case in the schema — it is an ordinary
org with one owner, which is why turning on teams later is a UI change rather than a migration.

**Three hard refusals when leaving `local`:**

1. Evie will not bind a non-loopback interface while the only principal is the auto-provisioned local
   owner. Set a credential first. The failure mode is a stranger on café wifi driving an agent with
   shell access to your home directory.
2. Evie will not accept a second member into an organization whose bots use the `just-bash` sandbox
   backend. See the threat model below.
3. Evie will not let a bot **move to** `just-bash` in an organization that already has more than one
   member. Refusal 2 guards the door; this one guards the window. A rule that only fires on the way
   in is a rule you can walk around, and *"switch the sandbox, then invite"* and *"invite, then
   switch the sandbox"* have to reach the same answer or the check is decorative. The Computer pane
   greys the option out with the reason, and the invite flow surfaces the same constraint.

Desktop and any non-cookie client use the `bearer` plugin. `device` rows are revocable from
Settings — pairing has an unpairing, per the reverse-state rule.

### The threat model teams introduces

This is the most important consequence of going multi-user, and it deserves to be stated plainly:

**An organization member who can send a message to a bot can run code on the machine hosting that
bot.** That is not a bug in Evie — it is what an agent with a shell *is*. Single-owner mode hides it
because the only person who can do that is the person who owns the machine.

So teams mode leans entirely on sandbox isolation, and Evie enforces it rather than assuming it:

| Backend        | Isolation                                        | Allowed with >1 member |
| -------------- | ------------------------------------------------ | ---------------------- |
| `vercel()`     | Hosted microVM, domain allow-lists, brokering    | Yes                    |
| `microsandbox()` | Local microVM, domain allow-lists, brokering   | Yes                    |
| `docker()`     | Container; `allow-all` / `deny-all` egress only  | Yes, with a warning that egress is coarse |
| `justbash()`   | **None.** Simulated shell, no network isolation  | **No.** Invitations blocked, and the backend cannot be selected once a second member exists. |

The invite flow surfaces this before the first invitation, not in a settings page nobody opens.
Beyond that: bots default to `deny-all` plus an allow-list, `bot:create` and `secret:manage` are
admin-and-above, and every dispatched turn is attributed to a member in the event log.

## Evie → eve runtime: carrying the member's identity

Each spawn mints a fresh 32-byte `EVIE_RUNTIME_SECRET`, injects it into the child's environment, and
binds the runtime to `127.0.0.1` on an ephemeral port that is never written to disk or logged.

Because connections can be member-scoped, the runtime needs to know *who* a turn is for — a static
shared credential is no longer enough. On every dispatch Evie mints a short-lived HS256 JWT carrying
the acting member, and the generated channel verifies it:

```ts
// agent/channels/eve.ts — generated per bot
import { eveChannel } from "eve/channels/eve";
import { extractBearerToken, verifyJwtHmac, withAuthChallenges, type AuthFn } from "eve/channels/auth";

const evieCaller: AuthFn<Request> = withAuthChallenges(async (request) => {
  const token = extractBearerToken(request.headers.get("authorization"));
  const result = await verifyJwtHmac(token, {
    algorithm: "HS256",
    issuer: "evie",
    audiences: [process.env.EVIE_BOT_ID!],
    secret: process.env.EVIE_RUNTIME_SECRET!,
  });
  if (!result.ok) return null;

  const claims = result.sessionAuth.attributes;
  return {
    authenticator: "evie",
    principalId: String(claims.sub),          // stable Better Auth user id
    principalType: "user",                     // required for member-scoped connections
    attributes: { orgId: claims.org, role: claims.role, issuer: "evie" },
  };
}, [{ scheme: "Bearer" }]);

export default eveChannel({ auth: [evieCaller] });
```

Three things this buys, none of which a shared secret could:

- `ctx.session.auth.current.principalId` is a real person, so a `principalType: "user"` connection
  resolves *their* token. eve keys its credential cache by issuer and principal id, which is why the
  `issuer` attribute is set explicitly.
- `auth.initiator` stays pinned to whoever started the thread while `auth.current` tracks whoever
  sent this turn — exactly the semantics a shared thread needs, and eve already implements it.
- Tokens are per-turn and short-lived, so a leaked one is worth almost nothing.

`GET /eve/v1/health` stays public in eve; the supervisor uses it for readiness and nothing else is
exposed.

## Agent → third party

Connections are authored files under `agent/connections/`. Evie's catalog writes them. With teams,
every connection now answers a second question: **whose account is this?**

| Scope      | eve `principalType` | Meaning                                                                     |
| ---------- | ------------------- | ----------------------------------------------------------------------------- |
| `org`      | `"app"`             | One shared credential — a bot account the whole organization acts through.  |
| `member`   | `"user"`            | Each member authorizes their own account. The bot acts as whoever is talking. |

`member` scope is the reason the runtime JWT above carries a real `principalId`. When a member who
has not linked their account triggers a tool that needs it, eve emits `authorization.required` for
that member only, parks the turn, and resumes after they sign in. Another member's grant is never
reused; eve keys its token cache by issuer and principal id.

Mechanisms, unchanged by teams:

- **Static token** (`{ getToken }`): the token lives in Evie's `secret` table and is injected at
  spawn. Enough for Linear, GitHub PATs, most internal APIs. Naturally `org`-scoped.
- **Interactive OAuth**: `defineInteractiveAuthorization` from `eve/connections`. Self-hosted, no
  Vercel Connect dependency, which keeps local-first honest. The callback URL must be reachable by
  the identity provider, so Evie proxies it through its own `/oauth/callback/:connection` route and
  forwards to the runtime's framework-owned webhook.
- **Vercel Connect** (`@vercel/connect/eve`) is an option for hosted environments where managed
  per-user token storage is worth the dependency. Never required.

Every connection carries an approval policy — `never()`, `once()`, `always()` from
`eve/tools/approval`. The catalog defaults anything that can write, send, purchase, delete, or read
sensitive data to `once()`. A member can loosen it only if they hold `connection:manage`.

### The routine trap

A scheduled run has no human behind it. eve is explicit about this: a user-scoped connection invoked
from a schedule fails with `reason: "principal_required"` rather than silently borrowing someone's
grant. That is the right behaviour and it has a direct product consequence:

**A routine that touches a `member`-scoped connection must pin a run-as member.** `routine.run_as`
holds that member id; the routine editor requires it as soon as the bot has a member-scoped
connection, and warns when the pinned member's grant is revoked or they leave the organization. A
routine with no member-scoped dependency runs as the app principal and needs nothing.

## Secrets

- AES-256-GCM, key from the OS keychain (macOS Keychain, Windows Credential Manager) or
  `~/.evie/userdata/secrets.key` at 0600 on Linux.
- Scoped `org:<id>`, `bot:<id>`, or `user:<id>`. A `user:` secret is a member's own credential for a
  member-scoped connection. **No API returns it to anyone but its owner's own turns** — an admin can
  revoke it and cannot read it through Evie.

  Say that precisely, because the precise version is weaker than it sounds and someone will build on
  whichever version is written down. There is one encryption key on the machine, and the person who
  administers the host can read `secrets.key` and `state.sqlite` directly. This is an
  **access-control property of the API, not a cryptographic guarantee against the host owner**, and
  it cannot be otherwise while a self-hosted admin owns the disk. What it does buy is real: no
  Settings screen, no export, no support tool, and no logged frame ever surfaces another member's
  token. The honest framing for the invite flow is *"the person who runs this box could read your
  token if they tried"*, not *"nobody can read your token"* — and members should be told that before
  they link a personal account, not after.
- Plaintext exists in exactly two places: the encrypt/decrypt call, and the environment of a spawned
  eve child. It is never in `agent.ts`, never in the event log, never in a projection.
- A client receives `{ name, hint: "…a4f2", configured: true }`. Never the value, not to an owner,
  not over loopback. Re-entry is cheap; a leaked secret in a logged WebSocket frame is not.
- Rotation is a first-class command; rotating restarts affected runtimes.
- Removing a member revokes their `user:` secrets and marks any routine pinned to them as blocked
  rather than letting it run as somebody else.

## Model access — BYOK

**Primary path: Vercel AI Gateway.** One `AI_GATEWAY_API_KEY` reaches every model, gives one place
to watch spend, and is what eve scaffolds by default. Onboarding asks for exactly one token.

The token is an **organization** secret, not a personal one: everyone in the org spends against it,
which is the point of a shared team environment and also the reason `secret:manage` is
admin-and-above. A member cannot see the key, cannot rotate it, and can see exactly what their own
turns cost.

**Secondary path: direct provider keys.** Install the AI SDK provider package into the bot's
`package.json` and set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / etc. Evie supports it; the model
picker just shows fewer options and a "direct provider" badge.

Model and reasoning effort are per-bot. Evie changes them by shelling out to `eve set --model … --reasoning …`
in the bot directory, reusing eve's own validated source editor rather than rewriting `agent.ts` —
so a model defined with `defineDynamic` or a provider SDK object is not silently clobbered.

Spend controls, because BYOK means a runaway loop costs the user real money:

- Monthly budgets at two levels: per organization and per bot. On breach the bot pauses and the
  thread shows a *budget reached* row with a raise-limit action, gated on `settings:manage`.
- Per-turn step ceiling, mapped to eve's `limits` in `agent.ts`.
- A usage view built from `step.completed` usage and, when the AI Gateway served the call, cost —
  broken down by bot **and by member**, since every turn is attributed to the member who sent it.
  A shared key with no per-person attribution is how a team ends up unable to explain its bill.

## Sandbox network policy

eve's default is `allow-all`. Evie's default is an allow-list, because the sandbox on a laptop sits
next to the user's real network.

Base allow-list: the AI Gateway host, plus each enabled connection's host. Adding a domain is a
visible action in Settings → Computer with a one-line explanation of what it lets the bot reach.

Domain-level allow-lists and credential brokering work on the `vercel()` and `microsandbox()`
backends. The Docker backend honours only `allow-all` / `deny-all`, and `just-bash` has no network
isolation at all — both facts are surfaced in the Computer pane rather than hidden, because a policy
the UI claims to enforce and doesn't is worse than no policy.

## Remote and multi-device

The eve session contract makes this straightforward, and it is why the durable-session design is
worth building on:

- Sessions are ID-addressed and durable for 30 days by default.
- Streams are cursor-addressed; `startIndex` is an absolute event count.
- Events carry a stable `meta.id`, so overlapping replay after a reconnect renders once.

So "take over from another device" is not a feature to invent. A second client authenticates to the
same Evie server, subscribes to the thread, and receives the timeline from its cursor. Both clients
are live. Both can send. Steering is eve's documented behaviour for a message arriving mid-turn.

Connection modes, in the order a user meets them:

1. **Local** — the desktop app talking to its own bundled server. Nothing on the network.
2. **LAN** — a phone or laptop on the same network hits `http://<host>.local:3000` after pairing.
3. **Tailscale** — the same, over a tailnet. No configuration on Evie's side beyond binding.
4. **Relay** — for the case where neither end is reachable. The Evie server dials out to a relay and
   tryevie.ai connects to the other side. **The relay forwards frames; it does not host agents and
   cannot read them.** tryevie.ai is a client.

That last point is a product commitment, not an implementation detail. The moment tryevie.ai can run
your agents, "local first" is marketing.

### What the relay claim actually requires

"Cannot read them" is a public promise about a mechanism, so the mechanism has to exist before the
promise ships. Phase 4 owns the design; these are the constraints it has to satisfy, written down
now so the sentence above is a specification and not a slogan:

- **Pairing establishes a shared secret out of band.** The environment displays a short code; the
  client enters it. A PAKE (SPAKE2 or CPace) turns that low-entropy code into a strong shared key
  without the relay learning either, which is what makes a six-digit code safe to read aloud. A
  code passed *through* the relay would authenticate the relay to itself.
- **The relay sees ciphertext and routing metadata only.** It learns that a pairing exists, roughly
  how much traffic flows, and when. It never holds a key. Frame lengths are padded to buckets so
  the shape of a transcript is not the transcript.
- **The channel is authenticated, not merely encrypted.** Noise IK or TLS with raw public keys
  pinned at pairing. Encryption without authentication buys nothing here: a relay that can swap
  keys can read everything and is exactly the party we are defending against.
- **Keys rotate, and pairing is revocable.** A `device` row already carries `revoked_at`; revoking
  it invalidates the pairing rather than just hiding the row.
- **The failure mode is refusal.** If the peer cannot be authenticated, the client shows an error.
  It never silently downgrades to a relay-readable channel — a security property that degrades
  quietly is worse than one we never claimed.

Until all five hold, tryevie.ai ships with the LAN and Tailscale paths only. Shipping the relay with
a weaker story than the sentence above would make the most load-bearing claim in the product false,
and it is the kind of claim users repeat on our behalf.
