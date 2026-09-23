/**
 * `<Table>` —— SPEC §10.1。
 *
 * 刻意不做「自动列宽推断」那套：TUI 里表格的宽度预算应该由**应用**决定
 * （它知道自己在几列终端里跑、旁边还有什么面板）。所以列宽要么显式给，
 * 要么按该列最长内容算一个自然宽度，然后整体按可用宽度裁剪。
 *
 * 没有竖线：终端里 `│` 会把本来就紧张的横向空间再切掉一列，而且复制出来的
 * 文本很难看。靠 `gap` + 对齐表达结构。
 */
import type { JSX } from "@butui/solid/jsx-runtime";
import { For, Show } from "solid-js";

export interface TableColumn {
  /** 取值用的 key（`row[key]`） */
  key: string;
  /** 表头文字；不给就不画表头 */
  title?: string;
  /** 固定列宽（cell）；不给就按内容算 */
  width?: number;
  /** 对齐方式；`left` / `right` 等价于布局层的 `start` / `end` */
  align?: "left" | "right" | "center";
  color?: string;
  /** 表头颜色，默认 muted */
  headerColor?: string;
}

export interface TableProps {
  columns: readonly TableColumn[];
  rows: ReadonlyArray<Record<string, string>>;
  /** 列间距，默认 2 */
  gap?: number;
  /** 表头下面画一条横线（默认 true） */
  headerRule?: boolean;
  /** 没有数据时显示的内容 */
  empty?: JSX.Element;
  semantic?: string;
}

const widthOf = (text: string): number => Bun.stringWidth(text);

/** 表格用 left/right 说话，布局层用 start/end —— 在这里翻译一次 */
const ALIGN = { left: "start", right: "end", center: "center" } as const;

export function Table(props: TableProps) {
  const gap = (): number => Math.max(0, props.gap ?? 2);

  /** 显式宽度优先，否则取该列「表头 + 所有单元格」里最宽的那个 */
  const columnWidths = (): number[] =>
    props.columns.map(column => {
      if (column.width !== undefined) return Math.max(1, Math.floor(column.width));
      let widest = column.title ? widthOf(column.title) : 0;
      for (const row of props.rows) {
        widest = Math.max(widest, widthOf(row[column.key] ?? ""));
      }
      return Math.max(1, widest);
    });

  const cell = (text: string, column: TableColumn, width: number, header: boolean): JSX.Element => (
    <box width={width} align={ALIGN[column.align ?? "left"]}>
      <text
        color={header ? (column.headerColor ?? "muted") : (column.color ?? "fg")}
        bold={header}
        truncate
      >
        {text}
      </text>
    </box>
  );

  return (
    <box gap={0} semantic={props.semantic ?? "table"}>
      <Show
        when={props.rows.length > 0}
        fallback={<Show when={props.empty}>{props.empty}</Show>}
      >
        <Show when={props.columns.some(column => column.title !== undefined)}>
          <row gap={gap()}>
            <For each={props.columns}>
              {(column, index) =>
                cell(column.title ?? "", column, columnWidths()[index()]!, true)
              }
            </For>
          </row>
        </Show>

        <Show when={props.headerRule !== false && props.columns.some(c => c.title)}>
          <row gap={gap()}>
            <For each={props.columns}>
              {(column, index) => (
                <text color="border" wrap={false}>
                  {"─".repeat(columnWidths()[index()]!)}
                </text>
              )}
            </For>
          </row>
        </Show>

        <For each={props.rows}>
          {row => (
            <row gap={gap()}>
              <For each={props.columns}>
                {(column, index) =>
                  cell(row[column.key] ?? "", column, columnWidths()[index()]!, false)
                }
              </For>
            </row>
          )}
        </For>
      </Show>
    </box>
  );
}
