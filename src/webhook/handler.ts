/**
 * Queue controller. Runs inside its own PPIO sandbox, reachable at the
 * sandbox host for CONTROLLER_PORT.
 *
 * Kimi delivers no webhooks: a self-hosted environment exposes a work queue
 * instead, and a session's input enqueues a work item there. So the request
 * path of the OpenAI variant becomes a poll loop, with the same two jobs,
 * deliberately split:
 *
 *  1. Claim and ack. The poll loop claims the oldest queued work item and
 *     acknowledges it at once — the ack window is five seconds and the item is
 *     returned to the queue when it closes. Nothing slow happens before the
 *     ack, so provisioning never costs a claim.
 *  2. Reconcile. A per-session queue drains the claims, re-reads the session
 *     and the work item from the API, and acts only if the lease is still
 *     ours. Re-reading is what makes a reclaimed or stale delivery harmless.
 *
 * One controller per environment. A claim is a claim: the API has no way to
 * hand an item back to a different worker, so two controllers on one
 * environment would race for every session and the loser's sessions would run
 * in the winner's sandboxes.
 *
 * Deployed by deploy.ts; not meant to be run directly on a laptop.
 */
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'
import { Sandbox } from 'ppio-sandbox'
import { Kimi, KimiAPIError, sessionWorkToken } from '../kimi.js'
import type { WorkItem } from '../kimi.js'
import { KIMI_BASE_URL, PPIO_DOMAIN } from '../config.js'
import {
  CONTROLLER_LOG,
  CONTROLLER_PORT,
  EXECUTOR_LOG,
  FAILURE_SWEEP_MS,
  LEASE_TTL_MS,
  POLL_BACKOFF_MS,
  POLL_BLOCK_MS,
  SANDBOX_LIFECYCLE,
  SESSION_METADATA_KEY,
  TEMPLATE_NAME,
  WORKER_TIMEOUT_MS,
  WORKSPACE_DIR,
  WORK_SECRET_FILE,
} from './config.js'

const KIMI_API_KEY = requireEnv('KIMI_API_KEY')
const ENVIRONMENT_KEY = requireEnv('KIMI_ENVIRONMENT_KEY')
const ENVIRONMENT_ID = requireEnv('KIMI_ENVIRONMENT_ID')
// Recorded for the log only. The controller serves every session on its
// environment: once claimed, an item cannot be handed to another controller,
// so scoping has to happen one level up, by giving each agent its own
// environment.
const AGENT_ID = process.env.KIMI_AGENT_ID || ''

/**
 * Identity registered on every lease this controller takes. `kha worker run`
 * must inherit it unchanged: heartbeat, ack and stop all check the
 * (item, worker_id, generation) triple and answer 412 on a mismatch.
 */
const WORKER_ID = `controller-${process.pid}`

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set in the controller environment`)
  return value
}

// Two clients, two credentials. The application key reads sessions and work
// items; the environment work key is the only thing that may poll the queue.
// Neither works in the other's place.
const client = new Kimi({ apiKey: KIMI_API_KEY, baseURL: KIMI_BASE_URL })
const queue = new Kimi({ apiKey: ENVIRONMENT_KEY, baseURL: KIMI_BASE_URL })

function log(event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields })
  console.log(line)
  try {
    appendFileSync(CONTROLLER_LOG, line + '\n')
  } catch {
    // Logging must never break reconciliation.
  }
}

/**
 * In-process queue, serialised per session.
 *
 * Serialising per session is the point: two work items for one session must not
 * both create a worker. Sessions still reconcile concurrently.
 */
const inFlight = new Map<string, Promise<void>>()

function enqueue(sessionId: string, task: () => Promise<void>): void {
  const previous = inFlight.get(sessionId) ?? Promise.resolve()
  const next = previous
    .then(task)
    .catch((error: unknown) =>
      log('reconcile_failed', { sessionId, error: String(error) })
    )
    .finally(() => {
      if (inFlight.get(sessionId) === next) inFlight.delete(sessionId)
    })
  inFlight.set(sessionId, next)
}

/** Find this session's worker, running or paused. */
async function findWorker(sessionId: string) {
  const paginator = Sandbox.list({
    query: { metadata: { [SESSION_METADATA_KEY]: sessionId } },
  })
  const items = await paginator.nextItems()
  return items.at(0)
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Start `kha worker run` in a worker for one claimed work item.
 *
 * `run` executes exactly one work item: it heartbeats the lease, consumes the
 * session's events, executes tools in the workdir, and settles the item when
 * the session goes idle. The controller already acked the delivery, which is
 * the contract `run` expects from its dispatcher.
 *
 * Background start is mandatory: `commands.run` defaults to a 60s timeout and
 * would kill this long-lived process at 61 seconds, surfacing as an unrelated
 * channel error. Output goes to a file in the worker so a failed lease can be
 * read afterwards — it is not reported in any HTTP status.
 */
async function launchExecutor(
  sandbox: Sandbox,
  work: WorkItem & { secret: string }
): Promise<void> {
  // The session credential is single-use and dies with the work item, but it
  // still never goes on a command line where `ps` would show it.
  //
  // `kha worker run` wants the bare `swt-` session token, not the base64url
  // envelope the poll returned. Measured: writing the envelope made run exit
  // at once with "expected a swt- token", leaving the item in `starting` with
  // no heartbeat while the agent's first tool call waited forever.
  await sandbox.files.write(WORK_SECRET_FILE, sessionWorkToken(work.secret))
  await sandbox.commands.run(`chmod 600 ${shellQuote(WORK_SECRET_FILE)}`, {
    timeoutMs: 30_000,
  })

  const command = [
    `cd ${shellQuote(WORKSPACE_DIR)}`,
    [
      'exec kha worker run',
      `--base-url ${shellQuote(KIMI_BASE_URL)}`,
      `>>${shellQuote(EXECUTOR_LOG)} 2>&1`,
    ].join(' '),
  ].join(' && ')

  await sandbox.commands.run(command, {
    background: true,
    // `background` alone is not enough: the SDK's 60s default still reaches
    // envd as the request timeout and the process is killed when it expires.
    // 0 is the documented "no limit"; a turn can run for many minutes.
    timeoutMs: 0,
    // A build-layer ENV does not reach processes started through the commands
    // API, so the identity has to travel with the command. These are the
    // variables `kha worker run` documents as its defaults.
    envs: {
      KHA_ENVIRONMENT_ID: work.environment_id,
      KHA_WORK_ID: work.id,
      KHA_SESSION_ID: work.session_id,
      KHA_WORKER_ID: WORKER_ID,
      KHA_WORK_GENERATION: String(work.generation),
      KHA_WORK_LEASE_TTL_MS: String(work.lease_ttl_ms),
      KHA_WORK_SECRET_FILE: WORK_SECRET_FILE,
      KHA_NO_UPDATE_CHECK: '1',
    },
  })
}

/** Re-read the session and start a worker only if the claim is still ours. */
async function reconcileClaim(work: WorkItem & { secret: string }): Promise<void> {
  const sessionId = work.session_id
  const session = await client.sessions.retrieve(sessionId).catch((error: unknown) => {
    // A deleted session is a normal outcome, not a failure to retry.
    log('session_gone', { sessionId, error: String(error) })
    return undefined
  })
  if (!session) return

  if (AGENT_ID && session.agent_id !== AGENT_ID) {
    // Served anyway: the claim is ours and cannot be handed on. This is the
    // signal that another agent shares this environment and should not.
    log('other_agent_on_environment', { sessionId, agent: session.agent_id })
  }

  // Re-read the work item: if the lease was reclaimed between claim and now,
  // another worker holds a newer generation and starting ours would only earn
  // a 412 on the first heartbeat. Read with the application key — the work key
  // is scoped to the queue's worker paths. If the read itself fails, proceed:
  // we hold a fresh lease and the alternative is to ack and then abandon it.
  const current = await client.environments.work
    .retrieve(work.environment_id, work.id)
    .catch((error: unknown) => {
      log('work_reread_failed', { sessionId, work: work.id, error: String(error) })
      return undefined
    })
  if (
    current &&
    (current.generation !== work.generation ||
      current.status === 'completed' ||
      current.status === 'failed' ||
      current.status === 'cancelled')
  ) {
    // Resolved between claim and reconciliation. Starting a worker now would
    // leak compute nothing is waiting for.
    log('claim_resolved', {
      sessionId,
      work: work.id,
      status: current.status,
      generation: current.generation,
    })
    return
  }

  const existing = await findWorker(sessionId)
  let sandbox: Sandbox

  if (existing) {
    // connect() resumes a paused sandbox and keeps its files. A replacement
    // would start empty: reusing the session id does not restore them.
    sandbox = await Sandbox.connect(existing.sandboxId)
    await sandbox.setTimeout(WORKER_TIMEOUT_MS)
    log('worker_resumed', { sessionId, sandbox: sandbox.sandboxId })
  } else {
    sandbox = await Sandbox.create(TEMPLATE_NAME, {
      timeoutMs: WORKER_TIMEOUT_MS,
      lifecycle: SANDBOX_LIFECYCLE,
      metadata: { [SESSION_METADATA_KEY]: sessionId },
    })
    log('worker_created', { sessionId, sandbox: sandbox.sandboxId })
  }

  // Launch and return. The run owns the lease from here; waiting on it would
  // hold this session's queue slot for the whole turn, and a second work item
  // for the same session (new input after idle) would then sit acked but
  // unheartbeated until the first run exited.
  await launchExecutor(sandbox, work)
  log('executor_started', {
    sessionId,
    sandbox: sandbox.sandboxId,
    work: work.id,
    generation: work.generation,
  })
}

/**
 * Handle a failed turn by pausing its worker rather than killing it.
 *
 * Pausing preserves the filesystem, so the worker log can be read after the
 * fact. Whoever inspects it is responsible for killing it.
 */
async function reconcileFailure(sessionId: string): Promise<void> {
  const worker = await findWorker(sessionId)
  if (!worker) {
    log('no_worker_to_pause', { sessionId })
    return
  }
  const sandbox = await Sandbox.connect(worker.sandboxId)
  await sandbox.pause()
  log('worker_paused', { sessionId, sandbox: sandbox.sandboxId })
}

/**
 * Failure watcher. Replaces the `agent.session.failed` webhook: a work item
 * that ends `failed` is the only durable record that a run died, so sweep the
 * queue's terminal rows and pause the worker of any session not yet handled.
 */
const handledFailures = new Set<string>()

async function sweepFailures(): Promise<void> {
  const { items } = await client.environments.work
    .list(ENVIRONMENT_ID, { status: 'failed', page_size: '50' })
    .catch(() => ({ items: [] as WorkItem[] }))
  for (const item of items) {
    if (handledFailures.has(item.id)) continue
    handledFailures.add(item.id)
    enqueue(item.session_id, () => reconcileFailure(item.session_id))
    log('enqueued', { sessionId: item.session_id, work: item.id, type: 'failed' })
  }
}

/**
 * Claim loop. Replaces the webhook receiver: instead of waiting to be told
 * about a session that needs compute, ask the queue.
 *
 * Each successful poll is a claim, so it is never retried idempotently. The
 * ack goes out before anything else: the ack window is 5000ms and the sandbox
 * SDK alone can take longer than that.
 */
async function pollForever(): Promise<never> {
  let lastSweep = 0
  for (;;) {
    if (Date.now() - lastSweep > FAILURE_SWEEP_MS) {
      lastSweep = Date.now()
      void sweepFailures()
    }

    let work: (WorkItem & { secret: string }) | undefined
    try {
      work = await queue.environments.work.poll(ENVIRONMENT_ID, {
        worker_id: WORKER_ID,
        block_ms: String(POLL_BLOCK_MS),
        lease_ttl_ms: String(LEASE_TTL_MS),
      })
    } catch (error) {
      log('poll_failed', { error: String(error) })
      if (error instanceof KimiAPIError && error.status === 401) {
        // A revoked work key never recovers on its own. Keep polling so the
        // log keeps saying why, but slow down.
        await sleep(POLL_BACKOFF_MS * 6)
      } else {
        await sleep(POLL_BACKOFF_MS)
      }
      continue
    }
    if (!work) continue // 204: budget spent, nothing queued.

    try {
      await queue.environments.work.ack(ENVIRONMENT_ID, work.id, work.secret, {
        worker_id: WORKER_ID,
        generation: work.generation,
      })
    } catch (error) {
      // 412: the ack window closed, or someone else holds it now. The item is
      // back in the queue and the next poll will see it.
      log('ack_failed', { sessionId: work.session_id, work: work.id, error: String(error) })
      continue
    }

    // Acked only after the claim succeeded: from here the lease is ours until
    // the worker's first heartbeat, and the sandbox work can take its time.
    const claimed = work
    enqueue(claimed.session_id, () => reconcileClaim(claimed))
    log('enqueued', { sessionId: claimed.session_id, work: claimed.id, type: 'claimed' })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The HTTP server only answers health checks. Nothing from Kimi ever calls it,
// but deploy.ts and a human still need a way to see that the controller is up.
// Unauthenticated, so it reports liveness and nothing else.
const server = createServer((request, response) => {
  if (request.method !== 'GET' || !request.url?.startsWith('/healthz')) {
    response.writeHead(404).end(JSON.stringify({ error: 'Not found' }))
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({ ok: true, inFlight: inFlight.size }))
})

// Overridable so the controller can be exercised locally on a free port. In a
// sandbox it must stay CONTROLLER_PORT, which is the port deploy.ts exposes.
const port = Number(process.env.CONTROLLER_PORT || CONTROLLER_PORT)

server.listen(port, () => {
  log('controller_listening', {
    port,
    template: TEMPLATE_NAME,
    environmentId: ENVIRONMENT_ID,
    workerId: WORKER_ID,
    agentId: AGENT_ID || null,
    // Which PPIO region the worker sandboxes will be created in. A reconcile
    // that fails with `invalid token` while this names a region the key does
    // not belong to means the deploying shell had a different PPIO_DOMAIN.
    ppioDomain: PPIO_DOMAIN,
  })
  void pollForever()
})
