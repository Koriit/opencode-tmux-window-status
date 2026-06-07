import { $ } from "bun"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { server } from "./index"

// Real glyphs, matching the implementation. Asserting against these proves the
// actual tmux window name ends up with the documented icon.
const ICON_BUSY = "\uF04B"
const ICON_IDLE = "\uE63F"
const ICON_ATTENTION = "\u{F03E4}"
const ICON_FAILURE = "\u{F1238}"

const tmuxBin = Bun.which("tmux")

// These tests drive a REAL tmux server on a private socket and assert the real
// window name. If tmux is unavailable (e.g. minimal CI image), skip rather than
// fail — the unit suite already covers the logic.
//
// NOTE: this suite mutates the shared global `process.env`; it relies on Bun's
// default serial execution of tests within a file.
const d = tmuxBin ? describe : describe.skip

/** A throwaway tmux server bound to a private socket in a temp dir. */
class TmuxSandbox {
  readonly socket: string
  private readonly dir: string

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "tmux-e2e-"))
    this.socket = join(this.dir, "srv.sock")
  }

  /** tmux invocation bound to this sandbox's socket. */
  private t(...args: string[]) {
    return $`${tmuxBin} -S ${this.socket} ${args}`.quiet()
  }

  async start(windowName: string) {
    // Detached session with a single window we can rename. A short-lived idle
    // command keeps the window alive without leaving a long orphan if teardown
    // is ever skipped (e.g. runner SIGKILL): the window persists via
    // remain-on-exit, but the process itself exits quickly.
    await this.t("new-session", "-d", "-s", "e2e", "-n", windowName, "sleep", "30")
    const pane = await this.pane()
    // Disable automatic-rename so our explicit rename sticks. (Production does
    // not manage automatic-rename; the README documents restoring it via a
    // shell wrapper. This test deliberately sidesteps it.)
    await this.t("set-window-option", "-t", pane, "automatic-rename", "off")
  }

  /** The pane id of the first window (e.g. "%0"). */
  async pane(): Promise<string> {
    const out = await this.t("list-panes", "-t", "e2e", "-F", "#{pane_id}")
    return out.stdout.toString().trim().split("\n")[0]!
  }

  async windowName(): Promise<string> {
    const pane = await this.pane()
    const out = await this.t("display-message", "-t", pane, "-p", "#{window_name}")
    return out.stdout.toString().trim()
  }

  async killSession() {
    await this.t("kill-session", "-t", "e2e")
  }

  async stop() {
    try {
      await this.t("kill-server")
    } catch {
      // server may already be gone
    }
    rmSync(this.dir, { recursive: true, force: true })
  }
}

/**
 * Build the real plugin input. We use the REAL Bun `$` so tmux is actually
 * exec'd. `client.app.log` is a no-op recorder.
 */
function realInput(over: Record<string, unknown> = {}) {
  return {
    $,
    client: { app: { log: async () => ({ data: undefined }) } },
    project: {},
    directory: "/tmp",
    worktree: "/tmp",
    serverUrl: new URL("http://localhost"),
    experimental_workspace: { register: () => {} },
    ...over,
  } as never
}

/**
 * Poll until `read()` returns `expected` (or until timeout). Replaces a fixed
 * sleep so real subprocess latency on loaded runners can't cause flakes.
 */
async function waitFor(read: () => Promise<string>, expected: string, timeoutMs = 3000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    last = await read()
    if (last === expected) return last
    await new Promise((r) => setTimeout(r, 10))
  }
  return last
}

/** Settle the async rename worker, then return the current window name. */
async function settledName(sandbox: TmuxSandbox, expected: string) {
  return waitFor(() => sandbox.windowName(), expected)
}

const ORIGINAL_ENV = { ...process.env }

function clearTmuxEnv() {
  delete process.env.TMUX
  delete process.env.TMUX_PANE
  delete process.env.REMOTE_TMUX
  delete process.env.REMOTE_PANE
}

d("e2e: real tmux window renaming", () => {
  let sandbox: TmuxSandbox

  beforeAll(() => {
    clearTmuxEnv()
  })

  afterAll(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  beforeEach(async () => {
    clearTmuxEnv()
    sandbox = new TmuxSandbox()
    await sandbox.start("work")
    process.env.TMUX = `${sandbox.socket},0,0`
    process.env.TMUX_PANE = await sandbox.pane()
  })

  afterEach(async () => {
    clearTmuxEnv()
    await sandbox.stop()
  })

  test("busy event prefixes the real window with the busy icon", async () => {
    const hooks = await server(realInput())
    await hooks.event!({ event: { type: "session.status", properties: { status: { type: "busy" } } } as never })
    expect(await settledName(sandbox, `${ICON_BUSY} work`)).toBe(`${ICON_BUSY} work`)
  })

  test("idle event prefixes the real window with the idle icon", async () => {
    const hooks = await server(realInput())
    await hooks.event!({ event: { type: "session.status", properties: { status: { type: "idle" } } } as never })
    expect(await settledName(sandbox, `${ICON_IDLE} work`)).toBe(`${ICON_IDLE} work`)
  })

  test("retry event prefixes the real window with the busy icon", async () => {
    const hooks = await server(realInput())
    await hooks.event!({
      event: {
        type: "session.status",
        properties: { status: { type: "retry", attempt: 1, message: "backoff", next: 0 } },
      } as never,
    })
    expect(await settledName(sandbox, `${ICON_BUSY} work`)).toBe(`${ICON_BUSY} work`)
  })

  test("permission.asked event prefixes the real window with the attention icon", async () => {
    const hooks = await server(realInput())
    await hooks.event!({ event: { type: "permission.asked", properties: {} } as never })
    expect(await settledName(sandbox, `${ICON_ATTENTION} work`)).toBe(`${ICON_ATTENTION} work`)
  })

  test("session.error event prefixes the real window with the failure icon", async () => {
    const hooks = await server(realInput())
    await hooks.event!({ event: { type: "session.error", properties: {} } as never })
    expect(await settledName(sandbox, `${ICON_FAILURE} work`)).toBe(`${ICON_FAILURE} work`)
  })

  test("a second event replaces the previous icon (no stacking) on the real window", async () => {
    const hooks = await server(realInput())
    await hooks.event!({ event: { type: "session.status", properties: { status: { type: "busy" } } } as never })
    expect(await settledName(sandbox, `${ICON_BUSY} work`)).toBe(`${ICON_BUSY} work`)

    await hooks.event!({ event: { type: "session.error", properties: {} } as never })
    expect(await settledName(sandbox, `${ICON_FAILURE} work`)).toBe(`${ICON_FAILURE} work`)
  })

  test("strips a pre-existing icon set outside the plugin, preserving the base name", async () => {
    // Simulate a window that already had an icon + a multi-word base name.
    const pane = await sandbox.pane()
    await $`${tmuxBin} -S ${sandbox.socket} rename-window -t ${pane} ${`${ICON_BUSY} my editor`}`.quiet()

    const hooks = await server(realInput())
    await hooks.event!({ event: { type: "session.status", properties: { status: { type: "idle" } } } as never })
    expect(await settledName(sandbox, `${ICON_IDLE} my editor`)).toBe(`${ICON_IDLE} my editor`)
  })

  test("handles window names with spaces", async () => {
    await sandbox.stop()
    sandbox = new TmuxSandbox()
    await sandbox.start("my project")
    process.env.TMUX = `${sandbox.socket},0,0`
    process.env.TMUX_PANE = await sandbox.pane()

    const hooks = await server(realInput())
    await hooks.event!({ event: { type: "session.status", properties: { status: { type: "busy" } } } as never })
    expect(await settledName(sandbox, `${ICON_BUSY} my project`)).toBe(`${ICON_BUSY} my project`)
  })

  test("rapid events coalesce to the final icon on the real window", async () => {
    const hooks = await server(realInput())
    hooks.event!({ event: { type: "session.status", properties: { status: { type: "busy" } } } as never })
    hooks.event!({ event: { type: "permission.asked", properties: {} } as never })
    hooks.event!({ event: { type: "session.status", properties: { status: { type: "idle" } } } as never })
    expect(await settledName(sandbox, `${ICON_IDLE} work`)).toBe(`${ICON_IDLE} work`)
  })

  test("does not throw when the target pane no longer exists", async () => {
    const hooks = await server(realInput())
    await sandbox.killSession() // pane is gone before the event fires
    // Should swallow the tmux failure and not reject.
    await hooks.event!({ event: { type: "session.error", properties: {} } as never })
    await new Promise((r) => setTimeout(r, 100))
    // No assertion on window name (it's gone); the point is no throw above.
    expect(true).toBe(true)
  })

  test("targets the env-provided socket only, leaving other servers untouched", async () => {
    // Second, independent sandbox. The plugin must rename ONLY the server named
    // by the TMUX env var, proving the bare `tmux` follows the injected socket
    // rather than some ambient/other server.
    const other = new TmuxSandbox()
    try {
      await other.start("other")
      // TMUX still points at `sandbox` (set in beforeEach).
      const hooks = await server(realInput())
      await hooks.event!({ event: { type: "session.status", properties: { status: { type: "busy" } } } as never })
      expect(await settledName(sandbox, `${ICON_BUSY} work`)).toBe(`${ICON_BUSY} work`)
      // The other server's window must be completely untouched.
      expect(await other.windowName()).toBe("other")
    } finally {
      await other.stop()
    }
  })

  test("works through the REMOTE_TMUX / REMOTE_PANE fallback (TMUX unset)", async () => {
    const pane = process.env.TMUX_PANE!
    delete process.env.TMUX
    delete process.env.TMUX_PANE
    process.env.REMOTE_TMUX = `${sandbox.socket},0,0`
    process.env.REMOTE_PANE = pane

    const hooks = await server(realInput())
    await hooks.event!({ event: { type: "session.status", properties: { status: { type: "busy" } } } as never })
    expect(await settledName(sandbox, `${ICON_BUSY} work`)).toBe(`${ICON_BUSY} work`)
  })
})
