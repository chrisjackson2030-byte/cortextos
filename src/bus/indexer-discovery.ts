import { readdirSync, statSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// JSONL Session Transcript Indexer — File Discovery + Agent Name Derivation
// ---------------------------------------------------------------------------
//
// Phase 1 skeleton: scan ~/.claude/projects/*/ for JSONL session transcript
// files, derive agent names from project slugs, and detect which files need
// (re-)indexing based on size/mtime comparison with stored session records.
//
// Synchronous API matching existing cortextOS bus module patterns.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One discovered JSONL session file on disk.
 */
export interface DiscoveredSession {
  /** The session UUID (filename minus .jsonl extension). */
  sessionId: string;
  /** Full absolute path to the .jsonl file. */
  filePath: string;
  /** The project slug directory name (e.g. "-Users-chrisjackson-cortextos-orgs-main-agents-jarvis"). */
  projectSlug: string;
  /** Derived agent name (e.g. "jarvis", "_interactive"). */
  agentName: string;
  /** File size in bytes. */
  fileSize: number;
  /** File modification time as ISO 8601 string. */
  fileMtime: string;
}

/**
 * Stored session record from the database, used for change detection.
 * The caller provides this from a database query.
 */
export interface StoredSessionInfo {
  sessionId: string;
  indexedLines: number;
  fileSize: number;
  fileMtime: string;
}

/**
 * Classification of what action is needed for a discovered session file.
 */
export type IndexAction =
  | 'full'       // New file, never indexed
  | 'incremental' // File grew since last index
  | 'reindex'     // File shrank (truncated/rotated) — full reindex needed
  | 'skip';       // No changes since last index

/**
 * A discovered session with its indexing disposition.
 */
export interface SessionIndexPlan {
  session: DiscoveredSession;
  action: IndexAction;
  /** For incremental: the line number to resume from. */
  resumeFromLine: number;
  /** For incremental: the stored file size to compare against. */
  storedFileSize: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The base directory where Claude Code stores project-scoped session files.
 */
function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * Regex to extract agent name from a project slug.
 * Matches the last `-agents-<name>` segment in the slug.
 */
const AGENTS_SEGMENT_REGEX = /-agents-([^/]+)$/;

// ---------------------------------------------------------------------------
// Agent name derivation
// ---------------------------------------------------------------------------

/**
 * Derive an agent name from a Claude Code project slug.
 *
 * Derivation logic (from architecture doc):
 *   1. If slug contains `-agents-`, extract everything after the last
 *      `-agents-` segment.
 *   2. Otherwise, mark as `_interactive` (B's direct CLI sessions).
 *
 * Examples:
 *   "-Users-chrisjackson-cortextos-orgs-main-agents-jarvis" -> "jarvis"
 *   "-Users-chrisjackson-cortextos-orgs-main-agents-analyst" -> "analyst"
 *   "-Users-chrisjackson-cortextos" -> "_interactive"
 *   "-Users-chrisjackson-cortextos-orgs-main-agents--phase2-drafts" -> "-phase2-drafts"
 *
 * @param projectSlug  The directory name under ~/.claude/projects/
 * @returns            The derived agent name.
 */
export function deriveAgentName(projectSlug: string): string {
  const match = AGENTS_SEGMENT_REGEX.exec(projectSlug);
  if (match && match[1]) {
    return match[1];
  }
  return '_interactive';
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Scan the Claude Code projects directory for all JSONL session files.
 *
 * Returns one DiscoveredSession per file.  Does NOT read file contents —
 * only stats for size/mtime.  Skips non-JSONL files and directories.
 *
 * @param projectsDirOverride  Optional override for the projects directory
 *                             path (useful for testing).
 * @returns  Array of discovered sessions, sorted by project slug then
 *           session ID for deterministic ordering.
 */
export function discoverSessions(
  projectsDirOverride?: string,
): DiscoveredSession[] {
  const projectsDir = projectsDirOverride || claudeProjectsDir();

  if (!existsSync(projectsDir)) {
    return [];
  }

  const sessions: DiscoveredSession[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name);
  } catch {
    return [];
  }

  for (const projectSlug of projectDirs) {
    const projectPath = join(projectsDir, projectSlug);
    const agentName = deriveAgentName(projectSlug);

    let files: string[];
    try {
      files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(projectPath, file);
      const sessionId = basename(file, '.jsonl');

      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;

        sessions.push({
          sessionId,
          filePath,
          projectSlug,
          agentName,
          fileSize: stat.size,
          fileMtime: stat.mtime.toISOString(),
        });
      } catch {
        // Skip files we can't stat (permissions, race conditions)
        continue;
      }
    }
  }

  // Deterministic sort: project slug, then session ID
  sessions.sort((a, b) => {
    const slugCmp = a.projectSlug.localeCompare(b.projectSlug);
    if (slugCmp !== 0) return slugCmp;
    return a.sessionId.localeCompare(b.sessionId);
  });

  return sessions;
}

/**
 * Scan for JSONL files belonging to a specific agent only.
 *
 * @param agentName            The agent name to filter by.
 * @param projectsDirOverride  Optional override for testing.
 * @returns  Discovered sessions for the specified agent.
 */
export function discoverSessionsForAgent(
  agentName: string,
  projectsDirOverride?: string,
): DiscoveredSession[] {
  return discoverSessions(projectsDirOverride)
    .filter(s => s.agentName === agentName);
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/**
 * Determine what indexing action is needed for a discovered session file
 * by comparing it against its stored database record.
 *
 * @param discovered  The on-disk session file.
 * @param stored      The stored session record (null if never indexed).
 * @returns           The index action classification.
 */
export function classifyIndexAction(
  discovered: DiscoveredSession,
  stored: StoredSessionInfo | null,
): SessionIndexPlan {
  if (!stored) {
    // Never indexed — full index from line 0
    return {
      session: discovered,
      action: 'full',
      resumeFromLine: 0,
      storedFileSize: 0,
    };
  }

  if (stored.fileSize === discovered.fileSize) {
    // Same size — skip (JSONL files are append-only, same size = no changes)
    return {
      session: discovered,
      action: 'skip',
      resumeFromLine: stored.indexedLines,
      storedFileSize: stored.fileSize,
    };
  }

  if (discovered.fileSize > stored.fileSize) {
    // File grew — incremental index from where we left off
    return {
      session: discovered,
      action: 'incremental',
      resumeFromLine: stored.indexedLines,
      storedFileSize: stored.fileSize,
    };
  }

  // File shrank — truncated/rotated, needs full reindex
  return {
    session: discovered,
    action: 'reindex',
    resumeFromLine: 0,
    storedFileSize: stored.fileSize,
  };
}

/**
 * Build an index plan for all discovered sessions given a lookup function
 * that retrieves stored session info from the database.
 *
 * @param sessions  All discovered sessions on disk.
 * @param lookup    Function to retrieve stored info by session ID.
 *                  Returns null if the session has never been indexed.
 * @returns         Array of plans, one per session, excluding 'skip' entries
 *                  (callers typically only want actionable items).
 */
export function buildIndexPlan(
  sessions: DiscoveredSession[],
  lookup: (sessionId: string) => StoredSessionInfo | null,
): SessionIndexPlan[] {
  const plans: SessionIndexPlan[] = [];

  for (const session of sessions) {
    const stored = lookup(session.sessionId);
    const plan = classifyIndexAction(session, stored);
    plans.push(plan);
  }

  return plans;
}

/**
 * Build an index plan filtered to only actionable items (excludes 'skip').
 * Convenience wrapper around buildIndexPlan for the common case.
 */
export function buildActionableIndexPlan(
  sessions: DiscoveredSession[],
  lookup: (sessionId: string) => StoredSessionInfo | null,
): SessionIndexPlan[] {
  return buildIndexPlan(sessions, lookup).filter(p => p.action !== 'skip');
}
