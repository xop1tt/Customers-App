// Помощник «золотых» тестов: превращает DOM в стабильный текстовый контур
// (роли, подписи, тексты), без классов и случайных идентификаторов.

const ROLE_BY_TAG: Record<string, string> = { button: "button", a: "link", input: "input", select: "select", textarea: "textarea", h1: "heading", h2: "heading", h3: "heading", table: "table", tr: "row", li: "item", nav: "nav", dialog: "dialog" };

export function outline(root: Element): string {
  const lines: string[] = [];
  const walk = (el: Element, depth: number) => {
    const role = el.getAttribute("role") ?? ROLE_BY_TAG[el.tagName.toLowerCase()];
    const label = el.getAttribute("aria-label") ?? "";
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    const head = [role, label && `«${label}»`, own].filter(Boolean).join(" ");
    const next = head ? depth + 1 : depth;
    if (head) lines.push(`${"  ".repeat(depth)}${head}`);
    for (const child of Array.from(el.children)) walk(child, next);
  };
  for (const child of Array.from(root.children)) walk(child, 0);
  return lines.join("\n");
}
