import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Attachment } from '../../types.js';

const UPLOADS_DIR = path.resolve('./uploads');

// Ensure uploads directory exists
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

/**
 * Download an attachment and save it locally.
 * Returns an object with the local path and a relative reference for the issue body.
 */
export async function saveAttachment(attachment: Attachment): Promise<{ localPath: string; fileName: string }> {
  const response = await fetch(attachment.url);
  if (!response.ok) {
    throw new Error(`Failed to download ${attachment.name}: ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());

  // Sanitize filename, add short hash to avoid collisions
  const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const hash = crypto.randomBytes(4).toString('hex');
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);
  const fileName = `${base}-${hash}${ext}`;

  const localPath = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(localPath, buffer);

  return { localPath, fileName };
}

/**
 * Get the absolute path to the uploads directory.
 */
export function getUploadsDir(): string {
  return UPLOADS_DIR;
}

/**
 * Copy a file from uploads into the target workspace directory.
 * Creates the destination directory if it doesn't exist.
 */
export function copyToWorkspace(fileName: string, destDir: string, destName?: string): string {
  const src = path.join(UPLOADS_DIR, fileName);
  if (!fs.existsSync(src)) {
    throw new Error(`Upload not found: ${fileName}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  const finalName = destName || fileName;
  const dest = path.join(destDir, finalName);
  fs.copyFileSync(src, dest);
  return dest;
}

/**
 * Delete uploaded files after a job completes.
 */
export function deleteUploads(fileNames: string[]): void {
  for (const fileName of fileNames) {
    const filePath = path.join(UPLOADS_DIR, fileName);
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Already gone — not a problem
    }
  }
}
