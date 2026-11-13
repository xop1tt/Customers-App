import { openSettings, type SettingsSection } from "../../state/store";

export interface Related { section: SettingsSection; sub?: string; label: string }

/** Сноска «См. также»: связанные параметры в других разделах настроек, переход по нажатию. */
export function SeeAlso({ items }: { items: Related[] }) {
  return (
    <p className="see-also faint" aria-label="Связанные параметры">
      См. также:{" "}
      {items.map((r, i) => (
        <span key={`${r.section}:${r.sub ?? ""}`}>
          {i > 0 && ", "}
          <button type="button" className="link" onClick={() => openSettings(r.section, r.sub ?? null)}>{r.label}</button>
        </span>
      ))}
    </p>
  );
}
