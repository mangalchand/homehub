import type { AttachmentDTO } from '@familyhub/shared';
import { api, ApiRequestError } from './api';

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';
export const MAX_RECORD_IMAGES = 5;

/** XHR supplies actual byte progress; uploads are never placed in the offline mutation queue. */
export async function uploadAttachment(
  path: string,
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
  retried = false,
): Promise<AttachmentDTO> {
  if (!navigator.onLine) throw new Error('You are offline. Connect before uploading images.');
  const { csrfToken } = await api<{ csrfToken: string }>('/api/v1/auth/csrf');
  if (signal?.aborted) throw new Error('Upload cancelled');
  try {
    return await new Promise<AttachmentDTO>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const done = () => signal?.removeEventListener('abort', abort);
      xhr.open('POST', path);
      xhr.withCredentials = true;
      xhr.timeout = 120_000;
      xhr.setRequestHeader('x-csrf-token', csrfToken);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded * 100) / e.total));
      };
      xhr.onload = () => {
        done();
        let data;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          reject(new Error('Unexpected upload response. Refresh images before retrying.'));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as AttachmentDTO);
        else
          reject(
            new ApiRequestError(
              xhr.status,
              data?.error?.code ?? 'UPLOAD',
              data?.error?.message ?? 'Upload failed',
            ),
          );
      };
      xhr.onerror = () => {
        done();
        reject(new Error('Connection lost. Refresh images before retrying; this upload may not have saved.'));
      };
      xhr.ontimeout = () => {
        done();
        reject(new Error('Upload timed out. Refresh images before retrying.'));
      };
      xhr.onabort = () => {
        done();
        reject(new Error('Upload cancelled'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      const form = new FormData();
      form.append('file', file);
      xhr.send(form);
    });
  } catch (e) {
    if (!retried && e instanceof ApiRequestError && e.status === 403 && e.code === 'CSRF') {
      return uploadAttachment(path, file, onProgress, signal, true);
    }
    throw e;
  }
}
