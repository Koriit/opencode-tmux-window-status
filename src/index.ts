import type { Plugin } from "@opencode-ai/plugin"

const ICON_BUSY = "\uF04B"
const ICON_IDLE = "\uE63F"
const ICON_ATTENTION = "\u{F03E4}"
const ICON_FAILURE = "\u{F1238}"
const STRIP_RE = /^[\uF04B\uE63F\u{F03E4}\u{F1238} ]+/u

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
export const TmuxWindowStatusPlugin: Plugin = async ({ $, client }) => {
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
      await log("error", "rename failed", {
        error: String(err),
        stderr: (err as { stderr?: { toString(): string } })?.stderr?.toString?.(),
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
      // `permission.asked` / `question.asked` are emitted at runtime but are not
      // part of the typed plugin `Event` union (it tracks the non-v2 SDK), so
      // match the type string loosely rather than via the typed discriminant.
      const type: string = event.type
      if (type === "permission.asked" || type === "question.asked") {
        rename(ICON_ATTENTION)
        return
      }
      if (event.type === "session.status") {
        if (event.properties.status.type === "busy") rename(ICON_BUSY)
        if (event.properties.status.type === "idle") rename(ICON_IDLE)
        return
      }
      if (event.type === "session.error") {
        rename(ICON_FAILURE)
        return
      }
    },
  }
}

export default TmuxWindowStatusPlugin
