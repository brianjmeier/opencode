import { APICallError } from "ai"
import { Instance } from "@/project/instance"
import { Hash } from "@/util/hash"
import { Log } from "@/util/log"

export namespace ProviderWebsocket {
  const log = Log.create({ service: "provider.websocket" })
  const HEADER = "x-opencode-websocket-session"
  const AGE_MAX = 55 * 60 * 1000

  type Head = {
    hash: string
    size: number
  }

  type Item = {
    ws?: WebSocket
    ready?: Promise<WebSocket>
    born?: number
    busy: boolean
    response?: string
    prompt?: Head
    next?: Head
  }

  const state = Instance.state(
    () => new Map<string, Item>(),
    async (map) => {
      for (const item of map.values()) {
        item.ws?.close(1000, "dispose")
      }
    },
  )

  function key(input: { sessionID: string; providerID: string; modelID: string }) {
    return Hash.fast(
      JSON.stringify({
        sessionID: input.sessionID,
        providerID: input.providerID,
        modelID: input.modelID,
      }),
    )
  }

  function get(input: { sessionID: string; providerID: string; modelID: string }) {
    const id = key(input)
    const map = state()
    const match = map.get(id)
    if (match) return match
    const item: Item = { busy: false }
    map.set(id, item)
    return item
  }

  function clear(item: Item) {
    item.response = undefined
    item.prompt = undefined
    item.next = undefined
  }

  function drop(item: Item, ws?: WebSocket) {
    if (ws && item.ws !== ws) return
    item.ws = undefined
    item.ready = undefined
    item.born = undefined
    item.busy = false
    clear(item)
  }

  function apiError(input: {
    body?: unknown
    headers?: HeadersInit
    message: string
    retryable: boolean
    status?: number
    url: string
    raw?: string
  }) {
    return new APICallError({
      message: input.message,
      url: input.url,
      requestBodyValues: input.body,
      responseHeaders: input.headers ? Object.fromEntries(new Headers(input.headers).entries()) : undefined,
      responseBody: input.raw,
      statusCode: input.status,
      isRetryable: input.retryable,
    })
  }

  function text(data: string | ArrayBuffer | Uint8Array) {
    if (typeof data === "string") return data
    if (data instanceof ArrayBuffer) return new TextDecoder().decode(data)
    return new TextDecoder().decode(data)
  }

  function json(input: string) {
    try {
      return JSON.parse(input) as Record<string, unknown>
    } catch {
      return undefined
    }
  }

  function head(prompt: unknown[]) {
    return {
      hash: Hash.fast(JSON.stringify(prompt)),
      size: prompt.length,
    }
  }

  function socketURL(input: URL) {
    const url = new URL(input)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    return url.toString()
  }

  async function ensure(input: { hdr: Headers; item: Item; sig?: AbortSignal; url: URL }) {
    const live =
      input.item.ws &&
      input.item.ws.readyState === WebSocket.OPEN &&
      input.item.born !== undefined &&
      Date.now() - input.item.born < AGE_MAX

    if (live) return input.item.ws!

    if (input.item.ws) {
      input.item.ws.close(1000, "refresh")
      drop(input.item, input.item.ws)
    }

    if (input.item.ready) return input.item.ready

    const Sock = WebSocket as unknown as {
      new (url: string, opts: { headers: Record<string, string> }): WebSocket
    }
    const ws = new Sock(socketURL(input.url), {
      headers: Object.fromEntries(input.hdr.entries()),
    })
    const done = Promise.withResolvers<WebSocket>()
    const stop = () => {
      ws.removeEventListener("open", onOpen)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
      input.sig?.removeEventListener("abort", onAbort)
    }
    const fail = () => {
      stop()
      drop(input.item, ws)
      done.reject(
        apiError({
          message: "WebSocket connection failed",
          retryable: true,
          url: input.url.toString(),
        }),
      )
    }
    const onAbort = () => {
      stop()
      drop(input.item, ws)
      ws.close(1000, "abort")
      done.reject(new DOMException("Aborted", "AbortError"))
    }
    const onOpen = () => {
      stop()
      input.item.ready = undefined
      input.item.born = Date.now()
      done.resolve(ws)
    }
    const onError = () => fail()
    const onClose = () => fail()

    ws.addEventListener("open", onOpen)
    ws.addEventListener("error", onError)
    ws.addEventListener("close", onClose)
    input.sig?.addEventListener("abort", onAbort, { once: true })

    input.item.ws = ws
    input.item.ready = done.promise
    return done.promise
  }

  async function warm(input: { body: Record<string, unknown>; hdr: Headers; item: Item; sig?: AbortSignal; url: URL }) {
    if (input.item.response) return
    if (input.item.busy) {
      throw apiError({
        body: input.body,
        message: "WebSocket connection is already handling a request",
        retryable: true,
        url: input.url.toString(),
      })
    }

    const body: Record<string, unknown> = {
      ...input.body,
      type: "response.create",
      generate: false,
      input: [],
    }
    delete body["stream"]
    delete body["previous_response_id"]

    const ws = await ensure(input)
    input.item.busy = true
    const done = Promise.withResolvers<string>()
    let id: string | undefined
    let closed = false

    const stop = () => {
      ws.removeEventListener("message", onMessage)
      ws.removeEventListener("error", onError)
      ws.removeEventListener("close", onClose)
      input.sig?.removeEventListener("abort", onAbort)
      input.item.busy = false
    }
    const onAbort = () => {
      if (closed) return
      closed = true
      stop()
      drop(input.item, ws)
      ws.close(1000, "abort")
      done.reject(new DOMException("Aborted", "AbortError"))
    }
    const onError = () => {
      if (closed) return
      closed = true
      stop()
      drop(input.item, ws)
      done.reject(
        apiError({
          body,
          message: "WebSocket request failed",
          retryable: true,
          url: input.url.toString(),
        }),
      )
    }
    const onClose = () => onError()
    const onMessage = (event: MessageEvent<string | ArrayBuffer | Uint8Array>) => {
      const raw = text(event.data)
      const msg = json(raw)
      if (!msg) return
      if (msg.type === "response.created") {
        const response = msg.response as Record<string, unknown> | undefined
        if (response && typeof response.id === "string") {
          id = response.id
        }
        return
      }
      if (msg.type === "response.completed" || msg.type === "response.incomplete") {
        if (closed) return
        closed = true
        stop()
        if (!id) {
          done.reject(
            apiError({
              body,
              message: "Warmup response was missing a response id",
              retryable: true,
              url: input.url.toString(),
              raw,
            }),
          )
          return
        }
        input.item.response = id
        done.resolve(id)
        return
      }
      if (msg.type === "error") {
        if (closed) return
        closed = true
        stop()
        const err = msg.error as Record<string, unknown> | undefined
        const code = err?.code
        const retryable = typeof code === "string" && code === "websocket_connection_limit_reached"
        if (retryable) {
          ws.close(1000, "limit")
        }
        clear(input.item)
        done.reject(
          apiError({
            body,
            message: typeof err?.message === "string" ? err.message : "WebSocket warmup failed",
            retryable,
            status: typeof msg.status === "number" ? msg.status : undefined,
            url: input.url.toString(),
            raw,
          }),
        )
      }
    }

    ws.addEventListener("message", onMessage)
    ws.addEventListener("error", onError)
    ws.addEventListener("close", onClose)
    input.sig?.addEventListener("abort", onAbort, { once: true })
    ws.send(JSON.stringify(body))
    return done.promise
  }

  function stream(input: { body: Record<string, unknown>; hdr: Headers; item: Item; sig?: AbortSignal; url: URL }) {
    const body: Record<string, unknown> = {
      ...input.body,
      type: "response.create",
    }
    delete body["stream"]

    return new ReadableStream<Uint8Array>({
      async start(controller) {
        if (input.item.busy) {
          controller.error(
            apiError({
              body,
              message: "WebSocket connection is already handling a request",
              retryable: true,
              url: input.url.toString(),
            }),
          )
          return
        }

        const ws = await ensure(input).catch((err) => {
          controller.error(err)
          return undefined
        })
        if (!ws) return

        input.item.busy = true
        const enc = new TextEncoder()
        let closed = false
        const stop = () => {
          ws.removeEventListener("message", onMessage)
          ws.removeEventListener("error", onError)
          ws.removeEventListener("close", onClose)
          input.sig?.removeEventListener("abort", onAbort)
          input.item.busy = false
        }
        const finish = () => {
          if (closed) return
          closed = true
          stop()
          controller.close()
        }
        const fail = (err: unknown) => {
          if (closed) return
          closed = true
          stop()
          controller.error(err)
        }
        const onAbort = () => {
          drop(input.item, ws)
          ws.close(1000, "abort")
          fail(new DOMException("Aborted", "AbortError"))
        }
        const onError = () => {
          drop(input.item, ws)
          fail(
            apiError({
              body,
              message: "WebSocket request failed",
              retryable: true,
              url: input.url.toString(),
            }),
          )
        }
        const onClose = () => onError()
        const onMessage = (event: MessageEvent<string | ArrayBuffer | Uint8Array>) => {
          const raw = text(event.data)
          controller.enqueue(enc.encode(`data: ${raw}\n\n`))
          const msg = json(raw)
          if (!msg) return
          if (msg.type === "response.completed" || msg.type === "response.incomplete") {
            finish()
            return
          }
          if (msg.type !== "error") return
          const err = msg.error as Record<string, unknown> | undefined
          const code = err?.code
          if (code === "websocket_connection_limit_reached") {
            ws.close(1000, "limit")
          }
          clear(input.item)
          finish()
        }

        ws.addEventListener("message", onMessage)
        ws.addEventListener("error", onError)
        ws.addEventListener("close", onClose)
        input.sig?.addEventListener("abort", onAbort, { once: true })
        ws.send(JSON.stringify(body))
      },
    })
  }

  export function header(sessionID: string) {
    return {
      [HEADER]: sessionID,
    }
  }

  export function prepare(input: {
    modelID: string
    prompt: unknown[]
    providerID: string
    providerOptions: Record<string, unknown>
    sessionID: string
  }) {
    const item = get(input)
    item.next = head(input.prompt)

    if (!item.response) {
      return {
        prompt: input.prompt,
        providerOptions: input.providerOptions,
      }
    }

    const prev = item.prompt ? Hash.fast(JSON.stringify(input.prompt.slice(0, item.prompt.size))) : undefined
    if (item.prompt && (prev !== item.prompt.hash || item.next.size < item.prompt.size)) {
      clear(item)
      return {
        prompt: input.prompt,
        providerOptions: input.providerOptions,
      }
    }

    const next = input.prompt.slice(item.prompt?.size ?? 0)
    if (next.length === 0) {
      clear(item)
      return {
        prompt: input.prompt,
        providerOptions: input.providerOptions,
      }
    }

    const key = Object.keys(input.providerOptions)[0]
    if (!key) {
      return {
        prompt: next,
        providerOptions: input.providerOptions,
      }
    }

    return {
      prompt: next,
      providerOptions: {
        ...input.providerOptions,
        [key]: {
          ...((input.providerOptions[key] as Record<string, unknown> | undefined) ?? {}),
          previousResponseId: item.response,
        },
      },
    }
  }

  export function commit(input: { modelID: string; providerID: string; responseID: string; sessionID: string }) {
    const item = get(input)
    item.response = input.responseID
    item.prompt = item.next
    item.next = undefined
  }

  export function fail(input: { modelID: string; providerID: string; sessionID: string }) {
    clear(get(input))
  }

  export async function fetch(input: {
    init?: BunFetchRequestInit
    next: (input: RequestInfo | URL, init?: BunFetchRequestInit) => Promise<Response>
    providerID: string
    url: RequestInfo | URL
  }) {
    const opts = input.init ?? {}
    const hdr = new Headers(opts.headers)
    const sessionID = hdr.get(HEADER)
    hdr.delete(HEADER)

    if (!sessionID) {
      return input.next(input.url, {
        ...opts,
        headers: hdr,
      })
    }

    const url = new URL(typeof input.url === "string" ? input.url : input.url.toString())
    if (opts.method !== "POST" || !url.pathname.endsWith("/responses") || typeof opts.body !== "string") {
      return input.next(input.url, {
        ...opts,
        headers: hdr,
      })
    }

    const body = json(opts.body)
    if (!body) {
      return input.next(input.url, {
        ...opts,
        headers: hdr,
      })
    }

    const modelID = typeof body.model === "string" ? body.model : "default"
    const item = get({ modelID, providerID: input.providerID, sessionID })
    await warm({ body, hdr, item, sig: opts.signal ?? undefined, url })
    if (typeof body.previous_response_id !== "string" && item.response) {
      body.previous_response_id = item.response
    }
    log.info("request", { modelID, providerID: input.providerID, sessionID, websocket: true })

    return new Response(stream({ body, hdr, item, sig: opts.signal ?? undefined, url }), {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
      },
    })
  }
}
