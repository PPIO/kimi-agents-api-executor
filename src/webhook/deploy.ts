/**
 * Puts the controller into its own PPIO sandbox and starts it.
 *
 * Rerunning reconnects to the existing controller and restarts it with fresh
 * environment variables, which is how a rotated work key or a changed agent id
 * gets installed. If that sandbox is gone, a new one is created; nothing is
 * registered with Kimi, so the new one simply starts polling.
 *
 *   npm run webhook:deploy
 */
import { readFileSync } from 'node:fs'
import { Sandbox } from 'ppio-sandbox'
import { KIMI_BASE_URL, optionalEnv, requireEnv } from '../config.js'
import {
  CONTROLLER_LOG,
  CONTROLLER_STDIO,
  LONG_RUNNING_METADATA,
  SANDBOX_LIFECYCLE,
  CONTROLLER_METADATA,
  CONTROLLER_PORT,
  CONTROLLER_TIMEOUT_MS,
  TEMPLATE_NAME,
} from './config.js'

requireEnv('PPIO_API_KEY')
const kimiApiKey = requireEnv('KIMI_API_KEY')
const environmentKey = requireEnv('KIMI_ENVIRONMENT_KEY')
const environmentId = requireEnv('KIMI_ENVIRONMENT_ID')
const agentId = process.env.KIMI_AGENT_ID || ''

/**
 * PPIO SDK settings the controller must inherit, because it creates worker
 * sandboxes with the same SDK this deploy uses.
 *
 * `PPIO_DOMAIN` is the one that bites: the SDK derives the API endpoint from
 * it, and an API key is only valid against its own region. Measured: a
 * controller deployed from a shell with `PPIO_DOMAIN` set, but without the
 * variable forwarded, fell back to the default domain and failed every
 * reconcile with `auth user unauthorized: invalid token` — after the Kimi
 * claim and ack had already succeeded, so the work item was held and lost.
 * Optional variables are forwarded only when set, so the SDK's own defaults
 * apply otherwise.
 */
// Every PPIO_* variable the SDK reads from the environment, except the two
// credentials: PPIO_API_KEY is passed explicitly above, and PPIO_ACCESS_TOKEN
// is a CLI login token that must not reach a sandbox.
const PPIO_ENV_PASSTHROUGH = [
  'PPIO_DOMAIN',
  'PPIO_API_URL',
  'PPIO_SANDBOX_URL',
  'PPIO_DEBUG',
] as const
const ppioEnvs: Record<string, string> = Object.fromEntries(
  PPIO_ENV_PASSTHROUGH.flatMap((name) => {
    const value = optionalEnv(name)
    return value ? [[name, value]] : []
  })
)

const CONTROLLER_DIR = '/app'
const BUNDLE = `${CONTROLLER_DIR}/controller.mjs`

/**
 * Bundle the controller to a single file.
 *
 * Bundling avoids installing dependencies inside the controller sandbox on
 * every deploy, which would otherwise be the slowest part of a redeploy.
 */
async function bundleController(): Promise<string> {
  const { build } = await import('esbuild')
  const result = await build({
    entryPoints: ['src/webhook/handler.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    // Node builtins that esbuild's esm output otherwise mangles.
    banner: {
      js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);",
    },
    write: false,
    logLevel: 'warning',
  })
  const output = result.outputFiles?.[0]
  if (!output) throw new Error('esbuild produced no output')
  return output.text
}

async function findController(): Promise<string | undefined> {
  // Prefer the id recorded by the last deploy, so a controller that is merely
  // paused is reused rather than replaced.
  const recorded = readRecordedId()
  if (recorded) {
    const alive = await Sandbox.connect(recorded)
      .then(() => recorded)
      .catch(() => undefined)
    if (alive) return alive
  }

  const items = await Sandbox.list({
    query: { metadata: { ...CONTROLLER_METADATA } },
  }).nextItems()
  return items.at(0)?.sandboxId
}

function readRecordedId(): string | undefined {
  try {
    return JSON.parse(readFileSync('.controller.json', 'utf8')).sandboxId
  } catch {
    return undefined
  }
}

const source = await bundleController()

let sandbox: Sandbox
const existing = await findController()
if (existing) {
  sandbox = await Sandbox.connect(existing)
  await sandbox.setTimeout(CONTROLLER_TIMEOUT_MS)
  console.log(`Reusing controller sandbox ${sandbox.sandboxId}`)
  // Restart so the new environment variables take effect. pkill matches the
  // bundle path rather than "node", which would also match this deploy's own
  // helper processes inside the sandbox.
  await sandbox.commands
    .run(`pkill -f ${BUNDLE} || true`, { timeoutMs: 30_000 })
    .catch(() => {})
} else {
  sandbox = await Sandbox.create(TEMPLATE_NAME, {
    timeoutMs: CONTROLLER_TIMEOUT_MS,
    // Pause rather than kill: the controller is the only holder of the
    // environment work key, and while it is down every new turn on the
    // environment sits `queued`. Pausing keeps its state, and autoResume
    // brings it back on the next connect().
    lifecycle: SANDBOX_LIFECYCLE,
    metadata: { ...CONTROLLER_METADATA, ...LONG_RUNNING_METADATA },
  })
  console.log(`Created controller sandbox ${sandbox.sandboxId}`)
}

await sandbox.files.makeDir(CONTROLLER_DIR).catch(() => {})
await sandbox.files.write(BUNDLE, source)

// Background start with no timeout. `background` only stops the SDK from
// waiting; the SDK still sends its 60s default as the request timeout, and
// envd kills the process when it expires — measured on PPIO as the controller
// dying at exactly 60s with `context deadline exceeded` / `signal: killed`,
// which left every work item `queued`. 0 is the documented "no limit".
// Redirect stdout/stderr into the sandbox. Without this the controller's own
// output goes to the command channel and is lost when deploy exits, so a crash
// leaves no evidence: controller.log only holds what the handler chose to log,
// which stops before any stack trace. setsid detaches it from the channel's
// process group as well, so a channel teardown cannot signal it.
await sandbox.commands.run(
  `setsid node ${BUNDLE} >> ${CONTROLLER_STDIO} 2>&1 < /dev/null`,
  {
    background: true,
    timeoutMs: 0,
    envs: {
      KIMI_API_KEY: kimiApiKey,
      KIMI_ENVIRONMENT_KEY: environmentKey,
      KIMI_ENVIRONMENT_ID: environmentId,
      KIMI_AGENT_ID: agentId,
      KIMI_BASE_URL,
      PPIO_API_KEY: requireEnv('PPIO_API_KEY'),
      ...ppioEnvs,
    },
  }
)

const host = sandbox.getHost(CONTROLLER_PORT)
const healthUrl = `https://${host}/healthz`

await sandbox.files.write(
  `${CONTROLLER_DIR}/.deployed`,
  new Date().toISOString()
)
const { writeFileSync } = await import('node:fs')
writeFileSync(
  '.controller.json',
  JSON.stringify({ sandboxId: sandbox.sandboxId, healthUrl }, null, 2) + '\n'
)

console.log(`\nHealth: ${healthUrl}`)
console.log(`Controller log: ${CONTROLLER_LOG} (inside ${sandbox.sandboxId})`)
console.log(
  `\nThe controller is now polling environment ${environmentId}. Sanity check:\n` +
    `  curl -s ${healthUrl}\n` +
    `expects {"ok":true,...}. Nothing needs registering with Kimi.`
)
