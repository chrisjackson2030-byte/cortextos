---
name: fleet-protocols
description: "cortextOS bus command contracts, task lifecycle, inbox sweep, inter-agent dispatch, and heartbeat patterns. Load when executing any bus operation, managing tasks, or processing agent messages."
tags: [bus, tasks, inbox, dispatch, cortextos]
---

# Fleet Protocols — cortextOS Bus Reference

## Task Lifecycle

Every significant piece of work (>10 min) requires a task. Taskless work is invisible on the dashboard.

```bash
# Create — BEFORE starting work
cortextos bus create-task "<title>" --desc "<description>"

# Start
cortextos bus update-task <task_id> in_progress

# Complete
cortextos bus complete-task <task_id> --result "<summary of what was produced>"

# Log KPI
cortextos bus log-event task task_completed info --meta '{"task_id":"<id>","agent":"'$CTX_AGENT_NAME'"}'
```

Attach file deliverables:
```bash
cortextos bus save-output <task_id> <file_path> --label "<descriptive label>"
```

## Heartbeat

```bash
cortextos bus update-heartbeat "<1-sentence status>"
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
```

If heartbeat fails, the agent shows as DEAD on the dashboard. Fix before anything else.

## Inbox Sweep

```bash
# Sweep (safety net — messages arrive in real time via fast-checker)
cortextos bus check-inbox

# ACK each message after processing
cortextos bus ack-inbox "<message_id>"

# Reply to an agent message (always include msg_id as reply_to)
cortextos bus send-message <agent> normal '<reply>' <msg_id>
```

Un-ACK'd messages redeliver after 5 minutes. Target: 0 un-ACK'd after each sweep.

For messages with no reply: `cortextos bus ack-inbox <msg_id>` (still ACK to stop redelivery).

## Inter-Agent Dispatch

```bash
# Send to another agent
cortextos bus send-message <agent> <priority> '<message>' [reply_to_msg_id]

# Priority levels: normal | high | critical
```

Dispatch format:
- Include task context (task_id if exists)
- Specify deliverable format expected
- Include deadline if time-sensitive
- Always include your agent name in the message context

## Event Logging

```bash
cortextos bus log-event <category> <event_name> <level> --meta '<json>'

# Common events:
cortextos bus log-event action session_start info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
cortextos bus log-event action task_completed info --meta '{"task_id":"<id>"}'
cortextos bus log-event heartbeat agent_heartbeat info --meta '{"agent":"'$CTX_AGENT_NAME'"}'
cortextos bus log-event action guardrail_triggered info --meta '{"guardrail":"<which>","context":"<what>"}'
```

Target: ≥3 events per active session. Invisible work is wasted work.

## Knowledge Base

```bash
# Query
cortextos bus kb-query "<topic>" --org $CTX_ORG

# Ingest
cortextos bus kb-ingest <file1> <file2> --org $CTX_ORG --agent $CTX_AGENT_NAME --scope private --collection memory-$CTX_AGENT_NAME --force
```

## Cron Management

Crons are daemon-managed. Do NOT use CronCreate or `/loop` — session-only and evaporate on restart.

```bash
cortextos bus list-crons $CTX_AGENT_NAME
cortextos bus add-cron $CTX_AGENT_NAME <name> <interval-or-cron-expr> <prompt>
cortextos bus remove-cron $CTX_AGENT_NAME <name>
```

## Restart

```bash
# Soft (preserves history)
cortextos bus self-restart --reason "why"

# Hard (fresh session)
cortextos bus hard-restart --reason "why"
```

Always ask B: "Fresh restart or continue with conversation history?" before restarting.

## Approvals

```bash
# Create approval request
cortextos bus create-approval "<title>" "<description>" --task-id <id>

# List pending
cortextos bus list-approvals --format json

# One approval ping per topic — never call create-approval on top of an existing approval_required return
```

## Telegram

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<message>"
```

See `.claude/skills/telegram-operator/SKILL.md` for formatting rules, L-tag conventions, and notification discipline.
