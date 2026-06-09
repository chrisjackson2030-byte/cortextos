import { NextResponse } from 'next/server';
import { execSync } from 'child_process';
import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

interface ActiveTask {
  id: string;
  assignee: string;
  title: string;
  priority: string;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const output = execSync('cortextos bus list-tasks --status in_progress', {
      encoding: 'utf-8',
      timeout: 10000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` },
    });

    const tasks: ActiveTask[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip headers, separators, empty lines, and the "Tasks (N)" line
      if (
        !trimmed ||
        trimmed.startsWith('Status') ||
        trimmed.startsWith('---') ||
        trimmed.startsWith('Tasks')
      ) {
        continue;
      }

      // Lines look like: "●       🔵   task_178...   friday    Title text here"
      // Split on 2+ whitespace to parse columns
      const parts = trimmed.split(/\s{2,}/);
      if (parts.length >= 4) {
        // parts: [status_icon, priority_icon, id, assignee, ...title parts]
        tasks.push({
          id: parts[2] || '',
          assignee: parts[3] || '',
          title: parts.slice(4).join(' ') || '',
          priority: parts[1] || '',
        });
      }
    }

    return NextResponse.json({ tasks });
  } catch {
    return NextResponse.json({ tasks: [] });
  }
}
