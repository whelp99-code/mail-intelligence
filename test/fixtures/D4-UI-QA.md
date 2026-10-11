# D4 synthetic UI fixture

Use Node 22+ from the repository root:

```sh
node test/fixtures/d4-ui-qa-host.mjs serve
```

The ready line contains the temporary directory, ephemeral loopback URL and
pre-seeded draft ID. All accounts/messages/credentials are synthetic. The
server uses a fresh HOME/data directory, disables send/external mutations/AI
and blocks outbound fetch. It does not access production configuration.

Use a task-owned browser only. Set its tab-scoped Basic header with username
`mailintelligence` and the synthetic access key declared in the fixture,
then navigate to the ready URL. Root access creates the local session cookie;
the application loads `GET /api/session`. Do not use `/api/auth/session` or
invent a different Basic username. Never show the session JSON in screenshots.
State changes keep the application's same-origin and
`x-mail-intelligence-request: 1` protection. Keep the server/browser alive
until the scenario ends; a short-lived monitor is not an authentication test.

The three inbox IDs are `d4-style`, `d4-handled` and `d4-cancel`. The first has
two owner Sent examples. The last has an unsent clarification draft. After
the real UI scenarios, simulate a later owner Sent reply through the actual
read-only synchronization path:

```sh
node test/fixtures/d4-ui-qa-host.mjs sync-reply
```

This fake Graph transport accepts GET only; it does not manually cancel the
draft or send a reply. Cancellation/event evidence is written privately under
`.omo/evidence/d4`.

Signal the server parent with SIGINT/SIGTERM and require
`D4_QA_HOST_CLEANED`; its child and temporary database are removed. Close the
owned browser and remove only its task profile. Preserve only synthetic
screenshots and sanitized receipts. No fixed machine path or listening port
is part of this fixture.
