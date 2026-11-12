// Кто сейчас работает: роль, ранг и должность в активном рабочем пространстве (для правил из lib/positions.ts).

import { useStore } from "../../state/store";
import type { TeamMember } from "../../api/types";

export type Actor = Pick<TeamMember, "user_id" | "role" | "rank" | "title">;

export function useActor(): Actor | null {
  const ws = useStore((s) => s.ws);
  const team = useStore((s) => s.team);
  const current = ws?.workspaces.find((w) => w.id === ws.active);
  if (!ws || !current) return null;
  const mine = team.find((m) => m.user_id === ws.me);
  return { user_id: ws.me, role: current.role, rank: current.rank, title: mine?.title ?? "" };
}
