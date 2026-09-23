import { describe, expect, test } from "bun:test";
import {
  type Node,
  createModifiers,
  dispatchEvent,
  eventTarget,
  focusNode,
  walk,
} from "@butui/core";
import { List, VirtualList, createSelection, createTextEditor, Input } from "@butui/components";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

type App = ReturnType<typeof mount>;

function findBySemantic(app: App, semantic: string): Node | undefined {
  for (const node of walk(app.root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

function rowCount(app: App): number {
  let n = 0;
  for (const node of walk(app.root)) {
    if (node.kind === "element" && String(node.props.semantic).startsWith("list-item:")) n++;
  }
  return n;
}

const range = (n: number): string[] => Array.from({ length: n }, (_, i) => `item-${i}`);

describe("<List>（SPEC §10.1）", () => {
  test("渲染条目，选中行带标记", () => {
    const items = range(3);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => <List items={items} selection={sel} renderItem={item => <text>{item}</text>} />,
      { width: 16, height: 4 }
    );
    const text = app.text();
    expect(text).toContain("item-0");
    expect(text).toContain("item-1");
    expect(text).toContain("item-2");
    // 只有第一行带标记
    expect(app.frame().lines[0].map(c => c.ch).join("").trimStart().startsWith(">")).toBe(true);
    expect(app.frame().lines[1].map(c => c.ch).join("").trimStart().startsWith(">")).toBe(false);
    app.unmount();
  });

  test("方向键移动选中项（焦点在列表上时）", () => {
    const items = range(5);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => <List items={items} selection={sel} renderItem={item => <text>{item}</text>} />,
      { width: 16, height: 6 }
    );
    focusNode(app.root, findBySemantic(app, "list"));

    app.key("down");
    app.flush();
    expect(sel.index()).toBe(1);
    app.key("down");
    app.key("down");
    app.flush();
    expect(sel.index()).toBe(3);
    app.key("up");
    app.flush();
    expect(sel.index()).toBe(2);
    // 标记跟着走：第 3 行是选中行
    expect(app.frame().lines[2].map(c => c.ch).join("").trimStart().startsWith(">")).toBe(true);
    app.unmount();
  });

  test("height 裁剪视口，选中项跑出去时窗口跟随", () => {
    const items = range(30);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => <List items={items} selection={sel} height={4} renderItem={item => <text>{item}</text>} />,
      { width: 16, height: 8 }
    );
    expect(app.text()).toContain("item-0");
    expect(app.text()).not.toContain("item-4");

    focusNode(app.root, findBySemantic(app, "list"));
    for (let i = 0; i < 6; i++) app.key("down");
    app.flush();

    expect(sel.index()).toBe(6);
    // 窗口贴着选中项：第 6 项在最底行
    const text = app.text();
    expect(text).toContain("item-3");
    expect(text).toContain("item-6");
    expect(text).not.toContain("item-2");
    app.unmount();
  });

  test("Enter 激活当前项", () => {
    const items = range(5);
    const sel = createSelection({ count: items.length, index: 2 });
    const activated: string[] = [];
    const app = mount(
      () => (
        <List
          items={items}
          selection={sel}
          renderItem={item => <text>{item}</text>}
          onActivate={item => activated.push(item)}
        />
      ),
      { width: 16, height: 6 }
    );
    focusNode(app.root, findBySemantic(app, "list"));
    app.key("enter");
    app.flush();
    expect(activated).toEqual(["item-2"]);
    app.unmount();
  });

  test("点击某行即选中", () => {
    const items = range(5);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => <List items={items} selection={sel} renderItem={item => <text>{item}</text>} />,
      { width: 16, height: 6 }
    );
    app.click(2, 2);
    app.flush();
    expect(sel.index()).toBe(2);
    app.unmount();
  });

  test("滚轮移动选中项（一次 wheelStep 格）", () => {
    const items = range(20);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => (
        <List items={items} selection={sel} height={4} wheelStep={2} renderItem={item => <text>{item}</text>} />
      ),
      { width: 16, height: 6 }
    );
    // 直接派发一个带方向的滚轮事件
    const list = findBySemantic(app, "list")!;
    dispatchEvent(
      list,
      eventTarget({
        type: "mouse" as const,
        action: "wheel" as const,
        button: "none" as const,
        wheel: "down" as const,
        x: 0,
        y: 0,
        modifiers: createModifiers(),
      })
    );
    app.flush();
    expect(sel.index()).toBe(2);
    app.unmount();
  });

  test("空列表显示 empty", () => {
    const sel = createSelection({ count: 0 });
    const app = mount(
      () => (
        <List
          items={[] as string[]}
          selection={sel}
          empty={<text color="muted">什么都没有</text>}
          renderItem={item => <text>{item}</text>}
        />
      ),
      { width: 20, height: 3 }
    );
    expect(app.text()).toContain("什么都没有");
    app.unmount();
  });

  test("onKey 先行：返回 true 时选择模型不介入", () => {
    const items = range(5);
    const sel = createSelection({ count: items.length });
    const seen: string[] = [];
    const app = mount(
      () => (
        <List
          items={items}
          selection={sel}
          renderItem={item => <text>{item}</text>}
          onKey={event => {
            seen.push(event.name);
            return event.name === "down";
          }}
        />
      ),
      { width: 16, height: 6 }
    );
    focusNode(app.root, findBySemantic(app, "list"));
    app.key("down");
    app.flush();
    expect(seen).toEqual(["down"]);
    expect(sel.index()).toBe(0); // 被 onKey 吃掉了
    app.unmount();
  });

  test("itemHeight > 1：一屏行数按高度折算", () => {
    const items = range(10);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => (
        <List
          items={items}
          selection={sel}
          height={4}
          itemHeight={2}
          renderItem={item => <text>{item}</text>}
        />
      ),
      { width: 16, height: 6 }
    );
    // 4 行高 / 每项 2 行 = 2 项
    const text = app.text();
    expect(text).toContain("item-0");
    expect(text).toContain("item-1");
    expect(text).not.toContain("item-2");
    app.unmount();
  });

  test("selectedBg 铺满整行（容器背景填满自己的盒子）", () => {
    const items = range(3);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => (
        <List
          items={items}
          selection={sel}
          selectedBg="accent"
          renderItem={item => <text>{item}</text>}
        />
      ),
      { width: 12, height: 4 }
    );
    const line = app.frame().lines[0];
    // 行首和行尾（第 12 列）都该是 accent 背景
    expect(line[0].sgr).toContain("48;2");
    expect(line[11].sgr).toContain("48;2");
    // 未选中的行不带背景
    expect(app.frame().lines[1][11].sgr).not.toContain("48;2");
    app.unmount();
  });
});

describe("命令面板形态：Input + List", () => {
  test("输入框聚焦时，方向键仍由列表消费（onKey 先行）", () => {
    const all = range(20);
    const [query, setQuery] = createSignal("");
    const filtered = (): string[] => all.filter(item => item.includes(query()));
    const sel = createSelection({ count: () => filtered().length });
    const editor = createTextEditor({ onChange: setQuery });

    const app = mount(
      () => (
        <box>
          <Input editor={editor} width={16} onKey={event => sel.handleKey(event)} />
          <List
            items={filtered()}
            selection={sel}
            height={3}
            renderItem={item => <text>{item}</text>}
          />
        </box>
      ),
      { width: 20, height: 6 }
    );
    focusNode(app.root, findBySemantic(app, "input"));

    app.key("1", "1");
    app.flush();
    expect(query()).toBe("1");
    expect(sel.count()).toBe(11); // item-1 / item-10..item-19

    app.key("down");
    app.flush();
    expect(sel.index()).toBe(1);
    expect(app.text()).toContain("item-11");
    // 方向键不该落到编辑器里（光标没动、文本没被改）
    expect(editor.value()).toBe("1");
    app.unmount();
  });
});

describe("<VirtualList>：只渲染可见窗口", () => {  test("10 万条也只建视口数量的行", () => {
    const items = range(100_000);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => (
        <VirtualList
          items={items}
          selection={sel}
          height={6}
          renderItem={item => <text>{item}</text>}
        />
      ),
      { width: 16, height: 8 }
    );
    expect(rowCount(app)).toBe(6);
    expect(app.text()).toContain("item-5");
    expect(app.text()).not.toContain("item-6");
    app.unmount();
  });

  test("选中项跑出窗口 → 只重建窗口（行数恒定）", () => {
    const items = range(10_000);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => (
        <VirtualList items={items} selection={sel} height={5} renderItem={item => <text>{item}</text>} />
      ),
      { width: 16, height: 7 }
    );
    focusNode(app.root, findBySemantic(app, "list"));
    for (let i = 0; i < 40; i++) app.key("down");
    app.flush();

    expect(sel.index()).toBe(40);
    expect(rowCount(app)).toBe(5);
    expect(app.text()).toContain("item-40");
    expect(app.text()).toContain("item-36");
    expect(app.text()).not.toContain("item-35");
    app.unmount();
  });

  test("items 换了但长度没变 → 行内容跟着更新（不能吃快照）", () => {
    const [items, setItems] = createSignal(range(4));
    const sel = createSelection({ count: 4 });
    const app = mount(
      () => (
        <VirtualList items={items()} selection={sel} height={4} renderItem={item => <text>{item}</text>} />
      ),
      { width: 16, height: 6 }
    );
    expect(app.text()).toContain("item-0");

    setItems(["alpha", "beta", "gamma", "delta"]);
    app.flush();
    const text = app.text();
    expect(text).toContain("alpha");
    expect(text).toContain("delta");
    expect(text).not.toContain("item-0");
    app.unmount();
  });

  test("非虚拟 List 不裁剪：没给 height 时全部条目都在", () => {
    const items = range(6);
    const sel = createSelection({ count: items.length });
    const app = mount(
      () => <List items={items} selection={sel} renderItem={item => <text>{item}</text>} />,
      { width: 16, height: 8 }
    );
    expect(rowCount(app)).toBe(6);
    expect(app.text()).toContain("item-5");
    app.unmount();
  });
});
