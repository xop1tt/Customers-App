// «Мои права»: роль и что она разрешает, простым языком (A8, ADR-077). Права задаёт сервер; здесь только показ.

import { useState } from "react";
import { api } from "../../api";
import { Button, Group, SettingRow, Spinner } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { Dialog } from "../../ui/overlay";
import { useStore } from "../../state/store";
import { useWsQuery } from "./useCrm";

export function MyRights() {
  const ws = useStore((s) => s.ws);
  const [open, setOpen] = useState(false);
  const current = ws?.workspaces.find((w) => w.id === ws.active);
  if (!ws || !current) return null;
  return (
    <Group title="Мои права">
      <SettingRow title={`Ваша роль: ${current.roleName}`} hint="Что можно и чего нельзя в этом рабочем пространстве. Изменить права может владелец или администратор.">
        <Button small icon="shield" onClick={() => setOpen(true)}>Что мне разрешено</Button>
      </SettingRow>
      {open && <RightsDialog onClose={() => setOpen(false)} roleName={current.roleName} perms={ws.permissions} />}
    </Group>
  );
}

function RightsDialog({ onClose, roleName, perms }: { onClose: () => void; roleName: string; perms: string[] }) {
  const { data } = useWsQuery(() => api.wsRoles().catch(() => null), []);
  const catalog = data?.catalog ?? [];
  const yes = catalog.filter((c) => perms.includes(c.key));
  const no = catalog.filter((c) => !perms.includes(c.key));
  return (
    <Dialog title={`Мои права · ${roleName}`} onClose={onClose} width={520}>
      {!data ? <Spinner /> : !catalog.length ? (
        <p className="faint">Для этого рабочего пространства список прав не ведётся: вы работаете один.</p>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <ul className="col" style={{ gap: 4 }} aria-label="Разрешено">
            {yes.map((c) => <li key={c.key} className="row" style={{ gap: 8 }}><Icon name="check" size={14} /><span>{c.description}</span></li>)}
          </ul>
          {no.length > 0 && (
            <>
              <strong>Недоступно вашей роли</strong>
              <ul className="col faint" style={{ gap: 4 }} aria-label="Недоступно">
                {no.map((c) => <li key={c.key} className="row" style={{ gap: 8 }}><Icon name="x" size={14} /><span>{c.description}</span></li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}
