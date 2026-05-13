'use client';

import { cn } from '@/lib/utils';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';

export interface AgentAvatarProps {
  name: string;
  emoji?: string;
  systemName?: string;
  size?: 'sm' | 'md' | 'lg';
  showName?: boolean;
  className?: string;
}

const sizeMap = {
  sm: 'sm' as const,
  md: 'default' as const,
  lg: 'lg' as const,
};

export function AgentAvatar({
  name,
  emoji,
  systemName,
  size = 'md',
  showName = false,
  className,
}: AgentAvatarProps) {
  const fallbackText = emoji ?? name.charAt(0).toUpperCase();
  const imageSrc = systemName ? `/agents/${systemName}.jpg` : undefined;

  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Avatar size={sizeMap[size]}>
        {imageSrc && <AvatarImage src={imageSrc} alt={name} />}
        <AvatarFallback>{fallbackText}</AvatarFallback>
      </Avatar>
      {showName && (
        <span className="text-sm font-medium">{name}</span>
      )}
    </span>
  );
}
