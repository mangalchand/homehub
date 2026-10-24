import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn, contrastText, initials } from '@/lib/utils';

export const Badge = ({ className, tone = 'default', ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: 'default' | 'success' | 'warning' | 'danger' | 'muted' }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
      {
        default: 'bg-primary/10 text-primary',
        success: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
        warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
        danger: 'bg-destructive/15 text-destructive',
        muted: 'bg-muted text-muted-foreground',
      }[tone],
      className,
    )}
    {...p}
  />
);

export function Avatar({ name, color, size = 36, className }: { name: string; color: string; size?: number; className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ring-2 ring-card', className)}
      style={{ width: size, height: size, background: color, color: contrastText(color), fontSize: size * 0.38 }}
      aria-label={name}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export function Switch({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative h-6 w-11 shrink-0 rounded-full bg-input transition-colors data-[state=checked]:bg-primary disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px]" />
    </SwitchPrimitive.Root>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <div className="rounded-2xl bg-muted p-3 text-muted-foreground">{icon}</div>
      <p className="font-medium">{title}</p>
      {body && <p className="max-w-sm text-sm text-muted-foreground">{body}</p>}
      {action}
    </div>
  );
}

export const Spinner = ({ className }: { className?: string }) => <span className={cn('inline-block h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent', className)} role="status" aria-label="Loading" />;

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
