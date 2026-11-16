import { Children, isValidElement, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, KeyboardEvent } from "react";
import { createPortal } from "react-dom";

type Option = { value: string | number; children: ReactNode; disabled?: boolean; title?: string };
type Props = {
  children: ReactNode;
  value?: string | number;
  defaultValue?: string | number;
  onChange?: (value: string) => void;
  name?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  title?: string;
  "aria-label"?: string;
};

// Call sites keep their option definitions; the rendered control is a button and a listbox.
export function Select({
  children,
  value,
  defaultValue,
  onChange,
  name,
  id,
  disabled,
  className = "",
  ...label
}: Props) {
  const generatedId = useId(),
    triggerId = id ?? generatedId,
    menuId = `${generatedId}-options`;
  const options = Children.toArray(children)
    .filter(isValidElement<Option>)
    .map(({ props }) => ({
      value: String(props.value),
      label: Children.toArray(props.children).join(""),
      disabled: props.disabled,
      title: props.title,
    }));
  const [internal, setInternal] = useState(String(defaultValue ?? options[0]?.value ?? "")),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(-1);
  const current = String(value ?? internal),
    selected = options.find((option) => option.value === current),
    enabled = options.flatMap((option, index) => (option.disabled ? [] : [index]));
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (value !== undefined || !name) return;
    const form = input.current!.form;
    const reset = () => setInternal(String(defaultValue ?? options[0]?.value ?? ""));
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, [value, name, defaultValue, options[0]?.value]);

  useLayoutEffect(() => {
    if (!open) return;
    if (disabled) {
      setOpen(false);
      return;
    }
    const popup = menu.current!;
    popup.showPopover();
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 12,
        above = rect.top - 12;
      popup.style.width = `${Math.min(Math.max(rect.width, 180), window.innerWidth - 16)}px`;
      popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popup.offsetWidth - 8))}px`;
      const upward = below < Math.min(320, popup.scrollHeight + 2) && above > below;
      popup.style.maxHeight = `${Math.max(0, Math.min(320, upward ? above : below))}px`;
      popup.style.top = `${upward ? rect.top - popup.offsetHeight - 4 : rect.bottom + 4}px`;
      popup.dataset.side = upward ? "top" : "bottom";
    };
    position();
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current!.contains(target) && !popup.contains(target)) setOpen(false);
    };
    const scroll = (event: Event) => {
      if (event.target !== popup) position();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", scroll, true);
    return () => {
      popup.hidePopover();
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [open, disabled]);

  useLayoutEffect(() => {
    if (open) menu.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function show(last = false) {
    const index = options.findIndex((option) => option.value === current && !option.disabled);
    setActive(index >= 0 ? index : ((last ? enabled.at(-1) : enabled[0]) ?? -1));
    setOpen(true);
  }
  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return; // Empty lists and disabled options have no selectable value.
    if (value === undefined) setInternal(option.value);
    if (option.value !== current) onChange?.(option.value);
    setOpen(false);
    trigger.current!.focus();
  }
  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!open) show(event.key === "ArrowUp");
        else {
          const next = enabled.indexOf(active) + (event.key === "ArrowDown" ? 1 : -1);
          setActive(enabled[Math.max(0, Math.min(enabled.length - 1, next))] ?? -1);
        }
        break;
      }
      case "Home":
      case "End":
        event.preventDefault();
        setOpen(true);
        setActive((event.key === "Home" ? enabled[0] : enabled.at(-1)) ?? -1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (open) choose(active);
        else show();
        break;
      case "Escape":
        if (open) {
          event.preventDefault();
          event.stopPropagation(); // Close the list before the surrounding dialog.
          setOpen(false);
        }
        break;
      case "Tab":
        setOpen(false);
        break;
    }
  }

  return (
    <span className={`select ${className}`}>
      {name && (
        <input
          ref={input}
          type="hidden"
          name={name}
          value={current}
          // Like a native select, omit an unavailable selection (e.g. an expired exception rule).
          disabled={disabled || !selected || selected.disabled}
        />
      )}
      <button
        {...label}
        id={triggerId}
        ref={trigger}
        type="button"
        className="select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-activedescendant={open && active >= 0 ? `${menuId}-${active}` : undefined}
        title={selected?.title ?? selected?.label ?? label.title}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={keyDown}
      >
        <span className="select-value">{selected?.label}</span>
        <span className="select-arrow" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            className="select-menu"
            popover="manual"
            role="listbox"
            aria-labelledby={triggerId}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${menuId}-${index}`}
                role="option"
                aria-selected={current === option.value}
                aria-disabled={option.disabled || undefined}
                data-index={index}
                className={`select-option${active === index ? " is-active" : ""}`}
                title={option.title ?? option.label}
                onPointerMove={() => {
                  if (!option.disabled) setActive(index);
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(index)}
              >
                {option.label}
              </div>
            ))}
          </div>,
          trigger.current!.closest("dialog") ?? document.body,
        )}
    </span>
  );
}
