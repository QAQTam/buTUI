import { describe, expect, test } from "bun:test";
import {
  Autocomplete,
  filterAutocompleteOptions,
  type SelectOption,
} from "@butui/components";
import { mount } from "@butui/test";

const options: Array<SelectOption<string>> = [
  { value: "main", label: "main", description: "主分支" },
  { value: "feature", label: "feature", description: "功能分支" },
  { value: "old", label: "old", disabled: true },
];

describe("filterAutocompleteOptions", () => {
  test("exact / prefix / substring / subsequence 排序并过滤 disabled", () => {
    expect(
      filterAutocompleteOptions(options, "feat").map(option => option.value)
    ).toEqual(["feature"]);
    expect(
      filterAutocompleteOptions(options, "mn").map(option => option.value)
    ).toEqual(["main"]);
    expect(
      filterAutocompleteOptions(options, "").map(option => option.value)
    ).toEqual(["main", "feature"]);
  });
});

describe("<Autocomplete>", () => {
  test("输入过滤、方向键与 Enter 选择", () => {
    const selected: string[] = [];
    const queries: string[] = [];
    const app = mount(
      () => (
        <Autocomplete
          options={options}
          autoFocus
          onQueryChange={query => queries.push(query)}
          onSelect={value => selected.push(value)}
        />
      ),
      { width: 40, height: 8 }
    );
    expect(app.text()).toContain("main");
    expect(app.text()).not.toContain("old");

    app.key("f", "f");
    app.flush();
    expect(app.text()).toContain("feature");
    expect(app.text()).not.toContain("main");

    app.key("enter");
    app.flush();
    expect(selected).toEqual(["feature"]);
    expect(queries).toContain("f");
    app.unmount();
  });

  test("Escape 清空 query 并恢复全部结果", () => {
    const app = mount(
      () => <Autocomplete options={options} query="feat" autoFocus />,
      { width: 40, height: 8 }
    );
    expect(app.text()).toContain("feature");
    expect(app.text()).not.toContain("main");

    app.key("escape");
    app.flush();
    expect(app.text()).toContain("main");
    expect(app.text()).toContain("feature");
    app.unmount();
  });
});
