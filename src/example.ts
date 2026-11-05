/**
 * The shape a real integration takes: a sandbox exists and holds the work, then
 * an agent is attached to it.
 *
 * This is the opposite order from `e2e.ts`, which creates a throwaway sandbox
 * per session to check the plumbing. Here the sandbox comes first, is seeded
 * with a repository-like workspace, and survives after the agent is done — so
 * later turns, or a different agent, can pick up where this one left off.
 *
 *   npm run example                      # create a sandbox, use it, keep it
 *   npm run example -- --sandbox-id <id> # reuse one from a previous run
 */
import { Sandbox } from 'ppio-sandbox'
import { Kimi, messageText } from './kimi.js'
import { startExecutor } from './runner.js'
import {
  CONNECT_DEADLINE_MS,
  EXECUTOR_LOG,
  SANDBOX_LIFECYCLE,
  SANDBOX_TIMEOUT_MS,
  TEMPLATE_NAME,
  WORKSPACE_DIR,
  optionalEnv,
  requireEnv,
} from './config.js'

const MODEL = process.env.AGENTS_MODEL || 'kimi-k3.1-pro'
const TASK =
  process.env.AGENT_TASK ||
  `Read ${WORKSPACE_DIR}/notes.md, then write a file ${WORKSPACE_DIR}/summary.md ` +
    `that lists each TODO it contains as a checklist. Verify by reading it back.`

const existingSandboxId = (() => {
  const index = process.argv.indexOf('--sandbox-id')
  return index === -1 ? undefined : process.argv[index + 1]
})()

requireEnv('PPIO_API_KEY')
const client = new Kimi({ apiKey: requireEnv('KIMI_API_KEY') })
const executorApiKey = requireEnv('KIMI_ENVIRONMENT_KEY')
const environmentId = requireEnv('KIMI_ENVIRONMENT_ID')

// ---------------------------------------------------------------------------
// 1. The sandbox, and the work already in it.
//
// In a real integration this is where a checkout is cloned, dependencies are
// installed, or files from a previous turn already live. The agent is a visitor
// to this workspace, not its owner.
// ---------------------------------------------------------------------------
let sandbox: Sandbox
if (existingSandboxId) {
  // connect() resumes a paused sandbox with its filesystem intact.
  sandbox = await Sandbox.connect(existingSandboxId)
  await sandbox.setTimeout(SANDBOX_TIMEOUT_MS)
  console.log(`Reusing sandbox ${sandbox.sandboxId}`)
} else {
  sandbox = await Sandbox.create(TEMPLATE_NAME, {
    timeoutMs: SANDBOX_TIMEOUT_MS,
    lifecycle: SANDBOX_LIFECYCLE,
    metadata: { purpose: 'agents-api-example' },
  })
  console.log(`Created sandbox ${sandbox.sandboxId}`)
  await sandbox.files.write(
    `${WORKSPACE_DIR}/notes.md`,
    [
      '# Project notes',
      '',
      '- TODO: pin the kha version in the template',
      '- TODO: allow egress to api.moonshot.cn when restricted',
      '- Done: bake the CLI into the image',
      '',
    ].join('\n')
  )
  console.log(`Seeded ${WORKSPACE_DIR}/notes.md`)
}

// ---------------------------------------------------------------------------
// 2. A session for this sandbox.
//
// The environment is a persistent resource created once, not assigned by the
// API per session; the session only names it. The agent is likewise a saved
// resource — use the configured one or create a throwaway for this run.
// ---------------------------------------------------------------------------
let agentId = optionalEnv('KIMI_AGENT_ID')
let throwawayAgentId: string | undefined
if (!agentId) {
  const agent = await client.agents.create({
    name: `example-${new Date().toISOString()}`,
    model: { id: MODEL },
    system:
      'You are working in an existing project directory. Use the shell to inspect ' +
      'files before changing them, and verify your work by reading it back.',
  })
  agentId = throwawayAgentId = agent.id
}

const session = await client.sessions.create({
  agent_id: agentId,
  environment_id: environmentId,
  title: 'kimi-agents-api-executor example',
})
const environment = await client.environments.retrieve(session.environment_id)
if (environment.config.type !== 'self_hosted') {
  throw new Error(`Session ${session.id} is not self-hosted`)
}
console.log(`Session ${session.id} -> environment ${environment.id}`)

// ---------------------------------------------------------------------------
// 3. Attach the executor to the sandbox that already exists.
//
// `stop()` will not kill it, because this run did not create it — except on the
// first run, where the flag below keeps it anyway.
// ---------------------------------------------------------------------------
const executor = await startExecutor({
  sandboxId: sandbox.sandboxId,
  environmentId: environment.id,
  executorApiKey,
  sessionId: session.id,
  onExecutorLog: (line) => console.error(`  [executor] ${line.trimEnd()}`),
})

try {
  // Open the stream before sending input, so the wait for a worker to claim
  // the turn is observable rather than a silent queue. `await` matters: the
  // stream is live only once the server's control frame has arrived.
  const events = await client.sessions.events.stream(session.id, {
    includeDeltas: true,
    signal: AbortSignal.timeout(CONNECT_DEADLINE_MS + 4 * 60 * 1000),
  })

  await client.sessions.events.create(session.id, {
    events: [{ type: 'user.message', data: { content: [{ type: 'text', text: TASK }] } }],
  })

  let streamedText = false
  for await (const frame of events) {
    if (frame.kind === 'error') {
      throw new Error(`stream error: ${JSON.stringify(frame.error)}`)
    }
    if (frame.kind !== 'event') continue
    const event = frame.event

    switch (event.type) {
      case 'session.status':
        console.error(`  [${event.type}] ${String(event.data?.status)}`)
        break

      case 'agent.tool_use':
        // The first tool call is the proof the worker attached: tools in a
        // self-hosted environment only run on the worker.
        console.error('  [worker executing tools]')
        break

      case 'agent.delta':
        if (event.data?.kind === 'text') {
          process.stdout.write(String(event.data.delta ?? ''))
          streamedText = true
        }
        break

      case 'agent.message':
        if (!streamedText) process.stdout.write(messageText(event) ?? '')
        break

      case 'session.error':
        throw new Error(
          `Session failed. Read ${EXECUTOR_LOG} in ${sandbox.sandboxId}: ${JSON.stringify(event.data)}`
        )
    }
    if (event.type === 'session.status' && event.data?.status === 'idle') {
      process.stdout.write('\n')
      break
    }
  }

  // Trust the filesystem, not the narration: a turn can report success while
  // the write never landed.
  const summary = await sandbox.files
    .read(`${WORKSPACE_DIR}/summary.md`)
    .catch(() => undefined)
  console.log('\n--- summary.md as it exists in the sandbox ---')
  console.log(summary ?? '(not written)')
} finally {
  // Release the session and the executor, but leave the sandbox: its files are
  // the point, and the next turn can reuse them.
  await executor.stop().catch(() => {})
  await client.releaseSession(session.id).catch(() => {})
  if (throwawayAgentId) await client.agents.archive(throwawayAgentId).catch(() => {})
  console.log(
    `\nSandbox ${sandbox.sandboxId} is still running with your files.\n` +
      `  reuse: npm run example -- --sandbox-id ${sandbox.sandboxId}\n` +
      `  worker log: ${EXECUTOR_LOG}`
  )
}
