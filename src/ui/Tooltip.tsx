import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/*
 * One tooltip for the whole app, in place of the native `title` tooltip, which the system draws
 * and which looks out of place on Windows. Mark an element with `data-tooltip="text"`; add
 * `data-tooltip-overflow` to show it only while the element's own text is cut off.
 */

const SHOW_DELAY_MS = 500;
/** Moving from one tooltip to the next within this window shows the next one at once. */
const WARM_MS = 400;
const GAP = 6;
const EDGE = 8;

interface Shown {
  anchor: HTMLElement;
  text: string;
}

function tooltipOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[data-tooltip]") : null;
}

function wanted(anchor: HTMLElement): string | null {
  const text = anchor.dataset.tooltip;
  if (!text) return null;
  if (anchor.hasAttribute("data-tooltip-overflow") && anchor.scrollWidth <= anchor.clientWidth) return null;
  return text;
}

export function TooltipLayer() {
  const [shown, setShown] = useState<Shown | null>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: HTMLElement | null = null;
    // A press hides the tooltip until the pointer leaves that element.
    let suppressed: HTMLElement | null = null;
    let hiddenAt = 0;
    let visible = false;

    const hide = () => {
      clearTimeout(timer);
      current = null;
      if (visible) hiddenAt = Date.now();
      visible = false;
      setShown(null);
    };
    const show = (anchor: HTMLElement, immediately: boolean) => {
      clearTimeout(timer);
      current = anchor;
      const reveal = () => {
        const text = anchor.isConnected ? wanted(anchor) : null;
        if (!text) return;
        visible = true;
        setShown({ anchor, text });
      };
      if (immediately || Date.now() - hiddenAt < WARM_MS) reveal();
      else timer = setTimeout(reveal, SHOW_DELAY_MS);
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const anchor = tooltipOf(event.target);
      if (anchor === current) return;
      if (visible || current) hide();
      if (anchor && anchor !== suppressed) show(anchor, false);
    };
    const onOut = (event: PointerEvent) => {
      const left = tooltipOf(event.target);
      if (left && !left.contains(event.relatedTarget as Node | null)) {
        if (left === suppressed) suppressed = null;
        if (left === current) hide();
      }
    };
    const onDown = (event: PointerEvent) => {
      suppressed = tooltipOf(event.target);
      hide();
    };
    const onFocus = (event: FocusEvent) => {
      const anchor = tooltipOf(event.target);
      if (anchor && anchor === event.target && anchor.matches(":focus-visible")) show(anchor, true);
    };
    const onBlur = (event: FocusEvent) => {
      if (tooltipOf(event.target) === current) hide();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && current) hide();
    };

    document.addEventListener("pointerover", onOver);
    document.addEventListener("pointerout", onOut);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerout", onOut);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Centred below the element, or above it when there is no room below, and kept inside the window.
  useLayoutEffect(() => {
    if (!shown || !bubble.current) {
      setPosition(null);
      return;
    }
    const target = shown.anchor.getBoundingClientRect();
    const box = bubble.current.getBoundingClientRect();
    const below = target.bottom + GAP;
    const top = below + box.height > window.innerHeight - EDGE ? target.top - GAP - box.height : below;
    const left = target.left + target.width / 2 - box.width / 2;
    setPosition({
      left: Math.max(EDGE, Math.min(left, window.innerWidth - box.width - EDGE)),
      top: Math.max(EDGE, top),
    });
  }, [shown]);

  if (!shown) return null;
  return createPortal(
    <div
      ref={bubble}
      role="tooltip"
      className={`pointer-events-none fixed z-[60] max-w-80 break-words rounded-md bg-tooltip px-2 py-1 text-xs leading-4 text-on-tooltip shadow-overlay transition-opacity duration-100 ${
        position ? "opacity-100" : "opacity-0"
      }`}
      style={position ?? { left: 0, top: 0 }}
    >
      {shown.text}
    </div>,
    document.body,
  );
}
