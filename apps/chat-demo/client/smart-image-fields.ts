/**
 * Shared smart-image field detection for table / detail / grid / create.
 *
 * Evidence (strong → soft):
 * 1. Value is url-like AND has image file ext (.jpg/.png/…) or data:image
 * 2. Field name segments (head, avatar, pictureUrl, …) OR column comment
 *    (头像 / Avatar / 图片 …) plus a url-like value (CDN may omit extension)
 *
 * DDL `show` override (ColumnMeta.show): picture forces image UI; text/file disables it;
 * auto (default) uses evidence above.
 *
 * Bare url/uri/path names (callbackUrl, apiPath) are NOT enough without (1).
 */

import { absoluteUploadUrl } from "./upload.js";
import type { SchemaComments } from "./schema-types.js";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)(\?|#|$)/i;

/** Segments that mean “this field holds image(s)”. Matched on camelCase/snake parts. */
const IMAGE_SEGMENTS = new Set([
  "picture",
  "pictures",
  "photo",
  "photos",
  "image",
  "images",
  "img",
  "imgs",
  "pic",
  "pics",
  "avatar",
  "head", // profile avatar (APIJSON User.head) — not “header”
  "icon",
  "portrait",
  "face",
  "cover",
  "gallery",
  "banner",
  "thumb",
  "thumbnail",
]);

/** Profile / avatar semantics — soft evidence when value is url-like without ext. */
const AVATAR_SEGMENTS = new Set([
  "head",
  "avatar",
  "portrait",
  "face",
  "icon",
  "photo",
  "img",
  "pic",
  "thumb",
  "thumbnail",
  "cover",
]);

const COLLECTION_SEGMENTS = new Set([
  "list",
  "array",
  "arr",
  "urls",
  "uris",
  "paths",
  "srcs",
]);

/** Column comment hints: 头像 / Avatar / 图片 / photo … */
const IMAGE_COMMENT_RE =
  /头像|照片|图片|图像|相片|封面|插图|缩略图|形象|肖像|图集|相册|avatar|photo(?:graph)?s?|images?|pictures?|portraits?|thumbnails?|covers?|icons?|banners?|gallery|face\b/i;

const IMAGE_LIST_COMMENT_RE =
  /图片列表|照片列表|图像列表|图集|相册|picture\s*lists?|photo\s*lists?|image\s*lists?|galleries/i;

export type ImageFieldComments = Pick<SchemaComments, "columns"> | null | undefined;

/** Mirrors ColumnMeta.show — kept local to avoid import cycles with field-meta. */
export type ImageShowMode = "auto" | "text" | "picture" | "file";

export function fieldColName(path: string): string {
  return path.includes(".") ? path.split(".").pop()! : path;
}

/** Split camelCase / snake_case / digits into lowercase segments. */
export function fieldNameSegments(col: string): string[] {
  return col
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function hasImageNameToken(col: string): boolean {
  return fieldNameSegments(col).some((s) => IMAGE_SEGMENTS.has(s));
}

/** head / avatar / portrait … — soft evidence for profile images. */
export function isAvatarLikeFieldName(col: string): boolean {
  const segs = fieldNameSegments(col);
  if (segs.length === 1 && AVATAR_SEGMENTS.has(segs[0]!)) return true;
  return segs.some((s) => AVATAR_SEGMENTS.has(s));
}

/** Raw column comment for Table.col (not “Table · comment”). */
export function columnCommentOnly(
  path: string,
  comments?: ImageFieldComments,
): string {
  const cols = comments?.columns;
  if (!cols) return "";
  if (cols[path]) return cols[path]!;
  const col = fieldColName(path);
  if (cols[col]) return cols[col]!;
  if (!path.includes(".")) {
    for (const [k, v] of Object.entries(cols)) {
      if (k.endsWith(`.${col}`)) return v;
    }
  }
  return "";
}

export function commentSuggestsImage(comment: string): boolean {
  const t = comment.trim();
  if (!t) return false;
  return IMAGE_COMMENT_RE.test(t);
}

export function commentSuggestsImageList(comment: string): boolean {
  const t = comment.trim();
  if (!t) return false;
  if (IMAGE_LIST_COMMENT_RE.test(t)) return true;
  return IMAGE_COMMENT_RE.test(t) && /列表|lists?|arrays?|集合|json/i.test(t);
}

export function hasImageFileExt(s: string): boolean {
  return IMAGE_EXT_RE.test(s.trim());
}

/** Field names that typically hold a single image URL / path. */
export function isImageUrlFieldName(col: string): boolean {
  const c = col.toLowerCase();
  if (isImageListFieldName(c)) return false;
  return hasImageNameToken(c);
}

/**
 * Field names that typically hold a collection of image URLs.
 * e.g. pictureList, imageUrls, photoArr, photos — not bare urlList / pathArr
 */
export function isImageListFieldName(col: string): boolean {
  const segs = fieldNameSegments(col);
  if (!segs.some((s) => IMAGE_SEGMENTS.has(s))) return false;
  if (
    segs.length === 1 &&
    /^(pictures|photos|images|imgs|pics|gallery)$/.test(segs[0]!)
  ) {
    return true;
  }
  return segs.some((s) => COLLECTION_SEGMENTS.has(s));
}

/** Name or comment suggests a single image field. */
export function fieldSuggestsImage(
  path: string,
  comments?: ImageFieldComments,
): boolean {
  const col = fieldColName(path);
  if (isImageListFieldName(col) || commentSuggestsImageList(columnCommentOnly(path, comments))) {
    return false;
  }
  return (
    isImageUrlFieldName(col) ||
    commentSuggestsImage(columnCommentOnly(path, comments))
  );
}

/** Name or comment suggests an image list field. */
export function fieldSuggestsImageList(
  path: string,
  comments?: ImageFieldComments,
): boolean {
  const col = fieldColName(path);
  return (
    isImageListFieldName(col) ||
    commentSuggestsImageList(columnCommentOnly(path, comments))
  );
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

/** 1st evidence: url-like value with image ext / data:image / blob. */
export function hasStrongImageValueEvidence(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t) return false;
  if (t.startsWith("data:image") || t.startsWith("blob:")) return true;
  return isUrlLike(t) && hasImageFileExt(t);
}

/**
 * Value looks like an image URL.
 * @param loose when true (named/comment image fields), allow http(s)/path without file ext
 */
export function isImageUrlLike(v: unknown, loose = false): boolean {
  if (hasStrongImageValueEvidence(v)) return true;
  if (!loose) return false;
  if (!isUrlLike(v)) return false;
  const t = String(v).trim();
  return /^https?:\/\//i.test(t) || t.startsWith("/");
}

export function isImageUrlField(
  path: string,
  value: unknown,
  comments?: ImageFieldComments,
): boolean {
  if (fieldSuggestsImageList(path, comments)) return false;

  // 1st evidence — any field name
  if (hasStrongImageValueEvidence(value)) return true;

  // 2nd evidence — name or comment (头像 / Avatar …) + url-like
  if (fieldSuggestsImage(path, comments)) {
    const s = String(value ?? "").trim();
    return !s || isImageUrlLike(s, true);
  }
  return false;
}

/** pictureList / imageUrls / photoArr — or arrays mostly with strong image values. */
export function isImageListField(
  path: string,
  value: unknown,
  comments?: ImageFieldComments,
): boolean {
  const nameSuggests = fieldSuggestsImageList(path, comments);
  const arr = parseArrayValue(value);
  if (nameSuggests) {
    if (arr != null || value == null || value === "") return true;
    return typeof value === "string" && isImageUrlLike(value, true);
  }
  if (!arr || !arr.length) return false;
  const strong = arr.filter((v) => hasStrongImageValueEvidence(v));
  return strong.length > 0 && strong.length >= Math.ceil(arr.length * 0.5);
}

/** Collect url-like strings from a value (for forced picture / file Show). */
function collectUrlLikeValues(value: unknown, loose: boolean): string[] {
  const arr = parseArrayValue(value);
  if (arr) {
    return arr
      .map((v) => String(v ?? "").trim())
      .filter((s) => s && (loose ? isUrlLike(s) : isImageUrlLike(s, false)));
  }
  const s = String(value ?? "").trim();
  if (!s) return [];
  if (loose ? isUrlLike(s) : isImageUrlLike(s, false)) return [s];
  return [];
}

/** Collect displayable image URLs from a field (single or list). */
export function collectImageUrls(
  path: string,
  value: unknown,
  comments?: ImageFieldComments,
  show: ImageShowMode = "auto",
): string[] {
  if (show === "text" || show === "file") return [];
  if (show === "picture") {
    return collectUrlLikeValues(value, true);
  }

  const loose =
    fieldSuggestsImageList(path, comments) ||
    fieldSuggestsImage(path, comments);

  if (isImageListField(path, value, comments)) {
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

  if (hasStrongImageValueEvidence(value)) {
    return [String(value).trim()];
  }
  if (isImageUrlField(path, value, comments)) {
    const s = String(value ?? "").trim();
    return s && isImageUrlLike(s, true) ? [s] : [];
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

/**
 * Score a column for grid thumbnail picking.
 * Strong value evidence ranks above avatar/image name / comment semantics.
 */
export function scoreImageFieldPath(
  path: string,
  primaryTable: string | null,
  value?: unknown,
  comments?: ImageFieldComments,
): number {
  const col = fieldColName(path);
  const comment = columnCommentOnly(path, comments);
  let score = 1;
  if (primaryTable && path.startsWith(`${primaryTable}.`)) score += 20;

  // 1st evidence
  if (value !== undefined && hasStrongImageValueEvidence(value)) {
    score += 80;
  } else if (value !== undefined) {
    const arr = parseArrayValue(value);
    if (arr?.some((v) => hasStrongImageValueEvidence(v))) score += 75;
  }

  // 2nd evidence — avatar / image name or comment (头像 / Avatar)
  if (commentSuggestsImageList(comment)) {
    score += 45;
  } else if (
    (isAvatarLikeFieldName(col) || commentSuggestsImage(comment)) &&
    !isImageListFieldName(col)
  ) {
    score += 50;
  } else if (isImageListFieldName(col)) {
    score += 45;
  } else if (hasImageNameToken(col) || commentSuggestsImage(comment)) {
    score += 40;
  }
  return score;
}

/** Unified result for table / grid / detail / create smart-image UI. */
export type SmartImageKind = "single" | "list" | "none";

export type SmartImageField = {
  kind: SmartImageKind;
  /** Displayable image URLs (may be empty for named image fields with no value yet). */
  urls: string[];
};

/**
 * Single entry point for smart-image detection.
 * Table / grid / detail / create must reuse this — do not re-implement locally.
 *
 * @param show DDL Show override (`ColumnMeta.show`): picture / text / file / auto
 *
 * Evidence order (when show=auto): strong value (.jpg/…) → name / comment (头像…).
 */
export function resolveSmartImageField(
  path: string,
  value: unknown,
  comments?: ImageFieldComments,
  show: ImageShowMode = "auto",
): SmartImageField {
  const mode = show || "auto";
  if (mode === "text" || mode === "file") {
    return { kind: "none", urls: [] };
  }
  if (mode === "picture") {
    const urls = collectImageUrls(path, value, comments, "picture");
    const list =
      fieldSuggestsImageList(path, comments) ||
      (parseArrayValue(value)?.length ?? 0) > 1 ||
      urls.length > 1;
    return { kind: list ? "list" : "single", urls };
  }
  // auto
  if (isImageListField(path, value, comments)) {
    return {
      kind: "list",
      urls: collectImageUrls(path, value, comments, "auto"),
    };
  }
  if (isImageUrlField(path, value, comments)) {
    return {
      kind: "single",
      urls: collectImageUrls(path, value, comments, "auto"),
    };
  }
  return { kind: "none", urls: [] };
}

/** True when the field should use image UI (even if urls empty — e.g. create form). */
export function isSmartImageField(
  path: string,
  value: unknown,
  comments?: ImageFieldComments,
  show: ImageShowMode = "auto",
): boolean {
  return resolveSmartImageField(path, value, comments, show).kind !== "none";
}

/**
 * Pick the best thumbnail URL from a row for grid cards.
 * Scans column list + all cell keys; scores via {@link scoreImageFieldPath}.
 */
export function pickBestImageUrl(
  cells: Record<string, unknown>,
  primaryTable: string | null,
  columns: string[],
  comments?: ImageFieldComments,
  showByPath?: Record<string, ImageShowMode | undefined> | null,
): string | null {
  let best: { url: string; score: number } | null = null;
  const paths = [...new Set([...columns, ...Object.keys(cells)])];
  for (const path of paths) {
    const value = cells[path];
    const show = showByPath?.[path] ?? "auto";
    if (show === "text" || show === "file") continue;
    const { urls } = resolveSmartImageField(path, value, comments, show);
    const url = urls[0] ?? null;
    if (!url) continue;
    let score = scoreImageFieldPath(path, primaryTable, value, comments);
    if (show === "picture") score += 30;
    if (!best || score > best.score) best = { url, score };
  }
  return best?.url ?? null;
}

/** Collect a single file URL for Show=file cells. */
export function collectFileUrl(value: unknown): string | null {
  const urls = collectUrlLikeValues(value, true);
  return urls[0] ?? null;
}
