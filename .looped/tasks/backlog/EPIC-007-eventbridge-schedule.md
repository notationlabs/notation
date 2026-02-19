---
type: epic
title: eventbridge-schedule
created: "2026-02-26T00:57:15.962Z"
updated: "2026-02-26T00:57:15.962Z"
tasks:
  - TASK-013
priority: low
estimate: small
---
## Human-readable helpers for building AWS EventBridge schedule expressions.

## Why

EventBridge schedule expressions are a small sharp edge. You always have to look up the format. Is it `rate(5 minutes)` or `rate(5, "minutes")`? Is the cron six fields or five? What is the `at()` datetime format? You get it wrong, the schedule silently fails or throws an opaque error at deploy time.

This package gives you typed builders (`rate`, `cron`, `once`) that make the intent readable and the format correct. It is the kind of micro-utility that saves five minutes every time you touch a scheduled task — and prevents the silent bugs that come from malformed expressions.

Borderline too small for a package, but the bug found in the existing `at()` serialization proves the point: even the original author got the formatting wrong. Encode it once, correctly, and move on.

---

## What to extract

| Source file | What to take |
|---|---|
| `packages/aws/src/event-bridge/schedule.ts` | `rate()`, `cron()`, `once()` builder functions and all types |
| `packages/aws/src/event-bridge/aws-conversions.ts` | `toAwsScheduleExpression()` serializer |

Two files, ~60 lines total.

## What to leave behind

| Source file | Why |
|---|---|
| `event-bridge-schedule.ts` | Notation-specific orchestration — Lambda wiring, resource groups, IAC resources. |
| `event-bridge/index.ts` | Re-export barrel for the Notation package structure. |

## API surface

```ts
import { rate, cron, once, toScheduleExpression } from "eventbridge-schedule";

rate(5, "minutes");
toScheduleExpression(rate(5, "minutes")); // "rate(5 minutes)"

cron("0 9 * * ? *");
toScheduleExpression(cron("0 9 * * ? *")); // "cron(0 9 * * ? *)"

once(new Date("2024-01-15T09:00:00Z"));
toScheduleExpression(once(new Date("2024-01-15T09:00:00Z"))); // "at(2024-01-15T09:00:00)"
```

## Key design decisions

1. **Fix the `at()` serialization bug.** Current code has broken formatting. Correct format: `at(yyyy-MM-ddTHH:mm:ss)`.
2. **Use UTC in `once()`.** Switch to `toISOString()` or explicit UTC getters.
3. **Rename to `toScheduleExpression`.** Drop the `Aws` infix — package is already EventBridge-specific.
4. **No validation.** Keep it a simple builder + serializer.
5. **Two-arg form for `rate`.** `rate(5, "minutes")` gives type safety on the unit.

## Dependencies

Zero. Pure TypeScript.

## Rough scope

~60-80 lines production code. ~40-60 lines tests. 1-2 hours total.