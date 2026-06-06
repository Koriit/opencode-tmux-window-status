# opencode-tmux-window-status

An [OpenCode](https://opencode.ai) plugin that renames the current tmux window
with a status icon reflecting the session state, so you can see at a glance
which pane needs your attention.

## What it does

While opencode runs inside a tmux pane, the window name is prefixed with an
icon that tracks the session state:

| State | Trigger | Icon (Nerd Font) |
| --- | --- | --- |
| Busy / working | `session.status` → `busy` | `\uF04B` () |
| Idle / waiting for prompt | `session.status` → `idle` | `\uE63F` () |
| Needs attention | `permission.asked` / `question.asked` | `\u{F03E4}` (󰏤) |
| Errored | `session.error` | `\u{F1238}` (󱈸) |

The icons are [Nerd Font](https://www.nerdfonts.com/) glyphs; use a Nerd Font
in your terminal to render them.

Outside tmux the plugin is a no-op. It honors `REMOTE_TMUX` / `REMOTE_PANE` in
addition to `TMUX` / `TMUX_PANE`, so it works with forwarded/remote tmux
sessions.

## Install

Add the package to your opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@koriit/opencode-tmux-window-status"]
}
```

opencode installs npm plugins automatically at startup.

## Restoring the window name on exit

This plugin deliberately does **not** restore the original window name when
opencode quits. opencode hard-terminates the plugin worker on exit, so a
`dispose` or process-exit hook cannot run reliably.

Restore the name from a shell wrapper around `opencode` instead. The wrapper
runs after opencode fully exits, in the same pane, so it is guaranteed to fire.
It also preserves a manually-set window name and the original `automatic-rename`
setting.

### zsh / bash

```sh
opencode() {
  if [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
    local _oc_name _oc_auto
    _oc_name="$(tmux display-message -t "$TMUX_PANE" -p '#{window_name}' 2>/dev/null)"
    _oc_auto="$(tmux show-window-options -t "$TMUX_PANE" automatic-rename 2>/dev/null | awk '{print $2}')"
  fi

  command opencode "$@"
  local ret=$?

  if [ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ]; then
    tmux rename-window -t "$TMUX_PANE" "$_oc_name" 2>/dev/null
    if [ -n "$_oc_auto" ]; then
      tmux set-window-option -t "$TMUX_PANE" automatic-rename "$_oc_auto" 2>/dev/null
    else
      tmux set-window-option -t "$TMUX_PANE" -u automatic-rename 2>/dev/null
    fi
  fi

  return $ret
}
```

## How it works

The plugin listens to the opencode `event` hook and maps session events to
window renames. Renames are serialized through a single worker that always
applies the latest requested icon: opencode invokes the event hook
fire-and-forget, so without serialization concurrent renames could finish out
of order and leave a stale icon.

Diagnostics are logged via `client.app.log` under the `tmux-window-status`
service tag; view them with `opencode --print-logs`.

## License

MIT
