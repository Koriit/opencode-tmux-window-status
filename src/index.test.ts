import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

import plugin, { PLUGIN_ID, server } from "./index"

// Icons mirrored from the implementation. Kept as literal codepoints here so a
// test fails loudly if the implementation silently changes a glyph (the test
// copy will not change with it).
const ICON_BUSY = "\uF04B"
const ICON_IDLE = "\uE63F"
const ICON_ATTENTION = "\u{F03E4}"
const ICON_FAILURE = "\u{F1238}"

/** The log service tag the plugin uses (distinct from PLUGIN_ID). */
const LOG_SERVICE = "tmux-window-status"

/** A single recorded `tmux` invocation. */
type TmuxCall = {
  /** argv passed to the shell, e.g. ["tmux", "rename-window", ...]. */
  argv: string[]
  /** The env object passed to `.env(...)`, if any (used to verify TMUX override). */
  env?: Record<string, string | undefined>
}

/**
 * Build a fake Bun `$` shell that records every `tmux ...` invocation (argv and
 * the env passed via `.env()`) and returns a configurable `#{window_name}` for
 * `display-message`.
 *
 * Fidelity notes:
 * - The real plugin calls `$\`tmux ${args}\`.env(env).quiet()` then awaits.
 *   Bun joins an interpolated array expression with spaces, so argv is
 *   "tmux" + the interpolated string[] args.
 * - A call is recorded only when the chain is actually awaited (first
 *   then/catch), so the recording reflects real execution, not chain
 *   construction.
 */
function makeShell(opts: { windowName?: string; failOn?: (argv: string[]) => boolean } = {}) {
  const calls: TmuxCall[] = []
  let windowName = opts.windowName ?? "shell"

  const $ = ((_strings: TemplateStringsArray, ...exprs: unknown[]) => {
    const args = (exprs[0] as string[]) ?? []
    const argv = ["tmux", ...args]
    let capturedEnv: Record<string, string | undefined> | undefined
    let recorded = false

    const run = () => {
      if (!recorded) {
        recorded = true
        calls.push({ argv, env: capturedEnv })
      }
      const shouldFail = opts.failOn?.(argv) ?? false
      const result = {
        stdout: Buffer.from(argv.includes("display-message") ? windowName : ""),
        stderr: Buffer.from(shouldFail ? "tmux error" : ""),
        exitCode: shouldFail ? 1 : 0,
      }
      if (shouldFail) return Promise.reject(Object.assign(new Error("tmux failed"), result))
      return Promise.resolve(result)
    }

    // A thenable that defers execution until awaited, with chainable methods
    // mirroring the subset of BunShellPromise the plugin uses.
    const makeThenable = (): unknown => ({
      env: (newEnv: Record<string, string | undefined>) => {
        capturedEnv = newEnv
        return makeThenable()
      },
      quiet: () => makeThenable(),
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        run().then(onFulfilled, onRejected),
      catch: (onRejected: (e: unknown) => unknown) => run().catch(onRejected),
    })

    return makeThenable()
  }) as unknown as PluginInput["$"]

  return {
    $,
    calls,
    renameCalls: () => calls.filter((c) => c.argv[1] === "rename-window"),
    displayCalls: () => calls.filter((c) => c.argv[1] === "display-message"),
    lastRenameName: () => calls.filter((c) => c.argv[1] === "rename-window").at(-1)?.argv.at(-1),
    /** The env object passed to the most recent recorded tmux call. */
    lastEnv: () => calls.at(-1)?.env,
    setWindowName: (name: string) => {
      windowName = name
    },
  }
}

function makeClient() {
  const logs: Array<Record<string, unknown>> = []
  const client = {
    app: {
      log: mock(async (arg: { body: Record<string, unknown> }) => {
        logs.push(arg.body)
        return { data: undefined }
      }),
    },
  } as unknown as PluginInput["client"]
  return { client, logs }
}

function makeInput(over: Partial<PluginInput> = {}): PluginInput {
  const shell = makeShell()
  const { client } = makeClient()
  return {
    $: shell.$,
    client,
    project: {} as PluginInput["project"],
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://localhost"),
    experimental_workspace: { register: () => {} },
    ...over,
  } as PluginInput
}

/**
 * Drain the serialized rename worker deterministically: keep yielding to the
 * event loop until the recorded-call count stops changing (the worker has
 * quiesced). Avoids coupling to a magic fixed delay.
 */
async function settle(shell: { calls: unknown[] }) {
  let prev = -1
  // Bounded loop guards against an infinite spin if something is wrong.
  for (let i = 0; i < 100 && shell.calls.length !== prev; i++) {
    prev = shell.calls.length
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
  }
}

const ORIGINAL_ENV = { ...process.env }

function clearTmuxEnv() {
  delete process.env.TMUX
  delete process.env.TMUX_PANE
  delete process.env.REMOTE_TMUX
  delete process.env.REMOTE_PANE
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV }
  clearTmuxEnv()
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe("module shape", () => {
  test("default export is a PluginModule with id and server", () => {
    expect(plugin.id).toBe(PLUGIN_ID)
    expect(plugin.server).toBe(server)
    expect(typeof server).toBe("function")
  })

  test("PLUGIN_ID is the published plugin identifier", () => {
    expect(PLUGIN_ID).toBe("opencode-tmux-window-status")
  })

  test("does not register a dispose hook (restore-on-exit is intentionally omitted)", async () => {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%1"
    const hooks = await server(makeInput())
    expect(hooks.dispose).toBeUndefined()
  })
})

describe("tmux gating", () => {
  test("returns no hooks when neither TMUX nor REMOTE_TMUX is set", async () => {
    const hooks = await server(makeInput())
    expect(hooks.event).toBeUndefined()
    expect(Object.keys(hooks)).toHaveLength(0)
  })

  test("returns no hooks when pane is missing", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,123,0"
    const hooks = await server(makeInput())
    expect(hooks.event).toBeUndefined()
  })

  test("still logs init even when gating fails (outside tmux)", async () => {
    const { client, logs } = makeClient()
    const hooks = await server(makeInput({ client }))
    expect(hooks.event).toBeUndefined()
    expect(logs.find((l) => l.message === "plugin init")).toBeDefined()
  })

  test("registers event hook when TMUX and TMUX_PANE are set", async () => {
    process.env.TMUX = "/tmp/tmux-1000/default,123,0"
    process.env.TMUX_PANE = "%1"
    const hooks = await server(makeInput())
    expect(typeof hooks.event).toBe("function")
  })

  test("falls back to REMOTE_TMUX / REMOTE_PANE", async () => {
    process.env.REMOTE_TMUX = "/tmp/remote.sock,123,0"
    process.env.REMOTE_PANE = "%9"
    const hooks = await server(makeInput())
    expect(typeof hooks.event).toBe("function")
  })

  test("logs init with the effective tmux/pane it resolved", async () => {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%2"
    const { client, logs } = makeClient()
    await server(makeInput({ client }))
    const init = logs.find((l) => l.message === "plugin init")
    expect(init).toBeDefined()
    expect((init!.extra as Record<string, unknown>).effectiveTmux).toBe("/tmp/sock,1,0")
    expect((init!.extra as Record<string, unknown>).effectivePane).toBe("%2")
  })
})

describe("env precedence", () => {
  async function resolved(envSetup: Record<string, string>) {
    Object.assign(process.env, envSetup)
    const { client, logs } = makeClient()
    await server(makeInput({ client }))
    const init = logs.find((l) => l.message === "plugin init")!.extra as Record<string, unknown>
    return { effectiveTmux: init.effectiveTmux, effectivePane: init.effectivePane }
  }

  test("TMUX takes precedence over REMOTE_TMUX when both are set", async () => {
    const r = await resolved({
      TMUX: "/local.sock,1,0",
      TMUX_PANE: "%local",
      REMOTE_TMUX: "/remote.sock,9,0",
      REMOTE_PANE: "%remote",
    })
    expect(r.effectiveTmux).toBe("/local.sock,1,0")
    expect(r.effectivePane).toBe("%local")
  })

  test("resolves tmux and pane independently (TMUX + REMOTE_PANE)", async () => {
    const r = await resolved({ TMUX: "/local.sock,1,0", REMOTE_PANE: "%remote" })
    expect(r.effectiveTmux).toBe("/local.sock,1,0")
    expect(r.effectivePane).toBe("%remote")
  })
})

describe("event → icon mapping", () => {
  async function dispatch(event: unknown, windowName = "shell") {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%1"
    const shell = makeShell({ windowName })
    const { client } = makeClient()
    const hooks = await server(makeInput({ $: shell.$, client }))
    await hooks.event!({ event: event as never })
    await settle(shell)
    return shell
  }

  test("session.status busy → busy icon", async () => {
    const shell = await dispatch({ type: "session.status", properties: { status: { type: "busy" } } })
    expect(shell.lastRenameName()).toBe(`${ICON_BUSY} shell`)
  })

  test("session.status idle → idle icon", async () => {
    const shell = await dispatch({ type: "session.status", properties: { status: { type: "idle" } } })
    expect(shell.lastRenameName()).toBe(`${ICON_IDLE} shell`)
  })

  test("session.status retry → busy icon (still working)", async () => {
    const shell = await dispatch({
      type: "session.status",
      properties: { status: { type: "retry", attempt: 1, message: "backoff", next: 0 } },
    })
    expect(shell.lastRenameName()).toBe(`${ICON_BUSY} shell`)
  })

  test("session.error → failure icon", async () => {
    const shell = await dispatch({ type: "session.error", properties: {} })
    expect(shell.lastRenameName()).toBe(`${ICON_FAILURE} shell`)
  })

  test("permission.asked → attention icon", async () => {
    const shell = await dispatch({ type: "permission.asked", properties: {} })
    expect(shell.lastRenameName()).toBe(`${ICON_ATTENTION} shell`)
  })

  test("question.asked → attention icon", async () => {
    const shell = await dispatch({ type: "question.asked", properties: {} })
    expect(shell.lastRenameName()).toBe(`${ICON_ATTENTION} shell`)
  })

  test("unknown session.status type does not rename", async () => {
    const shell = await dispatch({ type: "session.status", properties: { status: { type: "weird" } } })
    expect(shell.renameCalls()).toHaveLength(0)
  })

  test("session.idle (distinct from session.status idle) is ignored", async () => {
    const shell = await dispatch({ type: "session.idle", properties: {} })
    expect(shell.calls).toHaveLength(0)
  })

  test("permission.updated (v1 event) is ignored", async () => {
    const shell = await dispatch({ type: "permission.updated", properties: {} })
    expect(shell.calls).toHaveLength(0)
  })

  test("unrelated event type is ignored (no tmux calls)", async () => {
    const shell = await dispatch({ type: "message.updated", properties: {} })
    expect(shell.calls).toHaveLength(0)
  })

  test("targets the resolved pane with -t", async () => {
    const shell = await dispatch({ type: "session.error", properties: {} })
    const rename = shell.renameCalls().at(-1)!.argv
    expect(rename).toContain("-t")
    expect(rename[rename.indexOf("-t") + 1]).toBe("%1")
  })

  test("reads the window name before renaming (read-then-write)", async () => {
    const shell = await dispatch({ type: "session.error", properties: {} })
    expect(shell.displayCalls()).toHaveLength(1)
    expect(shell.renameCalls()).toHaveLength(1)
    // display-message must be recorded before rename-window.
    const displayIdx = shell.calls.findIndex((c) => c.argv[1] === "display-message")
    const renameIdx = shell.calls.findIndex((c) => c.argv[1] === "rename-window")
    expect(displayIdx).toBeLessThan(renameIdx)
  })
})

describe("TMUX env override (remote/forwarded support)", () => {
  test("injects effective TMUX socket into the tmux child env (local)", async () => {
    process.env.TMUX = "/local.sock,1,0"
    process.env.TMUX_PANE = "%1"
    const shell = makeShell({ windowName: "shell" })
    const hooks = await server(makeInput({ $: shell.$ }))
    await hooks.event!({ event: { type: "session.error", properties: {} } as never })
    await settle(shell)
    expect(shell.lastEnv()?.TMUX).toBe("/local.sock,1,0")
  })

  test("injects REMOTE_TMUX socket as TMUX when only the remote fallback is set", async () => {
    process.env.REMOTE_TMUX = "/remote.sock,9,0"
    process.env.REMOTE_PANE = "%remote"
    const shell = makeShell({ windowName: "shell" })
    const hooks = await server(makeInput({ $: shell.$ }))
    await hooks.event!({ event: { type: "session.status", properties: { status: { type: "busy" } } } as never })
    await settle(shell)
    // The bare `tmux` invocation must be pointed at the REMOTE socket via env.
    expect(shell.lastEnv()?.TMUX).toBe("/remote.sock,9,0")
    // And the pane target must be the remote pane.
    const rename = shell.renameCalls().at(-1)!.argv
    expect(rename[rename.indexOf("-t") + 1]).toBe("%remote")
  })
})

describe("icon stripping (no stacking)", () => {
  async function renameWith(windowName: string, event: unknown) {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%1"
    const shell = makeShell({ windowName })
    const hooks = await server(makeInput({ $: shell.$ }))
    await hooks.event!({ event: event as never })
    await settle(shell)
    return shell
  }

  const idle = { type: "session.status", properties: { status: { type: "idle" } } }
  const fail = { type: "session.error", properties: {} }

  test("strips an existing leading icon before applying the new one", async () => {
    const shell = await renameWith(`${ICON_BUSY} editor`, idle)
    expect(shell.lastRenameName()).toBe(`${ICON_IDLE} editor`)
  })

  test("strips multiple stacked icons and surrounding spaces", async () => {
    const shell = await renameWith(`${ICON_BUSY}${ICON_IDLE}  editor`, fail)
    expect(shell.lastRenameName()).toBe(`${ICON_FAILURE} editor`)
  })

  test("strips astral-plane icons (attention/failure) using the u flag", async () => {
    const shell = await renameWith(`${ICON_FAILURE} editor`, idle)
    expect(shell.lastRenameName()).toBe(`${ICON_IDLE} editor`)
  })

  test("strips an attention icon prefix too", async () => {
    const shell = await renameWith(`${ICON_ATTENTION} editor`, fail)
    expect(shell.lastRenameName()).toBe(`${ICON_FAILURE} editor`)
  })

  test("strips leading spaces before an icon", async () => {
    const shell = await renameWith(`  ${ICON_BUSY} editor`, idle)
    expect(shell.lastRenameName()).toBe(`${ICON_IDLE} editor`)
  })

  test("leaves a plain window name (no icon) intact except for new prefix", async () => {
    const shell = await renameWith("my-window", {
      type: "session.status",
      properties: { status: { type: "busy" } },
    })
    expect(shell.lastRenameName()).toBe(`${ICON_BUSY} my-window`)
  })

  test("does not strip an icon that appears later in the name", async () => {
    const shell = await renameWith(`run ${ICON_BUSY} thing`, idle)
    expect(shell.lastRenameName()).toBe(`${ICON_IDLE} run ${ICON_BUSY} thing`)
  })

  test("a window name that is only an icon collapses to just the new icon", async () => {
    const shell = await renameWith(`${ICON_BUSY}`, idle)
    expect(shell.lastRenameName()).toBe(`${ICON_IDLE} `)
  })

  test("an empty window name yields the icon with a trailing space", async () => {
    const shell = await renameWith("", fail)
    expect(shell.lastRenameName()).toBe(`${ICON_FAILURE} `)
  })
})

describe("serialization / coalescing", () => {
  test("rapid events coalesce to the LAST requested icon", async () => {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%1"
    const shell = makeShell({ windowName: "shell" })
    const hooks = await server(makeInput({ $: shell.$ }))

    // Fire several events synchronously without awaiting each.
    hooks.event!({ event: { type: "session.status", properties: { status: { type: "busy" } } } as never })
    hooks.event!({ event: { type: "permission.asked", properties: {} } as never })
    hooks.event!({ event: { type: "session.status", properties: { status: { type: "idle" } } } as never })
    await settle(shell)

    // The final visible icon must be the last requested one (idle).
    expect(shell.lastRenameName()).toBe(`${ICON_IDLE} shell`)
  })

  test("a burst fired synchronously coalesces to a single applied rename", async () => {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%1"
    const shell = makeShell({ windowName: "shell" })
    const hooks = await server(makeInput({ $: shell.$ }))

    // Ten events fired in the same synchronous tick: the worker starts on the
    // first and coalesces the rest, so exactly one rename should reach tmux.
    for (let i = 0; i < 10; i++) {
      hooks.event!({
        event: { type: "session.status", properties: { status: { type: i % 2 === 0 ? "busy" : "idle" } } } as never,
      })
    }
    await settle(shell)

    expect(shell.renameCalls()).toHaveLength(1)
    // i=9 is idle, the last requested.
    expect(shell.lastRenameName()).toBe(`${ICON_IDLE} shell`)
  })
})

describe("error handling", () => {
  test("logs error with captured stderr/exitCode when display-message fails", async () => {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%1"
    const shell = makeShell({ windowName: "shell", failOn: (argv) => argv.includes("display-message") })
    const { client, logs } = makeClient()
    const hooks = await server(makeInput({ $: shell.$, client }))

    await hooks.event!({ event: { type: "session.error", properties: {} } as never })
    await settle(shell)

    const err = logs.find((l) => l.level === "error" && l.message === "rename failed")
    expect(err).toBeDefined()
    const extra = err!.extra as Record<string, unknown>
    expect(extra.stderr).toBe("tmux error")
    expect(extra.exitCode).toBe(1)
  })

  test("logs error and does not throw when rename-window itself fails", async () => {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%1"
    const shell = makeShell({ windowName: "shell", failOn: (argv) => argv.includes("rename-window") })
    const { client, logs } = makeClient()
    const hooks = await server(makeInput({ $: shell.$, client }))

    await hooks.event!({ event: { type: "session.error", properties: {} } as never })
    await settle(shell)

    // display-message succeeded; the failure is on the rename itself.
    expect(shell.displayCalls()).toHaveLength(1)
    const err = logs.find((l) => l.level === "error" && l.message === "rename failed")
    expect(err).toBeDefined()
    expect((err!.extra as Record<string, unknown>).stderr).toBe("tmux error")
  })

  test("logs use the documented service tag", async () => {
    process.env.TMUX = "/tmp/sock,1,0"
    process.env.TMUX_PANE = "%1"
    const { client, logs } = makeClient()
    await server(makeInput({ client }))
    expect(logs.every((l) => l.service === LOG_SERVICE)).toBe(true)
  })
})
