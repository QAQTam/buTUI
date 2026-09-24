import { createSignal } from "solid-js";
import type { TooltipPoint } from "./tooltip.ts";

export interface PopoverControllerOptions {
  onChange?: (open: boolean) => void;
}

export interface PopoverController {
  open(): boolean;
  anchor(): TooltipPoint | undefined;
  show(anchor?: TooltipPoint): void;
  toggle(anchor?: TooltipPoint): void;
  hide(): void;
  dispose(): void;
}

export function createPopoverController(
  options: PopoverControllerOptions = {}
): PopoverController {
  const [open, setOpen] = createSignal(false);
  const [anchor, setAnchor] = createSignal<TooltipPoint>();
  let disposed = false;

  const update = (next: boolean): void => {
    if (disposed || open() === next) return;
    setOpen(next);
    options.onChange?.(next);
  };
  const show = (point?: TooltipPoint): void => {
    if (point) setAnchor(point);
    update(true);
  };

  return {
    open,
    anchor,
    show,
    toggle(point) {
      if (open()) update(false);
      else show(point);
    },
    hide() {
      update(false);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      setOpen(false);
      setAnchor(undefined);
    },
  };
}
