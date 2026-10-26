import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellRing, CalendarDays, CheckCheck, Gift, Images, Megaphone, ShoppingBasket, Sparkles } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import { toast } from 'sonner';
import { chime, unlockNotificationAudio, useMarkRead, useNotifications, type AppNotification } from '@/lib/notifications';
import { cn } from '@/lib/utils';

const ICONS: Record<string, typeof Bell> = {
  event: CalendarDays, chore: Sparkles, task: Sparkles, reward: Gift, list: ShoppingBasket, photos: Images, announcement: Megaphone,
};
const iconFor = (type: string) => ICONS[type.split('.')[0]!] ?? Bell;

export function NotificationBell({ className }: { className?: string }) {
  const { data, isSuccess } = useNotifications();
  const notifications = data ?? [];
  const markRead = useMarkRead();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [ring, setRing] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const unread = notifications.filter((n) => !n.readAt).length;

  useEffect(() => {
    window.addEventListener('pointerdown', unlockNotificationAudio);
    window.addEventListener('keydown', unlockNotificationAudio);
    return () => {
      window.removeEventListener('pointerdown', unlockNotificationAudio);
      window.removeEventListener('keydown', unlockNotificationAudio);
    };
  }, []);

  // Chime + toast when a new unread notification arrives (not on first load).
  useEffect(() => {
    if (!isSuccess || !data) return;
    const fresh = seen.current ? data.filter((n) => !seen.current!.has(n.id) && !n.readAt) : [];
    if (fresh.length) {
      chime();
      setRing(true);
      setTimeout(() => setRing(false), 1600);
      for (const latest of fresh.slice(0, 3)) toast(latest.title, { description: latest.body ?? undefined, action: latest.data?.url ? { label: 'Open', onClick: () => navigate(latest.data.url!) } : undefined });
    }
    seen.current = new Set(data.map((n) => n.id));
  }, [data, isSuccess, navigate]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const openItem = (n: AppNotification) => {
    if (!n.readAt) markRead.mutate([n.id]);
    setOpen(false);
    if (n.data?.url) navigate(n.data.url);
  };

  const Icon = ring ? BellRing : Bell;
  return (
    <div ref={box} className={cn('relative', className)}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={cn('relative flex h-11 w-11 items-center justify-center rounded-2xl border border-border/70 bg-card/80 shadow-soft backdrop-blur transition hover:bg-card', ring && 'animate-[wiggle_0.4s_ease-in-out_3]')}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
      >
        <Icon className="h-5 w-5" />
        {unread > 0 && <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[11px] font-bold text-white ring-2 ring-background">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="fixed inset-x-3 top-16 z-50 max-h-[70vh] overflow-hidden rounded-3xl border bg-card shadow-lift sm:absolute sm:inset-x-auto sm:right-0 sm:top-14 sm:w-96" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <p className="font-display font-bold">Notifications</p>
            {unread > 0 && <button className="flex items-center gap-1 text-xs font-semibold text-primary" onClick={() => markRead.mutate(undefined)}><CheckCheck className="h-4 w-4" /> Mark all read</button>}
          </div>
          <div className="max-h-[60vh] overflow-y-auto p-2">
            {notifications.length === 0 ? (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">You’re all caught up.</p>
            ) : (
              notifications.map((n) => {
                const I = iconFor(n.type);
                return (
                  <button key={n.id} onClick={() => openItem(n)} className={cn('flex w-full items-start gap-3 rounded-2xl p-3 text-left transition hover:bg-muted/70', !n.readAt && 'bg-primary/5')}>
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><I className="h-[18px] w-[18px]" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold leading-snug">{n.title}</span>
                      {n.body && <span className="block text-xs leading-relaxed text-muted-foreground">{n.body}</span>}
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">{formatDistanceToNowStrict(new Date(n.createdAt), { addSuffix: true })}</span>
                    </span>
                    {!n.readAt && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
