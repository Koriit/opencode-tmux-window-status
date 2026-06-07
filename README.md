# opencode-tmux-window-status

An [OpenCode](https://opencode.ai) plugin that renames the current tmux window
with a status icon reflecting the session state, so you can see at a glance
which pane needs your attention.

## What it does

While opencode runs inside a tmux pane, the window name is prefixed with an
icon that tracks the session state:

| State                     | Trigger                               | Icon (Nerd Font) |
| ------------------------- | ------------------------------------- | ---------------- |
| Busy / working            | `session.status` → `busy`             | `\uF04B` ()      |
| Idle / waiting for prompt | `session.status` → `idle`             | `\uE63F` ()      |
| Needs attention           | `permission.asked` / `question.asked` | `\u{F03E4}` (󰏤)  |
| Errored                   | `session.error`                       | `\u{F1238}` (󱈸)  |

The icons are [Nerd Font](https://www.nerdfonts.com/) glyphs; use a Nerd Font
in your terminal to render them.

Outside tmux the plugin is a no-op. It also honors `REMOTE_TMUX` / `REMOTE_PANE`
for controlling a forwarded local tmux server from a remote host (see
[Remote / forwarded tmux](#remote--forwarded-tmux)).

## Install

Add the package to your opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@koriit/opencode-tmux-window-status"]
}
```

opencode installs npm plugins automatically at startup.

## tmux configuration

The plugin works out of the box, but a couple of optional tmux settings make
the status icons more useful.

### Surface the icon in the terminal title

If you also set the terminal title from tmux (`set-titles on`), you can prepend
the status icon to the title so it shows up in your terminal tab / taskbar even
when the tmux window is not focused. The expression below prefixes the title
with the leading status icon (if the window name starts with one) and otherwise
leaves the title unchanged:

```tmux
set -g set-titles on
set -g set-titles-string "#{?#{m/r:^[\ue63f\uf04b󰏤󱈸],#{window_name}},#{=1:window_name} ,}tx/#{session_name}"
```

The character class `[\ue63f\uf04b󰏤󱈸]` matches the four status glyphs used by
this plugin (idle, busy, attention, error).

### Faster status refresh

tmux re-derives the window name on its status interval. If you want the icon to
appear/clear more promptly, lower the interval:

```tmux
set -g status-interval 1
```

## Remote / forwarded tmux

When opencode runs on a remote host (over SSH, inside a Lima/VM, a container,
etc.) there is no local `TMUX` to control. To still drive your **local** tmux
window from the remote opencode, the plugin reads `REMOTE_TMUX` / `REMOTE_PANE`
as a fallback for `TMUX` / `TMUX_PANE`:

| Variable      | Used for                                         |
| ------------- | ------------------------------------------------ |
| `REMOTE_TMUX` | tmux socket (set as `TMUX` when invoking `tmux`) |
| `REMOTE_PANE` | target pane (`tmux ... -t "$REMOTE_PANE"`)       |

These variables are **not** provided by tmux, opencode, or this plugin — you
must set them up yourself. The usual approach is to reverse-forward your local
tmux socket over SSH and export the two variables in the remote shell.

A minimal SSH wrapper that does this:

```sh
# Forward the local tmux socket to the remote host and expose it via
# REMOTE_TMUX / REMOTE_PANE so remote tools can drive the local tmux window.
ssht() {
  local target="$1"
  local sock="${TMUX%%,*}"                       # local socket path
  local remote_sock="/tmp/remote-tmux-$$.sock"
  local remote_tmux="${remote_sock},${TMUX#*,}"  # preserve tmux metadata

  ssh -t \
    -o StreamLocalBindUnlink=yes \
    -R "${remote_sock}:${sock}" \
    "$target" \
    "export REMOTE_TMUX='${remote_tmux}' REMOTE_PANE='${TMUX_PANE}'; exec \$SHELL -l"
}
```

Then `ssht myhost`, run `opencode` there, and the status icons will appear on
your local tmux window. If the remote host has its own tmux (`TMUX` is set),
that takes precedence and the forwarded socket is ignored.

## Restoring the window name on exit

This plugin deliberately does **not** restore the original window name when
opencode quits. opencode hard-terminates the plugin worker on exit, so a
`dispose` or process-exit hook cannot run reliably.

Restore the name from a shell wrapper around `opencode` instead. The wrapper
runs after opencode fully exits, in the same pane, so it is guaranteed to fire.
It also preserves a manually-set window name and the original `automatic-rename`
setting.

### zsh / bash

This wrapper uses the same `TMUX` → `REMOTE_TMUX` fallback as the plugin, so it
works both locally and on a remote host with a forwarded socket (see
[Remote / forwarded tmux](#remote--forwarded-tmux)).

```sh
opencode() {
  local _oc_tmux="${TMUX:-$REMOTE_TMUX}"
  local _oc_pane="${TMUX_PANE:-$REMOTE_PANE}"
  local _oc_name _oc_auto

  if [ -n "$_oc_tmux" ] && [ -n "$_oc_pane" ]; then
    _oc_name="$(TMUX="$_oc_tmux" tmux display-message -t "$_oc_pane" -p '#{window_name}' 2>/dev/null)"
    _oc_auto="$(TMUX="$_oc_tmux" tmux show-window-options -t "$_oc_pane" automatic-rename 2>/dev/null | awk '{print $2}')"
  fi

  command opencode "$@"
  local ret=$?

  if [ -n "$_oc_tmux" ] && [ -n "$_oc_pane" ]; then
    TMUX="$_oc_tmux" tmux rename-window -t "$_oc_pane" "$_oc_name" 2>/dev/null
    if [ -n "$_oc_auto" ]; then
      TMUX="$_oc_tmux" tmux set-window-option -t "$_oc_pane" automatic-rename "$_oc_auto" 2>/dev/null
    else
      TMUX="$_oc_tmux" tmux set-window-option -t "$_oc_pane" -u automatic-rename 2>/dev/null
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
