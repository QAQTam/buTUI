/**
 * 图片加载与安全策略 —— SPEC §12.3。
 *
 * 五条要求逐条对应到代码：
 *   1. 只允许白名单路径或明确授权的 URL  → `roots` + `allowRemote` + `authorizeRemote`
 *   2. 限制 MIME                          → `sniffMime`（看魔数，不信扩展名 / Content-Type）
 *   3. 限制大小                           → `maxBytes`（读之前先看 size，远程流式截断）
 *   4. 不把图片内容拼进 shell             → 全程没有 shell；Bun.Image 只收字节
 *   5. 不信任 terminal escape             → 输出的转义序列全部由我们自己生成（见 encode.ts）
 *
 * 特别地：**永远不要把用户可控的字符串直接喂给 `new Bun.Image(path)`**，
 * 那是任意文件读取原语（Bun 官方文档明确警告）。这里先把路径过一遍白名单，
 * 再用 `Bun.file()` 读字节，只把字节交给 Bun.Image。
 */
import { isAbsolute, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";

export class ImageSecurityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ImageSecurityError";
    this.code = code;
  }
}

export interface ImagePolicy {
  /** 允许的根目录（默认 `[process.cwd()]`）；symlink 会被 realpath 解掉 */
  roots?: string[];
  /** 单张图最大字节数，默认 16 MiB */
  maxBytes?: number;
  /** 最大像素数，默认 4096×4096（传给 Bun.Image 做解压炸弹防护） */
  maxPixels?: number;
  /** 允许的 MIME（默认见 DEFAULT_MIME） */
  allowMime?: string[];
  /** 是否允许 http(s) 远程图片；默认 false（SPEC §12.3「远程图片默认需要授权」） */
  allowRemote?: boolean;
  /** 远程图片的逐次授权回调；给了就必须返回 true 才继续 */
  authorizeRemote?: (url: string) => boolean | Promise<boolean>;
  /** 是否允许 data: URL（默认允许，仍然受 maxBytes 约束） */
  allowDataUrls?: boolean;
  /** 注入 fetch，便于测试 */
  fetch?: typeof fetch;
}

export const DEFAULT_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/heic",
];

export const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_PIXELS = 4096 * 4096;

/** 从魔数判断 MIME；不认识就返回 undefined（而不是猜扩展名） */
export function sniffMime(bytes: Uint8Array): string | undefined {
  const at = (offset: number, text: string): boolean => {
    if (bytes.length < offset + text.length) return false;
    for (let i = 0; i < text.length; i++) {
      if (bytes[offset + i] !== text.charCodeAt(i)) return false;
    }
    return true;
  };

  if (bytes.length >= 8 && at(0, "\x89PNG\r\n\x1a\n")) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if (at(0, "BM")) return "image/bmp";
  if (at(4, "ftyp")) {
    const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (brand.startsWith("avif") || brand.startsWith("avis")) return "image/avif";
    if (brand.startsWith("heic") || brand.startsWith("heix") || brand.startsWith("mif1")) return "image/heic";
  }
  return undefined;
}

export interface LoadedImage {
  bytes: Uint8Array;
  mime: string;
  /** 归一化后的来源描述：绝对路径 / URL / "data:" */
  origin: string;
}

function isWithin(root: string, target: string): boolean {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

async function resolveAllowedPath(source: string, policy: ImagePolicy): Promise<string> {
  if (source.includes("\0")) {
    throw new ImageSecurityError("ERR_IMAGE_PATH", "路径包含 NUL 字节");
  }
  const roots = policy.roots ?? [process.cwd()];
  const candidates: string[] = [];
  for (const root of roots) {
    const absoluteRoot = resolve(root);
    let realRoot: string;
    try {
      realRoot = await realpath(absoluteRoot);
    } catch {
      continue;
    }
    const candidate = isAbsolute(source) ? source : resolve(realRoot, source);
    let realTarget: string;
    try {
      realTarget = await realpath(candidate);
    } catch {
      continue;
    }
    if (isWithin(realRoot, realTarget)) candidates.push(realTarget);
  }
  if (candidates.length === 0) {
    throw new ImageSecurityError(
      "ERR_IMAGE_PATH_DENIED",
      `路径不在白名单内：${source}（roots=${(policy.roots ?? [process.cwd()]).join(", ")}）`
    );
  }
  return candidates[0];
}

async function readLimited(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  label: string
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `${label} 超过 ${maxBytes} 字节上限`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function checkMime(bytes: Uint8Array, policy: ImagePolicy, origin: string): string {
  const mime = sniffMime(bytes);
  if (!mime) {
    throw new ImageSecurityError("ERR_IMAGE_MIME", `无法识别的图片格式：${origin}`);
  }
  const allowed = policy.allowMime ?? DEFAULT_MIME;
  if (!allowed.includes(mime)) {
    throw new ImageSecurityError("ERR_IMAGE_MIME", `MIME ${mime} 不在白名单内：${origin}`);
  }
  return mime;
}

function decodeDataUrl(source: string, policy: ImagePolicy, maxBytes: number): Uint8Array {
  const comma = source.indexOf(",");
  if (comma < 0) throw new ImageSecurityError("ERR_IMAGE_DATA_URL", "data: URL 缺少逗号");
  const header = source.slice(5, comma);
  const payload = source.slice(comma + 1);
  if (payload.length > maxBytes * 2) {
    throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `data: URL 超过 ${maxBytes} 字节上限`);
  }
  if (/;base64$/i.test(header) || /;base64;/i.test(header)) {
    return new Uint8Array(Buffer.from(payload, "base64"));
  }
  const decoded = decodeURIComponent(payload);
  const bytes = new TextEncoder().encode(decoded);
  if (bytes.byteLength > maxBytes) {
    throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `data: URL 超过 ${maxBytes} 字节上限`);
  }
  return bytes;
}

/**
 * 读取一张图片的字节，并执行全部安全策略。
 * 返回的字节仍然要交给 Bun.Image 做真实解码（元数据 / 像素上限在那里兜底）。
 */
export async function loadImageBytes(
  source: string | Uint8Array,
  policy: ImagePolicy = {}
): Promise<LoadedImage> {
  const maxBytes = policy.maxBytes ?? DEFAULT_MAX_BYTES;

  if (source instanceof Uint8Array) {
    if (source.byteLength > maxBytes) {
      throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `内存图片超过 ${maxBytes} 字节上限`);
    }
    const bytes = source;
    return { bytes, mime: checkMime(bytes, policy, "<bytes>"), origin: "<bytes>" };
  }

  if (source.startsWith("data:")) {
    if (policy.allowDataUrls === false) {
      throw new ImageSecurityError("ERR_IMAGE_DATA_URL", "data: URL 未授权");
    }
    const bytes = decodeDataUrl(source, policy, maxBytes);
    if (bytes.byteLength > maxBytes) {
      throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `data: URL 超过 ${maxBytes} 字节上限`);
    }
    return { bytes, mime: checkMime(bytes, policy, "data:"), origin: "data:" };
  }

  if (/^https?:\/\//i.test(source)) {
    if (!policy.allowRemote) {
      throw new ImageSecurityError("ERR_IMAGE_REMOTE_DENIED", `远程图片未授权：${source}`);
    }
    if (policy.authorizeRemote && !(await policy.authorizeRemote(source))) {
      throw new ImageSecurityError("ERR_IMAGE_REMOTE_DENIED", `远程图片被拒绝：${source}`);
    }
    const fetchImpl = policy.fetch ?? fetch;
    const response = await fetchImpl(source);
    if (!response.ok) {
      throw new ImageSecurityError("ERR_IMAGE_FETCH", `HTTP ${response.status}：${source}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `远程图片声明 ${declared} 字节，超过上限`);
    }
    const body = response.body;
    const bytes = body
      ? await readLimited(body.getReader(), maxBytes, source)
      : new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `远程图片超过 ${maxBytes} 字节上限`);
    }
    return { bytes, mime: checkMime(bytes, policy, source), origin: source };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(source) && !isAbsolute(source)) {
    throw new ImageSecurityError("ERR_IMAGE_SCHEME", `不支持的协议：${source}`);
  }

  const path = await resolveAllowedPath(source, policy);
  const file = Bun.file(path);
  if (file.size > maxBytes) {
    throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `${path} 有 ${file.size} 字节，超过上限`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > maxBytes) {
    throw new ImageSecurityError("ERR_IMAGE_TOO_LARGE", `${path} 超过 ${maxBytes} 字节上限`);
  }
  return { bytes, mime: checkMime(bytes, policy, path), origin: path };
}
