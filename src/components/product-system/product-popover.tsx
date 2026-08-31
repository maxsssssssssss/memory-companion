"use client";

import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState
} from "react";

export function ProductPopover({
  children,
  className,
  label,
  panelClassName,
  trigger,
  triggerClassName
}: Readonly<{
  children: ReactNode;
  className?: string;
  label: string;
  panelClassName?: string;
  trigger: ReactNode;
  triggerClassName?: string;
}>) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const handlePanelClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    if (target.closest("a[href], [data-product-popover-close='true']")) {
      setOpen(false);
    }
  };

  return (
    <div className={className} ref={rootRef}>
      <button
        aria-controls={panelId}
        aria-expanded={open}
        aria-label={label}
        className={triggerClassName}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        {trigger}
      </button>
      {open ? (
        <div className={panelClassName} id={panelId} onClickCapture={handlePanelClick}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
