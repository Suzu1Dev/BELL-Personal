/**
 * Tabs for page sections (連線與設定 tabs, 作業與專案 tabs). Route-driven
 * tabs pass `href` and render links with aria-current="page" (the URL is
 * the state); in-page tabs omit it and render an ARIA tablist with arrow
 * keys. Classes: `.tabs` › `.tab(.is-active) .mono`.
 */
import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { isComposing } from "../lib/keys";
import { cx } from "../lib/cx";
import { scrollFocusedChipIntoView } from "./Chip";
import "./Tabs.css";

export interface TabItem<V extends string> {
  value: V;
  label: string;
  /** Present → a link tab. */
  href?: string;
  count?: number;
  /** id of the panel an in-page tab controls. */
  controls?: string;
}

export type TabInteraction = "keyboard" | "pointer";

export interface TabsProps<V extends string> {
  /** zh aria-label, e.g. 「設定分頁」. */
  label: string;
  items: TabItem<V>[];
  value: V;
  onChange?: (value: V, interaction: TabInteraction) => void;
  className?: string;
}

export function nextTabIndex<V extends string>(items: TabItem<V>[], value: V, key: string): number {
  const index = items.findIndex((item) => item.value === value);
  const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  return key === "Home" ? 0 : key === "End" ? items.length - 1 : step ? (index + step + items.length) % items.length : -1;
}

export function tabValueFromTarget<V extends string>(items: TabItem<V>[], value: V, target: EventTarget | null): V {
  const focused = (target as HTMLElement | null)?.closest?.("[role=tab]")?.getAttribute("data-value");
  return items.find((item) => item.value === focused)?.value ?? value;
}

export function tabInteractionForClick(detail: number): TabInteraction {
  return detail > 0 ? "pointer" : "keyboard";
}

export function setTabKeyboardFocus(tabs: HTMLDivElement, enabled: boolean) {
  tabs.classList.toggle("is-keyboard-focus", enabled);
}

export function Tabs<V extends string>({ label, items, value, onChange, className }: TabsProps<V>) {
  const listRef = useRef<HTMLElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const links = items.every((item) => item.href);
  const reveal = (event: FocusEvent<HTMLElement>) => scrollFocusedChipIntoView(event.currentTarget, event.target as HTMLElement);
  const updateOverflow = () => {
    const element = listRef.current;
    if (element) setAtEnd(element.scrollLeft + element.clientWidth >= element.scrollWidth - 1);
  };
  useEffect(() => {
    listRef.current?.querySelector(".is-active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    updateOverflow();
  }, [value, items.length]);

  if (links) {
    return (
      <nav ref={listRef} className={cx("tabs", className)} data-overflow={atEnd ? undefined : "true"} aria-label={label} onFocus={reveal} onScroll={updateOverflow}>
        {items.map((item) => (
          <a key={item.value} href={item.href} className={cx("tab", item.value === value && "is-active")} aria-current={item.value === value ? "page" : undefined}>
            {item.label}
            {item.count !== undefined ? <span className="mono">{item.count}</span> : null}
          </a>
        ))}
      </nav>
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isComposing(event.nativeEvent)) return;
    setTabKeyboardFocus(event.currentTarget, true);
    const focusedValue = tabValueFromTarget(items, value, event.target);
    const target = nextTabIndex(items, focusedValue, event.key);
    if (target < 0) return;
    event.preventDefault();
    onChange?.(items[target].value, "keyboard");
    listRef.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[target]?.focus();
  };

  return (
    <div ref={(element) => { listRef.current = element; }} className={cx("tabs", className)} data-overflow={atEnd ? undefined : "true"} role="tablist" aria-label={label} onKeyDown={onKeyDown} onPointerDown={(event) => setTabKeyboardFocus(event.currentTarget, false)} onFocus={reveal} onScroll={updateOverflow}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          data-value={item.value}
          className={cx("tab", item.value === value && "is-active")}
          aria-selected={item.value === value}
          aria-controls={item.controls}
          tabIndex={item.value === value ? 0 : -1}
          onClick={(event) => onChange?.(item.value, tabInteractionForClick(event.detail))}
        >
          {item.label}
          {item.count !== undefined ? <span className="mono">{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
