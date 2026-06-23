import os from 'os';
import path from 'path';
import fs from 'fs';
import { UPLOAD_DIR } from '../config.js';

export const IMAGE_MIME_TO_EXT = {
  'image/png':  '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif':  '.gif',
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB per image
export const MAX_IMAGES_PER_TURN = 4;

export function saveUploadedImage(img) {
  const mime = String(img?.mime || '').toLowerCase();
  const ext = IMAGE_MIME_TO_EXT[mime];
  if (!ext) return null;
  const dataStr = String(img?.fullData || img?.data || '').replace(/^data:image\/[a-z+]+;base64,/i, '');
  if (!dataStr) return null;
  let buf;
  try { buf = Buffer.from(dataStr, 'base64'); } catch { return null; }
  if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;
  const filePath = path.join(UPLOAD_DIR, filename);
  try { fs.writeFileSync(filePath, buf); } catch { return null; }
  return {
    filename,
    path: filePath,
    name: String(img.name || '').slice(0, 100) || filename,
    thumbData: typeof img.thumbData === 'string' ? img.thumbData.slice(0, 200_000) : null,
    bytes: buf.length,
    mime,
  };
}

export function resolveContainedDir(raw) {
  if (!raw) return { error: 'cwd required', status: 400 };
  const BASE = path.resolve(os.homedir());
  let dir;
  try { dir = path.resolve(String(raw)); } catch { return { error: 'Invalid path', status: 400 }; }
  let real, realBase;
  try { realBase = fs.realpathSync(BASE); real = fs.realpathSync(dir); }
  catch { return { error: 'Directory not found', status: 404 }; }
  if (real !== realBase && !real.startsWith(realBase + path.sep)) {
    return { error: 'Access denied', status: 403 };
  }
  if (!fs.statSync(real).isDirectory()) return { error: 'Not a directory', status: 400 };
  return { dir: real };
}
