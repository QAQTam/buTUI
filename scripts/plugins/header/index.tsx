import type { SolidPlugin } from "@butui/plugins/solid";

interface Slots {
  header: { title: string };
  footer: { hint: string };
}

interface Context {
  theme: string;
}

export default {
  id: "demo.header",
  order: 0,
  slots: {
    header: (ctx, props) => (
      <text bold color="accent">
        {`${props.title} · ${ctx.theme}`}
      </text>
    ),
  },
} satisfies SolidPlugin<Slots, Context>;
