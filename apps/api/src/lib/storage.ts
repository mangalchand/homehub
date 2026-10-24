import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

export interface ObjectStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

class LocalStorage implements ObjectStorage {
  constructor(private root: string) {}
  private file(key: string) {
    const p = path.resolve(this.root, key);
    if (!p.startsWith(path.resolve(this.root) + path.sep)) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.file(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    try {
      return await readFile(this.file(key));
    } catch {
      return null;
    }
  }
  async remove(key: string) {
    await rm(this.file(key), { force: true });
  }
}

class S3Storage implements ObjectStorage {
  private client = new S3Client({ region: config.AWS_REGION });
  constructor(private bucket: string) {}
  async put(key: string, body: Buffer, contentType: string) {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
  }
  async get(key: string) {
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return r.Body ? Buffer.from(await r.Body.transformToByteArray()) : null;
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey') return null;
      throw e;
    }
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let instance: ObjectStorage | null = null;
export function storage(): ObjectStorage {
  if (!instance) {
    if (config.STORAGE_DRIVER === 's3') {
      if (!config.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
      instance = new S3Storage(config.S3_BUCKET);
    } else instance = new LocalStorage(config.UPLOAD_DIR);
  }
  return instance;
}
