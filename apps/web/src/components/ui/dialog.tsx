import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Dialog({ open, onOpenChange, title, description, children, className }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <D.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 max-h-[92vh] w-full overflow-y-auto rounded-t-3xl border-t bg-card px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-lift data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[90vh] sm:w-[calc(100%-2rem)] sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-3xl sm:p-6 sm:data-[state=open]:zoom-in-95',
            className,
          )}
        >
          <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-muted sm:hidden" />
          <div className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <D.Title className="font-display text-lg font-bold leading-snug">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="-mr-1 shrink-0 rounded-full p-2 text-muted-foreground hover:bg-muted" aria-label="Close">
              <X className="h-5 w-5" />
            </D.Close>
          </div>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
