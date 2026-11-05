/**
 * Minimal client for the Kimi Hosted Agents API.
 *
 * Kimi publishes no TypeScript SDK for Hosted Agents, so this file stands in
 * for the `openai` package: the same handful of calls the examples need
 * (agents, environments, sessions, events, the SSE stream, and the self-hosted
 * work queue), shaped so the call sites read like the SDK they replace.
 * Everything else — sandbox lifecycle, the worker, the timing of each step —
 * lives in the files that use it.
 */
import { KIMI_API_VERSION, KIMI_BASE_URL } from './config.js'

// ---------------------------------------------------------------------------
// Resource types. Only the fields this project reads; the API returns more.
// ---------------------------------------------------------------------------

export interface Agent {
  id: string
  name: string
  version: string
  model: string | { id: string; reasoning_effort?: string; provider?: string }
  system?: string
}

export interface Environment {
  id: string
  name: string
  config: { type: 'cloud' | 'self_hosted' }
  build_status?: 'building' | 'ready' | 'failed'
  archived_at?: string
}

export type SessionState = 'idle' | 'running' | 'stopping' | 'terminated'

export interface Session {
  id: string
  agent_id: string
  environment_id: string
  status: SessionState
  interrupted?: boolean
  title?: string
  metadata?: Record<string, string>
  agent?: { id: string; version: string; name: string }
}

export type WorkItemStatus =
  | 'queued'
  | 'starting'
  | 'active'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface WorkItem {
  id: string
  session_id: string
  environment_id: string
  status: WorkItemStatus
  generation: number
  worker_id?: string
  lease_ttl_ms: number
  created_at: string
  claimed_at?: string
  started_at?: string
  stopped_at?: string
}

/**
 * `WorkItem.secret` is a base64url JSON object whose `sessions_token` member is
 * the Bearer credential for that session's write paths and the item's
 * ack/heartbeat/stop. Other members are reserved and must not be consumed.
 */
export function sessionWorkToken(secret: string): string {
  const json = Buffer.from(secret, 'base64url').toString('utf8')
  const parsed = JSON.parse(json) as { sessions_token?: string }
  if (!parsed.sessions_token) {
    throw new Error('work item secret has no sessions_token member')
  }
  return parsed.sessions_token
}

export interface WorkQueueStats {
  depth: number
  claimed: number
  workers: number
  oldest_queued_at?: string
}

/** One event from the session stream or history. `data` varies by `type`. */
export interface SessionEvent {
  id: string
  processed_at: string
  session_thread_id?: string
  type: string
  data?: Record<string, unknown>
}

export interface UserMessageInput {
  type: 'user.message'
  data: { content: Array<{ type: 'text'; text: string }> }
}
export interface UserInterruptInput {
  type: 'user.interrupt'
}
export type UserEventInput = UserMessageInput | UserInterruptInput

export class KimiAPIError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | undefined,
    message: string,
    readonly requestId?: string
  ) {
    super(`${status} ${type ?? 'error'}: ${message}`)
    this.name = 'KimiAPIError'
  }
}

export interface KimiOptions {
  apiKey: string
  baseURL?: string
}

/**
 * The one text-stream shape the SDK-less call sites iterate: either a parsed
 * session event or the control/error frames the stream itself emits.
 */
export type StreamFrame =
  | { kind: 'control'; cursor: string }
  | { kind: 'event'; cursor: string; event: SessionEvent }
  | { kind: 'error'; error: { type?: string; message?: string } }

export class Kimi {
  private readonly apiKey: string
  private readonly baseURL: string

  constructor(options: KimiOptions) {
    this.apiKey = options.apiKey
    this.baseURL = (options.baseURL ?? KIMI_BASE_URL).replace(/\/+$/, '')
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'kimi-api-version': KIMI_API_VERSION,
      ...extra,
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown
      query?: Record<string, string | undefined>
      signal?: AbortSignal
      /** Bearer credential for this one call, when it is not the client's key. */
      token?: string
    } = {}
  ): Promise<T> {
    const url = new URL(this.baseURL + path)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value)
    }
    const response = await fetch(url, {
      method,
      headers: this.headers({
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      }),
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    })
    if (!response.ok) throw await this.toError(response)
    if (response.status === 204) return undefined as T
    const text = await response.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private async toError(response: Response): Promise<KimiAPIError> {
    // The platform's request id header; the error body repeats it as
    // `error.request_id`.
    const requestId = response.headers.get('msh-request-id') ?? undefined
    const text = await response.text().catch(() => '')
    try {
      const parsed = JSON.parse(text) as {
        error?: { type?: string; message?: string; request_id?: string }
      }
      return new KimiAPIError(
        response.status,
        parsed.error?.type,
        parsed.error?.message ?? text,
        parsed.error?.request_id ?? requestId
      )
    } catch {
      // A gateway that never saw the request answers with plain text; keep it
      // verbatim so `404 page not found` stays recognisable as not-Kimi.
      return new KimiAPIError(response.status, undefined, text || response.statusText, requestId)
    }
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  readonly agents = {
    create: (body: {
      name: string
      model: Agent['model']
      system?: string
      description?: string
      metadata?: Record<string, string>
    }) => this.request<Agent>('POST', '/v1/agents', { body }),

    retrieve: (id: string) => this.request<Agent>('GET', `/v1/agents/${id}`),

    /** PATCH creates a new immutable version; omitted fields are untouched. */
    update: (
      id: string,
      body: { name?: string; model?: Agent['model']; system?: string; version?: string }
    ) => this.request<Agent>('PATCH', `/v1/agents/${id}`, { body }),

    /** Irreversible. Blocks new sessions; existing ones keep running. */
    archive: (id: string) => this.request<void>('POST', `/v1/agents/${id}/archive`),
  }

  // -------------------------------------------------------------------------
  // Environments
  // -------------------------------------------------------------------------

  readonly environments = {
    create: (body: {
      name: string
      config: { type: 'self_hosted' } | { type: 'cloud' }
      description?: string
      metadata?: Record<string, string>
    }) => this.request<Environment>('POST', '/v1/environments', { body }),

    retrieve: (id: string) => this.request<Environment>('GET', `/v1/environments/${id}`),

    archive: (id: string) => this.request<void>('POST', `/v1/environments/${id}/archive`),

    /** Only archived environments with no live sessions can be deleted. */
    delete: (id: string) => this.request<void>('DELETE', `/v1/environments/${id}`),

    /**
     * The self-hosted work queue.
     *
     * `list`, `retrieve` and `stats` observe it, which is how the examples learn
     * that a worker has attached. `poll`, `ack` and `stop` are worker-side:
     * `poll` needs the environment work key, and `ack`/`stop` the session work
     * token that the claiming poll returned in `secret`.
     */
    work: {
      list: (environmentId: string, query: { status?: WorkItemStatus; page_size?: string } = {}) =>
        this.request<{ items: WorkItem[]; next_page_token?: string }>(
          'GET',
          `/v1/environments/${environmentId}/work`,
          { query }
        ),
      retrieve: (environmentId: string, id: string) =>
        this.request<WorkItem>('GET', `/v1/environments/${environmentId}/work/${id}`),
      stats: (environmentId: string) =>
        this.request<WorkQueueStats>('GET', `/v1/environments/${environmentId}/work/stats`),

      /**
       * Claim the oldest queued item. A successful poll *is* a claim, so never
       * retry it idempotently. Resolves undefined on 204 (budget spent, nothing
       * queued). `secret` is the session work token: ack, heartbeat and stop
       * for this item authenticate with it, not with the environment key.
       */
      poll: async (
        environmentId: string,
        query: { worker_id: string; block_ms?: string; lease_ttl_ms?: string }
      ) => {
        const item = await this.request<(WorkItem & { secret: string }) | undefined>(
          'GET',
          `/v1/environments/${environmentId}/work/poll`,
          { query }
        )
        return item ?? undefined
      },

      /** Must land within 5000ms of delivery or the item returns to the queue. */
      ack: (
        environmentId: string,
        id: string,
        sessionToken: string,
        body: { worker_id: string; generation: number }
      ) =>
        this.request<WorkItem>('POST', `/v1/environments/${environmentId}/work/${id}/ack`, {
          body,
          token: sessionWorkToken(sessionToken),
        }),

      /**
       * Without `final_status`, a graceful stop request: the item enters
       * `stopping`, the worker sees that on its next heartbeat, cancels in-flight
       * tools, and then submits `final_status: 'completed'`. The request persists
       * across a lease reclaim, so it is not a way to hand an item to someone
       * else. `completed` on an idle worker releases the lease and keeps the
       * session; with pending input it is a 409.
       */
      stop: (
        environmentId: string,
        id: string,
        sessionToken: string,
        body: { worker_id: string; generation: number; final_status?: 'completed' }
      ) =>
        this.request<void>('POST', `/v1/environments/${environmentId}/work/${id}/stop`, {
          body,
          token: sessionWorkToken(sessionToken),
        }),
    },
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  readonly sessions = {
    create: (body: {
      agent_id: string
      environment_id: string
      title?: string
      metadata?: Record<string, string>
    }) => this.request<Session>('POST', '/v1/sessions', { body }),

    retrieve: (id: string) => this.request<Session>('GET', `/v1/sessions/${id}`),

    list: (query: { agent_id?: string; statuses?: string; page_size?: string } = {}) =>
      this.request<{ items: Session[]; next_page_token?: string }>('GET', '/v1/sessions', {
        query,
      }),

    /** Running sessions cannot be archived: interrupt first, wait for idle. */
    archive: (id: string) => this.request<void>('POST', `/v1/sessions/${id}/archive`),

    /** Only archived (`terminated`) sessions can be deleted. */
    delete: (id: string) => this.request<void>('DELETE', `/v1/sessions/${id}`),

    events: {
      /** Returns 202. `user.interrupt` must be the only event in its request. */
      create: (sessionId: string, body: { events: UserEventInput[] }) =>
        this.request<{ event_id?: string }>('POST', `/v1/sessions/${sessionId}/events`, {
          body,
        }),

      /**
       * Open the live SSE stream. `cursor=now` skips history, which is what a
       * caller that opens the stream before sending input wants.
       *
       * Resolves once the connection is up and the server's opening `control`
       * frame has arrived, so that `await stream()` followed by `events.create()`
       * really does subscribe before the input is sent. A generator alone would
       * not fetch until the first `next()`, which is after the input.
       */
      stream: (
        sessionId: string,
        options: { cursor?: string; includeDeltas?: boolean; signal?: AbortSignal } = {}
      ) => this.openStream(sessionId, options),
    },
  }

  /**
   * Interrupt, archive, delete. Three calls because the API refuses to archive
   * a running session or delete an unarchived one; a caller releasing a
   * session on the way out wants all three and none of the preconditions.
   */
  async releaseSession(sessionId: string): Promise<void> {
    const session = await this.sessions.retrieve(sessionId)
    if (session.status === 'terminated') {
      await this.sessions.delete(sessionId)
      return
    }
    if (session.status === 'running') {
      await this.sessions.events
        .create(sessionId, { events: [{ type: 'user.interrupt' }] })
        .catch(() => {})
    }
    // Archive only succeeds once the session is idle, and delete only once the
    // archive's thread cancellation has settled (409 conflict_error until
    // then). The interrupt above is asynchronous too, so give each step a
    // bounded moment rather than failing on the first precondition error.
    await retryFor(30_000, () => this.sessions.archive(sessionId))
    await retryFor(30_000, () => this.sessions.delete(sessionId))
  }

  // -------------------------------------------------------------------------
  // SSE
  // -------------------------------------------------------------------------

  private async openStream(
    sessionId: string,
    options: { cursor?: string; includeDeltas?: boolean; signal?: AbortSignal }
  ): Promise<EventStream> {
    const url = new URL(`${this.baseURL}/v1/sessions/${sessionId}/events/stream`)
    url.searchParams.set('cursor', options.cursor ?? 'now')
    if (options.includeDeltas) url.searchParams.set('include_deltas', 'true')

    // Own abort controller, chained to the caller's signal: closing the stream
    // from `return()` must tear the socket down, or a consumer that `break`s on
    // `idle` leaves the connection open until the caller's timeout fires.
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted) abort()
    else options.signal?.addEventListener('abort', abort, { once: true })

    const response = await fetch(url, {
      headers: this.headers({ Accept: 'text/event-stream' }),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) throw await this.toError(response)

    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    const frames = parseFrames(reader)

    // Wait for the opening `control` frame: that is the server saying the
    // subscription is live. Anything before it is not a subscription yet.
    const first = await frames.next()
    if (first.done) {
      await reader.cancel().catch(() => {})
      throw new Error('event stream closed before the control frame')
    }
    if (first.value.kind === 'error') {
      await reader.cancel().catch(() => {})
      throw new Error(`event stream failed to open: ${JSON.stringify(first.value.error)}`)
    }
    const cursor = first.value.kind === 'control' ? first.value.cursor : first.value.cursor

    const iterator: AsyncGenerator<StreamFrame, void, undefined> = (async function* () {
      try {
        // A non-control first frame is an event; do not lose it.
        if (first.value.kind === 'event') yield first.value
        yield* frames
      } finally {
        // cancel() tears down the whole pipe, including the HTTP body;
        // releaseLock() alone would leave the socket open.
        await reader.cancel().catch(() => {})
        options.signal?.removeEventListener('abort', abort)
        controller.abort()
      }
    })()

    return Object.assign(iterator, { cursor })
  }
}

/** The opened stream: an async iterable of frames plus its opening cursor. */
export type EventStream = AsyncGenerator<StreamFrame, void, undefined> & {
  /** Cursor from the opening `control` frame; pass as `cursor` to resume. */
  cursor: string
}

/**
 * Parse SSE frames off a text reader. Handles `: hb` comment lines, multi-line
 * `data:`, `id`/`event` in any order, and the terminal `event: error` frame.
 */
async function* parseFrames(
  reader: ReadableStreamDefaultReader<string>
): AsyncGenerator<StreamFrame, void, undefined> {
  let buffer = ''
  let frame: { event?: string; id?: string; data: string[] } = { data: [] }

  const flush = (): StreamFrame | undefined => {
    const current = frame
    frame = { data: [] }
    if (current.data.length === 0 && !current.event) return undefined
    const data = current.data.join('\n')
    // A frame with an `event:` line but no `data:` carries nothing to parse.
    if (data === '') return undefined
    if (current.event === 'control') {
      const parsed = JSON.parse(data) as { cursor?: string }
      return { kind: 'control', cursor: parsed.cursor ?? current.id ?? '0' }
    }
    if (current.event === 'error') {
      const parsed = JSON.parse(data) as { error?: { type?: string; message?: string } }
      return { kind: 'error', error: parsed.error ?? {} }
    }
    return {
      kind: 'event',
      cursor: current.id ?? '',
      event: JSON.parse(data) as SessionEvent,
    }
  }

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') {
        const out = flush()
        if (out) yield out
        continue
      }
      // `: hb` heartbeats and any other comment line.
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      const fieldValue = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') frame.event = fieldValue
      else if (field === 'id') frame.id = fieldValue
      else if (field === 'data') frame.data.push(fieldValue)
    }
  }
  const tail = flush()
  if (tail) yield tail
}

async function retryFor<T>(budgetMs: number, attempt: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
}

/** Text of an `agent.message` event, or undefined for any other event. */
export function messageText(event: SessionEvent): string | undefined {
  if (event.type !== 'agent.message') return undefined
  const content = event.data?.content as Array<{ type: string; text?: string }> | undefined
  if (!content) return undefined
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}
