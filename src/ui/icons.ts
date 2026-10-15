// Inline SVG icon set: 24x24, stroke currentColor, 2px, round caps.
const P: Record<string, string> = {
  road: '<path d="M8 3 5 21M16 3l3 18"/><path d="M12 5v2M12 11v2M12 17v2"/>',
  light: '<rect x="8" y="2" width="8" height="16" rx="3"/><circle cx="12" cy="6.5" r="1.3"/><circle cx="12" cy="13.5" r="1.3"/><path d="M12 18v4"/>',
  roundabout: '<circle cx="12" cy="12" r="4"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><path d="M15 8.5l1.5-.5-.5 1.5"/>',
  demolish: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/><path d="M10 11v6M14 11v6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13 7l4 4"/>',
  oneway: '<path d="M3 12h17"/><path d="M14 6l6 6-6 6"/>',
  flip: '<path d="M4 8h15l-4-4M20 16H5l4 4"/>',
  straight: '<path d="M4 20 20 4"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/>',
  curve: '<path d="M4 20C4 10 10 4 20 4"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/>',
  money: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/>',
  car: '<path d="M5 16V11l2-5h10l2 5v5z"/><path d="M5 11h14"/><circle cx="8" cy="18" r="1.5"/><circle cx="16" cy="18" r="1.5"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  fast: '<path d="M4 5v14l8-7zM12 5v14l8-7z"/>',
  faster: '<path d="M2 6v12l6-6zM9 6v12l6-6zM16 6v12l6-6z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><path d="M12 17.5v.01"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="M4 12.5 9.5 18 20 6"/>',
  warning: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.01"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.2 9.4l6.1-.8z"/>',
  smile: '<circle cx="12" cy="12" r="9.5"/><path d="M8 14.5a5 5 0 0 0 8 0M9 9.5v.01M15 9.5v.01"/>',
  neutral: '<circle cx="12" cy="12" r="9.5"/><path d="M8.5 15h7M9 9.5v.01M15 9.5v.01"/>',
  frown: '<circle cx="12" cy="12" r="9.5"/><path d="M8 16.5a5 5 0 0 1 8 0M9 9.5v.01M15 9.5v.01"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  place: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  interchange: '<path d="M12 2v20M2 12h20"/><path d="M12 7a5 5 0 1 0 5 5M12 17a5 5 0 1 0-5-5"/>',
  heat: '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-3 2-5 5-5 8a7 7 0 0 0 7 7z"/>',
  noise: '<path d="M4 9v6h4l5 4V5L8 9z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19.5 5.5a9 9 0 0 1 0 13"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-5 3 3 5-7"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  dice: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3M8 21v-7h8v7"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
};

export const ICONS: Record<string, string> = Object.fromEntries(
  Object.entries(P).map(([k, d]) => [k, `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`]),
);

export function icon(name: string, cls = ''): string {
  const svg = ICONS[name] ?? '';
  return `<span class="ico${cls ? ' ' + cls : ''}">${svg}</span>`;
}
