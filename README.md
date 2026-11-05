# PPIO Sandbox

Run sandbox tools in PPIO while Kimi runs the agent and maintains session
state. Kimi hosts the [agent harness](https://platform.kimi.com/docs/hosted-agents/overview.md);
a controller in its own PPIO sandbox polls the environment's work queue and
starts one worker sandbox per session. Inside each worker, `kha worker run`
dials out to Kimi to execute tool calls and return results. Nothing listens on
an inbound port, and your application never imports the sandbox SDK.

```
application ──create session, send input──▶ Hosted Agents API
                                                 │  work queue
                                                 ▼
                                      controller (PPIO sandbox) ──poll/ack──▶ Kimi
                                                 │
                                                 └──create/resume──▶ worker (PPIO sandbox)
                                                                       kha worker run ──▶ Kimi
```

The controller lives in `src/webhook/`, kept under that name so the layout
matches the OpenAI variant it was ported from. Kimi delivers no webhooks, so the
controller polls instead.

## Before you begin

```bash
cp .env.example .env
npm install
```

| Variable | Where it comes from | Scope |
| --- | --- | --- |
| `PPIO_API_KEY` | PPIO console | template build, controller and worker sandboxes |
| `PPIO_DOMAIN` | PPIO console, if your key is not on the default region | optional; forwarded to the controller, which creates worker sandboxes with the same SDK |
| `KIMI_API_KEY` | [platform.kimi.com](https://platform.kimi.com) API keys | client and controller; **never** enters a worker |
| `KIMI_ENVIRONMENT_ID` | `npm run webhook:client -- --create-environment <name>` | the self-hosted environment every session binds to and the controller polls |
| `KIMI_ENVIRONMENT_KEY` | console → the environment's **Worker** tab | controller only; the only credential that may poll the queue |
| `KIMI_AGENT_ID` | `npm run webhook:client -- --create-agent <name>` | default agent for `webhook:client` |

The application key (`sk-...`) manages agents, environments and sessions. The
environment work key (`ewk-...`) can claim work from one environment and nothing
else. It is generated once in the console, shown once, and cannot be created
through the API; keep it in `.env` only. Workers never see either key: each
worker gets a per-session token that dies with its work item.

See [self-hosted environments](https://platform.kimi.com/docs/hosted-agents/self-hosted-environments.md)
for Kimi's own description of the split. Self-hosted environments are a
separately granted feature for enterprise-verified accounts; without it,
creating an environment fails with `403 permission_denied_error`.

## How Kimi differs from the OpenAI Agents API

Worth reading once, because it is why the controller is shaped the way it is.

| | OpenAI Agents API | Kimi Hosted Agents |
| --- | --- | --- |
| Environment | created by the API per session, with a per-session `remote_url` | a persistent resource you create once; every session names its id |
| Executor credential | restricted project key | per-environment work key (`ewk-...`), console-only |
| Executor | `codex exec-server --environment-id` serves one session | `kha worker run` serves one claimed work item; the controller does the claiming |
| "Connected" signal | `agent.session.environment.connected` event | none; the session's work item leaves `queued` once a worker claims it |
| Provisioning hook | `agent.session.action_required` webhook | none; poll `GET /v1/environments/{id}/work/poll` |
| Turn output | `agent.session.turn.output_text.delta`, `turn.completed` | `agent.delta` (opt-in), `agent.message`, `session.status` → `idle` |
| Cleanup | `sessions.delete` | interrupt → archive → delete, in that order |

One consequence matters for isolation: a poll claims the **oldest queued item
in the environment**, not a particular session, and a claim cannot be handed to
another worker. Two controllers polling the same environment race for each
session, and the loser's sessions run in the winner's sandboxes. Run exactly one
controller per environment. Scope by environment, not by agent: the controller
serves whatever lands in its queue.

## Setup

Four steps. The first needs only `PPIO_API_KEY`; the rest need Kimi.

### 1. Build and verify the executor template

The template bakes in the `kha` CLI at a pinned version, so a worker boots with
the CLI already present and every sandbox runs the same image.

```bash
npm run build:template
npm run verify
```

`verify` creates a sandbox from the template, runs eleven checks, and kills it.
The one to watch is `runner command parses`: it executes the exact `kha worker`
command line the controller will use, against a fake environment and key, so a
wrong flag fails here rather than as a work item stuck in `queued` later.

If the builder reaches Debian mirrors and `ha-static.moonshot.cn` through a
proxy, set `PPIO_BUILD_PROXY` before building:

```bash
PPIO_BUILD_PROXY=http://10.97.197.11:1081 npm run build:template
```

It is injected as a build-only `ENV` ahead of the download steps, so `apt-get`
and both `curl` calls use it and nothing of it is left in the sandbox runtime;
`verify` asserts that too. The worker inside a running sandbox dials
`api.moonshot.cn` directly.

Two details matter if you change the template:

- **Pin the kha version.** The install script resolves `stable.txt` at build
  time. Two templates built a week apart would ship different workers and
  diverge with no visible cause. `KHA_VERSION` in `src/config.ts` is passed to
  the installer.
- **Do not set a start command.** A template start command runs once at build
  time and is snapshotted, so it cannot see the environment id or work key,
  which belong to the caller. The controller starts the worker at runtime.

### 2. Create a self-hosted environment and an agent

Once, not per session:

```bash
npm run webhook:client -- --create-environment ppio-executor   # → KIMI_ENVIRONMENT_ID
npm run webhook:client -- --create-agent coding-assistant        # → KIMI_AGENT_ID
```

Put both ids in `.env`. Then open the environment in the Kimi console under
托管智能体 › 环境, generate a work key on its **Worker** tab, and put it in
`KIMI_ENVIRONMENT_KEY`. It is shown once.

`--create-agent` takes `--instructions` and `--model` to give the agent its own
role. Both are ordinary [agent configuration](https://platform.kimi.com/docs/hosted-agents/agents.md)
fields; the flags only stop this client from hardcoding them. `--update-agent <id>`
edits them in place, which keeps the agent id and so needs no redeploy.

```bash
npm run webhook:client -- --create-agent triage \
  --instructions "You triage failing tests: find the failing assertion, propose the smallest fix." \
  --model kimi-k3.1-pro
npm run webhook:client -- --update-agent "$KIMI_AGENT_ID" --instructions "..."
```

### 3. Deploy the controller

```bash
npm run webhook:deploy   # prints the health URL
```

Nothing needs registering with Kimi. The controller starts polling the
environment as soon as it is up. Confirm:

```bash
curl -s <health-url>
#   {"ok":true,"inFlight":0}
```

The sandbox id is saved to the ignored `.controller.json`. Rerunning
`webhook:deploy` reconnects to the same controller and restarts it with fresh
environment variables. Redeploy whenever `KIMI_ENVIRONMENT_ID` or any key
changes: the controller reads them at startup. Changing `AGENTS_MODEL` or
editing the agent with `--update-agent` needs no redeploy; the controller does
not filter by agent.

### 4. Send work

```bash
npm run webhook:client -- --input "Write hello to /workspace/hello.txt, then read it back."
```

The first line printed is `{"session_id":"sesn_..."}`. Keep it for follow-ups,
which land in the same worker and the same workspace:

```bash
npm run webhook:client -- --session-id "$SESSION_ID" --input "Read it again."
```

Output streams as the agent produces it and the command exits when the session
returns to `idle`.

## How a turn flows

1. `client.ts` creates a session on the self-hosted environment and posts a
   `user.message`. The input enqueues a **work item** for the environment.
2. The controller's poll claims the item and **acks within the five-second
   window**. Nothing slow happens before the ack.
3. The controller queues the claim per session, then reconciles: it re-reads
   the session and the work item and, only if the lease is still its own,
   creates a worker from the template, or resumes a paused one found by its
   `agents-session-id` metadata. Pausing preserves the files; a replacement
   worker would start empty.
4. It writes the item's session token into the worker and launches
   `kha worker run`, which heartbeats the lease, executes tools in
   `/workspace`, writes results back, and settles the item when the session
   goes idle. The controller does not wait on it.
5. A work item that ends `failed` **pauses** that session's worker rather than
   killing it, so the worker log can be read afterwards. The controller learns
   of it by sweeping the queue's terminal rows every 30 seconds; Kimi emits no
   event to the controller. Kill the worker yourself when done.

## Cleanup

Releasing a session does not release its sandbox; nothing tells the controller
a session is gone. Release both sides:

```bash
npm run webhook:client -- --session-id "$SESSION_ID" --delete
ppio sbx kill <worker-id>        # including if paused
```

`--delete` interrupts the session if running, archives it, then deletes it; the
API refuses to skip steps. Workers have a 30-minute timeout, refreshed on
resume. The controller sits at the platform's timeout ceiling in long-running
mode with `onTimeout: pause` + `autoResume`, because it is the only process
holding the work key: while it is down, every new turn on the environment sits
`queued` with no error anywhere. Revoke the work key in the console before
retiring the controller for good.

## Inspect

- Controller log: `/app/controller.log` inside the controller sandbox, JSON
  lines (`enqueued`, `ack_failed`, `worker_created`, `worker_resumed`,
  `executor_started`, `worker_paused`, `claim_resolved`, `work_reread_failed`,
  `other_agent_on_environment`, `reconcile_failed`, `poll_failed`). A crash
  goes to `/app/controller.stdio.log` instead.
- Worker log: `/tmp/kha-worker.log` inside each worker. Lease and tool
  failures surface here, not in any HTTP status.
- Queue: `GET /v1/environments/$KIMI_ENVIRONMENT_ID/work` lists every work item
  with its status and `worker_id`; `/work/stats` gives depth and worker count.
- Workers carry metadata `agents-session-id=<session>`; the controller carries
  `agents-webhook-controller=ppio`.

## Lease window

A claimed work item must be acknowledged within 5000ms or it returns to the
queue, and must heartbeat within its lease or it is reclaimed and handed to the
next poller with a new `generation`. The controller acks before any sandbox
work for that reason, and `kha worker run` owns the heartbeats from then on.
Baking the kha CLI into the template keeps the install out of this window; a
sandbox boots from the template in about two seconds.

## Environment variables reach the worker per command

A build-layer `ENV` is **not** visible to processes started later through the
commands API, not even in a login shell. The worker's identity (`KHA_*`) and
the path to its session token therefore travel with `kha worker run` in
`commands.run({ envs })`, which `npm run verify` asserts in both directions.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `403 permission_denied_error` creating an environment | The account has not been granted the self-hosted feature. Contact Kimi with the `request_id`. |
| Work item stays `queued` | Controller alive (`curl` the health URL)? `KIMI_ENVIRONMENT_ID` in the controller matches the one sessions bind to? If you restrict egress, allowlist `api.moonshot.cn`. |
| `poll_failed` with `401` in the controller log | Work key revoked, or for a different environment than the one polled. Regenerate on the Worker tab and redeploy. |
| `ack_failed` with `412` | The ack window closed before the controller got there. Usually the controller sandbox is starved; check its load. |
| Worker dies around 61 seconds | A `commands.run` started without `background: true`. |
| `claim_resolved` on every item | The lease was reclaimed before reconcile. Another poller on the same environment, or `LEASE_TTL_MS` too short. |
| `session.error` | Read the worker log. Tool failures surface there, not in the HTTP status. |
| `reconcile_failed` with `auth user unauthorized: invalid token` after a successful `enqueued` | The controller is talking to the wrong PPIO region: `PPIO_DOMAIN` is set in your shell but the deployed controller did not get it. Check `ppioDomain` in the `controller_listening` log line, then redeploy. The claim was acked and is lost until the lease lapses. |
| Every SDK call fails with 503 and an HTML body | `PPIO_DOMAIN` set to a region the SDK does not recognize. Leave it unset. |
| Agent reports success but files are missing | Assert against the sandbox filesystem, not the final response. |
| `ppio-sandbox-cli sandbox exec` hangs with no output | Non-interactive stdin is treated as piped input and waited on. Add `</dev/null` to every `exec` in a script. |

## Layout

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Pinned kha version, paths, timeouts |
| `src/kimi.ts` | Minimal Hosted Agents client: agents, environments, sessions, SSE, work queue |
| `src/build-template.ts` | Builds the template with the kha CLI baked in |
| `src/verify.ts` | Eleven checks against the built image; needs only `PPIO_API_KEY` |
| `src/runner.ts` | Builds the `kha worker` command line; shared with `verify` |
| `src/webhook/handler.ts` | The controller: poll loop, per-session queue, reconcile |
| `src/webhook/deploy.ts` | Bundles the controller and runs it in its own sandbox |
| `src/webhook/client.ts` | Your application's side: agents, environments, sessions, input, streaming |
| `src/webhook/config.ts` | Controller constants: ports, lifetimes, metadata keys |
| `src/webhook/README.md` | Design notes for the controller |

`src/example.ts` and `src/e2e.ts` are the application-managed variant, where
your own process starts the sandbox and a `kha worker poll` for one
environment. They are kept as reference and for plumbing checks, but are not
the recommended path: one environment can only safely have one poller.

## References

- [Self-hosted environments](https://platform.kimi.com/docs/hosted-agents/self-hosted-environments.md)
- [Sessions](https://platform.kimi.com/docs/hosted-agents/sessions.md) and [session operations](https://platform.kimi.com/docs/hosted-agents/session-operations.md)
- [Event stream](https://platform.kimi.com/docs/hosted-agents/event-stream.md)
- [Hosted Agents OpenAPI](https://platform.kimi.com/docs/hosted-agents/openapi.yaml) (work queue endpoints)
- [kha CLI](https://platform.kimi.com/docs/hosted-agents/kha.md)
- [PPIO Sandbox documentation](https://ppio.com/docs/sandbox/overview)
