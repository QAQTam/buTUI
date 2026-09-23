/**
 * Bun 编译插件 —— SPEC §5.3 的 TUI 编译管线。
 *
 *   Bun.plugin(onLoad)
 *     → @solidjs/compiler.transform({ generate: "universal", moduleName: "@butui/solid" })
 *     → Bun.Transpiler 剥 TypeScript
 *
 * 为什么是两步：`@solidjs/compiler` 只做 JSX → host ops 改写，**不剥类型**
 * （实测：interface / 类型注解原样保留在输出里）。
 *
 * 为什么不用 @solidjs/babel-plugin：Rust/napi 版本快得多，而且
 * `@solidjs/babel-plugin` 作为纯 JS 兜底仍然可用（SPEC §5.2）。
 */
import { transform } from "@solidjs/compiler";

export interface ButuiPluginOptions {
  /** host ops 的模块名，默认 `@butui/solid` */
  moduleName?: string;
  /** 要编译的扩展名，默认 `[".tsx", ".jsx"]` */
  extensions?: string[];
  /** 开发模式（保留调试名），默认跟随 NODE_ENV */
  dev?: boolean;
}

const TS = new Bun.Transpiler({ loader: "ts" });

export function butui(options: ButuiPluginOptions = {}): Bun.BunPlugin {
  const moduleName = options.moduleName ?? "@butui/solid";
  const extensions = options.extensions ?? [".tsx", ".jsx"];
  const dev = options.dev ?? process.env.NODE_ENV !== "production";
  const filter = new RegExp(`(${extensions.map(escapeRegExp).join("|")})$`);

  return {
    name: "butui-solid",
    setup(build: Parameters<Bun.BunPlugin["setup"]>[0]) {
      build.onLoad({ filter }, async args => {
        if (args.path.includes("node_modules")) return undefined;
        const source = await Bun.file(args.path).text();
        let code: string;
        try {
          ({ code } = transform(source, {
            filename: args.path,
            generate: "universal",
            moduleName,
            dev,
          }));
        } catch (error) {
          // 让编译错误带上文件名，否则 oxc 的错误定位很难读
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`[butui] 编译失败 ${args.path}\n${message}`, { cause: error });
        }
        // 第二段：剥 TypeScript
        return { contents: TS.transformSync(code), loader: "js" };
      });
    },
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default butui;
