---
name: log-conventions
description: "Context-size protection: read caps for large shared files, image isolation protocol, and grep/tail patterns for lazy reads. Load when working with shared memory files or processing images."
tags: [memory, context, logging, shared-files]
---

# Log Conventions — Context Protection

## Read Caps — NEVER read these files in full

They are 500–2000+ lines each. Repeated full reads bloat context by 3–10 MB per session.

### Shared memory files (all agents)

| File | Max Read | Method |
|------|----------|--------|
| `memory/shared/reasoning-log.md` | Last 50 lines | `tail -50` or Read with offset |
| `memory/shared/reel-ideas-by-source.md` | Last 50 lines | `tail -50` or Read with offset |
| `memory/shared/deferred-items.md` | Last 100 lines | `tail -100` or Read with offset |
| `memory/shared/idea-inbox.md` | Last 50 lines | `tail -50` or Read with offset |
| `memory/shared/observation-journal.md` | Last 30 lines | `tail -30` or Read with offset |
| `memory/shared/rehearsal-log.md` | Last 50 lines | `tail -50` or Read with offset |
| `memory/shared/confidence-calibration-log.md` | Last 50 lines | `tail -50` or Read with offset |
| `experiments/learnings.md` (analyst) | Last 100 lines | `tail -100` or Read with offset |

### Search before reading

```bash
# Find one entry without reading the whole file
grep -n "search_term" <file> | tail -10

# Read only the matching section
sed -n '42,60p' <file>
```

Never read a file in full just to find one entry. Grep first.

## Image Isolation — Base64 Protection

**NEVER read image files (PNG, JPG, screenshots) directly in your conversation.** A single base64 image is 100–200 KB — 64× larger than reading HEARTBEAT.md.

To process an image:
1. Spawn a sub-agent via the Agent tool
2. Have the sub-agent read and describe the image
3. Sub-agent returns a text summary — base64 never enters your context

This applies to screenshots, diagrams, chart exports, reel thumbnails — any binary image file.

## Large File Patterns

```bash
# Read last N lines of a large log
tail -50 memory/shared/reasoning-log.md

# Read with offset (skip first N-1 lines)
# Use Read tool: offset=<line_number>

# Count before deciding whether to read
wc -l <file>

# Check if a memory entry already exists
grep -c "2026-05-" memory/shared/idea-inbox.md
```
