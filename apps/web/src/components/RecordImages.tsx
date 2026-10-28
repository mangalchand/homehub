import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, ImagePlus, Trash2 } from 'lucide-react';
import type { AttachmentDTO } from '@familyhub/shared';
import { IMAGE_ATTACHMENT_MIME_TYPES, MAX_ATTACHMENT_SIZE_BYTES } from '@familyhub/shared';
import { api, hh } from '@/lib/api';
import { IMAGE_ACCEPT, MAX_RECORD_IMAGES, uploadAttachment } from '@/lib/attachments';
import { useHid } from '@/lib/queries';
import { Button } from '@/components/ui/button';

interface ImageList {
  items: AttachmentDTO[];
  canUpload: boolean;
  canDeleteIds: string[];
}
interface Props {
  parentType: 'tasks' | 'notes';
  parentId: string;
  readOnly?: boolean;
}
interface Pending {
  id: string;
  file: File;
  url: string;
  progress: number;
  error?: string;
}

export function RecordImages(props: Props) {
  const hid = useHid();
  return hid ? (
    <ImagesForRecord key={`${hid}/${props.parentType}/${props.parentId}`} {...props} householdId={hid} />
  ) : null;
}

function ImagesForRecord({ householdId, parentType, parentId, readOnly }: Props & { householdId: string }) {
  const qc = useQueryClient();
  const path = hh(householdId, `/${parentType}/${parentId}/attachments`);
  const queryKey = ['attachments', householdId, parentType, parentId];
  const list = useQuery({ queryKey, queryFn: () => api<ImageList>(path), refetchInterval: 30_000 });
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const urls = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const previews = urls.current;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      previews.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['attachments', householdId, parentType, parentId] }),
      qc.invalidateQueries({ queryKey: [parentType] }),
    ]);
  };
  const remove = useMutation({
    mutationFn: (id: string) => api(hh(householdId, `/attachments/${id}`), { method: 'DELETE' }),
    networkMode: 'always',
    onSuccess: refresh,
    onError: (e) => setError((e as Error).message),
  });
  const discard = (item: Pending) => {
    URL.revokeObjectURL(item.url);
    urls.current.delete(item.url);
    setPending((rows) => rows.filter((row) => row.id !== item.id));
  };
  const send = async (items: Pending[]) => {
    if (busy) return;
    setBusy(true);
    controller.current = new AbortController();
    try {
      for (const item of items) {
        if (controller.current.signal.aborted) break;
        setPending((rows) =>
          rows.map((row) => (row.id === item.id ? { ...row, error: undefined, progress: 0 } : row)),
        );
        try {
          await uploadAttachment(
            path,
            item.file,
            (progress) => {
              if (mounted.current)
                setPending((rows) => rows.map((row) => (row.id === item.id ? { ...row, progress } : row)));
            },
            controller.current.signal,
          );
          if (mounted.current) discard(item);
        } catch (e) {
          if (mounted.current)
            setPending((rows) =>
              rows.map((row) => (row.id === item.id ? { ...row, error: (e as Error).message } : row)),
            );
        }
      }
    } finally {
      await refresh();
      if (mounted.current) {
        if (controller.current?.signal.aborted)
          setPending((rows) =>
            rows.map((row) =>
              row.error ? row : { ...row, error: 'Upload cancelled. Refresh images before retrying.' },
            ),
          );
        setBusy(false);
      }
    }
  };
  const select = (files: FileList | null) => {
    if (!files?.length || busy) return;
    setError('');
    const candidates = Array.from(files);
    if ((list.data?.items.length ?? 0) + pending.length + candidates.length > MAX_RECORD_IMAGES) {
      setError('Choose at most five images per record. Remove an image first.');
      return;
    }
    if (
      candidates.some(
        (file) =>
          !IMAGE_ATTACHMENT_MIME_TYPES.includes(file.type as (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number]) ||
          !file.size ||
          file.size > MAX_ATTACHMENT_SIZE_BYTES,
      )
    ) {
      setError('Choose JPEG, PNG or WebP images, up to 10 MB each.');
      return;
    }
    const items = candidates.map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.add(url);
      return { id: crypto.randomUUID(), file, url, progress: 0 };
    });
    setPending((rows) => [...rows, ...items]);
    void send(items);
  };

  return (
    <section className="mt-3 min-w-0 space-y-2" aria-label="Attached images">
      {list.isLoading && <p className="text-xs text-muted-foreground">Loading images…</p>}
      {list.error && (
        <p role="alert" className="text-sm text-destructive">
          {(list.error as Error).message}{' '}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            Retry images
          </button>
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {list.data?.items.map((image, i) => {
          const file = hh(householdId, `/attachments/${image.id}/file`);
          return (
            <figure key={image.id} className="relative w-24 shrink-0">
              <a href={file} target="_blank" rel="noreferrer" aria-label={`Open attached image ${i + 1}`}>
                <img
                  src={`${file}?size=thumb`}
                  alt={`Attachment ${i + 1}`}
                  loading="lazy"
                  className="h-24 w-24 rounded-lg border object-cover"
                />
              </a>
              {!readOnly && list.data?.canDeleteIds.includes(image.id) && (
                <Button
                  type="button"
                  size="icon"
                  variant="destructive"
                  className="absolute right-0 top-0 h-8 w-8 rounded-lg"
                  aria-label={`Remove image ${i + 1}`}
                  disabled={busy || remove.isPending}
                  onClick={() => {
                    setError('');
                    remove.mutate(image.id);
                  }}
                >
                  <Trash2 />
                </Button>
              )}
            </figure>
          );
        })}
        {pending.map((item) => (
          <figure key={item.id} className="w-36 min-w-0 rounded-lg border p-2">
            <img
              src={item.url}
              alt={`Preview: ${item.file.name}`}
              className="h-24 w-full rounded object-cover"
            />
            <figcaption className="break-words text-xs">{item.file.name}</figcaption>
            {item.error ? (
              <>
                <p role="alert" className="break-words text-xs text-destructive">
                  {item.error}
                </p>
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void send([item])}
                  >
                    Retry
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => discard(item)}
                  >
                    Discard
                  </Button>
                </div>
              </>
            ) : (
              <>
                <progress
                  className="w-full"
                  max={100}
                  value={item.progress}
                  aria-label={`Uploading ${item.file.name}`}
                />
                <p className="text-xs" aria-live="polite">
                  {item.progress === 100 ? 'Processing…' : `Uploading ${item.progress}%`}
                </p>
              </>
            )}
          </figure>
        ))}
      </div>
      {!readOnly && list.data?.canUpload && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                busy || remove.isPending || list.data.items.length + pending.length >= MAX_RECORD_IMAGES
              }
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus /> Add images
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                busy || remove.isPending || list.data.items.length + pending.length >= MAX_RECORD_IMAGES
              }
              onClick={() => cameraRef.current?.click()}
            >
              <Camera /> Camera
            </Button>
            {busy && (
              <Button type="button" variant="ghost" size="sm" onClick={() => controller.current?.abort()}>
                Cancel upload
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            aria-label="Choose attachment images"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              select(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={cameraRef}
            type="file"
            aria-label="Take an attachment photo"
            accept={IMAGE_ACCEPT}
            capture="environment"
            hidden
            onChange={(e) => {
              select(e.target.files);
              e.target.value = '';
            }}
          />
          <p className="text-xs text-muted-foreground">
            Up to 5 images · JPEG, PNG, WebP · 10 MB each. Online only; images are saved after processing.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
