/**
 * 运行时守卫：把「静默失效」变成「明确报错」。
 *
 * solid-js@2 的 exports map 里，`node` / `deno` / `worker` 条件都指向
 * `dist/server.js`（SSR，无客户端响应式），只有 `browser` 条件指向
 * `dist/solid.js`。Bun 默认命中 `node` 条件，结果是：
 *
 *   - 不报错
 *   - signal 写进去毫无反应
 *   - UI 永远停在首帧
 *
 * 而且实测：`bunfig.toml` 不支持 `conditions`；Bun 插件的 `onResolve`
 * 对 bare specifier 不生效。所以只能用 CLI flag。
 *
 * 这个检查就是为了让踩坑的人 5 秒内知道原因。
 */

export const CONDITIONS_HINT =
  '请用 `bun --conditions=browser run <entry>` 运行，或设置环境变量 ' +
  'BUN_OPTIONS="--conditions=browser"（Bun 会把 BUN_OPTIONS 拼进 argv）。';

export interface RuntimeCheckResult {
  ok: boolean;
  resolved: string;
  reason?: string;
}

/** 纯函数版本，方便测试 */
export function checkSolidRuntime(resolved: string | undefined): RuntimeCheckResult {
  if (!resolved) {
    return { ok: true, resolved: "", reason: "无法解析 solid-js，跳过检查" };
  }
  const isServer = /[/\\]dist[/\\]server(\.dev|\.observe)?\.js$/.test(resolved);
  return isServer
    ? {
        ok: false,
        resolved,
        reason:
          "solid-js 被解析到了 server 构建，客户端响应式不会工作（signal 更新不会触发重渲染）。",
      }
    : { ok: true, resolved };
}

export function assertSolidClientBuild(): RuntimeCheckResult {
  let resolved: string | undefined;
  try {
    if (typeof import.meta.resolve === "function") {
      resolved = import.meta.resolve("solid-js");
    }
  } catch {
    // 解析失败不阻塞：某些打包器不实现 import.meta.resolve
  }
  const result = checkSolidRuntime(resolved);
  if (!result.ok) {
    throw new Error(
      `[butui] ${result.reason}\n` +
        `  ${CONDITIONS_HINT}\n` +
        `  当前解析结果：${result.resolved}`
    );
  }
  return result;
}
