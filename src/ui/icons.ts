// Inline SVG icon set: 24x24, stroke currentColor, 2px, round caps.
const P: Record<string, string> = {
  road: '<path d="M8 3 5 21M16 3l3 18"/><path d="M12 5v2M12 11v2M12 17v2"/>',
  light: '<rect x="8" y="2" width="8" height="16" rx="3"/><circle cx="12" cy="6.5" r="1.3"/><circle cx="12" cy="13.5" r="1.3"/><path d="M12 18v4"/>',
  roundabout: '<circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><path d="M15 8.5l1.5-.5-.5 1.5"/>',
  demolish: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  oneway: '<path d="M3 12h17"/><path d="M14 6l6 6-6 6"/>',
  flip: '<path d="M4 8h15l-4-4M20 16H5l4 4"/>',
  asphalt: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 6v3M12 15v3"/>',
  bridge: '<path d="M2 9h20M4 9v10M20 9v10"/><path d="M4 18c3-6 13-6 16 0"/><path d="M2 21h20" stroke-dasharray="2 3"/>',
  tunnel: '<path d="M2 20 9 6l3 4 3-5 7 15z"/><path d="M9 20v-3a3 3 0 0 1 6 0v3"/>',
  car: '<path d="M5 16V11l2-5h10l2 5v5z"/><path d="M5 11h14"/><circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  fast: '<path d="M4 5v14l8-7zM12 5v14l8-7z"/>',
  faster: '<path d="M2 6v12l6-6zM9 6v12l6-6zM16 6v12l6-6z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><path d="M12 17.5v.01"/>',
  week: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  gift: '<rect x="3" y="8" width="18" height="5" rx="1"/><path d="M5 13v8h14v-8M12 8v13"/><path d="M12 8C10 3 6 4 7.5 7 8.3 8 12 8 12 8zM12 8c2-5 6-4 4.5-1-.8 1-4.5 1-4.5 1z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M4 12.5 9.5 18 20 6"/>',
  warning: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/>',
};

export const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(P).map(([k, d]) => [k, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`]),
);

export function icon(name: string, cls = ''): string {
  const svg = ICONS[name] ?? '';
  return `<span class="ico${cls ? ' ' + cls : ''}">${svg}</span>`;
}
