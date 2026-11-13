/**
 * The ⋯ menu on a habit row: a button and a small popover of actions
 * (`--surface`, `--shadow-pop`, `--r-md`, rows like `.pal-opt`, the
 * `.snooze-pop` look of SPEC-ux §9). Arrow keys move, Esc closes and returns
 * focus to the button, a click outside closes it. IME-safe. It opens
 * upward when it would not fit below (the last rows, or above the phone
 * quickbar), and stacks above the toast host and the quickbar.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Ellipsis } from "lucide-react";
import { Button } from "../../components/Button";
import { Icon, type IconType } from "../../components/Icon";
import { cx } from "../../lib/cx";
import { isComposing } from "../../lib/keys";
import { menuOpensUp } from "./model";
import "./HabitMenu.css";

/** Measured before paint, so the menu never shows below and then jumps up. */
function opensUp(button: HTMLElement, menu: HTMLElement): boolean {
  const rect = button.getBoundingClientRect();
  const edge = (selector: string, side: "top" | "bottom") => {
    const box = document.querySelector(selector)?.getBoundingClientRect();
    return box && box.height > 0 ? box[side] : undefined;
  };
  return menuOpensUp({
    buttonTop: rect.top,
    buttonBottom: rect.bottom,
    menuHeight: menu.offsetHeight,
    viewportHeight: window.innerHeight,
    topEdge: edge(".topbar", "bottom"),
    bottomEdge: edge(".quickbar", "top"),
  });
}

export interface HabitMenuItem {
  id: string;
  label: string;
  icon: IconType;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function HabitMenu({ label, items }: { label: string; items: HabitMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);

  useLayoutEffect(() => {
    if (open && button.current && menu.current) setUp(opensUp(button.current, menu.current));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(event.nativeEvent)) return;
    const options = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === "ArrowDown" ? 1 : -1;
      options[(index + step + options.length) % options.length]?.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? options[0] : options.at(-1))?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  };

  return (
    <div className="habit-menu-wrap" ref={wrap} onKeyDown={open ? onKeyDown : undefined}>
      <Button
        ref={button}
        variant="icon"
        icon={Ellipsis}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div className={cx("habit-menu", up && "is-up")} id={menuId} role="menu" aria-label={label} ref={menu}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={cx("habit-menu-item", item.danger && "is-danger")}
              disabled={item.disabled}
              onClick={() => { close(); item.onSelect(); }}
            >
              <Icon icon={item.icon} size="sm" />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
