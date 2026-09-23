import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  ImageSecurityError,
  loadImageBytes,
  sniffMime,
} from "@butui/image";
import { rgbaPng } from "./helpers/png.ts";

const PNG = rgbaPng(1, 1, [[255, 0, 0, 255]]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF = new TextEncoder().encode("GIF89a...");
const WEBP = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")]);
const BMP = new TextEncoder().encode("BM......");
const AVIF = new Uint8Array([0, 0, 0, 0x20, ...new TextEncoder().encode("ftypavif")]);

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "butui-img-"));
  outside = await mkdtemp(join(tmpdir(), "butui-out-"));
  await mkdir(join(root, "shots"), { recursive: true });
  await writeFile(join(root, "shots", "a.png"), PNG);
  // 合法 PNG 头 + 填充：用来验证「体积上限在读之前生效」
  const big = new Uint8Array(4096);
  big.set(PNG, 0);
  await writeFile(join(root, "big.png"), big);
  await writeFile(join(root, "not-image.txt"), new TextEncoder().encode("hello world"));
  await writeFile(join(outside, "secret.png"), PNG);
  await symlink(join(outside, "secret.png"), join(root, "escape.png"));
});

afterAll(() => {
  // 临时目录交给系统回收；这里不删是为了失败时还能人工看
});

describe("图片安全加载（SPEC §12.3）", () => {
  test("魔数嗅探：看字节不看扩展名", () => {
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(GIF)).toBe("image/gif");
    expect(sniffMime(WEBP)).toBe("image/webp");
    expect(sniffMime(BMP)).toBe("image/bmp");
    expect(sniffMime(AVIF)).toBe("image/avif");
    expect(sniffMime(new TextEncoder().encode("#!/bin/sh\nrm -rf /"))).toBeUndefined();
  });

  test("白名单根目录内的相对路径可以读", async () => {
    const loaded = await loadImageBytes("shots/a.png", { roots: [root] });
    expect(loaded.mime).toBe("image/png");
    expect(loaded.origin).toBe(join(root, "shots", "a.png"));
    expect(loaded.bytes.byteLength).toBe(PNG.byteLength);
  });

  test("根目录外一律拒绝（含 ../ 逃逸）", async () => {
    await expect(loadImageBytes(join(outside, "secret.png"), { roots: [root] })).rejects.toThrow(
      ImageSecurityError
    );
    await expect(loadImageBytes("../" + "x", { roots: [root] })).rejects.toThrow(ImageSecurityError);
  });

  test("symlink 逃逸被 realpath 拦下", async () => {
    await expect(loadImageBytes("escape.png", { roots: [root] })).rejects.toThrow(ImageSecurityError);
  });

  test("NUL 字节直接拒绝", async () => {
    await expect(loadImageBytes("a\0b.png", { roots: [root] })).rejects.toThrow(ImageSecurityError);
  });

  test("体积上限在读之前就生效", async () => {
    await expect(loadImageBytes("big.png", { roots: [root], maxBytes: 1024 })).rejects.toThrow(
      ImageSecurityError
    );
    const ok = await loadImageBytes("big.png", { roots: [root], maxBytes: 8192 });
    expect(ok.bytes.byteLength).toBe(4096);
  });

  test("MIME 白名单：不是图片 / 不在名单里的都拒绝", async () => {
    await expect(loadImageBytes("not-image.txt", { roots: [root] })).rejects.toThrow(ImageSecurityError);
    await expect(
      loadImageBytes("shots/a.png", { roots: [root], allowMime: ["image/jpeg"] })
    ).rejects.toThrow(ImageSecurityError);
  });

  test("远程图片默认拒绝", async () => {
    await expect(loadImageBytes("https://example.com/a.png")).rejects.toThrow(ImageSecurityError);
  });

  test("远程图片：显式开启 + 逐次授权才放行", async () => {
    const fetchStub = (async () =>
      new Response(PNG, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;

    const loaded = await loadImageBytes("https://example.com/a.png", {
      allowRemote: true,
      fetch: fetchStub,
    });
    expect(loaded.mime).toBe("image/png");
    expect(loaded.origin).toBe("https://example.com/a.png");

    await expect(
      loadImageBytes("https://example.com/a.png", {
        allowRemote: true,
        authorizeRemote: () => false,
        fetch: fetchStub,
      })
    ).rejects.toThrow(ImageSecurityError);

    const allowed = await loadImageBytes("https://example.com/a.png", {
      allowRemote: true,
      authorizeRemote: url => url.endsWith(".png"),
      fetch: fetchStub,
    });
    expect(allowed.mime).toBe("image/png");
  });

  test("远程图片：声明体积超限时在读流之前就拒绝", async () => {
    const fetchStub = (async () =>
      new Response(PNG, { headers: { "content-length": "99999999" } })) as unknown as typeof fetch;
    await expect(
      loadImageBytes("https://example.com/a.png", { allowRemote: true, fetch: fetchStub })
    ).rejects.toThrow(ImageSecurityError);
  });

  test("远程图片：流式读取超过上限时中断", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const fetchStub = (async () => new Response(stream)) as unknown as typeof fetch;
    await expect(
      loadImageBytes("https://example.com/big.png", {
        allowRemote: true,
        fetch: fetchStub,
        maxBytes: 128 * 1024,
      })
    ).rejects.toThrow(ImageSecurityError);
  });

  test("data: URL 默认允许，可关闭", async () => {
    const url = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;
    const loaded = await loadImageBytes(url);
    expect(loaded.mime).toBe("image/png");
    expect(loaded.bytes.byteLength).toBe(PNG.byteLength);

    await expect(loadImageBytes(url, { allowDataUrls: false })).rejects.toThrow(ImageSecurityError);
  });

  test("内存字节直接放行，但仍要过 MIME 与体积检查", async () => {
    const loaded = await loadImageBytes(PNG);
    expect(loaded.mime).toBe("image/png");
    expect(loaded.origin).toBe("<bytes>");
    await expect(loadImageBytes(PNG, { maxBytes: 8 })).rejects.toThrow(ImageSecurityError);
    await expect(loadImageBytes(new TextEncoder().encode("not an image"))).rejects.toThrow(
      ImageSecurityError
    );
  });

  test("默认上限是 16 MiB（SPEC §12.3 限制大小）", () => {
    expect(DEFAULT_MAX_BYTES).toBe(16 * 1024 * 1024);
  });

  test("不支持的协议（file: / ssh: 等）拒绝", async () => {
    await expect(loadImageBytes("ftp://example.com/a.png")).rejects.toThrow(ImageSecurityError);
  });
});
