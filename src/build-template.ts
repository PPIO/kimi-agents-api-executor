/**
 * Builds the PPIO Sandbox template used as a self-hosted execution
 * environment for the Kimi Hosted Agents API.
 *
 * The image bakes in the `kha` CLI at a pinned version. It deliberately sets
 * NO start command: the worker must be launched per sandbox with the
 * environment id and work key, and a template start command runs once at
 * build time and is then snapshotted — it cannot see values that only exist
 * when the caller decides which environment to serve. The runner starts the
 * worker over the commands API instead (see src/runner.ts).
 *
 *   npm run build:template
 */
import { Template, TemplateBase, defaultBuildLogger } from 'ppio-sandbox'
import {
  KHA_INSTALL_URL,
  KHA_VERSION,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
  optionalEnv,
  requireEnv,
} from './config.js'

requireEnv('PPIO_API_KEY')

const tag = optionalEnv('PPIO_BUILD_TAG')
const target = tag ? `${TEMPLATE_NAME}:${tag}` : TEMPLATE_NAME

/**
 * Build-time HTTP proxy, for builders whose egress to Debian mirrors and
 * ha-static.moonshot.cn goes through a corporate proxy.
 *
 * Declared with `setEnvs` *before* the download steps and without
 * `runtime: true`, so it is a build-only ENV: `apt-get` and both `curl`
 * invocations (the installer, and the installer's own download of the binary
 * and checksums) honour the lower-case variables, and nothing of it reaches the
 * sandbox runtime, where the worker must dial api.moonshot.cn directly.
 * `no_proxy` keeps loopback and RFC 1918 addresses off the proxy.
 */
const buildProxy = optionalEnv('PPIO_BUILD_PROXY')
const buildProxyEnvs: Record<string, string> = buildProxy
  ? {
      http_proxy: buildProxy,
      https_proxy: buildProxy,
      HTTP_PROXY: buildProxy,
      HTTPS_PROXY: buildProxy,
      no_proxy: 'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
      NO_PROXY: 'localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16',
    }
  : {}

const template = Template()
  .fromNodeImage('22')
  // Build-only; an empty map is a no-op in the SDK.
  .setEnvs(buildProxyEnvs)
  // What the agent needs to do real work in the workspace: git, a Python
  // runtime, ripgrep, and file/PDF inspection.
  .aptInstall([
    'ca-certificates',
    'curl',
    'file',
    'git',
    'poppler-utils',
    'python3',
    'python3-pip',
    'ripgrep',
  ])
  .runCmd(
    [
      // The installer verifies the SHA-256 against the published checksums and
      // honours KHA_VERSION, which is what pins the worker. KHA_INSTALL_DIR
      // puts it on the default PATH for every user, not just root.
      `curl -fsSL ${KHA_INSTALL_URL} | KHA_VERSION=${KHA_VERSION} KHA_INSTALL_DIR=/usr/local/bin sh`,
      `mkdir -p ${WORKSPACE_DIR}`,
      `chown -R user:user ${WORKSPACE_DIR}`,
    ],
    { user: 'root' }
  )
  // Build-time self-check. Without it a broken or renamed binary surfaces much
  // later as a work item stuck in `queued`, which looks identical to a
  // network-policy problem.
  .runCmd('KHA_NO_UPDATE_CHECK=1 kha worker poll --help >/dev/null')
  // No runtime setEnvs: a build-layer ENV is not visible to processes started
  // later through the commands API, not even in a login shell (measured). The
  // runner passes everything the worker needs with the command instead, which
  // is the only way it reliably arrives.
  .setWorkdir(WORKSPACE_DIR)

console.log(
  `Building ${target} with kha ${KHA_VERSION}` +
    (buildProxy ? ` (build-time proxy ${buildProxy})` : '')
)

const build = await TemplateBase.build(template, target, {
  cpuCount: 2,
  memoryMB: 4096,
  onBuildLogs: defaultBuildLogger(),
})

console.log(
  `Built template=${build.templateId} build=${build.buildId} alias=${target}`
)
