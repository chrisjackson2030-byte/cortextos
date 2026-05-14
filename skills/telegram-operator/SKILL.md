---
name: telegram-operator
description: "Telegram message formatting, L-tag blast-radius prefix conventions, notification discipline, and send-vs-defer rules for operator communication. Load when composing any Telegram message to B."
tags: [telegram, messaging, notifications, blast-radius]
---

# Telegram Operator — Message Conventions

## Formatting Rules

Telegram uses regular Markdown (NOT MarkdownV2).

- **DO NOT escape** characters like `!`, `.`, `(`, `)`, `-` with backslashes
- Only `_`, `*`, `` ` ``, and `[` have special meaning
- Write plain natural text — no escaped punctuation

```bash
# Correct
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Bot halted: kill_switch_file present."

# Wrong (MarkdownV2 escaping)
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "Bot halted\: kill\_switch\_file present\."
```

## L-Tag Prefix — Blast Radius Declaration

Every Telegram message announcing an action must be prefixed with its blast-radius tag. This is a declaration of authority.

| Tag | Color | Authority Level |
|-----|-------|----------------|
| `[L0]` | Green | Autonomous — no announcement required |
| `[L1]` | Amber | Announce-and-do with 60s STOP grace |
| `[L2]` | Red | Require explicit B ACK before execution |
| `[L3]` | Black | Refuse and report — no token can unlock |

For full L0/L1/L2/L3 definitions and examples, see `HEARTBEAT.md` in your agent directory.

### L1 Template
```
[L1] About to: <verb> <object> (<why — one clause>). Reply STOP within 60s to cancel.
```

### L2 Template
```
[L2] PROPOSED: <full description>. Approval ID: <id>. Reply approve/deny.
```
Then WAIT — do NOT proceed until the approval row is `approved` and you have the unlock token.

### L3 Template
```
[L3 REFUSED] <action description>. Reason: <why this is L3>. Not proceeding.
```

## Notification Discipline

**Send to Telegram:**
- Failures and incidents (system down, trading halt, data integrity issues)
- Active conversation (B is waiting on you)
- Significant milestones (bot live, major task complete)
- Stale approvals older than 4 hours
- Stale [HUMAN] tasks blocking specialist agents

**Disk only (never Telegram):**
- Lifecycle events (heartbeats, compaction, soft restarts, cron fires)
- Routine task completion (unless B is actively watching)
- Stability/dedup status messages (fix silently, only message if still broken)
- Compaction/restart events (exception: genuine cold boot where B is actively waiting)

**One message per topic.** No rapid-fire sequences. No duplicate messages. If compaction may have caused a duplicate, err on silence.

## Message Timing

- Morning brief: 10:33 AM ET daily
- Evening brief: 5:57 PM ET daily
- Weekly review: Sunday 7:57 PM ET
- Quiet window: respect B's sleep schedule (late-night work is normal — don't add noise during focus sessions)

## Photos and Callbacks

Photos arrive with a `local_file:` path. Read and process the image via a sub-agent (see log-conventions skill for image isolation protocol).

Callbacks include `callback_data:` and `message_id:`. Process immediately. Reply using the send-telegram command shown in the message header.
