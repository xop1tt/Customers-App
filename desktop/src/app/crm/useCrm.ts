// Данные Workspace для страниц CRM: справочники (воронки, этапы, компании) и чтение с перезапросом при изменениях.

import { useEffect, useState } from "react";
import { api } from "../../api";
import type { CrmRecord } from "../../api/types";
import type { Lookup } from "../../lib/crm";
import { errText, useStore } from "../../state/store";

/** Результат запроса к ядру; перечитывается, когда меняются `deps` или данные Workspace (`wsVersion`). */
export function useWsQuery<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const version = useStore((s) => s.wsVersion);
  const [out, setOut] = useState<{ data: T | null; error: string | null }>({ data: null, error: null });
  useEffect(() => {
    let live = true;
    load().then((data) => { if (live) setOut({ data, error: null }); }, (e) => { if (live) setOut({ data: null, error: errText(e) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  return out;
}

const byId = (rows: CrmRecord[]) => new Map(rows.map((r) => [r.id, r]));

export function useLookup(): Lookup {
  const members = useStore((s) => s.ws?.members ?? []);
  const { data } = useWsQuery(async () => {
    const [pipelines, stages, companies] = await Promise.all([
      api.wsList("pipelines", { limit: 5000 }),
      api.wsList("pipeline_stages", { limit: 5000, sort: [{ field: "position", dir: "asc" }] }),
      api.wsList("companies", { limit: 5000, archived: true, sort: [{ field: "name", dir: "asc" }] }),
    ]);
    return { pipelines: pipelines.items, stages: stages.items, companies: companies.items };
  }, []);
  return {
    members,
    pipelines: byId(data?.pipelines ?? []),
    stages: byId(data?.stages ?? []),
    companies: byId(data?.companies ?? []),
  };
}

/** Этапы воронки по порядку. */
export function stagesOf(lk: Lookup, pipeline: unknown): CrmRecord[] {
  return [...lk.stages.values()].filter((s) => s.pipeline_id === pipeline).sort((a, b) => (a.position as number) - (b.position as number));
}

/** Воронка по умолчанию и её первый открытый этап — для новой сделки. */
export function defaultStage(lk: Lookup): { pipeline_id: string; stage_id: string } | null {
  const pipes = [...lk.pipelines.values()];
  const pipe = pipes.find((p) => p.is_default) ?? pipes[0];
  if (!pipe) return null;
  const stage = stagesOf(lk, pipe.id).find((s) => s.kind === "open") ?? stagesOf(lk, pipe.id)[0];
  return stage ? { pipeline_id: pipe.id, stage_id: stage.id } : null;
}
