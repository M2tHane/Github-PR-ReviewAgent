import { useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { More } from "./icons.js";

export type MenuItem = { label: string; onSelect?: () => void; href?: string; danger?: boolean };

// 操作菜单：按钮打开，方向键移动，Enter/空格执行，Esc 或 Tab 关闭并把焦点还给按钮。
// 浮层挂到 body（在对话框里则挂到对话框），不会被父容器裁掉。
export function Menu({ items, label, children }: { items: MenuItem[]; label: string; children?: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const popup = menu.current!;
    popup.showPopover();
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 8;
      const upward = below < popup.offsetHeight + 4 && rect.top > below;
      popup.style.left = `${Math.max(8, Math.min(rect.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
      popup.style.top = `${upward ? rect.top - popup.offsetHeight - 4 : rect.bottom + 4}px`;
    };
    position();
    popup.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!trigger.current!.contains(target) && !popup.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      popup.hidePopover();
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [active, open]);

  const close = (focus = true) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  function run(item: MenuItem) {
    close();
    if (item.href) location.hash = item.href.replace(/^#/, "");
    else item.onSelect?.();
  }
  function menuKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : items.length - 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // 先关菜单，不关外层对话框。
      close();
    } else if (event.key === "Tab") close(false);
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ghost icon-only menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          setActive(0);
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive(event.key === "ArrowDown" ? 0 : items.length - 1);
            setOpen(true);
          }
        }}
      >
        {children ?? <More />}
      </button>
      {open &&
        createPortal(
          <div ref={menu} id={id} className="menu" popover="manual" role="menu" aria-label={label} onKeyDown={menuKey}>
            {items.map((item, index) => (
              <button
                type="button"
                role="menuitem"
                tabIndex={index === active ? 0 : -1}
                data-index={index}
                key={item.label}
                className={item.danger ? "menu-item danger" : "menu-item"}
                onPointerMove={() => setActive(index)}
                onClick={() => run(item)}
              >
                {item.label}
              </button>
            ))}
          </div>,
          trigger.current!.closest("dialog") ?? document.body,
        )}
    </>
  );
}
