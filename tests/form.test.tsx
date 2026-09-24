import { describe, expect, test } from "bun:test";
import {
  Form,
  FormField,
  createForm,
  useForm,
} from "@butui/components";
import { type Node, focusNode, walk } from "@butui/core";
import { mount } from "@butui/test";
import { flush } from "solid-js";

function findBySemantic(root: Node, semantic: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.kind === "element" && node.props.semantic === semantic) return node;
  }
  return undefined;
}

interface Values {
  name: string;
  count: number;
}

describe("createForm", () => {
  test("setValue / touched / validation / async submit / reset", async () => {
    const submitted: Values[] = [];
    const form = createForm<Values>({
      initialValues: { name: "", count: 0 },
      validate(values) {
        return values.name ? {} : { name: "name required" };
      },
      async onSubmit(values) {
        await Bun.sleep(0);
        submitted.push({ ...values });
      },
    });

    expect(form.values()).toEqual({ name: "", count: 0 });
    expect(form.dirty()).toBe(false);
    form.setValue("name", "A");
    flush();
    expect(form.value("name")).toBe("A");
    expect(form.dirty()).toBe(true);

    form.touch("name");
    flush();
    expect(form.touched("name")).toBe(true);
    expect(await form.validate()).toBe(true);
    expect(await form.submit()).toBe(true);
    expect(submitted).toEqual([{ name: "A", count: 0 }]);
    expect(form.submitted()).toBe(true);

    form.reset({ count: 2 });
    flush();
    expect(form.values()).toEqual({ name: "", count: 2 });
    expect(form.dirty()).toBe(true);
    expect(form.touched("name")).toBe(false);
  });

  test("validation failure 阻止 onSubmit", async () => {
    let submits = 0;
    const form = createForm<Values>({
      initialValues: { name: "", count: 0 },
      validate: () => ({ name: "required" }),
      onSubmit() {
        submits++;
      },
    });

    expect(await form.submit()).toBe(false);
    expect(submits).toBe(0);
    expect(form.error("name")).toBe("required");
    expect(form.valid()).toBe(false);
  });
});

describe("<Form>", () => {
  test("提供 context、显示 field error，并在 Enter 提交", async () => {
    let submits = 0;
    const form = createForm<Values>({
      initialValues: { name: "", count: 0 },
      validate: values => (values.name ? {} : { name: "required" }),
      onSubmit() {
        submits++;
      },
    });
    const Probe = () => {
      const current = useForm<Values>();
      return <text>value:{String(current?.value("name"))}</text>;
    };
    const app = mount(
      () => (
        <Form form={form}>
          <FormField name="name" label="Name" required>
            <Probe />
          </FormField>
        </Form>
      ),
      { width: 30, height: 6 }
    );

    expect(app.text()).toContain("value:");
    form.setValue("name", "A");
    app.flush();
    expect(app.text()).toContain("value:A");

    focusNode(app.root, findBySemantic(app.root, "form"));
    app.key("enter");
    await Bun.sleep(0);
    app.flush();
    expect(submits).toBe(1);

    form.setValue("name", "");
    form.touch("name");
    await form.validate();
    app.flush();
    expect(app.text()).toContain("required");
    app.unmount();
  });
});
