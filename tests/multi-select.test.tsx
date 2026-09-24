import { describe, expect, test } from "bun:test";
import {
  MultiSelect,
  createMultiSelect,
  type SelectOption,
} from "@butui/components";
import { type Node, focusNode, walk } from "@butui/core";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

function findBySemantic(root: Node, semantic: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

const options: Array<SelectOption<string>> = [
  { value: "group", label: "分组", heading: true },
  { value: "main", label: "main" },
  { value: "feature", label: "feature" },
  { value: "old", label: "old", disabled: true },
];

describe("createMultiSelect", () => {
  test("toggle / selectAll / clear / invert 跳过 heading 和 disabled", () => {
    let values: readonly string[] = [];
    const model = createMultiSelect({
      options: () => options,
      values: () => values,
      onChange(next) {
        values = next;
      },
    });

    expect(model.toggle("group")).toBe(false);
    expect(model.toggle("old")).toBe(false);
    expect(model.toggle("main")).toBe(true);
    expect(values).toEqual(["main"]);

    model.selectAll();
    expect(values).toEqual(["main", "feature"]);
    model.invert();
    expect(values).toEqual([]);
    model.toggle("feature");
    model.clear();
    expect(values).toEqual([]);
  });
});

describe("<MultiSelect>", () => {
  test("Space / Enter / 点击切换，Ctrl+A 全选，Ctrl+Shift+A 清空", () => {
    const [values, setValues] = createSignal<readonly string[]>([]);
    const app = mount(
      () => (
        <MultiSelect
          options={options}
          values={values()}
          onChange={next => setValues(next)}
        />
      ),
      { width: 30, height: 5 }
    );
    expect(app.text()).toContain("[ ] main");
    expect(app.text()).toContain("分组");

    focusNode(app.root, findBySemantic(app.root, "multi-select"));
    app.key(" ");
    app.flush();
    expect(values()).toEqual(["main"]);
    expect(app.text()).toContain("[x] main");

    app.key("down");
    app.key("enter");
    app.flush();
    expect(values()).toEqual(["main", "feature"]);

    app.key("a", undefined, { ctrl: true });
    app.flush();
    expect(values()).toEqual(["main", "feature"]);

    app.key("a", undefined, { ctrl: true, shift: true });
    app.flush();
    expect(values()).toEqual([]);

    app.click(2, 2);
    app.flush();
    expect(values()).toEqual(["feature"]);
    app.unmount();
  });

  test("disabled 项不会被鼠标选中", () => {
    const [values, setValues] = createSignal<readonly string[]>([]);
    const app = mount(
      () => (
        <MultiSelect
          options={options}
          values={values()}
          onChange={next => setValues(next)}
        />
      ),
      { width: 30, height: 5 }
    );
    const oldRow = app
      .text()
      .split("\n")
      .findIndex(line => line.includes("old"));
    app.click(2, oldRow);
    app.flush();
    expect(values()).toEqual([]);
    app.unmount();
  });
});
