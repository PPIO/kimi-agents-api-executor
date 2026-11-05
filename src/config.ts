import { config as loadEnv } from 'dotenv'

// override: true so .env wins over the surrounding shell. dotenv defaults to
// leaving an already-exported variable alone, which bites on a machine with a
// local LLM gateway: an exported KIMI_BASE_URL sends Hosted Agents calls to the
// gateway, which does not serve /v1/sessions and answers with a plain
// `404 page not found` — a Go default, not a Kimi error, so it reads as if
// the API rejected the request rather than never having received it.
loadEnv({ override: true })

/**
 * kha CLI version baked into the template.
 *
 * Pinned deliberately: the install script resolves `stable.txt` at build time,
 * so two templates built a week apart would ship different workers and diverge
 * in behaviour with no visible cause. Bump this explicitly, rebuild, and re-run
 * `npm run verify`.
 */
export const KHA_VERSION = '0.4.2'

/** Where the kha installer downloads from. Set as KHA_BASE_URL for install.sh only. */
export const KHA_INSTALL_URL = 'https://ha-static.moonshot.cn/kha/install.sh'

/** Template alias the build publishes to and the runner creates sandboxes from. */
export const TEMPLATE_NAME =
  process.env.PPIO_TEMPLATE_NAME || 'kimi-agents-api-executor'

/** Workspace the agent operates in. Passed to `kha worker poll --workdir`. */
export const WORKSPACE_DIR = '/workspace'

/**
 * Hosted Agents API base. Only api.moonshot.cn serves it; see the note on
 * `loadEnv` above for why this is read from the environment at all.
 */
export const KIMI_BASE_URL = (
  process.env.KIMI_BASE_URL || 'https://api.moonshot.cn'
).replace(/\/+$/, '')

/** Contract version every request must carry. Missing it is a 400. */
export const KIMI_API_VERSION = '2026-09-01-beta'

/**
 * Hosts the worker reaches. PPIO sandboxes allow outbound traffic by
 * default, so nothing here needs configuring for the common case.
 *
 * Documented for the caller who deliberately restricts egress: miss the API
 * host and the session's work item sits `queued` until the lease window
 * expires, with nothing in the event stream pointing at the network policy.
 * The static host is only needed at template build time.
 */
export const REQUIRED_EGRESS_HOSTS = [
  'api.moonshot.cn',
  'ha-static.moonshot.cn',
] as const

/** Where the worker's output is teed inside the sandbox, for post-mortems. */
export const EXECUTOR_LOG = '/tmp/kha-worker.log'

/**
 * Sandbox lifetime. Independent of any command timeout: an expired sandbox
 * dies even while a command claims to have no deadline.
 */
export const SANDBOX_TIMEOUT_MS = 30 * 60 * 1000

/**
 * The Hosted Agents API has no fixed connect window the way the OpenAI Agents
 * API does: a work item stays `queued` until some worker claims it. This is the
 * budget the examples give a worker to claim and activate the session's work
 * item before declaring the setup broken.
 */
// Pause instead of discarding when the sandbox timeout expires: the workspace is
// the point of a self-hosted environment, and reusing an environment id does not
// restore files in replacement compute. autoResume lets the next connect() bring
// it back. Applies to sandboxes whose files outlive one turn, not to throwaways.
export const SANDBOX_LIFECYCLE = {
  onTimeout: 'pause',
  autoResume: true,
} as const

/**
 * Long-running mode: lifts the ceiling on `timeoutMs`.
 *
 * The CLI's `--long-running` flag describes itself as storing a metadata
 * marker, which reads as inert bookkeeping. It is a server-side switch.
 *
 * Measured on the Novita-branded SDK this project was ported from: without this
 * key the server rejects anything past four hours with
 * `400 Timeout cannot be greater than 4 hours` (three hours is fine). With it,
 * 720 hours is granted exactly. Must be set at creation — `setTimeout()` beyond
 * the ceiling on a sandbox created without it is silently ignored, no error and
 * `endAt` unchanged. The PPIO SDK and CLI carry the same `--long-running`
 * marker; the ceiling itself has not been re-measured on PPIO.
 */
export const LONG_RUNNING_METADATA = { long_running: 'true' } as const

/**
 * Practical ceiling for `timeoutMs`. The wire format is int32 *seconds*, so
 * anything past 2147483647s (~68 years) is rejected outright:
 * `integer doesn't match the format "int32"`. Measured on Novita: this value is
 * accepted and yields an endAt in 2094; 100 years is a 400. Not re-measured on
 * PPIO; if a deploy fails on `timeoutMs`, lower CONTROLLER_TIMEOUT_MS first.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647 * 1000

export const CONNECT_DEADLINE_MS = 5 * 60 * 1000

export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in.`
    )
  }
  return value
}

/** Read an env var without asserting, for optional credentials. */
export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined
}
