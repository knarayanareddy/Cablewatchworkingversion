'use client';

import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { Icon } from '@/components/ui';

export type Route = 'real' | 'synthetic' | 'about' | 'slides';

const NAV: { id: Route; label: string; href: string; external?: boolean }[] = [
  { id: 'real', label: 'Live Radar', href: '/real' },
  { id: 'synthetic', label: 'Synthetic Prototype', href: '/synthetic' },
  { id: 'about', label: 'About', href: '/' },
  { id: 'slides', label: 'Overview Slides', href: '/slides.html', external: true },
];

export function TopBar({ route, children }: { route: Route; children?: ReactNode }) {
  return (
    <header className="z-40 flex shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-ink-700 bg-ink-900 px-4 py-2 shadow-lg shadow-black/30">
      <a href="/real" className="group flex items-center gap-2.5">
        <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-xl bg-brand text-ink-950 shadow-md shadow-brand/20">
          <Icon name="radar" size={22} />
        </span>
        <span className="leading-tight">
          <span className="block text-[17px] font-extrabold tracking-tight text-white">
            Cable<span className="text-brand">Watch</span>
          </span>
          <span className="hidden text-[10px] font-semibold uppercase tracking-[0.14em] text-mute md:block">Mantavia Behavioral Threat Detector</span>
        </span>
      </a>

      <nav className="flex items-center gap-1" aria-label="Primary">
        {NAV.map((n) => (
          <a
            key={n.id}
            href={n.href}
            target={n.external ? '_blank' : undefined}
            rel={n.external ? 'noopener noreferrer' : undefined}
            aria-current={route === n.id ? 'page' : undefined}
            className={cn(
              'relative rounded-lg px-3 py-2 text-xs font-bold transition-colors',
              route === n.id ? 'bg-ink-700 text-brand' : 'text-soft hover:bg-ink-800 hover:text-white'
            )}
          >
            {n.label}
          </a>
        ))}
      </nav>

      <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
    </header>
  );
}
