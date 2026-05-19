# Monitor.test

> **Navigation aid.** Route list and file locations extracted via AST. Read the source files listed below before implementing or modifying this subsystem.

The Monitor.test subsystem handles **3 routes** and touches: auth, payment.

## Routes

- `POST` `/api/messages` [auth, payment]
  `extensions\msteams\src\monitor.test.ts`
- `WS` `error` `[inferred]`
  `extensions/msteams/src/monitor.test.ts`
- `WS` `close` `[inferred]`
  `extensions/msteams/src/monitor.test.ts`

## Source Files

Read these before implementing or modifying this subsystem:
- `extensions\msteams\src\monitor.test.ts`
- `extensions/msteams/src/monitor.test.ts`

---
_Back to [overview.md](./overview.md)_