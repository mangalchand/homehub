import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const Card = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-2xl border border-border/80 bg-card text-card-foreground shadow-soft transition-shadow sm:rounded-3xl', className)} {...p} />
);
export const CardHeader = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn('flex items-center justify-between gap-2 p-4 pb-2 sm:p-5 sm:pb-2', className)} {...p} />;
export const CardTitle = ({ className, ...p }: HTMLAttributes<HTMLHeadingElement>) => <h3 className={cn('flex min-w-0 items-center gap-2.5 font-display text-[15px] font-bold tracking-tight', className)} {...p} />;
export const CardContent = ({ className, ...p }: HTMLAttributes<HTMLDivElement>) => <div className={cn('p-4 pt-2 sm:p-5 sm:pt-2', className)} {...p} />;

/** Small rounded, tinted square used in front of card titles. */
export const IconTile = ({ className, ...p }: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn('inline-flex h-8 w-8 items-center justify-center rounded-xl [&_svg]:h-[18px] [&_svg]:w-[18px]', className)} {...p} />
);
