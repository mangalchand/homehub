import { useRef, useState } from 'react';
import { Camera, Heart, Images, Maximize2, Trash2, Upload, X } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { api, hh } from '@/lib/api';
import { useHhMutation, useHid, useMembers, usePhotos, useRole, type Photo } from '@/lib/queries';
import { PhotoSlideshow } from '@/features/photos';
import { Button } from '@/components/ui/button';
import { Avatar, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { cn } from '@/lib/utils';

export default function PhotosPage() {
  const hid = useHid();
  const qc = useQueryClient();
  const [favOnly, setFavOnly] = useState(false);
  const photos = usePhotos({ favorites: favOnly });
  const members = useMembers().data ?? [];
  const { role, isDevice } = useRole();
  const canUpload = isDevice || role !== 'GUEST';
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [open, setOpen] = useState<Photo | null>(null);
  const [show, setShow] = useState(false);

  const toggleFav = useHhMutation((h, p: Photo) => api(hh(h, `/photos/${p.id}`), { method: 'PATCH', body: { isFavorite: !p.isFavorite } }), [['photos']]);
  const remove = useHhMutation((h, p: Photo) => api(hh(h, `/photos/${p.id}`), { method: 'DELETE' }), [['photos']]);

  const upload = async (files: FileList | null) => {
    if (!files?.length || !hid) return;
    const list = Array.from(files);
    setUploading(list.length);
    try {
      for (let i = 0; i < list.length; i += 5) {
        const fd = new FormData();
        list.slice(i, i + 5).forEach((f) => fd.append('files', f));
        await api(hh(hid, '/photos'), { method: 'POST', formData: fd });
        setUploading(Math.max(0, list.length - i - 5));
      }
      toast.success(`${list.length} photo${list.length === 1 ? '' : 's'} added — syncing to every screen`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(0);
      await qc.invalidateQueries({ queryKey: ['photos'] });
      if (fileRef.current) fileRef.current.value = '';
      if (camRef.current) camRef.current.value = '';
    }
  };

  const items = photos.data ?? [];
  return (
    <div>
      <PageHeader
        title="Family photos"
        subtitle="Upload from any phone or computer — they appear on the wall display and screensaver instantly."
        actions={
          <>
            <Button variant={favOnly ? 'default' : 'outline'} onClick={() => setFavOnly((v) => !v)}><Heart className={cn(favOnly && 'fill-current')} /> Favorites</Button>
            <Button variant="outline" onClick={() => setShow(true)} disabled={!items.length}><Maximize2 /> Slideshow</Button>
            <Button variant="outline" className="md:hidden" onClick={() => camRef.current?.click()}><Camera /> Camera</Button>
            {canUpload && <Button onClick={() => fileRef.current?.click()} disabled={uploading > 0}>{uploading ? <Spinner className="h-4 w-4" /> : <Upload />} {uploading ? `Uploading ${uploading}…` : 'Upload photos'}</Button>}
          </>
        }
      />
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => void upload(e.target.files)} />
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void upload(e.target.files)} />

      {photos.isLoading ? (
        <div className="flex justify-center py-20"><Spinner /></div>
      ) : items.length === 0 ? (
        <div
          className="rounded-3xl border-2 border-dashed border-primary/30 bg-primary/5"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}
        >
          <EmptyState icon={<Images className="h-7 w-7" />} title={favOnly ? 'No favorites yet' : 'Your family photo frame is empty'} body="Drop photos here or tap Upload. Location data is stripped automatically before photos are stored." action={canUpload ? <Button className="mt-2" onClick={() => fileRef.current?.click()}><Upload /> Upload photos</Button> : undefined} />
        </div>
      ) : (
        <div className="columns-2 gap-3 sm:columns-3 lg:columns-4 xl:columns-5" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void upload(e.dataTransfer.files); }}>
          {items.map((p) => {
            const by = members.find((m) => m.id === p.uploadedBy);
            return (
              <figure key={p.id} className="group relative mb-3 break-inside-avoid overflow-hidden rounded-2xl bg-muted shadow-soft">
                <button className="block w-full" onClick={() => setOpen(p)} aria-label={`Open photo${p.caption ? `: ${p.caption}` : ''}`}>
                  <img src={p.thumbUrl} alt={p.caption ?? 'Family photo'} loading="lazy" className="w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" style={p.width && p.height ? { aspectRatio: `${p.width}/${p.height}` } : undefined} />
                </button>
                <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                  {by ? <Avatar name={by.displayName} color={by.color} size={24} /> : <span />}
                </div>
                <button onClick={() => toggleFav.mutate(p)} className={cn('absolute right-2 top-2 rounded-full bg-black/35 p-1.5 text-white backdrop-blur transition-opacity', p.isFavorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')} aria-label={p.isFavorite ? 'Remove from favorites' : 'Add to favorites'}>
                  <Heart className={cn('h-4 w-4', p.isFavorite && 'fill-rose-500 text-rose-500')} />
                </button>
              </figure>
            );
          })}
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 backdrop-blur-sm" onClick={() => setOpen(null)} role="dialog" aria-label="Photo">
          <img src={open.url} alt={open.caption ?? 'Family photo'} className="max-h-full max-w-full rounded-2xl object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
          <div className="absolute right-4 top-4 flex gap-2" onClick={(e) => e.stopPropagation()}>
            <Button variant="secondary" size="icon" onClick={() => { toggleFav.mutate(open); setOpen({ ...open, isFavorite: !open.isFavorite }); }} aria-label="Favorite"><Heart className={cn(open.isFavorite && 'fill-rose-500 text-rose-500')} /></Button>
            <Button variant="secondary" size="icon" aria-label="Delete photo" onClick={() => { if (confirm('Delete this photo for everyone?')) { remove.mutate(open, { onError: (e) => toast.error((e as Error).message) }); setOpen(null); } }}><Trash2 /></Button>
            <Button variant="secondary" size="icon" onClick={() => setOpen(null)} aria-label="Close"><X /></Button>
          </div>
        </div>
      )}

      {show && (
        <div className="fixed inset-0 z-50 bg-black" onClick={() => setShow(false)} role="dialog" aria-label="Slideshow. Tap to close.">
          <PhotoSlideshow rounded={false} className="h-full w-full" intervalMs={7000} />
        </div>
      )}
    </div>
  );
}
