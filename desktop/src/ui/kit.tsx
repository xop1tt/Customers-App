// Единый набор элементов управления. Все экраны собирают интерфейс только из них.

import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes, createContext, forwardRef, useContext, useEffect, useId, useRef, useState } from "react";
import { scoreTone } from "../lib/leads";
import { Icon } from "./icons";
import { Popover } from "./overlay";

// ------------------------------------------------------------------ кнопки

type Variant = "default" | "primary" | "danger" | "ghost" | "subtle";
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: string;
  busy?: boolean;
  small?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, BtnProps>(function Button({ variant = "default", icon, busy, small, className = "", children, disabled, type = "button", ...rest }, ref) {
  const v = variant === "default" ? "" : `btn-${variant}`;
  return (
    <button ref={ref} type={type} className={`btn ${v}${small ? " btn-sm" : ""} ${className}`} disabled={disabled || busy} {...rest}>
      {busy ? <Spinner size={13} /> : icon ? <Icon name={icon} size={14} /> : null}
      {children != null && children !== false && <span className="btn-label">{children}</span>}
    </button>
  );
});

interface IconBtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  tip?: string;
  active?: boolean;
  size?: number;
}
export const IconButton = forwardRef<HTMLButtonElement, IconBtnProps>(function IconButton({ icon, tip, active, size = 16, className = "", type = "button", ...rest }, ref) {
  return (
    <button ref={ref} type={type} className={`icon-btn${active ? " active" : ""} ${className}`} data-tip={tip} aria-label={tip} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
});

export function Spinner({ size = 16 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="progressbar" aria-label="Загрузка" />;
}

// ------------------------------------------------------------------ переключатели

interface SwitchProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}
export function Switch({ checked, onChange, disabled, label }: SwitchProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}>
      <span className="switch-knob" />
    </button>
  );
}

interface CheckProps { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; indeterminate?: boolean }
export function Checkbox({ checked, onChange, label, disabled, indeterminate }: CheckProps) {
  return (
    <label className={`check${disabled ? " disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
      <span className={`check-box${checked || indeterminate ? " on" : ""}`} aria-hidden="true">
        {indeterminate ? <Icon name="minus" size={11} stroke={2.6} /> : checked ? <Icon name="check" size={11} stroke={2.6} /> : null}
      </span>
      {label != null && <span className="check-label">{label}</span>}
    </label>
  );
}

interface SegProps<T extends string | number> {
  value: T;
  options: { value: T; label: ReactNode; tip?: string }[];
  onChange: (v: T) => void;
  small?: boolean;
}
export function Segmented<T extends string | number>({ value, options, onChange, small }: SegProps<T>) {
  return (
    <div className={`segmented${small ? " small" : ""}`} role="tablist">
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)} data-tip={o.tip}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ поля ввода

/** Подпись поля «Field» для полей ввода внутри него (доступность: у поля есть имя, ADR-060). */
const FieldLabel = createContext<string | undefined>(undefined);
/** aria-labelledby из Field, если у поля нет своего aria-label / aria-labelledby. */
function useFieldLabel(rest: { "aria-label"?: string; "aria-labelledby"?: string }) {
  const id = useContext(FieldLabel);
  return id && !rest["aria-label"] && !rest["aria-labelledby"] ? { "aria-labelledby": id } : {};
}

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  value: string;
  onChange: (v: string) => void;
  icon?: string;
  onClear?: () => void;
  invalid?: boolean;
  wrapClass?: string;
}
export const TextInput = forwardRef<HTMLInputElement, InputProps>(function TextInput({ value, onChange, icon, onClear, invalid, className = "", wrapClass = "", ...rest }, ref) {
  const labelled = useFieldLabel(rest);
  return (
    <div className={`input${invalid ? " invalid" : ""} ${wrapClass}`}>
      {icon && <Icon name={icon} size={14} className="input-icon" />}
      <input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} className={className} spellCheck={false} autoComplete="off" {...labelled} {...rest} />
      {onClear && value !== "" && (
        <button type="button" className="input-clear" onClick={onClear} aria-label="Очистить" tabIndex={-1}>
          <Icon name="x" size={12} />
        </button>
      )}
    </div>
  );
});

export function PasswordInput({ value, onChange, ...rest }: Omit<InputProps, "type" | "icon">) {
  const [shown, setShown] = useState(false);
  const labelled = useFieldLabel(rest);
  return (
    <div className="input">
      <input value={value} onChange={(e) => onChange(e.target.value)} type={shown ? "text" : "password"} spellCheck={false} autoComplete="off" {...labelled} {...rest} />
      <button type="button" className="input-clear" onClick={() => setShown(!shown)} aria-label={shown ? "Скрыть пароль" : "Показать пароль"} data-tip={shown ? "Скрыть" : "Показать"} tabIndex={-1}>
        <Icon name={shown ? "eyeOff" : "eye"} size={14} />
      </button>
    </div>
  );
}

interface AreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange"> {
  value: string;
  onChange: (v: string) => void;
}
export function TextArea({ value, onChange, className = "", ...rest }: AreaProps) {
  const labelled = useFieldLabel(rest);
  return <textarea className={`textarea ${className}`} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} {...labelled} {...rest} />;
}

interface NumberProps { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; width?: number }
export function NumberInput({ value, onChange, min = 0, max = 100000, step = 1, suffix, width = 120 }: NumberProps) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = (raw: string) => {
    const n = Number(raw.replace(",", "."));
    const v = Number.isFinite(n) ? Math.min(Math.max(n, min), max) : value;
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <div className="stepper" style={{ width }}>
      <button type="button" onClick={() => commit(String(value - step))} aria-label="Меньше" disabled={value <= min}><Icon name="minus" size={12} /></button>
      <input value={text} inputMode="decimal" onChange={(e) => setText(e.target.value)} onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") commit(text); }} />
      {suffix && <span className="stepper-suffix">{suffix}</span>}
      <button type="button" onClick={() => commit(String(value + step))} aria-label="Больше" disabled={value >= max}><Icon name="plus" size={12} /></button>
    </div>
  );
}

// ------------------------------------------------------------------ выпадающий список

export interface Option<T> { value: T; label: string; hint?: string }
interface SelectProps<T extends string | number> {
  value: T;
  options: Option<T>[];
  onChange: (v: T) => void;
  width?: number | string;
  small?: boolean;
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}
export function Select<T extends string | number>({ value, options, onChange, width, small, placeholder, disabled, label }: SelectProps<T>) {
  const ref = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [hot, setHot] = useState(0);
  const current = options.find((o) => o.value === value);
  const open = () => {
    if (disabled || !ref.current) return;
    setHot(Math.max(0, options.findIndex((o) => o.value === value)));
    setRect(ref.current.getBoundingClientRect());
  };
  const close = () => setRect(null);
  const pick = (o: Option<T>) => { close(); onChange(o.value); ref.current?.focus(); };
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`select${small ? " small" : ""}${rect ? " open" : ""}`}
        style={{ width }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={!!rect}
        aria-label={label}
        onClick={() => (rect ? close() : open())}
        onKeyDown={(e) => {
          if (rect) {
            if (e.key === "ArrowDown") { e.preventDefault(); setHot((hot + 1) % options.length); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setHot((hot + options.length - 1) % options.length); }
            else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const o = options[hot]; if (o) pick(o); }
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); open(); }
        }}
      >
        <span className={`ellipsis grow${current ? "" : " faint"}`}>{current?.label ?? placeholder ?? "Выбрать"}</span>
        <Icon name="chevronDown" size={13} />
      </button>
      {rect && (
        <Popover anchor={rect} onClose={close} minWidth="anchor" ignore={ref.current} className="popover-list" role="listbox">
          <ul className="list-options">
            {options.map((o, i) => (
              <li key={String(o.value)}>
                <button type="button" role="option" aria-selected={o.value === value} className={`option${i === hot ? " hot" : ""}${o.value === value ? " sel" : ""}`} onPointerEnter={() => setHot(i)} onClick={() => pick(o)}>
                  <span className="menu-icon">{o.value === value ? <Icon name="check" size={13} /> : null}</span>
                  <span className="ellipsis grow">{o.label}</span>
                  {o.hint && <span className="menu-hint">{o.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      )}
    </>
  );
}

// ------------------------------------------------------------------ метки и оценки

export function Tag({ children, tone = "gray", icon, title }: { children: ReactNode; tone?: "gray" | "red" | "orange" | "green" | "purple" | "blue"; icon?: string; title?: string }) {
  return (
    <span className={`tag tag-${tone}`} data-tip={title}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

export function Score({ value, big }: { value: number; big?: boolean }) {
  const tone = scoreTone(value);
  return <span className={`score score-${tone}${big ? " score-big" : ""} num`}>{Math.round(value)}</span>;
}

export function ProgressBar({ value, tone, label = "Ход выполнения" }: { value: number; tone?: "good" | "mid" | "low"; label?: string }) {
  return (
    <div className="bar" role="progressbar" aria-label={label} aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <div className={`bar-fill ${tone ?? ""}`} style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Avatar({ name, size = 28, src }: { name: string; size?: number; src?: string | null }) {
  const letter = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.46) }} aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : letter}
    </span>
  );
}

export function EmptyState({ icon = "inbox", title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={26} stroke={1.4} /></div>
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

// ------------------------------------------------------------------ формы и настройки

export function Field({ label, hint, error, children }: { label?: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  const id = useId();
  return (
    <div className="field" id={id}>
      {label && <div className="field-label" id={`${id}-label`}>{label}</div>}
      <FieldLabel.Provider value={label ? `${id}-label` : undefined}>{children}</FieldLabel.Provider>
      {error ? <div className="field-error" role="alert">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

/** Группа настроек: заголовок и строки, разделённые линиями. */
/** Открытый подраздел настроек: группы с `sub` показываются, только когда выбран их подраздел. */
export const SubContext = createContext<string | null>(null);

export function Sub({ id, children }: { id: string; children: ReactNode }) {
  const current = useContext(SubContext);
  return current === null || current === id ? <>{children}</> : null;
}

export function Group({ title, note, children, action, sub }: { title?: string; note?: ReactNode; children: ReactNode; action?: ReactNode; sub?: string }) {
  const current = useContext(SubContext);
  if (sub && current !== null && current !== sub) return null;
  return (
    <section className="group">
      {(title || action) && (
        <div className="group-head">
          {title && <h4>{title}</h4>}
          <span className="grow" />
          {action}
        </div>
      )}
      <div className="group-body">{children}</div>
      {note && <p className="group-note">{note}</p>}
    </section>
  );
}

export function SettingRow({ title, hint, children, stack }: { title: ReactNode; hint?: ReactNode; children?: ReactNode; stack?: boolean }) {
  return (
    <div className={`srow${stack ? " stack" : ""}`}>
      <div className="srow-text">
        <div className="srow-title">{title}</div>
        {hint && <div className="srow-hint">{hint}</div>}
      </div>
      {children != null && <div className="srow-ctl">{children}</div>}
    </div>
  );
}

export function Notice({ tone = "info", children, action }: { tone?: "info" | "warn" | "error" | "ok"; children: ReactNode; action?: ReactNode }) {
  const icon = tone === "ok" ? "check" : tone === "info" ? "info" : "alert";
  return (
    <div className={`notice notice-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={icon} size={15} />
      <div className="grow">{children}</div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------------ списки значений

interface TagListProps {
  items: string[];
  onChange: (items: string[]) => void;
  normalize: (raw: string) => string | null;
  placeholder: string;
  addLabel?: string;
  emptyText?: string;
  onRejected?: (rejected: string[]) => void;
  prefix?: string;
}

/** Список значений с полем добавления; вставка нескольких значений через запятую, пробел или строку. */
export function ValueList({ items, onChange, normalize, placeholder, emptyText, onRejected, prefix }: TagListProps) {
  const [text, setText] = useState("");
  const add = () => {
    if (!text.trim()) return;
    const parts = text.split(/[\n,;]+/).map((p) => p.trim()).filter(Boolean);
    const out = [...items];
    const rejected: string[] = [];
    for (const raw of parts) {
      const v = normalize(raw);
      if (!v) rejected.push(raw);
      else if (!out.some((x) => x.toLowerCase() === v.toLowerCase())) out.push(v);
    }
    if (out.length !== items.length) onChange(out);
    setText("");
    if (rejected.length) onRejected?.(rejected);
  };
  return (
    <div className="valuelist">
      <div className="row">
        <TextInput value={text} onChange={setText} placeholder={placeholder} wrapClass="grow" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
        <Button onClick={add} icon="plus" disabled={!text.trim()}>Добавить</Button>
      </div>
      {items.length === 0 ? (
        emptyText && <p className="faint valuelist-empty">{emptyText}</p>
      ) : (
        <ul className="chips">
          {items.map((v) => (
            <li key={v} className="chip">
              <span className="ellipsis">{prefix}{v}</span>
              <button type="button" onClick={() => onChange(items.filter((x) => x !== v))} aria-label={`Убрать ${v}`} data-tip="Убрать">
                <Icon name="x" size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: { id: T; label: string; icon?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className={t.id === value ? "on" : ""} onClick={() => onChange(t.id)}>
          {t.icon && <Icon name={t.icon} size={14} />}
          {t.label}
        </button>
      ))}
    </div>
  );
}
