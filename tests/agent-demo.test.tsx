import { describe, expect, test } from "bun:test";
import { flush } from "solid-js";
import { mount } from "@butui/test";
import { App } from "../examples/agent-demo/src/app.tsx";
import { permission, respondPermission, setPermission, setSize } from "../examples/agent-demo/src/state.ts";

describe("agent demo（SPEC §10.2 组件的雏形）", () => {
  test("渲染消息 / tool card / todo / 输入栏", () => {
    setSize({ columns: 60, rows: 20 });
    const app = mount(() => <App />, { width: 60, height: 20 });
    const text = app.text();

    expect(text).toContain("buTUI · agent runtime");
    expect(text).toContain("● user");
    expect(text).toContain("○ assistant");
    expect(text).toContain("✓ read_file src/auth.ts");
    expect(text).toContain("todo 2/4");
    expect(text).toContain("›");
    app.unmount();
  });

  test("点击消息返回语义节点并展开 action bar", () => {
    const app = mount(() => <App />, { width: 60, height: 20 });
    const spot = findSemantic(app, "message:");
    expect(spot).toBeDefined();

    app.click(spot!.x, spot!.y);
    app.flush();
    expect(app.text()).toContain("[u] undo");
    expect(app.text()).toContain("[f] fork");
    app.unmount();
  });

  test("权限弹窗走 overlay 且不可逆操作有提示", () => {
    setPermission({
      id: "perm-test",
      tool: "bash",
      detail: "rm -rf node_modules",
      irreversible: true,
    });
    flush();
    const app = mount(() => <App />, { width: 60, height: 20 });
    const text = app.text();

    expect(text).toContain("permission required");
    expect(text).toContain("该操作无法撤销");
    expect(text).toContain("[y] 允许");

    // overlay 的按钮有独立语义，可以被鼠标命中
    const spot = findSemantic(app, "perm:allow");
    expect(spot).toBeDefined();
    app.click(spot!.x, spot!.y);
    flush();
    expect(permission()).toBeNull();
    app.unmount();
  });

  test("拒绝权限后状态更新", () => {
    setPermission({ id: "perm-2", tool: "bash", detail: "git push", irreversible: true });
    flush();
    expect(permission()?.id).toBe("perm-2");
    respondPermission(false);
    flush();
    expect(permission()).toBeNull();
  });
});

/** 扫描帧，找到第一个匹配语义前缀的 cell 坐标 */
function findSemantic(app: ReturnType<typeof mount>, prefix: string) {
  const frame = app.frame();
  for (let y = 0; y < frame.lines.length; y++) {
    const line = frame.lines[y];
    for (let x = 0; x < line.length; x++) {
      const semantic = line[x].semantic;
      if (semantic && semantic.startsWith(prefix)) return { x, y, semantic };
    }
  }
  return undefined;
}
