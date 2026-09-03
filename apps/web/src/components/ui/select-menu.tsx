"use client";

import { Check, ChevronDown } from "lucide-react";
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
  const [placement, setPlacement] = useState<{ up: boolean; shiftX: number }>({ up: false, shiftX: 0 });

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
    // Flip up only when below genuinely does not fit and above does.
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;
    const up = spaceBelow < listRect.height + margin && spaceAbove > spaceBelow;
    let shiftX = 0;
    if (listRect.left < margin) shiftX = margin - listRect.left;
    else if (listRect.right > window.innerWidth - margin) shiftX = window.innerWidth - margin - listRect.right;
    setPlacement({ up, shiftX });
  }, [open]);

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
          style={placement.shiftX ? { transform: `translateX(${placement.shiftX}px)` } : undefined}
          className={cn(
            "absolute z-50 min-w-full overflow-hidden bg-card p-1 outline-none wanderly-edge wanderly-r-md wanderly-shadow",
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
                  "flex cursor-pointer items-center gap-2 whitespace-nowrap px-3 py-2 text-sm wanderly-r-sm",
                  index === activeIndex && "bg-[var(--w-highlight)]",
                )}
              >
                <Check aria-hidden="true" className={cn("size-4 shrink-0", !isSelected && "opacity-0")} />
                {option.label}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
