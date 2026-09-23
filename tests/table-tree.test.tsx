import { describe, expect, test } from "bun:test";
import { type Node, focusNode, walk } from "@butui/core";
import { Table, Tree, flattenTree } from "@butui/components";
import { mount } from "@butui/test";
import { createSignal } from "solid-js";

function findBySemantic(root: Node, semantic: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

const line = (app: ReturnType<typeof mount>, y: number): string =>
  app.frame().lines[y].map(c => (c.width === 0 ? "" : c.ch)).join("");

describe("<Table>", () => {
  const columns = [
    { key: "name", title: "文件", width: 12 },
    { key: "add", title: "+", width: 4, align: "right" as const, color: "success" },
    { key: "del", title: "-", width: 4, align: "right" as const, color: "danger" },
  ];
  const rows = [
    { name: "src/auth.ts", add: "12", del: "3" },
    { name: "src/util.ts", add: "1", del: "0" },
  ];

  test("表头 + 分隔线 + 数据行", () => {
    const app = mount(() => <Table columns={columns} rows={rows} />, { width: 40, height: 6 });
    expect(line(app, 0)).toContain("文件");
    expect(line(app, 1)).toContain("─");
    expect(line(app, 2)).toContain("src/auth.ts");
    expect(line(app, 3)).toContain("src/util.ts");
    app.unmount();
  });

  test("数字列右对齐", () => {
    const app = mount(() => <Table columns={columns} rows={rows} />, { width: 40, height: 6 });
    // 右对齐 = 右边界对齐（"12" 的末位与 "1" 的末位在同一列）
    const a = line(app, 2);
    const b = line(app, 3);
    expect(a.indexOf("12") + 2).toBe(b.indexOf("1") + 1);
    app.unmount();
  });

  test("没有 title 就不画表头 / 分隔线", () => {
    const bare = [{ key: "name", width: 10 }];
    const app = mount(() => <Table columns={bare} rows={[{ name: "a" }]} />, {
      width: 20,
      height: 3,
    });
    expect(line(app, 0).trim()).toBe("a");
    app.unmount();
  });

  test("空数据走 empty", () => {
    const app = mount(
      () => <Table columns={columns} rows={[]} empty={<text>没有改动</text>} />,
      { width: 40, height: 4 }
    );
    expect(app.text()).toContain("没有改动");
    expect(app.text()).not.toContain("文件");
    app.unmount();
  });

  test("列宽不给就按内容算", () => {
    const auto = [{ key: "name", title: "名" }, { key: "v", title: "值" }];
    const app = mount(
      () => <Table columns={auto} rows={[{ name: "很长的一个名字", v: "1" }]} />,
      { width: 40, height: 4 }
    );
    expect(line(app, 2)).toContain("很长的一个名字");
    expect(line(app, 2)).toContain("1");
    app.unmount();
  });
});

describe("flattenTree", () => {
  const tree = [
    {
      id: "src",
      label: "src",
      children: [
        { id: "a.ts", label: "a.ts" },
        { id: "b.ts", label: "b.ts" },
      ],
    },
    { id: "readme", label: "README" },
  ];

  test("收起时只显示根节点", () => {
    const rows = flattenTree(tree, new Set<string>());
    expect(rows.map(r => r.node.id)).toEqual(["src", "readme"]);
    expect(rows[0].hasChildren).toBe(true);
    expect(rows[0].isExpanded).toBe(false);
  });

  test("展开后带上子节点，并记录父下标与深度", () => {
    const rows = flattenTree(tree, new Set(["src"]));
    expect(rows.map(r => r.node.id)).toEqual(["src", "a.ts", "b.ts", "readme"]);
    expect(rows[1].depth).toBe(1);
    expect(rows[1].parentIndex).toBe(0);
    expect(rows[3].parentIndex).toBe(-1);
  });

  test("也接受数组形式的展开集合", () => {
    const rows = flattenTree(tree, ["src"]);
    expect(rows).toHaveLength(4);
  });
});

describe("<Tree>", () => {
  const nodes = [
    {
      id: "src",
      label: "src",
      children: [
        { id: "a.ts", label: "a.ts", data: "a" },
        { id: "b.ts", label: "b.ts", data: "b" },
      ],
    },
    { id: "readme", label: "README", data: "r" },
  ];

  function setup(initialExpanded: string[] = []) {
    const [expanded, setExpanded] = createSignal<readonly string[]>(initialExpanded);
    const activated: string[] = [];
    const app = mount(
      () => (
        <Tree
          nodes={nodes}
          expanded={expanded()}
          onToggle={(id, open) =>
            setExpanded(current => (open ? [...current, id] : current.filter(x => x !== id)))
          }
          onActivate={node => activated.push(node.id)}
        />
      ),
      { width: 30, height: 6 }
    );
    return { app, expanded, setExpanded, activated };
  }

  test("收起状态只显示根，展开显示子节点（带缩进和箭头）", () => {
    const { app, setExpanded } = setup();
    expect(app.text()).toContain("▸ src");
    expect(app.text()).not.toContain("a.ts");

    setExpanded(["src"]);
    app.flush();
    const text = app.text();
    expect(text).toContain("▾ src");
    expect(text).toContain("a.ts");
    // 子节点缩进 2 格
    expect(line(app, 1)).toContain("  ");
    app.unmount();
  });

  test("→ 展开，再 → 进入第一个子节点", () => {
    const { app, expanded } = setup();
    focusNode(app.root, findBySemantic(app.root, "tree"));
    app.key("right");
    app.flush();
    expect(expanded()).toEqual(["src"]);

    app.key("right");
    app.flush();
    // 现在选中的应该是 a.ts —— Enter 会激活它
    app.key("enter");
    app.flush();
    expect(app.text()).toContain("▾ src");
    app.unmount();
  });

  test("← 收起；已经是子节点则回到父节点", () => {
    const { app, expanded, activated } = setup(["src"]);
    focusNode(app.root, findBySemantic(app.root, "tree"));
    app.key("down"); // src → a.ts
    app.key("left"); // a.ts → 回到 src
    app.key("enter"); // src 有子节点 → 收起
    app.flush();
    expect(expanded()).toEqual([]);
    expect(activated).toEqual([]);
    app.unmount();
  });

  test("Enter 在叶子上触发 onActivate", () => {
    const { app, activated } = setup(["src"]);
    focusNode(app.root, findBySemantic(app.root, "tree"));
    app.key("down"); // a.ts
    app.key("enter");
    app.flush();
    expect(activated).toEqual(["a.ts"]);
    app.unmount();
  });

  test("上下键在可见行之间移动（跳过折叠的子树）", () => {
    const { app } = setup();
    focusNode(app.root, findBySemantic(app.root, "tree"));
    app.key("down"); // src → readme（src 收起着，子节点不在列表里）
    app.key("enter"); // readme 是叶子 → 激活
    app.flush();
    expect(app.text()).toContain("README");
    app.unmount();
  });

  test("点击行等同于 Enter", () => {
    const { app, expanded } = setup();
    app.click(4, 0); // 点 src
    app.flush();
    expect(expanded()).toEqual(["src"]);
    app.unmount();
  });
});
