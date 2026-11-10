// Профиль: свой (из меню учётной записи). Имя и фото меняются в настройках учётной записи.

import { Avatar, Button, Tag } from "../../ui/kit";
import { Icon } from "../../ui/icons";
import { openSettings, useStore } from "../../state/store";

export function ProfilePage() {
  const session = useStore((s) => s.session);
  const ws = useStore((s) => s.ws);
  if (!session) return null;
  const current = ws?.workspaces.find((w) => w.id === ws.active);
  const email = session.cloudUser?.email ?? null;
  return (
    <div className="page scroll">
      <div className="profile">
        <header className="profile-head">
          <Avatar name={session.displayName} src={session.avatar} size={96} />
          <div className="col profile-title">
            <h1 className="selectable">{session.displayName}</h1>
            <div className="row profile-tags">
              {current && <Tag tone="blue" icon="shield">{current.roleName}</Tag>}
              <Tag>{session.isCloud ? "Облачная учётная запись" : "Локальная учётная запись"}</Tag>
            </div>
          </div>
          <span className="grow" />
          <Button icon="edit" onClick={() => openSettings("account", "profile")}>Изменить профиль</Button>
        </header>
        <dl className="profile-facts">
          <ProfileFact icon="mail" label="Почта">{email ? <span className="selectable">{email}</span> : <span className="faint">Нет: локальная учётная запись</span>}</ProfileFact>
          {current && <ProfileFact icon="users" label="Рабочее пространство">{current.name}</ProfileFact>}
        </dl>
      </div>
    </div>
  );
}

export function ProfileFact({ icon, label, children }: { icon: string; label: string; children: React.ReactNode }) {
  return (
    <div className="profile-fact">
      <dt><Icon name={icon} size={14} />{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
