/**
 * APIJSON Demo file upload: POST multipart /upload → { path: "/download/…" }.
 * Full URL = apijsonBase + path (for pictureList verifyURLList).
 */

export type UploadResult = {
  url: string;
  path: string;
  size?: number;
};

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Join host + path from /upload into an absolute http(s) URL. */
export function absoluteUploadUrl(baseUrl: string, path: string): string {
  const base = normalizeBase(baseUrl);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export async function uploadFile(
  baseUrl: string,
  file: File,
): Promise<UploadResult> {
  const base = normalizeBase(baseUrl);
  const form = new FormData();
  form.append("file", file, file.name || "file");
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    body: form,
    credentials: "include",
  });
  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    code?: number;
    msg?: string;
    path?: string;
    size?: number;
  } | null;
  const path = typeof data?.path === "string" ? data.path.trim() : "";
  if (!res.ok || !path || data?.code === 400 || data?.ok === false) {
    throw new Error(
      data?.msg || `Upload failed (${res.status}) for ${file.name}`,
    );
  }
  return {
    path,
    url: absoluteUploadUrl(base, path),
    size: data?.size,
  };
}

/** Upload several files; returns absolute URLs in order. */
export async function uploadFiles(
  baseUrl: string,
  files: File[],
): Promise<string[]> {
  const urls: string[] = [];
  for (const file of files) {
    const { url } = await uploadFile(baseUrl, file);
    urls.push(url);
  }
  return urls;
}

/**
 * If value is a data:/blob: URL, upload it; if already http(s), keep.
 * Used as a submit-time safety net for leftover local previews.
 */
export async function ensureRemoteImageUrl(
  baseUrl: string,
  value: string,
): Promise<string> {
  const s = value.trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith("/download/") || s.startsWith("/upload/")) {
    return absoluteUploadUrl(baseUrl, s);
  }
  if (!s.startsWith("data:") && !s.startsWith("blob:")) return s;

  const res = await fetch(s);
  const blob = await res.blob();
  const ext =
    blob.type === "image/png"
      ? "png"
      : blob.type === "image/webp"
        ? "webp"
        : blob.type === "image/gif"
          ? "gif"
          : "jpg";
  const file = new File([blob], `image.${ext}`, {
    type: blob.type || "image/jpeg",
  });
  const { url } = await uploadFile(baseUrl, file);
  return url;
}

export async function ensureRemoteImageList(
  baseUrl: string,
  values: unknown[],
): Promise<string[]> {
  const out: string[] = [];
  for (const v of values) {
    const s = String(v ?? "").trim();
    if (!s) continue;
    out.push(await ensureRemoteImageUrl(baseUrl, s));
  }
  return out;
}
