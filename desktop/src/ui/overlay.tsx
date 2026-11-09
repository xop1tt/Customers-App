// Всплывающие слои: поповеры, меню, подсказки, диалоги. Все слои непрозрачные и рисуются в одном месте поверх приложения.

import { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

const layerRoot = () => document.body;

/** Положение слоя рядом с якорем с переворотом, если места снизу не хватает. */
export type Anchor = { x: number; y: number } | DOMRect;
const isRect = (a: Anchor): a is DOMRect => "width" in a;

function place(a: Anchor, w: number, h: number, placement: "bottom-start" | "bottom-end" | "right-start" | "top-start") {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 8;
  let x: number;
  let y: number;
  if (!isRect(a)) {
    x = a.x;
    y = a.y;
  } else if (placement === "right-start") {
    x = a.right + 6;
    y = a.top;
  } else if (placement === "bottom-end") {
    x = a.right - w;
    y = a.bottom + 4;
  } else if (placement === "top-start") {
    x = a.left;
    y = a.top - h - 4;
  } else {
    x = a.left;
    y = a.bottom + 4;
  }
  if (isRect(a)) {
    if (y + h > vh - pad && a.top - h - 4 > pad) y = a.top - h - 4;
    if (x + w > vw - pad && placement === "right-start") x = a.left - w - 6;
  }
  x = Math.max(pad, Math.min(x, vw - w - pad));
  y = Math.max(pad, Math.min(y, vh - h - pad));
  return { x, y };
}

interface PopoverProps {
  anchor: Anchor;
  onClose: () => void;
  placement?: "bottom-start" | "bottom-end" | "right-start" | "top-start";
  children: ReactNode;
  className?: string;
  minWidth?: number | "anchor";
  /** Элемент, нажатие на который не считается «снаружи» (кнопка-триггер). */
  ignore?: HTMLElement | null;
  role?: string;
}

export function Popover({ anchor, onClose, placement = "bottom-start", children, className = "", minWidth, ignore, role }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setPos(place(anchor, el.offsetWidth, el.offsetHeight, placement));
  }, [anchor, placement, children]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || ignore?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    const resize = () => onClose();
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("resize", resize);
    window.addEventListener("blur", resize);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
      window.removeEventListener("blur", resize);
    };
  }, [onClose, ignore]);

  // Пока положение не посчитано, слой прозрачен. `visibility: hidden` не используем: в WebKit (macOS)
  // после его снятия текст внутри слоя мог не отрисоваться.
  const style: React.CSSProperties = pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, opacity: 0, pointerEvents: "none", animation: "none" };
  if (minWidth === "anchor" && isRect(anchor)) style.minWidth = anchor.width;
  else if (typeof minWidth === "number") style.minWidth = minWidth;
  return createPortal(
    <div ref={ref} className={`popover ${className}`} style={style} role={role}>
      {children}
    </div>,
    layerRoot(),
  );
}

// ------------------------------------------------------------------ меню

export interface MenuItem {
  label?: string;
  icon?: string;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  onSelect?: () => void;
}

interface MenuState { items: MenuItem[]; anchor: Anchor; placement?: "bottom-start" | "bottom-end" | "right-start" | "top-start" }
let menuState: MenuState | null = null;
const menuSubs = new Set<() => void>();
const emitMenu = () => menuSubs.forEach((f) => f());

export function showMenu(items: MenuItem[], anchor: Anchor, placement?: MenuState["placement"]) {
  menuState = { items, anchor, placement };
  emitMenu();
}
export function closeMenu() {
  if (menuState) { menuState = null; emitMenu(); }
}

export function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const [index, setIndex] = useState(-1);
  const enabled = items.map((it, i) => (it.separator || it.disabled ? -1 : i)).filter((i) => i >= 0);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const cur = enabled.indexOf(index);
        const next = e.key === "ArrowDown" ? (cur + 1) % enabled.length : (cur <= 0 ? enabled.length - 1 : cur - 1);
        setIndex(enabled[next] ?? -1);
      } else if (e.key === "Enter" && index >= 0) {
        e.preventDefault();
        const it = items[index];
        onDone();
        it?.onSelect?.();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  });
  return (
    <ul className="menu" role="menu">
      {items.map((it, i) =>
        it.separator ? (
          <li key={i} className="menu-sep" role="separator" />
        ) : (
          <li key={i} role="menuitem" aria-disabled={it.disabled}>
            <button
              type="button"
              className={`menu-item${it.danger ? " danger" : ""}${index === i ? " active" : ""}`}
              disabled={it.disabled}
              onPointerEnter={() => setIndex(i)}
              onClick={() => { onDone(); it.onSelect?.(); }}
            >
              <span className="menu-icon">{it.checked ? <Icon name="check" size={14} /> : it.icon ? <Icon name={it.icon} size={14} /> : null}</span>
              <span className="ellipsis grow">{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

export function MenuHost() {
  const st = useSyncExternalStore((f) => { menuSubs.add(f); return () => { menuSubs.delete(f); }; }, () => menuState);
  if (!st) return null;
  return (
    <Popover anchor={st.anchor} placement={st.placement} onClose={closeMenu} className="popover-menu" minWidth={168}>
      <MenuList items={st.items} onDone={closeMenu} />
    </Popover>
  );
}

/** Кнопка с меню: меню открывается у якоря, закрывается при выборе. */
export function useMenuButton(items: () => MenuItem[], placement: MenuState["placement"] = "bottom-start") {
  return useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(items(), r, placement);
    },
    [items, placement],
  );
}

// ------------------------------------------------------------------ подсказки

interface TipState { text: string; rect: DOMRect }
let tipState: TipState | null = null;
const tipSubs = new Set<() => void>();
const setTip = (t: TipState | null) => { tipState = t; tipSubs.forEach((f) => f()); };

export function TooltipHost() {
  const tip = useSyncExternalStore((f) => { tipSubs.add(f); return () => { tipSubs.delete(f); }; }, () => tipState);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: Element | null = null;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; current = null; setTip(null); };
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]") ?? null;
      if (el === current) return;
      clear();
      if (!el) return;
      current = el;
      timer = setTimeout(() => {
        const text = el.getAttribute("data-tip");
        if (text && el.isConnected) setTip({ text, rect: el.getBoundingClientRect() });
      }, tipState ? 60 : 450);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", clear, true);
    document.addEventListener("keydown", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", clear, true);
      document.removeEventListener("keydown", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, []);

  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(null);
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    let x = tip.rect.left + tip.rect.width / 2 - w / 2;
    let y = tip.rect.bottom + 6;
    if (y + h > window.innerHeight - 6) y = tip.rect.top - h - 6;
    x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
    setPos({ x, y });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={ref} className="tooltip" role="tooltip" style={pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, opacity: 0, pointerEvents: "none" }}>
      {tip.text}
    </div>,
    layerRoot(),
  );
}

// ------------------------------------------------------------------ диалоги

interface DialogProps {
  title?: string;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Не закрывать по нажатию на фон (например, во время операции). */
  modal?: boolean;
  className?: string;
}

export function Dialog({ title, onClose, children, footer, width = 480, modal, className = "" }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("[data-autofocus], input, textarea, select, button:not(.dialog-x)");
    first?.focus();
    return () => { prev?.focus?.(); };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose && !modal && !document.querySelector(".popover")) { e.stopPropagation(); onClose(); }
      if (e.key === "Tab" && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea, select, [tabindex='0']")].filter((x) => x.offsetParent !== null);
        if (f.length === 0) return;
        const first = f[0] as HTMLElement;
        const last = f[f.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose, modal]);
  return createPortal(
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget && onClose && !modal) onClose(); }}>
      <div ref={ref} className={`dialog ${className}`} style={{ width }} role="dialog" aria-modal="true" aria-label={title}>
        {(title || onClose) && (
          <header className="dialog-head">
            <h3 className="grow ellipsis">{title}</h3>
            {onClose && !modal && (
              <button type="button" className="icon-btn dialog-x" onClick={onClose} aria-label="Закрыть" data-tip="Закрыть">
                <Icon name="x" size={15} />
              </button>
            )}
          </header>
        )}
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>,
    layerRoot(),
  );
}

// ------------------------------------------------------------------ подтверждение

interface ConfirmRequest {
  title: string;
  message?: string;
  confirm?: string;
  cancel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
let confirmReq: ConfirmRequest | null = null;
const confirmSubs = new Set<() => void>();

export function confirmDialog(o: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => {
    confirmReq = { ...o, resolve };
    confirmSubs.forEach((f) => f());
  });
}

export function ConfirmHost() {
  const req = useSyncExternalStore((f) => { confirmSubs.add(f); return () => { confirmSubs.delete(f); }; }, () => confirmReq);
  if (!req) return null;
  const done = (ok: boolean) => { confirmReq = null; confirmSubs.forEach((f) => f()); req.resolve(ok); };
  return (
    <Dialog
      title={req.title}
      width={420}
      onClose={() => done(false)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => done(false)}>{req.cancel ?? "Отмена"}</button>
          <button type="button" className={`btn ${req.danger ? "btn-danger" : "btn-primary"}`} onClick={() => done(true)} data-autofocus>
            {req.confirm ?? "Подтвердить"}
          </button>
        </>
      }
    >
      {req.message && <p className="muted dialog-text">{req.message}</p>}
    </Dialog>
  );
}

// ------------------------------------------------------------------ контекстное меню полей ввода

/** Меню «Вырезать / Копировать / Вставить» для текстовых полей. Остальные места получают своё меню или никакого. */
export function installInputContextMenu(readClipboard: () => Promise<string>, writeClipboard: (t: string) => Promise<void>) {
  const handler = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    const field = t?.closest?.("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
    if (field && !(field instanceof HTMLInputElement && ["checkbox", "radio", "range", "button"].includes(field.type))) {
      e.preventDefault();
      const has = field.selectionStart !== field.selectionEnd;
      const ro = field.readOnly || field.disabled;
      const replace = (text: string) => {
        const s = field.selectionStart ?? field.value.length;
        const en = field.selectionEnd ?? s;
        const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        setter?.call(field, field.value.slice(0, s) + text + field.value.slice(en));
        field.setSelectionRange(s + text.length, s + text.length);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      };
      field.focus();
      showMenu(
        [
          { label: "Вырезать", icon: "x", disabled: !has || ro, onSelect: () => { void writeClipboard(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)); replace(""); } },
          { label: "Копировать", icon: "copy", disabled: !has, onSelect: () => void writeClipboard(field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)) },
          { label: "Вставить", icon: "file", disabled: ro, onSelect: () => void readClipboard().then((txt) => replace(txt)).catch(() => {}) },
          { separator: true },
          { label: "Выделить всё", onSelect: () => field.select() },
        ],
        { x: e.clientX, y: e.clientY },
      );
      return;
    }
    if (!(e.target as HTMLElement | null)?.closest?.("[data-native-menu]")) e.preventDefault();
  };
  document.addEventListener("contextmenu", handler);
  return () => document.removeEventListener("contextmenu", handler);
}
