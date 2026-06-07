import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import type { Event as EventV2 } from "@opencode-ai/sdk/v2"

type ShellError = Bun.$.ShellError

const ICON_BUSY = "\uF04B"
const ICON_IDLE = "\uE63F"
const ICON_ATTENTION = "\u{F03E4}"
const ICON_FAILURE = "\u{F1238}"

// Leading run of any status icon (plus surrounding spaces) we may have applied
// previously. Derived from the icon constants so the strip set can never drift
// from the icons themselves. The codepoints are Private-Use-Area glyphs with no
// regex-metacharacter meaning, so a plain join is safe inside the class.
const ICONS = [ICON_BUSY, ICON_IDLE, ICON_ATTENTION, ICON_FAILURE] as const
const STRIP_RE = new RegExp(`^[${ICONS.join("")} ]+`, "u")

/** Narrow an unknown thrown value to Bun's shell error shape, if it is one. */
function asShellError(err: unknown): ShellError | undefined {
  return err instanceof Error && "exitCode" in err ? (err as ShellError) : undefined
}

export const PLUGIN_ID = "opencode-tmux-window-status"

/**
 * Renames the current tmux window with a status icon that reflects the
 * opencode session state:
 *
 * - busy / working
 * - idle / waiting for the next prompt
 * - waiting for a permission or question (needs attention)
 * - errored
 *
 * The window is only touched when running inside tmux. Honors `REMOTE_TMUX` /
 * `REMOTE_PANE` so it also works for forwarded/remote tmux setups.
 *
 * Restoring the original window name on exit is intentionally NOT handled here:
 * opencode hard-terminates the plugin worker on quit, so a dispose/exit hook
 * cannot reliably run. Restore the name from a shell wrapper around `opencode`
 * instead (see README).
 */
export const server: Plugin = async ({ $, client }) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    client.app.log({ body: { service: "tmux-window-status", level, message, extra } })

  const effectiveTmux = process.env.TMUX || process.env.REMOTE_TMUX
  const effectivePane = process.env.TMUX_PANE || process.env.REMOTE_PANE

  await log("info", "plugin init", { effectiveTmux, effectivePane })

  if (!effectiveTmux || !effectivePane) return {}

  const tmux = (...args: string[]) => $`tmux ${args}`.env({ ...process.env, TMUX: effectiveTmux }).quiet()

  const apply = async (icon: string) => {
    try {
      const out = await tmux("display-message", "-t", effectivePane, "-p", "#{window_name}")
      const base = out.stdout.toString().trim().replace(STRIP_RE, "").trim()
      await tmux("rename-window", "-t", effectivePane, icon + " " + base)
    } catch (err) {
      const shellErr = asShellError(err)
      await log("error", "rename failed", {
        error: String(err),
        stderr: shellErr?.stderr?.toString(),
        exitCode: shellErr?.exitCode,
      })
    }
  }

  // opencode invokes the event hook fire-and-forget (it does not await the
  // returned promise), so multiple async renames can run concurrently and
  // finish out of order, leaving a stale icon. Serialize through a single
  // worker that always applies the LATEST requested icon, coalescing
  // intermediate requests.
  let pending: string | null = null
  let running = false

  const rename = (icon: string) => {
    pending = icon
    if (running) return
    running = true
    queueMicrotask(async () => {
      while (pending !== null) {
        const next = pending
        pending = null
        await apply(next)
      }
      running = false
    })
  }

  return {
    event: async ({ event }) => {
      // The plugin `Hooks.event` type is still wired to the v1 SDK `Event`
      // union, which lacks `permission.asked` / `question.asked` (it only has
      // `permission.updated`). The runtime actually emits the v2 events, so we
      // re-type the event against the v2 union at this single boundary and then
      // discriminate with full type-safety below.
      const e = event as unknown as EventV2
      switch (e.type) {
        case "permission.asked":
        case "question.asked":
          rename(ICON_ATTENTION)
          return
        case "session.status":
          switch (e.properties.status.type) {
            case "busy":
            // `retry` is a transient backoff while still working on the turn;
            // keep showing the busy icon rather than reverting to idle.
            case "retry":
              rename(ICON_BUSY)
              return
            case "idle":
              rename(ICON_IDLE)
              return
          }
          return
        case "session.error":
          rename(ICON_FAILURE)
          return
      }
    },
  }
}

const plugin: PluginModule = { id: PLUGIN_ID, server }
export default plugin
