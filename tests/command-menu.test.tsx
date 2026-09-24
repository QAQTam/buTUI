import { describe, expect, test } from "bun:test";
import { CommandMenu } from "@butui/components";
import { CommandRegistry, type Command } from "@butui/keymap";
import { mount } from "@butui/test";

function registry(): CommandRegistry {
  const commands = new CommandRegistry();
  commands.register({
    id: "file.save",
    title: "保存",
    description: "写入磁盘",
    run: () => {
      runs.push("save");
    },
  });
  commands.register({
    id: "file.close",
    title: "关闭",
    run: () => {
      runs.push("close");
    },
  });
  commands.register({
    id: "hidden",
    title: "隐藏",
    when: () => false,
    run: () => {
      runs.push("hidden");
    },
  });
  return commands;
}

const runs: string[] = [];

describe("<CommandMenu>", () => {
  test("查询过滤、Enter 执行当前命令", () => {
    runs.length = 0;
    const commands = registry();
    const queries: string[] = [];
    const app = mount(
      () => (
        <CommandMenu
          registry={commands}
          autoFocus
          shortcut={command =>
            command.id === "file.save" ? "ctrl+s" : undefined
          }
          onQueryChange={query => queries.push(query)}
        />
      ),
      { width: 50, height: 8 }
    );
    expect(app.text()).toContain("保存");
    expect(app.text()).toContain("关闭");
    expect(app.text()).toContain("ctrl+s");
    expect(app.text()).not.toContain("隐藏");

    app.key("s", "s");
    app.key("a", "a");
    app.key("v", "v");
    app.key("e", "e");
    app.flush();
    expect(queries).toContain("save");
    expect(app.text()).toContain("保存");
    expect(app.text()).not.toContain("关闭");

    app.key("enter");
    app.flush();
    expect(runs).toEqual(["save"]);
    app.unmount();
  });

  test("运行期注册 / 注销命令会刷新结果", () => {
    const commands = registry();
    const app = mount(
      () => <CommandMenu registry={commands} />,
      { width: 50, height: 8 }
    );
    expect(app.text()).not.toContain("导出");

    const unregister = commands.register({
      id: "file.export",
      title: "导出",
      run: () => {},
    });
    app.flush();
    expect(app.text()).toContain("导出");

    unregister();
    app.flush();
    expect(app.text()).not.toContain("导出");
    app.unmount();
  });

  test("Esc 清空 query", () => {
    const commands = registry();
    const app = mount(
      () => <CommandMenu registry={commands} query="file" autoFocus />,
      { width: 50, height: 8 }
    );
    expect(app.text()).toContain("保存");
    expect(app.text()).toContain("关闭");

    app.key("escape");
    app.flush();
    expect(app.text()).toContain("保存");
    expect(app.text()).toContain("关闭");
    app.unmount();
  });
});
