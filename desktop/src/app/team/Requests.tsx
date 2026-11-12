// Запросы руководству (ADR-079): отдел кадров готовит приём, смену должности и закрытие доступа, а сотрудник просит сменить имя профиля.
// Запрос уходит личным сообщением владельцу и заместителям; выполняет его тот, у кого есть право (в карточке сотрудника).

import { useState } from "react";
import type { TeamMember } from "../../api/types";
import { approversOf, nameError, nameRequestRecipients, POSITIONS, requestText, type RequestKind } from "../../lib/positions";
import { Button, Field, Notice, Select, TextInput } from "../../ui/kit";
import { Dialog } from "../../ui/overlay";
import { sendRequest } from "../../state/team";

const TITLES: Record<RequestKind, string> = {
  hire: "Запрос на оформление сотрудника",
  position: "Запрос на смену должности",
  access: "Запрос на закрытие доступа",
  name: "Запрос на смену имени",
};

export function RequestDialog({ kind, author, team, target, current, onClose }: {
  kind: RequestKind;
  author: TeamMember;
  team: TeamMember[];
  target?: TeamMember;
  /** Для смены имени: текущее имя профиля. */
  current?: string;
  onClose: () => void;
}) {
  const [position, setPosition] = useState(POSITIONS.find((p) => !p.hr && !p.lead)?.name ?? "");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const recipients = kind === "name" ? nameRequestRecipients(team, author) : approversOf(team, author.user_id);
  const nameProblem = kind === "name" ? nameError(name, current ?? "") : null;
  const missing = (kind === "hire" && !email.includes("@")) || (kind === "hire" && !name.trim()) || !!nameProblem;
  const options = (kind === "hire" || kind === "position" ? POSITIONS.filter((p) => !p.deputy) : []).map((p) => ({ value: p.name, label: p.name, hint: p.hint }));
  const send = async () => {
    setBusy(true);
    const ok = await sendRequest(recipients, requestText({ kind, author: author.display_name, target: target?.display_name, position, email, name, reason }));
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title={TITLES[kind]} onClose={onClose} width={480} footer={
      <>
        <span className="grow" />
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" busy={busy} disabled={missing || !recipients.length} onClick={() => void send()}>Отправить запрос</Button>
      </>
    }>
      <div className="col" style={{ gap: 14, alignItems: "stretch" }}>
        <Notice>
          {kind === "name"
            ? "Имя профиля задаётся при оформлении и меняется только с разрешения руководителя. Запрос получат: "
            : "Кадровые действия выполняет владелец рабочего пространства или его заместитель. Запрос получат: "}
          {recipients.length ? recipients.map((m) => m.display_name).join(", ") : "никто — в рабочем пространстве нет владельца или заместителя"}.
        </Notice>
        {target && <div>Сотрудник: <b>{target.display_name}</b></div>}
        {kind === "hire" && (
          <>
            <Field label="Почта нового сотрудника"><TextInput type="email" value={email} onChange={setEmail} autoFocus aria-label="Почта нового сотрудника" /></Field>
            <Field label="Имя в профиле" hint="Его задаёте вы при оформлении; сотрудник сам изменить его не сможет."><TextInput value={name} onChange={setName} maxLength={40} aria-label="Имя в профиле" /></Field>
          </>
        )}
        {kind === "name" && (
          <Field label="Новое имя" hint={nameProblem ?? `Сейчас: ${current ?? ""}`}><TextInput value={name} onChange={setName} maxLength={40} autoFocus aria-label="Новое имя" /></Field>
        )}
        {options.length > 0 && <Field label="Должность"><Select value={position} onChange={setPosition} options={options} label="Должность" /></Field>}
        <Field label="Причина" hint="Необязательно, но так быстрее решат."><TextInput value={reason} onChange={setReason} maxLength={400} aria-label="Причина" /></Field>
      </div>
    </Dialog>
  );
}

