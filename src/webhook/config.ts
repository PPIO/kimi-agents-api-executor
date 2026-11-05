/**
 * Configuration shared by the controller, its deploy script, and the client.
 */
import {
  EXECUTOR_LOG,
  KHA_VERSION,
  LONG_RUNNING_METADATA,
  MAX_TIMEOUT_MS,
  SANDBOX_LIFECYCLE,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
} from '../config.js'

export {
  EXECUTOR_LOG,
  KHA_VERSION,
  LONG_RUNNING_METADATA,
  MAX_TIMEOUT_MS,
  SANDBOX_LIFECYCLE,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
}

/**
 * Port the controller's HTTP server listens on inside its sandbox.
 *
 * Kimi delivers no webhooks, so nothing from the platform ever calls this port.
 * It only serves `/healthz`, which is how `deploy.ts` and a human confirm the
 * controller is alive and which configuration it loaded.
 */
export const CONTROLLER_PORT = 8000

/** Metadata marking the controller sandbox, so deploy can find and reuse it. */
export const CONTROLLER_METADATA = {
  'agents-webhook-controller': 'ppio',
} as const

/** Metadata key mapping a worker sandbox back to its Hosted Agents session. */
export const SESSION_METADATA_KEY = 'agents-session-id'

/** Where the controller writes its log inside its sandbox. */
export const CONTROLLER_LOG = '/app/controller.log'

/**
 * The controller process's own stdout/stderr, kept separate from the structured
 * log above. A crash writes its stack trace here and nowhere else: the
 * structured log only holds what the handler chose to record, so it simply
 * stops mid-stream when the process dies.
 */
export const CONTROLLER_STDIO = '/app/controller.stdio.log'

/**
 * Where the controller drops a work item's session credential inside the
 * worker, for `kha worker run` to read (KHA_WORK_SECRET_FILE). Mode 0600,
 * scoped to one session, and invalid once the work item ends — so there is
 * nothing durable to protect, but it is kept off /workspace all the same so
 * agent file operations cannot read it back.
 */
export const WORK_SECRET_FILE = '/tmp/kha-work-secret'

/**
 * Worker lifetime. Refreshed when a worker is resumed, so a session that keeps
 * receiving input keeps its files.
 */
export const WORKER_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Controller lifetime. Set to the platform maximum with long-running mode on,
 * because the controller is the only process holding the environment work key
 * and polling the queue: while it is down, every new turn on the environment
 * sits `queued`. Extended by every deploy regardless.
 */
export const CONTROLLER_TIMEOUT_MS = MAX_TIMEOUT_MS

/**
 * Long-poll budget per claim attempt. The API caps `block_ms` at 999, so the
 * loop re-polls about once a second while idle and returns immediately when a
 * work item is queued.
 */
export const POLL_BLOCK_MS = 999

/** Backoff after a poll error, so a dead API does not turn into a hot loop. */
export const POLL_BACKOFF_MS = 5_000

/**
 * Lease the controller asks for when claiming. The platform clamps anything
 * above its default, so this is a request, not a guarantee. It only has to
 * cover the gap between claim and the worker's first heartbeat — ack happens
 * before any sandbox work, and `kha worker run` heartbeats from then on.
 */
export const LEASE_TTL_MS = 5 * 60 * 1000

/**
 * How often the controller sweeps the queue for `failed` work items, which is
 * the only durable record that a run died — Kimi emits no event to the
 * controller for it.
 */
export const FAILURE_SWEEP_MS = 30_000
