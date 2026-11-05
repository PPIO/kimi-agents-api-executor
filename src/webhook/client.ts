/**
 * The application side of controller-managed provisioning.
 *
 * Never imports the sandbox SDK: creating and connecting compute is entirely
 * the controller's job. This process only creates agents, environments and
 * sessions, sends input, and streams the turn.
 *
 *   npm run webhook:client -- --create-agent <name> [--instructions "..."] [--model <id>]
 *   npm run webhook:client -- --update-agent <id> [--instructions "..."] [--model <id>]
 *   npm run webhook:client -- --create-environment <name>
 *   npm run webhook:client -- --agent-id <id> --input "..."
 *   npm run webhook:client -- --session-id <id> --input "..."
 *   npm run webhook:client -- --session-id <id> --delete
 */
import { Kimi, messageText } from '../kimi.js'
import { requireEnv } from '../config.js'

const MODEL = process.env.AGENTS_MODEL || 'kimi-k3.1-pro'

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}
const has = (name: string) => process.argv.includes(`--${name}`)

const client = new Kimi({ apiKey: requireEnv('KIMI_API_KEY') })

const DEFAULT_INSTRUCTIONS =
  'You are a coding assistant. Use the shell to do real work in the workspace, and verify results by reading files back.'

if (has('create-agent')) {
  // `system` is the whole system prompt: there is no base prompt it is
  // appended to, so what is passed here is what the agent runs with.
  const agent = await client.agents.create({
    name: arg('create-agent')!,
    model: { id: arg('model') || MODEL },
    system: arg('instructions') || DEFAULT_INSTRUCTIONS,
  })
  console.log(JSON.stringify({ agent_id: agent.id }))
  process.exit(0)
}

if (has('update-agent')) {
  // Editing in place keeps the agent id, so the controller keeps matching and
  // needs no redeploy. Omitted fields are left unchanged; the update is a new
  // immutable version, and sessions created afterwards pick it up.
  const agent = await client.agents.update(arg('update-agent')!, {
    ...(arg('instructions') ? { system: arg('instructions') } : {}),
    ...(arg('model') ? { model: { id: arg('model')! } } : {}),
    ...(arg('name') ? { name: arg('name') } : {}),
  })
  console.log(
    JSON.stringify({ agent_id: agent.id, model: agent.model, name: agent.name })
  )
  process.exit(0)
}

if (has('create-environment')) {
  // A self-hosted environment has no image to build, so it is usable at once.
  // The work key it needs is console-only: generate it on the environment's
  // Worker tab and put it in KIMI_ENVIRONMENT_KEY.
  const environment = await client.environments.create({
    name: arg('create-environment')!,
    config: { type: 'self_hosted' },
  })
  console.log(
    JSON.stringify({
      environment_id: environment.id,
      note: 'generate a work key on this environment\'s Worker tab in the console and set KIMI_ENVIRONMENT_KEY',
    })
  )
  process.exit(0)
}

if (has('delete')) {
  const sessionId = arg('session-id')
  if (!sessionId) throw new Error('--delete needs --session-id')
  await client.releaseSession(sessionId)
  // Releasing a session does not stop its worker and emits no event the
  // controller sees, so the sandbox has to be released separately.
  console.log(
    JSON.stringify({ deleted: sessionId, note: 'kill the worker sandbox separately' })
  )
  process.exit(0)
}

const input = arg('input')
if (!input) throw new Error('--input is required')

let sessionId = arg('session-id')

if (!sessionId) {
  const agentId = arg('agent-id') || process.env.KIMI_AGENT_ID
  if (!agentId) {
    throw new Error('provide --agent-id, KIMI_AGENT_ID, or --session-id')
  }
  const session = await client.sessions.create({
    agent_id: agentId,
    environment_id: requireEnv('KIMI_ENVIRONMENT_ID'),
  })
  sessionId = session.id
  // Printed first so a caller can capture it even if the turn later fails.
  console.log(JSON.stringify({ session_id: session.id }))
}

// Open the stream before sending input. The controller reacts to the work
// item the input creates, and this is how the wait becomes observable rather
// than a silent queue. `await` matters: the stream is live only once the
// server's control frame has arrived.
const events = await client.sessions.events.stream(sessionId, { includeDeltas: true })

await client.sessions.events.create(sessionId, {
  events: [{ type: 'user.message', data: { content: [{ type: 'text', text: input }] } }],
})

let streamedText = false
for await (const frame of events) {
  if (frame.kind === 'error') {
    console.error(`\n[stream error] ${JSON.stringify(frame.error)}`)
    process.exit(1)
  }
  if (frame.kind !== 'event') continue
  const event = frame.event

  switch (event.type) {
    case 'session.status': {
      const status = event.data?.status
      console.error(`[${event.type}] ${String(status)}`)
      if (status === 'idle') {
        if (streamedText) process.stdout.write('\n')
        process.exit(0)
      }
      break
    }

    case 'agent.delta':
      if (event.data?.kind === 'text') {
        process.stdout.write(String(event.data.delta ?? ''))
        streamedText = true
      }
      break

    case 'agent.message':
      // Deltas already printed this; print the authoritative body only if
      // none arrived.
      if (!streamedText) process.stdout.write(messageText(event) ?? '')
      break

    case 'session.error':
      console.error(`\n[${event.type}] ${JSON.stringify(event.data)}`)
      console.error(
        'Check the controller log, then the worker log in the worker sandbox.'
      )
      process.exit(1)
  }
}
