import httpStatus from 'http-status';
import multer from 'multer';

import ApiError from '@/shared/utils/api-error';

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);

/** In-memory image upload (avatars/logos) - persisted to disk by storage.service. */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      cb(new ApiError(httpStatus.BAD_REQUEST, 'Only PNG, JPEG, or WEBP images are allowed'));
      return;
    }
    cb(null, true);
  },
});

const ALLOWED_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
]);

/**
 * In-memory client document upload, forwarded straight to the firm's
 * GoHighLevel Media Library. Held in memory rather than on disk because the
 * app must run on read-only/serverless filesystems.
 */
export const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_DOCUMENT_TYPES.has(file.mimetype)) {
      cb(new ApiError(httpStatus.BAD_REQUEST, 'Only PDF, JPG, PNG, DOC or DOCX files are allowed'));
      return;
    }
    cb(null, true);
  },
});
