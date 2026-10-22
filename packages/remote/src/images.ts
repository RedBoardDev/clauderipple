// Transcript/SDK boundary: only referenced local cache files and raster base64 images.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ATTACHMENT_CAP, ATTACHMENT_COUNT, type Attachment, type ImagePart } from "./protocol.ts";

export type InputBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; data: string } };

/** Validate everything before writing; generated filenames cannot escape or overwrite a user file. */
export function attachmentContent(cwd: string, text: string, attachments: Attachment[], read: (id: string) => string | null): { content: string | InputBlock[]; images: ImagePart[] } {
  if (!Array.isArray(attachments) || attachments.length > ATTACHMENT_COUNT) throw new Error(`At most ${ATTACHMENT_COUNT} attachments.`);
  const items = attachments.map(a => {
    if (!a || typeof a.name !== "string" || typeof a.mediaType !== "string") throw new Error("Invalid attachment.");
    const data = read(a.blob);
    if (!data || data.length > Math.ceil(ATTACHMENT_CAP / 3) * 4 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("Attachment missing or too large (8 MB limit).");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > ATTACHMENT_CAP) throw new Error("Attachment exceeds 8 MB.");
    if (a.mediaType.startsWith("image/") && !MIME.has(a.mediaType)) throw new Error("Use PNG, JPEG, GIF or WebP images.");
    return { a, data, bytes };
  });
  const blocks: InputBlock[] = [], images: ImagePart[] = [];
  const mentions: string[] = [];
  for (const { a, data, bytes } of items) {
    if (a.mediaType === "image/png" || a.mediaType === "image/jpeg" || a.mediaType === "image/gif" || a.mediaType === "image/webp") {
      blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType, data } });
      images.push({ type: "image", blob: a.blob, mediaType: a.mediaType });
      continue;
    }
    const root = path.join(cwd, ".ripple-attachments");
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Attachment folder must not be a symlink.");
    const name = a.name.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-100) || "file";
    const file = path.join(root, `${a.blob}-${name}`);
    try {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        if (!fs.fstatSync(fd).isFile() || !fs.readFileSync(fd).equals(bytes)) throw new Error("Attachment filename collision.");
      } finally { fs.closeSync(fd); }
    }
    mentions.push(`Attached file: ${JSON.stringify(file)}`);
  }
  const prompt = [text, ...mentions].filter(Boolean).join("\n\n");
  return { content: blocks.length ? [{ type: "text", text: prompt || "Please inspect these images." }, ...blocks] : prompt, images };
}

export type ImageSink = (base64: string) => string;
const MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Extension → media type for the raster formats the app shows; anything else is not an image. */
const EXT_MEDIA: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
const MAX_BYTES = 32 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Both the lexical and real path must remain in the same cache root. */
export function imageCachePath(file: string, home = os.homedir()): string | null {
  if (!path.isAbsolute(file)) return null;
  const normalized = path.resolve(file);
  const claude = path.join(home, ".claude");
  const tempRoots = [...new Set(["/tmp", "/private/tmp", os.tmpdir()])];
  const tempRoot = tempRoots.find(root => normalized.startsWith(root + path.sep));
  const cache = tempRoot ? path.relative(tempRoot, normalized).split(path.sep) : [];
  const imageIndex = cache.lastIndexOf("images");
  const tmp = /^claude-[^/]+$/.test(cache[0] ?? "") && imageIndex >= 1
    ? path.join(tempRoot!, ...cache.slice(0, imageIndex + 1)) : undefined;
  const root = normalized.startsWith(claude + path.sep) ? claude : tmp;
  if (!root) return null;
  try {
    const realRoot = fs.realpathSync(root);
    // A symlinked cache directory itself must not authorize an arbitrary directory.
    const expectedRoot = root.startsWith("/tmp/") ? "/private" + root : root;
    const platformRoot = root === claude ? path.join(fs.realpathSync(home), ".claude")
      : tempRoot && tmp ? path.join(fs.realpathSync(tempRoot), ...cache.slice(0, imageIndex + 1)) : expectedRoot;
    if (realRoot !== platformRoot) return null;
    const real = fs.realpathSync(normalized);
    return real.startsWith(realRoot + path.sep) ? real : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

function fileImage(file: string, sink?: ImageSink): ImagePart {
  const mediaType = EXT_MEDIA[path.extname(file).toLowerCase()] ?? "image/png";
  const unavailable: ImagePart = { type: "image", mediaType };
  const real = imageCachePath(file);
  if (!real || !sink || !/\.(png|jpe?g|gif|webp)$/i.test(file)) return unavailable;
  let fd: number;
  try { fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) {
    if (["ENOENT", "ELOOP", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return unavailable;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const checked = imageCachePath(file);
    if (checked !== real) return unavailable;
    const current = fs.statSync(checked, { bigint: true });
    // Windows path stats report dev as zero while handle stats do not; its ino, size and birth time agree.
    const sameDevice = current.dev === 0n || stat.dev === 0n || current.dev === stat.dev;
    if (!sameDevice || current.ino !== stat.ino || current.size !== stat.size || current.birthtimeNs !== stat.birthtimeNs) return unavailable;
    if (!stat.isFile() || stat.size > BigInt(MAX_BYTES) || !MIME.has(mediaType)) return unavailable;
    return { ...unavailable, blob: sink(fs.readFileSync(fd).toString("base64")) };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return unavailable;
    throw error;
  } finally { fs.closeSync(fd); }
}

/** Original bytes are retained; clients scale thumbnails (no platform-specific sips dependency). */
export function messageContent(content: unknown, sink?: ImageSink): { text: string; images: ImagePart[] } {
  const texts: string[] = [], images: ImagePart[] = [];
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  for (const value of blocks) {
    const block = object(value);
    if (block?.type === "text" && typeof block.text === "string") {
      const stripped = block.text.replace(/\[Image: source: ([^\]\r\n]+)\]/g, (_match, file: string) => {
        images.push(fileImage(file.trim(), sink));
        return "";
      });
      if (stripped) texts.push(stripped);
    }
    if (block?.type !== "image") continue;
    const source = object(block.source);
    const mediaType = typeof source?.media_type === "string" && MIME.has(source.media_type) ? source.media_type : "image/png";
    const part: ImagePart = { type: "image", mediaType };
    if (source?.type === "base64" && typeof source.data === "string" && MIME.has(String(source.media_type)) &&
        source.data.length <= Math.ceil(MAX_BYTES / 3) * 4 && source.data.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(source.data) && !/=/.test(source.data.slice(0, -2)) && /[A-Za-z0-9+/](?:[A-Za-z0-9+/]{2}|[A-Za-z0-9+/]=|==)$/.test(source.data) && source.data && sink) {
      part.blob = sink(source.data);
    }
    images.push(part);
  }
  return { text: texts.join("\n\n"), images };
}

/**
 * The images a `SendUserFile` tool call hands the person. Each listed path that is a regular raster
 * image of ATTACHMENT_CAP or less is read through the blob sink (bytes travel in the chunked blob
 * transport, never inline in an event). A relative path resolves against cwd; an absolute one may sit
 * anywhere (the tool's own files usually live in a scratchpad outside the project), as the official app
 * shows them too, and they only ever reach the paired phone. A non-regular file, a missing file, a
 * non-image extension or an oversized file yields no image and throws nothing, so the tool row stands
 * on its own.
 */
export function sendUserFileImages(content: unknown, cwd: string, sink?: ImageSink): ImagePart[] {
  if (!sink) return [];
  const images: ImagePart[] = [];
  for (const value of Array.isArray(content) ? content : []) {
    const block = object(value);
    if (block?.type !== "tool_use" || block.name !== "SendUserFile") continue;
    const files = object(block.input)?.files;
    for (const file of Array.isArray(files) ? files : []) {
      const part = userFileImage(typeof file === "string" ? file : "", cwd, sink);
      if (part) images.push(part);
    }
  }
  return images;
}

/** One listed file as an ImagePart, or null when it is not a regular raster image within the cap. */
function userFileImage(file: string, cwd: string, sink: ImageSink): ImagePart | null {
  const mediaType = EXT_MEDIA[path.extname(file).toLowerCase()];
  if (!file || !mediaType || !MIME.has(mediaType)) return null;
  let fd: number;
  try { fd = fs.openSync(fs.realpathSync(path.resolve(cwd, file)), fs.constants.O_RDONLY); }
  catch { return null; } // Missing, unreadable or a broken link: the event must still be written.
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > ATTACHMENT_CAP) return null; // Never a directory, FIFO or device.
    return { type: "image", mediaType, blob: sink(fs.readFileSync(fd).toString("base64")) };
  } catch { return null; } finally { fs.closeSync(fd); }
}
