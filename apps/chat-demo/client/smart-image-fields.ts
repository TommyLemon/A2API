/**
 * Shared smart-image field detection for table / detail / grid / create.
 *
 * Name must suggest an image (picture / image / photo / img / avatar …),
 * not bare url/uri/path. Values preferably show .jpg/.png/… (or data:image);
 * named image fields may still use extension-less CDN URLs.
 */

import { absoluteUploadUrl } from "./upload.js";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i;

/** picture / image / photo / img / pic / avatar / head / cover … (incl. abbreviations) */
const IMAGE_NAME_TOKEN_RE =
  /picture|pictures|photo|photos|image|images|img|imgs|pic|pics|avatar|head|icon|portrait|face|cover|gallery|banner|thumb|thumbnail/;

export function fieldColName(path: string): string {
  return path.includes(".") ? path.split(".").pop()! : path;
}

/** Column name contains an image-related word / abbreviation. */
export function hasImageNameToken(col: string): boolean {
  return IMAGE_NAME_TOKEN_RE.test(col.toLowerCase());
}

export function hasImageFileExt(s: string): boolean {
  return IMAGE_EXT_RE.test(s.trim());
}

/** Field names that typically hold a single image URL / path. */
export function isImageUrlFieldName(col: string): boolean {
  const c = col.toLowerCase();
  if (isImageListFieldName(c)) return false;
  // Classic avatar-like short names
  if (
    /^(head|avatar|photo|icon|img|image|portrait|face|cover|pic|thumb|thumbnail)$/.test(
      c,
    )
  ) {
    return true;
  }
  // Must include an image token — e.g. pictureUrl, imagePath, photoUri, imgSrc
  // (not callbackUrl / apiPath / filePath alone)
  return hasImageNameToken(c);
}

/**
 * Field names that typically hold a collection of image URLs.
 * e.g. pictureList, imageUrls, photoArr, photos — not bare urlList / pathArr
 */
export function isImageListFieldName(col: string): boolean {
  const c = col.toLowerCase();
  if (!hasImageNameToken(c)) return false;
  if (/^(pictures|photos|images|imgs|pics|gallery)$/.test(c)) return true;
  // pictureList / imageArray / photoArr / coverList
  if (/(list|array|arr)$/.test(c)) return true;
  // imageUrls / photoPaths / imgSrcs
  if (/(urls|uris|paths|srcs)$/.test(c)) return true;
  return false;
}

export function parseArrayValue(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const t = value.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function isUrlLike(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const t = v.trim();
  return (
    /^https?:\/\//i.test(t) ||
    t.startsWith("data:image") ||
    t.startsWith("blob:") ||
    (t.startsWith("/") && t.length > 1)
  );
}

/**
 * Value looks like an image URL.
 * @param loose when true (named image fields), allow http(s)/path without file ext
 */
export function isImageUrlLike(v: unknown, loose = false): boolean {
  if (!isUrlLike(v)) return false;
  const t = String(v).trim();
  if (t.startsWith("data:image") || t.startsWith("blob:")) return true;
  if (hasImageFileExt(t)) return true;
  if (!loose) return false;
  // Named image fields often use CDN URLs without .jpg/.png
  return /^https?:\/\//i.test(t) || t.startsWith("/");
}

export function isImageUrlField(path: string, value: unknown): boolean {
  const col = fieldColName(path);
  if (isImageListFieldName(col)) return false;
  if (isImageUrlFieldName(col)) {
    const s = String(value ?? "").trim();
    // Named image field: empty OK, or any url-like (ext optional)
    return !s || isImageUrlLike(s, true);
  }
  // No image token in name — only treat as image when value has image evidence
  return typeof value === "string" && isImageUrlLike(value, false);
}

/** pictureList / imageUrls / photoArr — or arrays mostly with .jpg/.png/… values. */
export function isImageListField(path: string, value: unknown): boolean {
  const col = fieldColName(path).toLowerCase();
  const nameSuggests = isImageListFieldName(col);
  const arr = parseArrayValue(value);
  if (nameSuggests) {
    if (arr != null || value == null || value === "") return true;
    return typeof value === "string" && isImageUrlLike(value, true);
  }
  if (!arr || !arr.length) return false;
  // Value-only: majority must have .jpg/.png/data:image (not bare http)
  const asImages = arr.filter((v) => isImageUrlLike(v, false));
  return asImages.length > 0 && asImages.length >= Math.ceil(arr.length * 0.5);
}

/** Collect displayable image URLs from a field (single or list). */
export function collectImageUrls(path: string, value: unknown): string[] {
  const loose =
    isImageListFieldName(fieldColName(path)) ||
    isImageUrlFieldName(fieldColName(path));
  if (isImageListField(path, value)) {
    const arr = parseArrayValue(value);
    if (arr) {
      return arr
        .map((v) => String(v ?? "").trim())
        .filter((s) => s && isImageUrlLike(s, loose));
    }
    if (typeof value === "string" && isImageUrlLike(value, loose)) {
      return [value.trim()];
    }
    return [];
  }
  if (isImageUrlField(path, value)) {
    const s = String(value ?? "").trim();
    return s ? [s] : [];
  }
  return [];
}

/** Resolve relative /download paths against APIJSON base for <img src>. */
export function resolveImageSrc(url: string, apijsonBase: string): string {
  const s = url.trim();
  if (!s) return s;
  if (
    /^https?:\/\//i.test(s) ||
    s.startsWith("data:") ||
    s.startsWith("blob:")
  ) {
    return s;
  }
  if (s.startsWith("/")) return absoluteUploadUrl(apijsonBase, s);
  return s;
}

/** Score a column path for picking the best grid thumbnail source. */
export function scoreImageFieldPath(
  path: string,
  primaryTable: string | null,
): number {
  const col = fieldColName(path).toLowerCase();
  let score = 1;
  if (primaryTable && path.startsWith(`${primaryTable}.`)) score += 20;
  if (/^(head|avatar|photo|icon|img|image|portrait|face|cover)$/.test(col)) {
    score += 50;
  } else if (isImageListFieldName(col)) {
    score += 45;
  } else if (hasImageNameToken(col)) {
    score += 40;
  }
  return score;
}
