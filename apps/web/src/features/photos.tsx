import { useNotifications } from '@/lib/notifications';
import { useEffect, useMemo, useRef, useState } from 'react';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { ImagePlus, ShieldAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useHousehold, usePhotos, type Photo } from '@/lib/queries';
import { zoned } from '@/lib/time';
import { cn } from '@/lib/utils';

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Cross-fading Ken Burns slideshow. Favorites appear twice as often. */
export function PhotoSlideshow({ intervalMs = 9000, className, rounded = true, fit = 'contain', children }: { intervalMs?: number; className?: string; rounded?: boolean; fit?: 'contain' | 'cover'; children?: React.ReactNode }) {
  const data = usePhotos().data;
  const deck = useMemo(() => shuffle((data ?? []).flatMap((p) => (p.isFavorite ? [p, p] : [p]))), [data]);
  const [i, setI] = useState(0);
  useEffect(() => {
    if (deck.length < 2) return;
    const t = setInterval(() => setI((n) => (n + 1) % deck.length), intervalMs);
    return () => clearInterval(t);
  }, [deck.length, intervalMs]);
  const current: Photo | undefined = deck[i % Math.max(deck.length, 1)];
  const next = deck[(i + 1) % Math.max(deck.length, 1)];

  return (
    <div className={cn('relative overflow-hidden bg-gradient-to-br from-violet-600 via-indigo-600 to-sky-500', rounded && 'rounded-3xl', className)}>
      {current ? (
        <>
          {/* Blurred fill behind, whole photo in front: no heads cut off on wide banners. */}
          <img key={'bg' + current.id + i} src={current.thumbUrl} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 animate-[fade-in_1.2s_ease-out] object-cover blur-2xl brightness-75" />
          <img key={current.id + i} src={current.url} alt={current.caption ?? 'Family photo'} className={cn('absolute inset-0 h-full w-full animate-[fade-in_1.2s_ease-out] object-center', fit === 'contain' ? 'object-contain' : 'object-cover object-[50%_30%]')} />
          {next && <link rel="prefetch" href={next.url} />}
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-black/20" />
          {current.caption && <p className="absolute bottom-4 right-5 max-w-[60%] truncate text-right text-sm font-medium text-white/90 drop-shadow">{current.caption}</p>}
        </>
      ) : (
        <Link to="/photos" className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/90">
          <ImagePlus className="h-10 w-10" />
          <span className="text-sm font-medium">Add family photos</span>
        </Link>
      )}
      <div className="relative h-full">{children}</div>
    </div>
  );
}

/** Full-screen photo frame with clock, shown on shared displays after a period of inactivity. */
function IdleNotifications() {
  const unread = (useNotifications().data ?? []).filter((n) => !n.readAt);
  if (!unread.length) return null;
  return (
    <div className="absolute right-6 top-6 w-[min(26rem,calc(100%-3rem))] rounded-3xl border border-white/20 bg-slate-950/55 p-4 text-white shadow-lift backdrop-blur-xl">
      <p className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-white/85">
        <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-rose-500 px-2 text-sm text-white">{unread.length > 99 ? '99+' : unread.length}</span>
        {unread.length === 1 ? 'New notification' : 'New notifications'}
      </p>
      <ul className="space-y-2">
        {unread.slice(0, 4).map((n) => (
          <li key={n.id} className="rounded-2xl bg-white/10 px-3 py-2">
            <p className="font-semibold leading-snug">{n.title}</p>
            {n.body && <p className="line-clamp-2 text-sm text-white/80">{n.body}</p>}
            <p className="mt-0.5 text-xs text-white/60">{formatDistanceToNowStrict(new Date(n.createdAt), { addSuffix: true })}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Screensaver({ idleMinutes = 5, enabled }: { idleMinutes?: number; enabled: boolean }) {
  const [active, setActive] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const tz = useHousehold().data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    if (!enabled) return;
    const reset = () => {
      setActive(false);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setActive(true), idleMinutes * 60_000);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [enabled, idleMinutes]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, [active]);

  if (!enabled || !active) return null;
  const z = zoned(now, tz);
  return (
    <div className="fixed inset-0 z-[100] bg-black" role="dialog" aria-label="Photo frame. Tap to return." onPointerDown={() => setActive(false)}>
      <PhotoSlideshow rounded={false} className="h-full w-full" intervalMs={12000}>
        <IdleNotifications />
        <div className="absolute left-4 top-4" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Link to="/safety" onClick={() => setActive(false)} className="inline-flex items-center gap-2 rounded-2xl bg-red-600 px-5 py-3 font-bold text-white shadow-lg"><ShieldAlert /> Panic / SOS</Link>
        </div>
        <div className="absolute bottom-10 left-10 text-white drop-shadow-lg">
          <p className="font-display text-8xl font-extrabold tabular-nums tracking-tight">{format(z, 'h:mm')}</p>
          <p className="mt-1 text-2xl font-medium text-white/85">{format(z, 'EEEE, d MMMM')}</p>
        </div>
      </PhotoSlideshow>
    </div>
  );
}
