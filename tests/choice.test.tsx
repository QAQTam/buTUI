import { describe, expect, test } from "bun:test";
import { Checkbox, RadioGroup, type SelectOption } from "@butui/components";
import { type Node, focusNode, walk } from "@butui/core";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

function findBySemantic(root: Node, semantic: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

describe("<Checkbox>", () => {
  test("Space / Enter / 点击切换，disabled 不响应", () => {
    const [checked, setChecked] = createSignal(false);
    const app = mount(
      () => (
        <box>
          <Checkbox
            checked={checked()}
            label="启用"
            onChange={setChecked}
          />
          <Checkbox disabled label="禁用" semantic="checkbox:disabled" />
        </box>
      ),
      { width: 30, height: 3 }
    );
    expect(app.text()).toContain("[ ] 启用");

    focusNode(app.root, findBySemantic(app.root, "checkbox"));
    app.key(" ");
    app.flush();
    expect(checked()).toBe(true);
    expect(app.text()).toContain("[x] 启用");

    app.key("enter");
    app.flush();
    expect(checked()).toBe(false);

    app.click(2, 0);
    app.flush();
    expect(checked()).toBe(true);

    const disabled = findBySemantic(app.root, "checkbox:disabled")!;
    expect(disabled.kind === "element" && disabled.props.disabled).toBe(true);
    app.click(2, 1);
    app.flush();
    expect(checked()).toBe(true);
    app.unmount();
  });
});

const options: Array<SelectOption<string>> = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
  { value: "c", label: "C", disabled: true },
  { value: "d", label: "D" },
];

describe("<RadioGroup>", () => {
  test("垂直方向键跳过 disabled，Home / End 定位", () => {
    const [value, setValue] = createSignal("a");
    const app = mount(
      () => (
        <RadioGroup
          options={options}
          value={value()}
          onChange={setValue}
        />
      ),
      { width: 20, height: 5 }
    );
    focusNode(app.root, findBySemantic(app.root, "radio"));
    app.key("down");
    app.flush();
    expect(value()).toBe("b");
    app.key("down");
    app.flush();
    expect(value()).toBe("d");
    app.key("up");
    app.flush();
    expect(value()).toBe("b");
    app.key("home");
    app.flush();
    expect(value()).toBe("a");
    app.key("end");
    app.flush();
    expect(value()).toBe("d");
    app.unmount();
  });

  test("水平模式使用 ←→，点击也可切换", () => {
    const [value, setValue] = createSignal("a");
    const app = mount(
      () => (
        <RadioGroup
          orientation="horizontal"
          options={options}
          value={value()}
          onChange={setValue}
        />
      ),
      { width: 30, height: 2 }
    );
    focusNode(app.root, findBySemantic(app.root, "radio"));
    app.key("right");
    app.flush();
    expect(value()).toBe("b");
    app.key("right");
    app.flush();
    expect(value()).toBe("d");

    const firstColumn = app.text().indexOf("A");
    app.click(firstColumn, 0);
    app.flush();
    expect(value()).toBe("a");
    app.unmount();
  });
});
