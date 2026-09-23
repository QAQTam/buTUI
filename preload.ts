/**
 * 本仓库的编译插件配置。
 *
 * TUI 走 universal + `@butui/solid`；WebUI 走 dom + `@solidjs/web`
 * （SPEC §5.3 / §5.4）。靠路径区分，一个插件里共存。
 */
import { butui } from "@butui/solid/plugin";

Bun.plugin(
  butui({
    targets: [
      { include: /packages[/\\]web[/\\].*\.tsx$/, generate: "dom", moduleName: "@solidjs/web" },
      { include: /examples[/\\]web-demo[/\\].*\.tsx$/, generate: "dom", moduleName: "@solidjs/web" },
    ],
  })
);
