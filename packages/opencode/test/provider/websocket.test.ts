import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ProviderWebsocket } from "../../src/provider/websocket"
import type { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"
import { tmpdir } from "../fixture/fixture"

type Call = {
  body: Record<string, unknown>
  headers: Record<string, string>
}

const state = {
  calls: [] as Call[],
  server: undefined as ReturnType<typeof Bun.serve> | undefined,
}

function send(ws: Bun.ServerWebSocket<{ headers: Record<string, string> }>, msg: unknown) {
  ws.send(JSON.stringify(msg))
}

beforeAll(() => {
  state.server = Bun.serve({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/responses")) {
        return new Response("not found", { status: 404 })
      }
      const headers = Object.fromEntries(req.headers.entries())
      const ok = server.upgrade(req, { data: { headers } })
      return ok ? undefined : new Response("upgrade failed", { status: 500 })
    },
    websocket: {
      data: {} as { headers: Record<string, string> },
      message(ws, raw) {
        const body = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)) as Record<
          string,
          unknown
        >
        state.calls.push({ body, headers: ws.data.headers })

        const model = typeof body.model === "string" ? body.model : "demo"
        const id = typeof body.previous_response_id === "string" ? "resp-2" : "resp-1"

        send(ws, {
          type: "response.created",
          response: {
            id: body.generate === false ? "warm-1" : id,
            created_at: Math.floor(Date.now() / 1000),
            model,
            service_tier: null,
          },
        })

        if (body.generate === false) {
          send(ws, {
            type: "response.completed",
            response: {
              incomplete_details: null,
              usage: {
                input_tokens: 0,
                input_tokens_details: null,
                output_tokens: 0,
                output_tokens_details: null,
              },
              service_tier: null,
            },
          })
          return
        }

        send(ws, {
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "message",
            id: `item-${id}`,
          },
        })
        send(ws, {
          type: "response.output_text.delta",
          item_id: `item-${id}`,
          delta: id === "resp-1" ? "hello" : "again",
          logprobs: null,
        })
        send(ws, {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "message",
            id: `item-${id}`,
          },
        })
        send(ws, {
          type: "response.completed",
          response: {
            incomplete_details: null,
            usage: {
              input_tokens: 1,
              input_tokens_details: null,
              output_tokens: 1,
              output_tokens_details: null,
            },
            service_tier: null,
          },
        })
      },
    },
  })
})

afterAll(() => {
  state.server?.stop()
})

describe("provider.websocket.prepare", () => {
  test("chains incremental prompts and resets on prefix changes", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const first = ProviderWebsocket.prepare({
          sessionID: "s1",
          providerID: "openai",
          modelID: "gpt-5.2",
          prompt: [{ role: "system" }, { role: "user" }],
          providerOptions: { openai: {} },
        })
        expect(first.prompt).toHaveLength(2)
        expect(first.providerOptions).toEqual({ openai: {} })

        ProviderWebsocket.commit({
          sessionID: "s1",
          providerID: "openai",
          modelID: "gpt-5.2",
          responseID: "resp-1",
        })

        const second = ProviderWebsocket.prepare({
          sessionID: "s1",
          providerID: "openai",
          modelID: "gpt-5.2",
          prompt: [{ role: "system" }, { role: "user" }, { role: "assistant" }, { role: "user" }],
          providerOptions: { openai: {} },
        })
        expect(second.prompt).toHaveLength(2)
        expect(second.providerOptions).toEqual({
          openai: { previousResponseId: "resp-1" },
        })

        const third = ProviderWebsocket.prepare({
          sessionID: "s1",
          providerID: "openai",
          modelID: "gpt-5.2",
          prompt: [{ role: "system" }, { role: "other-user" }],
          providerOptions: { openai: {} },
        })
        expect(third.prompt).toHaveLength(2)
        expect(third.providerOptions).toEqual({ openai: {} })
      },
    })
  })
})

describe("provider.websocket.llm", () => {
  test("warms and uses websocket responses for openai-compatible providers", async () => {
    const server = state.server
    if (!server) throw new Error("Server not initialized")
    state.calls.length = 0

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            enabled_providers: ["local-llm"],
            provider: {
              "local-llm": {
                name: "Local LLM",
                npm: "@ai-sdk/openai-compatible",
                api: `${server.url.origin}/v1`,
                models: {
                  "gpt-5.2": {
                    name: "Demo",
                    reasoning: true,
                    tool_call: true,
                    limit: {
                      context: 128000,
                      output: 4096,
                    },
                  },
                },
                options: {
                  apiKey: "test-key",
                  baseURL: `${server.url.origin}/v1`,
                  setCacheKey: true,
                  websocket: true,
                },
              },
            },
          }),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const model = await Provider.getModel("local-llm", "gpt-5.2")
        const agent = {
          name: "test",
          mode: "primary",
          options: {},
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
          temperature: 0.2,
        } satisfies Agent.Info

        const user = {
          id: "user-1",
          sessionID: "session-ws",
          role: "user",
          time: { created: Date.now() },
          agent: agent.name,
          model: { providerID: "local-llm", modelID: model.id },
        } satisfies MessageV2.User

        const first = await LLM.stream({
          user,
          sessionID: user.sessionID,
          model,
          agent,
          system: ["You are helpful."],
          abort: new AbortController().signal,
          messages: [{ role: "user", content: "hello" }],
          tools: {},
        })

        for await (const _ of first.fullStream) {
        }

        const firstMeta = await first.response
        ProviderWebsocket.commit({
          sessionID: user.sessionID,
          providerID: model.providerID,
          modelID: model.api.id,
          responseID: firstMeta.id,
        })

        const second = await LLM.stream({
          user: {
            ...user,
            id: "user-2",
            time: { created: Date.now() + 1 },
          },
          sessionID: user.sessionID,
          model,
          agent,
          system: ["You are helpful."],
          abort: new AbortController().signal,
          messages: [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hello" },
            { role: "user", content: "again" },
          ],
          tools: {},
        })

        for await (const _ of second.fullStream) {
        }

        expect(state.calls).toHaveLength(3)
        expect(state.calls[0].body.generate).toBe(false)
        expect(state.calls[0].body.input).toEqual([])
        expect(state.calls[0].headers.authorization).toBe("Bearer test-key")
        expect(state.calls[1].body.previous_response_id).toBe("warm-1")
        expect(state.calls[1].body.prompt_cache_key).toBe(user.sessionID)
        expect((state.calls[1].body.reasoning as { effort?: string } | undefined)?.effort).toBe("medium")
        expect(state.calls[2].body.previous_response_id).toBe(firstMeta.id)

        const firstInput = state.calls[1].body.input
        const secondInput = state.calls[2].body.input
        if (!Array.isArray(firstInput) || !Array.isArray(secondInput)) {
          throw new Error("Expected response inputs to be arrays")
        }
        expect(JSON.stringify(firstInput)).toContain("interactive CLI tool")
        expect(JSON.stringify(secondInput)).not.toContain("interactive CLI tool")
        expect(JSON.stringify(secondInput)).toContain("again")
      },
    })
  })
})
