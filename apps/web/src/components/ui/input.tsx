import * as React from 'react';
import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const field = 'flex w-full rounded-xl border border-input bg-card px-3.5 py-2 text-base shadow-sm transition-colors placeholder:text-muted-foreground/80 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15 disabled:opacity-50 sm:text-sm';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(field, 'h-11 sm:h-10', className)} {...p} />);
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cn(field, 'min-h-[80px]', className)} {...p} />);
Textarea.displayName = 'Textarea';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => <select ref={ref} className={cn(field, 'h-11 sm:h-10', className)} {...p} />);
Select.displayName = 'Select';

export const Label = ({ className, ...p }: LabelHTMLAttributes<HTMLLabelElement>) => <label className={cn('text-sm font-semibold text-foreground/90', className)} {...p} />;

export function Field({ label, error, children, hint }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  const autoId = React.useId();
  const child = React.isValidElement<{ id?: string }>(children) ? children : null;
  const isControl = child && typeof child.type !== 'string' ? true : child ? ['input', 'select', 'textarea'].includes(child.type as string) : false;
  const id = child?.props.id ?? autoId;
  return (
    <div className="space-y-1.5">
      {isControl ? <Label htmlFor={id}>{label}</Label> : <p className="text-sm font-semibold text-foreground/90">{label}</p>}
      {isControl && child ? React.cloneElement(child, { id }) : children}
      {hint && !error && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
