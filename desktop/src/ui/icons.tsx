// Набор линейных иконок 24×24 с единой толщиной штриха. Один компонент на все иконки приложения.

const P: Record<string, string> = {
  home: "M3 10.5 12 3l9 7.5M5 9.5V20h5v-5.5h4V20h5V9.5",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5.5 5h13L21 13v6H3v-6Z",
  sparkles: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2",
  star: "m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8L3.5 9.7l5.9-.9L12 3.5Z",
  archive: "M3 5h18v4H3zM5 9v10h14V9M10 13h4",
  ban: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM5.6 5.6l12.8 12.8",
  database: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
  history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14ZM20 20l-4.2-4.2",
  settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM19.4 13.5a7.5 7.5 0 0 0 0-3l2-1.5-2-3.5-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.4a7.5 7.5 0 0 0-2.6 1.5l-2.3-.9-2 3.5 2 1.5a7.5 7.5 0 0 0 0 3l-2 1.5 2 3.5 2.3-.9a7.5 7.5 0 0 0 2.6 1.5l.5 2.4h4l.5-2.4a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.5-2-1.5Z",
  sidebar: "M4 5h16v14H4zM9.5 5v14",
  panelRight: "M4 5h16v14H4zM14.5 5v14",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  x: "M6 6l12 12M18 6 6 18",
  check: "m5 12.5 4.5 4.5L19 7.5",
  chevronDown: "m6 9 6 6 6-6",
  chevronUp: "m6 15 6-6 6 6",
  chevronRight: "m9 6 6 6-6 6",
  chevronLeft: "m15 6-6 6 6 6",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  external: "M14 4h6v6M20 4l-9 9M18 14v5H5V6h5",
  copy: "M9 9h11v11H9zM5 15V4h11",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  phone: "M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A15 15 0 0 1 3 6a2 2 0 0 1 2-2Z",
  mail: "M3 6h18v12H3zM3 7l9 7 9-7",
  send: "m21 3-9.5 18-2.5-8-6-2.5L21 3ZM9 13l12-10",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM4 20c0-3.5 3.6-6 8-6s8 2.5 8 6",
  users: "M9 5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM2.5 19c0-3 2.9-5 6.5-5s6.5 2 6.5 5M16 6a3 3 0 0 1 0 6M18 14c2.2.5 3.5 2 3.5 4.5",
  cloud: "M7 18a4.5 4.5 0 0 1-.7-8.9A6 6 0 0 1 17.8 8 4.5 4.5 0 0 1 17.5 18H7Z",
  cloudCheck: "M7 18a4.5 4.5 0 0 1-.7-8.9A6 6 0 0 1 17.8 8 4.5 4.5 0 0 1 17.5 18H7ZM9.5 13l2 2 3.5-4",
  cloudAlert: "M7 18a4.5 4.5 0 0 1-.7-8.9A6 6 0 0 1 17.8 8 4.5 4.5 0 0 1 17.5 18H7ZM12 10.5v3M12 16h.01",
  cloudOff: "M3 3l18 18M7 18a4.5 4.5 0 0 1-.7-8.9M10 6a6 6 0 0 1 7.8 2A4.5 4.5 0 0 1 20 16",
  refresh: "M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  upload: "M12 16V5M7 9l5-5 5 5M5 20h14",
  folder: "M3 6h6l2 2h10v11H3z",
  file: "M6 3h8l5 5v13H6zM14 3v5h5",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  eyeOff: "M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.5 7.6C3.9 9.3 2 12 2 12s3.6 6 10 6a9.5 9.5 0 0 0 4-.9",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 11v6M12 7.5v.01",
  alert: "M12 3 2 20h20L12 3ZM12 10v5M12 17.5v.01",
  help: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 1-1 1.7M12 16.5v.01",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2ZM10 21h4",
  edit: "M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4",
  filter: "M3 5h18l-7 8v6l-4-2v-4L3 5Z",
  palette: "M12 3a9 9 0 0 0 0 18c1.5 0 2-1 1.5-2-.6-1.2.2-2.5 1.6-2.5H17a4 4 0 0 0 4-4A9 9 0 0 0 12 3ZM7.5 11h.01M10 7.5h.01M14.5 7.5h.01",
  shield: "M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6l-8-3Z",
  report: "M5 3h14v18H5zM9 8h6M9 12h6M9 16h3",
  chart: "M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  rss: "M5 5a14 14 0 0 1 14 14M5 11a8 8 0 0 1 8 8M6 19h.01",
  telegram: "M21 4 3 11l5.5 2L10 19l3-3.5 4.5 3.5L21 4ZM8.5 13 17 7",
  vk: "M4 7c.5 6 3.5 10 9 10v-4c2 .2 3 1.5 4 3h3c-1-2.5-2.5-3.8-3.5-4.5C17.5 10.5 19 9 19.5 7h-3c-.5 1.5-1.8 3-3.5 3.2V7h-3v5C9 11 8 9 7 7H4Z",
  pin: "M12 21s7-6.2 7-12a7 7 0 1 0-14 0c0 5.8 7 12 7 12ZM12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  tag: "M3 12V4h8l10 10-8 8L3 12ZM7.5 8h.01",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  logout: "M10 4H5v16h5M15 8l4 4-4 4M19 12H9",
  power: "M12 3v8M6.5 6.5a8 8 0 1 0 11 0",
  list: "M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01",
  stop: "M7 7h10v10H7z",
  play: "m8 5 11 7-11 7V5Z",
  dot: "M12 12h.01",
  note: "M5 4h14v12l-4 4H5zM15 20v-4h4M8 9h8M8 13h5",
  more: "M6 12h.01M12 12h.01M18 12h.01",
  chat: "M4 5h16v11H9l-5 4V5ZM8 9.5h8M8 12.5h5",
  at: "M16 12a4 4 0 1 0-1.2 2.8M16 8v5a2.5 2.5 0 0 0 5 0v-1a9 9 0 1 0-3.5 7.1",
  bellOff: "M6 16V11a6 6 0 0 1 9.5-4.9M18 11v5l2 2H8M10 21h4M3 3l18 18",
  paperclip: "M21 11.5l-8.5 8.5a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L10 17.9a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8",
  store: "M4 9l1.5-5h13L20 9M4 9h16M4 9a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0M5 11v9h14v-9M10 20v-5h4v5",
  tree: "M12 3v5M12 8H6v5M12 8h6v5M4 13h4v4H4zM16 13h4v4h-4zM10 3h4v5h-4z",
};

export type IconName = keyof typeof P;

interface Props {
  name: IconName | string;
  size?: number;
  className?: string;
  fill?: boolean;
  stroke?: number;
}

export function Icon({ name, size = 16, className, fill, stroke = 1.7 }: Props) {
  const d = P[name] ?? P.dot;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
