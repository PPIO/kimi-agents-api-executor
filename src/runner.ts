/**
 * Starts a PPIO sandbox from the executor template and connects
 * `kha worker poll` to one self-hosted Kimi environment.
 *
 * The worker claims sessions from the environment's work queue, so unlike an
 * executor that is told its session up front, a worker learns which session it
 * serves only when a work item is delivered. Each session's work item is held
 * under a lease by exactly one worker. All traffic is outbound; nothing
 * listens on an inbound port.
 */
import { Sandbox } from 'ppio-sandbox'
import type { CommandHandle } from 'ppio-sandbox'
import {
  EXECUTOR_LOG,
  KIMI_BASE_URL,
  SANDBOX_TIMEOUT_MS,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
} from './config.js'

export interface ExecutorOptions {
  /** The self-hosted environment id (`env_...`) the worker polls. */
  environmentId: string
  /**
   * Attach to a sandbox that already exists instead of creating one.
   *
   * This is the common case: the sandbox holds the work — a checkout, running
   * services, files from earlier turns — and the agent is attached to it. A
   * paused sandbox is resumed, keeping its filesystem. Omit to create a fresh
   * sandbox from the template, which is only right for throwaway work.
   */
  sandboxId?: string
  /**
   * API base the worker dials. Defaults to KIMI_BASE_URL; pass through
   * unchanged, including on reconnect.
   */
  remoteUrl?: string
  /** Environment work key (`ewk-...`). The only credential that enters the sandbox. */
  executorApiKey: string
  /** Defaults to SANDBOX_TIMEOUT_MS. */
  sandboxTimeoutMs?: number
  /** Stored on the sandbox for reconciliation. */
  sessionId?: string
  /**
   * Worker identity registered on each lease; shows up in the work item's
   * `worker_id` and the queue stats. Defaults to the sandbox id so a work item
   * can be traced back to its compute.
   */
  workerId?: string
  onExecutorLog?: (line: string) => void
}

export interface RunningExecutor {
  sandbox: Sandbox
  handle: CommandHandle
  /** The `worker_id` the executor registered with. */
  workerId: string
  /** True when this call created the sandbox rather than attaching to one. */
  createdSandbox: boolean
  /**
   * Stops the executor. Kills the sandbox only if this call created it, so
   * attaching an agent to a caller's sandbox never destroys their work.
   */
  stop: () => Promise<void>
}

/** POSIX single-quote escaping. The command string is evaluated by a shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The shell command that runs the worker.
 *
 * The work key goes in over stdin (`--token-stdin`), never as an argument:
 * `ps` inside the sandbox would otherwise show it to any agent-run process.
 * The worker has no keychain in a sandbox, so `kha worker login` is skipped.
 * `--max-idle 0` keeps the worker waiting indefinitely; the default exits
 * after 60 idle seconds, which would surface as a session that never starts.
 * The flag is a Go duration: `0` is the only bare number it accepts, anything
 * else needs a unit (`30s`, `5m`). Measured by `npm run verify`.
 */
export function workerCommand(options: {
  environmentId: string
  remoteUrl: string
  workerId: string
  log: string
}): string {
  return [
    `cd ${shellQuote(WORKSPACE_DIR)}`,
    [
      'printenv KIMI_ENVIRONMENT_KEY',
      [
        'kha worker poll',
        shellQuote(options.environmentId),
        `--base-url ${shellQuote(options.remoteUrl)}`,
        `--worker-id ${shellQuote(options.workerId)}`,
        `--workdir ${shellQuote(WORKSPACE_DIR)}`,
        '--max-idle 0',
        '--token-stdin',
        // Tee rather than redirect: the caller still gets a live stream through
        // onExecutorLog, and the file survives for inspection afterwards, which
        // is the only place a claim or lease failure is reported.
        `2>&1 | tee ${shellQuote(options.log)}`,
      ].join(' '),
    ].join(' | '),
  ].join(' && ')
}

export async function startExecutor(
  options: ExecutorOptions
): Promise<RunningExecutor> {
  const {
    environmentId,
    remoteUrl = KIMI_BASE_URL,
    executorApiKey,
    sessionId,
    onExecutorLog,
    sandboxTimeoutMs = SANDBOX_TIMEOUT_MS,
  } = options

  // No network configuration: PPIO sandboxes allow outbound traffic by
  // default, so the worker reaches Kimi as-is. Only a caller that deliberately
  // restricts egress needs to allowlist REQUIRED_EGRESS_HOSTS, and that is
  // their policy, not ours.
  const createdSandbox = !options.sandboxId
  const sandbox = options.sandboxId
    ? // connect() resumes a paused sandbox and keeps its files.
      await Sandbox.connect(options.sandboxId)
    : await Sandbox.create(TEMPLATE_NAME, {
        // Sandbox lifetime is its own clock, unrelated to any command timeout.
        // PPIO kills the sandbox when this expires, which also bounds a
        // leaked worker if the caller crashes.
        timeoutMs: sandboxTimeoutMs,
        metadata: {
          purpose: 'kimi-agents-api-executor',
          environmentId,
          ...(sessionId ? { sessionId } : {}),
        },
      })

  const workerId = options.workerId ?? sandbox.sandboxId

  if (!createdSandbox) {
    // Extend a borrowed sandbox so it outlives the turn, without assuming
    // anything about how long its owner wanted it.
    await sandbox.setTimeout(sandboxTimeoutMs).catch(() => {})
  }

  try {
    if (!createdSandbox) {
      // A caller's sandbox may not be built from the executor template, and a
      // missing binary would otherwise surface as a work item stuck in
      // `queued` — indistinguishable from a network problem.
      const probe = await sandbox.commands
        .run('command -v kha', { timeoutMs: 30_000 })
        .catch(() => undefined)
      if (!probe?.stdout.trim()) {
        throw new Error(
          `Sandbox ${sandbox.sandboxId} has no kha binary on PATH. Build it from ` +
            `the executor template, or install the kha CLI inside it first.`
        )
      }
    }

    // The worker is a long-lived process, so it must run in the background:
    // `commands.run` defaults to a 60s timeout, which would kill it at 61s and
    // surface as an unrelated channel error. Background start reads only the
    // first frame (the pid) and leaves the process running.
    const command = workerCommand({
      environmentId,
      remoteUrl,
      workerId,
      log: EXECUTOR_LOG,
    })

    const handle = await sandbox.commands.run(command, {
      background: true,
      // `background` only stops the SDK from waiting. Without an explicit
      // timeout it still sends its 60s default as the request timeout, and
      // the sandbox-side envd kills the process when it expires (measured on
      // PPIO: `context deadline exceeded` → `signal: killed` at exactly 60s).
      // 0 is the documented "no limit".
      timeoutMs: 0,
      // Passed here as well as at creation: a process started through the
      // commands API only sees the env this call sends.
      envs: {
        KIMI_ENVIRONMENT_KEY: executorApiKey,
        KHA_NO_UPDATE_CHECK: '1',
      },
      onStdout: onExecutorLog,
      onStderr: onExecutorLog,
    })

    return {
      sandbox,
      handle,
      workerId,
      createdSandbox,
      stop: async () => {
        try {
          await handle.kill()
        } catch {
          // Already gone, or the sandbox died first.
        }
        // Only tear down what we brought. A caller's own sandbox is left
        // running with its files intact.
        if (createdSandbox) await sandbox.kill()
      },
    }
  } catch (error) {
    // Never leave compute running behind a failed start — but only compute this
    // call created.
    if (createdSandbox) await sandbox.kill().catch(() => {})
    throw error
  }
}
