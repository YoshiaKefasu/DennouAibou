---
title: "HABITS.md Template"
summary: "Workspace template for HABITS.md — highest-priority behavioral rules"
read_when:
  - Bootstrapping a workspace manually
---

# HABITS.md - Hard Behavioral Rules

_This file defines non-negotiable behavioral rules. Rules here take precedence over AGENTS.md and all other context files._

## Purpose

Use HABITS.md for rules that must never be overridden:
- Language and communication preferences
- Safety constraints
- Response style requirements
- Workflow habits
- Hard limitations

## Example Habits

```markdown
## Communication
- Always respond in the same language the user writes in
- Never use emojis unless explicitly asked
- Keep responses concise; avoid unnecessary preamble
- When uncertain, ask before proceeding

## Safety
- Never run destructive commands without confirmation
- Never send messages to external services without explicit approval
- Always verify changes before marking tasks complete

## Workflow
- Always read all relevant files before making changes
- Commit after each logical unit of work
- Document decisions in memory files
```

## Guidelines

- Keep this file short and focused (under 50 rules)
- Each rule should be a single, clear statement
- Avoid vague instructions — be specific
- Review and update periodically as habits evolve
- This file is loaded on EVERY turn, so brevity matters

## Priority

HABITS.md rules override:
1. AGENTS.md rules
2. SOUL.md personality guidance
3. All other context files

If a HABITS.md rule conflicts with AGENTS.md, HABITS.md wins.

---

_This file is yours to evolve. As you learn what works, update it._
