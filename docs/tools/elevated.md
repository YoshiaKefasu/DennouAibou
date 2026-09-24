---
summary: "Elevated exec mode: run commands directly on the gateway/node host"
read_when:
  - Adjusting elevated mode defaults, allowlists, or slash command behavior
title: "Elevated Mode"
---

# Elevated Mode

`exec` commands run on the gateway host (or a paired node). **Elevated mode**
lets an agent run commands directly on the effective host with configurable
approval gates (`full` skips approvals, `on`/`ask` keep them).

<Info>
  Elevated mode controls exec approvals and which host exec runs on; it does not
  grant filesystem access beyond normal tool policy.
</Info>

## Directives

Control elevated mode per-session with slash commands:

| Directive       | What it does         |
| --------------- | -------------------- |
| `/elevated ask` | Same as `on` (alias) |

Also available as `/elev on|off|ask|full`.

Send `/elevated` with no argument to see the current level.

## How it works

<Steps>
  <Step title="Check availability">
    Elevated must be enabled in config and the sender must be on the allowlist:

    ```json5
    {
      tools: {
        elevated: {
          enabled: true,
          allowFrom: {
            discord: ["user-id-123"],
            whatsapp: ["+15555550123"],
          },
        },
      },
    }
    ```

  </Step>

  <Step title="Set the level">
    Send a directive-only message to set the session default:

    ```
    /elevated full
    ```

    Or use it inline (applies to that message only):

    ```
    /elevated on run the deployment script
    ```

  </Step>

  <Step title="Commands run directly on the host">
    With elevated active, `exec` calls run on the effective host. The effective host is
    `gateway` by default, or `node` when the configured/session exec target is
    `node`. In `full` mode, exec approvals are skipped. In `on`/`ask` mode,
    configured approval rules still apply.
  </Step>
</Steps>

## Resolution order

1. **Inline directive** on the message (applies only to that message)
2. **Session override** (set by sending a directive-only message)
3. **Global default** (`agents.defaults.elevatedDefault` in config)

## Availability and allowlists

- **Global gate**: `tools.elevated.enabled` (must be `true`)
- **Sender allowlist**: `tools.elevated.allowFrom` with per-channel lists
- **Per-agent gate**: `agents.list[].tools.elevated.enabled` (can only further restrict)
- **Per-agent allowlist**: `agents.list[].tools.elevated.allowFrom` (sender must match both global + per-agent)
- **Discord fallback**: if `tools.elevated.allowFrom.discord` is omitted, `channels.discord.allowFrom` is used as fallback
- **All gates must pass**; otherwise elevated is treated as unavailable

Allowlist entry formats:

| Prefix                  | Matches                         |
| ----------------------- | ------------------------------- |
| (none)                  | Sender ID, E.164, or From field |
| `name:`                 | Sender display name             |
| `username:`             | Sender username                 |
| `tag:`                  | Sender tag                      |
| `id:`, `from:`, `e164:` | Explicit identity targeting     |

## What elevated does not control

- **Tool policy**: if `exec` is denied by tool policy, elevated cannot override it
- **Host selection policy**: elevated does not turn `auto` into a free cross-host override. It uses the configured/session exec target rules, choosing `node` only when the target is already `node`.
- **Separate from `/exec`**: the `/exec` directive adjusts per-session exec defaults for authorized senders and does not require elevated mode

## Related

- [Exec tool](/tools/exec) — shell command execution
- [Exec approvals](/tools/exec-approvals) — approval and allowlist system
-
