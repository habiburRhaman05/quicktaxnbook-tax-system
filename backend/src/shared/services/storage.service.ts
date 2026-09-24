import crypto from 'crypto';
import path from 'path';

import { del, put } from '@vercel/blob';
import { StoredFile } from '@prisma/client';

import prisma from '@/client';
import config from '@/config/config';

export interface SaveFileParams {
  firmId?: string;
  uploadedById?: string;
  subDir: string; // e.g. "avatars", "firm-logos"
  originalName: string;
  mimeType: string;
  buffer: Buffer;
  uploadIp?: string;
}

/** Uploads a buffer to Vercel Blob and records it as a StoredFile row.
 * Works identically in local dev and in production - Blob is a hosted
 * service, not tied to the deployment filesystem, which is what makes it
 * safe to use from Vercel's read-only serverless functions. */
export const saveFile = async (params: SaveFileParams): Promise<StoredFile> => {
  const ext = path.extname(params.originalName).toLowerCase();
  const pathname = `${params.subDir}/${crypto.randomUUID()}${ext}`;

  const blob = await put(pathname, params.buffer, {
    access: 'public',
    contentType: params.mimeType,
    addRandomSuffix: false,
    token: config.storage.blobToken,
  });

  const checksumSha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');

  return prisma.storedFile.create({
    data: {
      firmId: params.firmId,
      provider: 'VERCEL_BLOB',
      bucket: 'vercel-blob',
      // The blob's public URL is globally unique and permanent - stored
      // directly as the key rather than reconstructed from a bucket+path
      // pattern the way S3/local storage would be.
      key: blob.url,
      originalName: params.originalName,
      mimeType: params.mimeType,
      sizeBytes: BigInt(params.buffer.byteLength),
      checksumSha256,
      virusScanStatus: 'SKIPPED',
      uploadedById: params.uploadedById,
      uploadIp: params.uploadIp,
    },
  });
};

/** Public URL for a StoredFile saved via saveFile. */
export const fileUrl = (storedFile: Pick<StoredFile, 'provider' | 'key'>): string | null => {
  if (storedFile.provider !== 'VERCEL_BLOB') return null;
  return storedFile.key;
};

export const deleteFile = async (storedFile: Pick<StoredFile, 'provider' | 'key'>): Promise<void> => {
  if (storedFile.provider !== 'VERCEL_BLOB') return;
  await del(storedFile.key, { token: config.storage.blobToken });
};
