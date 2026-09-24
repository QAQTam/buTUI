import { describe, expect, test } from "bun:test";
import {
  CommandPalette,
  commandScore,
  filterCommands,
} from "@butui/components";
import { CommandRegistry, defineCommand } from "@butui/keymap";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

const commands = [
  defineCommand({
    id: "git.commit",
    title: "Git: Commit",
    description: "Commit staged changes",
    run: () => {},
  }),
  defineCommand({
    id: "file.save",
    title: "File: Save",
    description: "Write the current file",
    run: () => {},
  }),
  defineCommand({
    id: "file.close",
    title: "File: Close",
    when: () => false,
    run: () => {},
  }),
];

describe("command palette filtering", () => {
  test("按 title / id / description 评分，过滤 when=false", () => {
    expect(commandScore(commands[1]!, "save")).toBeGreaterThan(
      commandScore(commands[1]!, "current")
    );
    expect(filterCommands(commands, "file").map(command => command.id)).toEqual([
      "file.save",
    ]);
    expect(filterCommands(commands, "git").map(command => command.id)).toEqual([
      "git.commit",
    ]);
    expect(
      filterCommands(commands, "file", { includeDisabled: true }).map(
        command => command.id
      )
    ).toEqual(["file.save", "file.close"]);
  });

  test("子序列匹配和 limit", () => {
    expect(filterCommands(commands, "gcm").map(command => command.id)).toEqual([
      "git.commit",
    ]);
    expect(filterCommands(commands, "", { limit: 1 })).toHaveLength(1);
  });
});

describe("<CommandPalette>", () => {
  test("输入过滤、上下选择、Enter 执行并关闭", () => {
    const registry = new CommandRegistry();
    const calls: string[] = [];
    registry.register({
      id: "git.commit",
      title: "Git: Commit",
      description: "Commit staged changes",
      run: () => {
        calls.push("git.commit");
      },
    });
    registry.register({
      id: "file.save",
      title: "File: Save",
      description: "Write the current file",
      run: () => {
        calls.push("file.save");
      },
    });
    const [open, setOpen] = createSignal(true);
    const selected: string[] = [];
    const app = mount(
      () => (
        <CommandPalette
          registry={registry}
          open={open()}
          onDismiss={() => setOpen(false)}
          onSelect={command => selected.push(command.id)}
        />
      ),
      { width: 80, height: 24 }
    );

    app.flush();
    expect(app.text()).toContain("Git: Commit");
    expect(app.text()).toContain("File: Save");

    app.key("g", "g");
    app.flush();
    expect(app.text()).toContain("Git: Commit");
    expect(app.text()).not.toContain("File: Save");

    app.key("enter");
    app.flush();
    expect(calls).toEqual(["git.commit"]);
    expect(selected).toEqual(["git.commit"]);
    expect(open()).toBe(false);
    app.unmount();
  });

  test("Escape 关闭，空查询保留全部命令", () => {
    const registry = new CommandRegistry();
    registry.register({ id: "a", title: "Alpha", run: () => {} });
    const [open, setOpen] = createSignal(true);
    const app = mount(
      () => (
        <CommandPalette
          registry={registry}
          open={open()}
          onDismiss={() => setOpen(false)}
        />
      ),
      { width: 80, height: 24 }
    );

    expect(app.text()).toContain("Alpha");
    app.key("escape");
    app.flush();
    expect(open()).toBe(false);
    app.unmount();
  });
});
