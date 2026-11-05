# Controller-managed provisioning

Kimi runs the agent and keeps session state. A **controller** in its own PPIO
sandbox polls the self-hosted environment's work queue and starts, resumes, or
pauses a separate **worker** sandbox per session. Agent tool calls run only in
the worker. The application never imports the sandbox SDK.

Kimi delivers no webhooks. This directory keeps the `webhook` name so the
layout matches the OpenAI variant it was ported from; the only thing that
changed is where the signal comes from.

Setup, operation and troubleshooting live in the [repository README](../../README.md);
this file holds the design notes.

```
client.ts      create agent / environment / session, send input, stream the turn   (your app)
deploy.ts      bundle handler.ts into a PPIO sandbox and run it                   (one-off)
handler.ts     work-queue poller + per-session queue                                (controller)
```

## How a turn flows

1. `client.ts` creates a session on the self-hosted environment and posts
   input.
2. The input enqueues a **work item** for the environment. The item stays
   `queued` until a worker claims it.
3. The controller claims it with the environment work key, **acks within the
   five-second window**, queues the claim, then reconciles: it re-reads the
   session and the work item and, only if the lease is still its own, creates a
   worker from the template (or resumes a paused one, found by
   `agents-session-id` metadata) and launches `kha worker run` inside it with
   the item's identity and session token.
4. `kha worker run` heartbeats the lease, executes the tools, writes the
   results back, and settles the item when the session goes idle. The client
   streams output.
5. A work item that ends `failed` **pauses** that session's worker rather than
   killing it, so the worker log can be read afterwards. The controller learns
   of it by sweeping the queue's terminal rows every 30 seconds — Kimi emits no
   event to the controller. Kill the worker yourself when done.

The poll loop and the reconcile queue are separate on purpose: the ack window is
shorter than a sandbox create, so nothing slow may happen before the ack.

## Setup

| Variable | Used by |
| --- | --- |
| `KIMI_API_KEY` | client (creates sessions) and controller (reads sessions and work items) |
| `KIMI_ENVIRONMENT_ID` | client (binds sessions) and controller (which queue to poll) |
| `KIMI_ENVIRONMENT_KEY` | controller only; the only credential that polls the queue |
| `KIMI_AGENT_ID` | client (default agent); controller logs when another agent appears on its environment |
| `PPIO_API_KEY` | deploy (controller sandbox) and controller (worker sandboxes) |

1. Nothing to build — workers and the controller both come from the published
   `kimi-agents-api-executor` template. To confirm it first:

   ```bash
   npm run verify
   ```

2. Create a self-hosted environment and an agent, and put both ids in `.env`:

   ```bash
   npm run webhook:client -- --create-environment ppio-controller
   npm run webhook:client -- --create-agent ppio-controller-managed
   ```

3. In the console, open the environment, generate a work key on its **Worker**
   tab, and put it in `KIMI_ENVIRONMENT_KEY`. It is shown once.

4. Deploy the controller:

   ```bash
   npm run webhook:deploy
   # Health: https://8000-<sandbox-id>.<domain>/healthz
   ```

   The sandbox id is saved to the ignored `.controller.json`. Rerunning
   `webhook:deploy` reconnects to the same controller and restarts it with fresh
   environment variables. If that sandbox is gone, a new one is created and
   starts polling; nothing is registered with Kimi, so nothing else changes.

   Sanity check: `curl -s <health-url>` returns `{"ok":true,"inFlight":0}`.
   The endpoint is unauthenticated, so it reports liveness and nothing else.

## Run

```bash
npm run webhook:client -- --agent-id "$KIMI_AGENT_ID" \
  --input "Write hello to /workspace/hello.txt with the shell, then read it back."
```

The first line printed is `{"session_id":"sesn_..."}`. Keep it for follow-ups:

```bash
npm run webhook:client -- --session-id "$SESSION_ID" --input "Read it again."
```

Workers stay running between turns. A paused worker is resumed with files intact;
a killed one is replaced by a fresh worker with no previous files, because the
session id alone does not restore them.

## Inspect

- Controller log: `/app/controller.log` inside the controller sandbox, JSON lines
  (`enqueued`, `ack_failed`, `worker_created`, `worker_resumed`,
  `executor_started`, `worker_paused`, `claim_resolved`, `work_reread_failed`,
  `other_agent_on_environment`, `reconcile_failed`, `poll_failed`).
- Worker log: `/tmp/kha-worker.log` inside each worker. Lease and tool failures
  surface here, not in any HTTP status.
- Queue: `GET /v1/environments/$KIMI_ENVIRONMENT_ID/work` lists every work item
  with its status and `worker_id`; `/work/stats` gives depth and worker count.
- Workers carry metadata `agents-session-id=<session>`; the controller carries
  `agents-webhook-controller=ppio`.

## Lifetimes

| Sandbox | Setting | Why |
| --- | --- | --- |
| Controller | `long_running: 'true'`, `timeoutMs` at the platform ceiling, `onTimeout: pause` + `autoResume` | It is the only process polling the queue. While it is down, every new turn sits `queued` with no error anywhere. |
| Worker | 30 minutes, `onTimeout: pause` + `autoResume` | Pausing preserves the workspace; a replacement worker starts empty. |

`long_running` and `lifecycle` both have to be passed at creation, so changing
either means replacing the sandbox.

Redeploy after changing `KIMI_ENVIRONMENT_ID` or any key — the controller reads
them at startup. A stale `KIMI_ENVIRONMENT_ID` is the quiet failure: the
controller polls an environment nobody creates sessions on, and every real
session waits for a worker that never comes. Changing `AGENTS_MODEL` needs no
redeploy, since the model belongs to the saved agent. Nor does editing an
agent's instructions or model with `--update-agent`: the controller does not
filter by agent at all.

## Cleanup

Nothing tells the controller a session is gone, so release both sides:

```bash
npm run webhook:client -- --session-id "$SESSION_ID" --delete
# then kill the worker sandbox, including if paused
```

Workers have a 30-minute timeout, refreshed on resume. The controller sits at
the platform's timeout ceiling in long-running mode, extended by every deploy. Revoke the work key in the console
before retiring the controller for good.

## Design notes

**Claim, ack, then reconcile.** The poll loop only claims and acks; the
reconcile queue does the slow work. The ack window is 5000ms and a sandbox
create alone can exceed it, so an ack after provisioning would lose the claim
every time. The reconcile step re-reads the work item, which is what makes a
reclaimed lease harmless — if the `generation` moved on, starting a worker would
leak compute that earns a 412 on its first heartbeat.

**One queue slot per session.** Claims for the same session are serialised so
two of them cannot both create a worker; different sessions still reconcile
concurrently.

**One controller per environment.** Two controllers polling one environment
race for every claim, and the loser's sessions land in the winner's sandboxes.
A claim cannot be handed back: `stop` without `final_status` only marks the item
`stopping`, and that request persists across a reclaim, so the next holder
cancels the session. Scope by environment — one per agent if agents must not
share compute.

**The session token is a file, not an argument.** `kha worker run` reads it from
`KHA_WORK_SECRET_FILE` at mode 0600. It is scoped to one session and dies with
the work item, but it still never appears in `ps`.

**Launch and return.** The controller does not wait on `kha worker run`. The
run owns the lease, and holding the session's queue slot for the whole turn
would leave a second work item for the same session acked but unheartbeated
until the first run exited. Failure is read from the queue instead: a `failed`
work item pauses the worker on the next sweep.

**A failed run's worker is paused, not killed.** Pausing keeps the filesystem
so the worker log survives for inspection.

**The controller is bundled, not installed.** `deploy.ts` bundles `handler.ts`
with esbuild and writes one file, so a redeploy does not reinstall dependencies
inside the sandbox. The bundle needs a `createRequire` banner: `dotenv` reaches
it transitively as CommonJS and esbuild's ESM output otherwise fails at startup
with `Dynamic require of "fs" is not supported`.
