/**
 * Verifies the built template without touching the Hosted Agents API.
 *
 * Needs only PPIO_API_KEY, so it can run before Kimi credentials exist.
 * It checks the things that would otherwise fail much later as an opaque
 * work item stuck in `queued` during a real session.
 *
 *   npm run verify
 */
import { Sandbox } from 'ppio-sandbox'
import type { CommandResult } from 'ppio-sandbox'
import {
  KHA_VERSION,
  KIMI_BASE_URL,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
  requireEnv,
} from './config.js'
import { workerCommand } from './runner.js'

requireEnv('PPIO_API_KEY')

interface Check {
  name: string
  command: string
  envs?: Record<string, string>
  expect?: (stdout: string) => boolean
}

const checks: Check[] = [
  {
    name: 'kha binary on PATH',
    command: 'command -v kha',
  },
  {
    name: `kha version is pinned to ${KHA_VERSION}`,
    command: 'kha version',
    envs: { KHA_NO_UPDATE_CHECK: '1' },
    expect: (out) => out.includes(KHA_VERSION),
  },
  {
    name: 'worker poll subcommand exists',
    command: 'kha worker poll --help 2>&1',
    envs: { KHA_NO_UPDATE_CHECK: '1' },
    expect: (out) => out.includes('--token-stdin'),
  },
  {
    name: `${WORKSPACE_DIR} is writable by the sandbox user`,
    command: `test -w ${WORKSPACE_DIR} && touch ${WORKSPACE_DIR}/.probe && rm ${WORKSPACE_DIR}/.probe && echo writable`,
    expect: (out) => out.includes('writable'),
  },
  {
    // A build-layer ENV does not reach processes started through the commands
    // API. Asserting that here keeps the fact measured rather than assumed: if
    // the platform ever starts propagating it, this check fails and the runner
    // can stop passing it explicitly.
    name: 'build-layer KHA_NO_UPDATE_CHECK is absent at runtime (must be passed per command)',
    command: 'printenv KHA_NO_UPDATE_CHECK || echo ABSENT',
    expect: (out) => out.trim() === 'ABSENT',
  },
  {
    // PPIO_BUILD_PROXY is declared with setEnvs() without `runtime: true`,
    // which the SDK documents as build-only. Measure it: a proxy that leaked
    // into the runtime would send the worker's api.moonshot.cn traffic through
    // a host the sandbox cannot reach, and the only symptom would be a work
    // item stuck in `queued`.
    name: 'build-time proxy does not leak into the runtime',
    command: 'printenv https_proxy HTTPS_PROXY http_proxy HTTP_PROXY || echo ABSENT',
    expect: (out) => out.trim() === 'ABSENT',
  },
  {
    name: 'env passed with the command reaches the process',
    command: 'printenv KIMI_ENVIRONMENT_KEY',
    envs: { KIMI_ENVIRONMENT_KEY: 'ewk-probe' },
    expect: (out) => out.trim() === 'ewk-probe',
  },
  {
    // The exact command the runner starts, against a fake environment and key.
    // The worker must parse every flag, read the key from stdin, and then fail
    // on authentication — a usage error here is the one that would otherwise
    // surface as a work item stuck in `queued`. `--max-idle 0` is swapped for
    // a short idle so the check returns. `--max-idle` is a Go duration
    // (measured: `1` is rejected with "missing unit"; `0` is the one bare
    // value Go accepts), so the unit is required here.
    name: 'runner command parses: worker reads the work key from stdin',
    command:
      workerCommand({
        environmentId: 'env_probe',
        remoteUrl: KIMI_BASE_URL,
        workerId: 'verify',
        log: '/tmp/kha-verify.log',
      }).replace('--max-idle 0', '--max-idle 1s') + ' | head -c 400; true',
    envs: { KIMI_ENVIRONMENT_KEY: 'ewk-probe', KHA_NO_UPDATE_CHECK: '1' },
    expect: (out) =>
      !/unknown flag|unknown command|unknown shorthand|required flag|invalid argument|invalid value|accepts \d+ arg/i.test(
        out
      ),
  },
  {
    name: 'runs as an unprivileged user that owns the workspace',
    command: 'whoami && test -O ' + WORKSPACE_DIR + ' && echo owned',
    expect: (out) => out.includes('owned') && !out.includes('root'),
  },
  {
    name: 'agent tooling present (git, python3, rg)',
    command: 'command -v git && command -v python3 && command -v rg',
  },
  {
    name: 'workdir is the workspace',
    command: 'pwd',
    expect: (out) => out.trim() === WORKSPACE_DIR,
  },
]

const started = Date.now()
console.log(`Creating sandbox from ${TEMPLATE_NAME}`)
const sandbox = await Sandbox.create(TEMPLATE_NAME, { timeoutMs: 5 * 60 * 1000 })
console.log(`  ready in ${Date.now() - started}ms (sandbox ${sandbox.sandboxId})`)

let failed = 0
try {
  for (const check of checks) {
    // Exit code alone is not enough: a wrong-but-present binary passes it,
    // so most checks also assert on stdout.
    const result = await sandbox.commands
      .run(check.command, {
        timeoutMs: 60_000,
        requestTimeoutMs: 60_000,
        ...(check.envs ? { envs: check.envs } : {}),
      })
      // A nonzero exit throws CommandExitError. Catch it so one failure does
      // not hide the remaining checks, and keep its real fields rather than
      // flattening everything to exit=1 with the message as stderr.
      .catch((error: unknown) => {
        const partial = error as Partial<CommandResult>
        return {
          exitCode: partial?.exitCode ?? 1,
          stdout: partial?.stdout ?? '',
          stderr: partial?.stderr ?? String(error),
        }
      })

    const ok =
      result.exitCode === 0 &&
      (check.expect ? check.expect(result.stdout) : true)

    console.log(`${ok ? 'PASS' : 'FAIL'}  ${check.name}`)
    if (!ok) {
      failed += 1
      console.log(`      exit=${result.exitCode}`)
      if (result.stdout) console.log(`      stdout: ${result.stdout.trim().slice(0, 400)}`)
      if (result.stderr) console.log(`      stderr: ${result.stderr.trim().slice(0, 400)}`)
    }
  }
} finally {
  await sandbox.kill()
}

console.log(
  failed === 0
    ? `\nAll ${checks.length} checks passed.`
    : `\n${failed} of ${checks.length} checks failed.`
)
process.exit(failed === 0 ? 0 : 1)
