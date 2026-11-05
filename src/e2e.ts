/**
 * End-to-end check: one Hosted Agents session executing in a PPIO sandbox.
 *
 * Everything except the sandbox side is the REST API used directly. Reports a
 * timing breakdown, because a work item only exists once input is sent and the
 * useful question is which phase between input and execution consumes time.
 *
 *   npm run e2e
 */
import { Kimi } from './kimi.js'
import type { WorkItem } from './kimi.js'
import { startExecutor } from './runner.js'
import {
  CONNECT_DEADLINE_MS,
  WORKSPACE_DIR,
  optionalEnv,
  requireEnv,
} from './config.js'

const MODEL = process.env.AGENTS_MODEL || 'kimi-k3.1-pro'
const EXPECTED = 'ppio executor ok'

/**
 * Attach to an existing sandbox instead of creating one:
 *
 *   npm run e2e -- --sandbox-id <id>
 *
 * This is the shape a real integration takes — the sandbox already holds the
 * work and the agent is attached to it. Without the flag a throwaway sandbox is
 * created from the template and killed afterwards.
 */
const sandboxIdArg = (() => {
  const index = process.argv.indexOf('--sandbox-id')
  return index === -1 ? undefined : process.argv[index + 1]
})()
const keepSandbox = process.argv.includes('--keep-sandbox')

requireEnv('PPIO_API_KEY')
const client = new Kimi({ apiKey: requireEnv('KIMI_API_KEY') })
const executorApiKey = requireEnv('KIMI_ENVIRONMENT_KEY')
const environmentId = requireEnv('KIMI_ENVIRONMENT_ID')

const marks: Array<[string, number]> = []
const t0 = Date.now()
const mark = (label: string) => marks.push([label, Date.now() - t0])

let sessionId: string | undefined
let throwawayAgentId: string | undefined
let executor: Awaited<ReturnType<typeof startExecutor>> | undefined

try {
  console.log('1. Creating self-hosted session')
  // The environment is a persistent resource, not something the API assigns
  // per session: confirm it is the self-hosted kind before a worker is pointed
  // at it, so a cloud environment cannot reach the executor command line.
  const environment = await client.environments.retrieve(environmentId)
  if (environment.config.type !== 'self_hosted') {
    throw new Error(
      `Environment ${environmentId} is not self-hosted (got ${environment.config.type}).`
    )
  }
  if (environment.archived_at) {
    throw new Error(`Environment ${environmentId} is archived.`)
  }

  // Sessions need an existing agent. Use the configured one, or create a
  // throwaway and archive it on the way out.
  let agentId = optionalEnv('KIMI_AGENT_ID')
  if (!agentId) {
    const agent = await client.agents.create({
      name: `e2e-${new Date().toISOString()}`,
      model: { id: MODEL },
      system:
        'You are a coding assistant. Write files in the workspace and verify your work by reading them back.',
    })
    agentId = throwawayAgentId = agent.id
  }

  const session = await client.sessions.create({
    agent_id: agentId,
    environment_id: environmentId,
    title: 'kimi-agents-api-executor e2e',
  })
  sessionId = session.id
  mark('session created')
  console.log(`   session=${session.id} environment=${environment.id}`)

  console.log(
    sandboxIdArg
      ? `2. Attaching the executor to sandbox ${sandboxIdArg}`
      : '2. Creating a sandbox and starting the executor'
  )
  executor = await startExecutor({
    ...(sandboxIdArg ? { sandboxId: sandboxIdArg } : {}),
    environmentId: environment.id,
    executorApiKey,
    sessionId: session.id,
    onExecutorLog: (line) => console.log(`   [executor] ${line.trimEnd()}`),
  })
  mark('executor started')
  console.log(
    `   sandbox=${executor.sandbox.sandboxId} (${executor.createdSandbox ? 'created' : 'attached'}) worker=${executor.workerId}`
  )

  // Open the stream before sending input, so nothing between the input and the
  // first status change is missed. `await` matters: the stream is live only
  // once the server's control frame has arrived.
  console.log('3. Sending a task')
  const events = await client.sessions.events.stream(session.id, {
    signal: AbortSignal.timeout(CONNECT_DEADLINE_MS + 4 * 60 * 1000),
  })
  await client.sessions.events.create(session.id, {
    events: [
      {
        type: 'user.message',
        data: {
          content: [
            {
              type: 'text',
              text: `Write a file at ${WORKSPACE_DIR}/hello.txt containing exactly "${EXPECTED}", then read it back and report the contents.`,
            },
          ],
        },
      },
    ],
  })
  mark('input accepted')

  // There is no "environment connected" event: the input enqueued a work item,
  // and the worker's claim shows up as that item leaving `queued`. Follow the
  // queue rather than the session: a session retrieve keeps returning
  // `running` whether or not anyone is executing its tools, which looks
  // identical to a network problem.
  console.log('4. Waiting for the worker to claim the work item')
  const deadline = Date.now() + CONNECT_DEADLINE_MS
  let work: WorkItem | undefined
  let lastStatus: string | undefined
  while (Date.now() < deadline) {
    const { items } = await client.environments.work.list(environment.id, {
      page_size: '20',
    })
    work = items.find((item) => item.session_id === session.id)
    if (work && work.status !== lastStatus) {
      console.log(`   work ${work.id}: ${work.status}${work.worker_id ? ` (worker ${work.worker_id})` : ''}`)
      lastStatus = work.status
    }
    if (work && work.status !== 'queued') break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  if (!work || work.status === 'queued') {
    throw new Error(
      'No worker claimed the work item within the deadline.\n' +
        `Check the worker log. If egress is restricted, allow api.moonshot.cn.`
    )
  }
  if (work.worker_id !== executor.workerId) {
    // The environment is shared: another worker polling the same queue got
    // there first. The turn will still run, but not in this sandbox, so the
    // filesystem check below would be checking the wrong machine.
    throw new Error(
      `Work item was claimed by worker ${work.worker_id}, not ${executor.workerId}. ` +
        `Another worker is polling environment ${environment.id}.`
    )
  }
  mark('work item claimed')

  console.log('5. Following the turn')
  for await (const frame of events) {
    if (frame.kind === 'error') {
      throw new Error(`stream error: ${JSON.stringify(frame.error)}`)
    }
    if (frame.kind !== 'event') continue
    const event = frame.event
    if (event.type === 'session.status') {
      console.log(`   ${event.type}: ${String(event.data?.status)}`)
      if (event.data?.status === 'idle') break
    }
    if (event.type === 'session.error') {
      throw new Error(`${event.type}: ${JSON.stringify(event.data)}`)
    }
  }
  mark('turn completed')

  // Assert against the sandbox filesystem, not the agent's own narration:
  // a turn can report success while the write never landed.
  console.log('6. Checking the workspace for the written file')
  const fileDeadline = Date.now() + 60 * 1000
  let contents: string | undefined
  while (Date.now() < fileDeadline) {
    contents = await executor.sandbox.files
      .read(`${WORKSPACE_DIR}/hello.txt`)
      .catch(() => undefined)
    if (contents?.includes(EXPECTED)) break
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  mark('file observed')

  if (!contents?.includes(EXPECTED)) {
    throw new Error(
      `The agent did not write the expected file. Last read: ${JSON.stringify(contents ?? null)}`
    )
  }
  console.log(`   file contents: ${contents.trim()}`)

  console.log('\nTiming breakdown:')
  let previous = 0
  for (const [label, at] of marks) {
    console.log(`   ${String(at - previous).padStart(7)}ms  ${label}`)
    previous = at
  }
  console.log(`   ${String(previous).padStart(7)}ms  total`)
  console.log('\nPASS')
} catch (error) {
  console.error('\nFAIL')
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
} finally {
  // Session release and compute teardown are separate: archiving a session
  // does not stop its worker. stop() only kills a sandbox this run created,
  // so an attached sandbox survives either way.
  if (executor && keepSandbox) {
    console.log(
      `\nSandbox ${executor.sandbox.sandboxId} left running for inspection ` +
        `(worker log: /tmp/kha-worker.log). Kill it when done.`
    )
  } else {
    await executor?.stop().catch((error: unknown) =>
      console.error('sandbox teardown failed:', error)
    )
  }
  if (sessionId) {
    await client
      .releaseSession(sessionId)
      .catch((error: unknown) => console.error('session release failed:', error))
  }
  if (throwawayAgentId) {
    await client.agents
      .archive(throwawayAgentId)
      .catch((error: unknown) => console.error('agent archive failed:', error))
  }
}
