import type { SolidPlugin } from "@butui/plugins/solid";

interface Slots {
  header: { title: string };
  footer: { hint: string };
}

interface Context {
  theme: string;
}

export default {
  id: "demo.footer",
  order: 0,
  slots: {
    footer: (_ctx, props) => <text color="muted">{props.hint}</text>,
  },
} satisfies SolidPlugin<Slots, Context>;
