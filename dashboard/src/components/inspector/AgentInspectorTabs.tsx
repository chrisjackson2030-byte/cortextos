'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = ['overview', 'chat', 'memory', 'skills', 'mcp', 'files', 'terminal'] as const;

export function AgentInspectorTabs({ agentName }: { agentName: string }) {
  const pathname = usePathname();
  const encodedName = encodeURIComponent(agentName);
  return (
    <nav className="flex flex-wrap gap-1 border-b">
      {TABS.map((tab) => {
        // Overview maps to the root agent page; all others get their own sub-path
        const href =
          tab === 'overview'
            ? `/agents/${encodedName}`
            : `/agents/${encodedName}/${tab}`;
        const active =
          tab === 'overview'
            ? pathname === `/agents/${encodedName}` || pathname === `/agents/${encodedName}/`
            : pathname === href;
        return (
          <Link
            key={tab}
            href={href}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize ${active ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
          >
            {tab === 'mcp' ? 'MCP' : tab}
          </Link>
        );
      })}
    </nav>
  );
}
