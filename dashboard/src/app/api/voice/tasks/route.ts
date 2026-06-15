import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface ActiveTask {
  id: string;
  assignee: string;
  title: string;
  description: string;
  priority: string;
  updatedAt: string | null;
}

interface BusTask {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  assigned_to?: string;
  priority?: string;
  updated_at?: string;
  archived?: boolean;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Structured JSON output — the old text-table parse split columns on 2+
    // spaces, which broke as soon as long task IDs ran into the assignee column
    // (mangled rows: assignee got the title text, title was empty).
    const output = execSync('cortextos bus list-tasks --status in_progress --format json', {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });

    let parsed: BusTask[];
    try {
      parsed = JSON.parse(output);
    } catch {
      return NextResponse.json({ tasks: [] });
    }
    if (!Array.isArray(parsed)) return NextResponse.json({ tasks: [] });

    const tasks: ActiveTask[] = parsed
      .filter((t) => !t.archived)
      .map((t) => ({
        id: t.id ?? '',
        assignee: t.assigned_to ?? '',
        title: t.title ?? '',
        description: t.description ?? '',
        priority: t.priority ?? '',
        updatedAt: t.updated_at ?? null,
      }));

    return NextResponse.json({ tasks });
  } catch {
    return NextResponse.json({ tasks: [] });
  }
}
