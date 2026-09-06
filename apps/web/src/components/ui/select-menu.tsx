"use client";

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export type SelectMenuOption<T extends string> = { value: T; label: string };

/**
 * A select that looks like the rest of the product.
 *
 * A native `<select>` renders its option list with the operating system's own
 * widget — no CSS reaches inside it — so a page with a considered visual
 * language still drops to a stock grey list the moment one is opened. This
 * keeps the native control's behaviour (roving focus, type-through, Escape,
 * Home/End) but draws the list itself.
 *
 * The trigger is replaceable so the same list can sit under a full-width form
 * control or under a square icon tile.
 */
/** Eight rows of options; past that a list is a page, not a menu. */
const LIST_MAX_HEIGHT = 288;
/** Below this a cramped viewport would leave a sliver rather than a menu. */
const LIST_MIN_HEIGHT = 132;

export function SelectMenu<T extends string>({
  value,
  options,
  onChange,
  id,
  ariaLabel,
  disabled,
  invalid,
  align = "start",
  triggerClassName,
  renderTrigger,
}: {
  value: T;
  options: readonly SelectMenuOption<T>[];
  onChange: (value: T) => void;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** Which edge of the trigger the list lines up with. */
  align?: "start" | "end";
  triggerClassName?: string;
  renderTrigger?: (state: { open: boolean; selected: SelectMenuOption<T> | undefined }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, options.findIndex((o) => o.value === value)));
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const selected = options.find((option) => option.value === value);
  // Measured after opening rather than guessed: this list also hangs off a
  // 44px tile at the bottom of the left rail, where opening downward ran past
  // the viewport and right-aligning pushed it off the left edge entirely.
  const [placement, setPlacement] = useState<{ up: boolean; shiftX: number; maxHeight: number }>(
    { up: false, shiftX: 0, maxHeight: LIST_MAX_HEIGHT },
  );
  // What the transform is applying right now, readable during measurement.
  const shiftXRef = useRef(0);

  // Opening decides which option is active, so no effect has to sync it back.
  const openMenu = useCallback(() => {
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    setOpen(true);
  }, [options, value]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  // Pointer-down rather than click: a click that starts inside and ends
  // outside should not count as leaving, and vice versa.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Placement is a measurement of the rendered list against the viewport, so
  // it cannot be derived during render — there is nothing to measure yet. A
  // layout effect runs before paint, so the corrected position is the first
  // one drawn. While closed the list is unmounted and the stale value is
  // simply unused, so nothing resets it.
  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const trigger = triggerRef.current;
    if (!list || !trigger) return;
    const margin = 8;
    const listRect = list.getBoundingClientRect();
    const triggerRect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    // The list scrolls, so what has to fit is the capped height, not the
    // natural one. Twenty-three nationalities are seven hundred pixels of
    // options: measured uncapped, this flipped upward and then covered the
    // form it belongs to, and there was no way to reach the entries past the
    // viewport because the list did not scroll either.
    const wanted = Math.min(listRect.height, LIST_MAX_HEIGHT);
    const up = spaceBelow < wanted + margin && spaceAbove > spaceBelow;
    // Never taller than the side it opens on. A floor keeps a cramped viewport
    // from collapsing the list to a sliver — it scrolls instead.
    const available = (up ? spaceAbove : spaceBelow) - margin * 2;
    const maxHeight = Math.max(LIST_MIN_HEIGHT, Math.min(LIST_MAX_HEIGHT, available));
    // `listRect` already carries the previous shift, because the transform is
    // still applied when this runs. Measuring it as-is made each reopen add a
    // fresh correction on top of the old one, so the second open drifted and
    // the third drifted further. Subtract what is currently applied to get
    // back to where the list actually sits.
    const naturalLeft = listRect.left - shiftXRef.current;
    const naturalRight = listRect.right - shiftXRef.current;
    let shiftX = 0;
    if (naturalLeft < margin) shiftX = margin - naturalLeft;
    else if (naturalRight > window.innerWidth - margin) shiftX = window.innerWidth - margin - naturalRight;
    shiftXRef.current = shiftX;
    setPlacement({ up, shiftX, maxHeight });
  }, [open]);

  // Once the list scrolls, the active option can sit outside it — so arrow
  // keys would move a highlight nobody can see. Follow it.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-${activeIndex}`)}`);
    active?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listId]);

  useEffect(() => {
    if (!open) return;
    // Focus the list so arrow keys and typing land here, not on the page.
    listRef.current?.focus();
  }, [open]);

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    close(true);
  }

  function onListKeyDown(event: React.KeyboardEvent) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(options.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        commit(activeIndex);
        break;
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openMenu();
          }
        }}
        className={triggerClassName ?? cn(
          "flex min-h-11 w-full items-center justify-between gap-2 bg-card px-3 text-left text-base outline-none wanderly-edge wanderly-r-sm focus-visible:ring-4 focus-visible:ring-[var(--w-highlight)]/40 sm:text-sm",
          invalid && "border-destructive",
          disabled && "opacity-60",
        )}
      >
        {renderTrigger
          ? renderTrigger({ open, selected })
          : (
            <>
              <span className="truncate">{selected?.label ?? ""}</span>
              <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
            </>
          )}
      </button>

      {open ? (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-activedescendant={`${listId}-${activeIndex}`}
          onKeyDown={onListKeyDown}
          style={{
            maxHeight: placement.maxHeight,
            ...(placement.shiftX ? { transform: `translateX(${placement.shiftX}px)` } : {}),
          }}
          className={cn(
            // Scrolls rather than growing: `overflow-hidden` clipped the rounded
            // corners and hid every option past the fold with it.
            "absolute z-50 min-w-full max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto overflow-x-hidden overscroll-contain bg-card p-1 outline-none wanderly-edge wanderly-r-md wanderly-shadow",
            align === "end" ? "right-0" : "left-0",
            placement.up ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {options.map((option, index) => {
            const isSelected = option.value === value;
            return (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={isSelected}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => commit(index)}
                className={cn(
                  "cursor-pointer whitespace-nowrap px-3 py-2 text-sm wanderly-r-sm",
                  // Selection is carried by weight as well as the highlight, so
                  // it does not rest on colour alone; `aria-selected` above is
                  // what a screen reader reads.
                  isSelected && "font-semibold",
                  // The same blue every other chosen thing wears — the selected
                  // filter chip, the new-plan button, Save Profile. The mint it
                  // used to be was the last of the old accent in this control.
                  index === activeIndex && "bg-[var(--w-cal-run)]",
                )}
              >
                {option.label}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
