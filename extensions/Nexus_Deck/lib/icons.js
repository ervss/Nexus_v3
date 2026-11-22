export const logo = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#1c231e"/><circle cx="16" cy="16" r="8.25" fill="none" stroke="#e6a23c" stroke-width="1.6"/><path d="M16 9.2 19.1 16 16 22.8 12.9 16Z" fill="#e6a23c"/></svg>`;

const paths = {
  refresh: `<path d="M19.5 6.5a7 7 0 1 0 1.6 6.8"/><path d="M16 3.5h4.2V8"/>`,
  settings: `<path d="M4 8h10"/><path d="M18 8h2"/><path d="M4 16h2"/><path d="M10 16h10"/><circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>`,
  play: `<path d="M8 5.5v13l11-6.5-11-6.5Z"/>`,
  close: `<path d="M6 6l12 12M18 6 6 18"/>`,
  film: `<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M8 5v14M16 5v14M3.5 9.5h17M3.5 14.5h17"/>`,
  check: `<path d="M4.5 12.5 9 17l10.5-11"/>`,
  alert: `<path d="M12 4.5 21 19H3L12 4.5Z"/><path d="M12 10v4"/><path d="M12 16.5h.01"/>`,
  link: `<path d="M10 13a4 4 0 0 1 0-6l1.5-1.5a4 4 0 0 1 6 5"/><path d="M14 11a4 4 0 0 1 0 6L12.5 18.5a4 4 0 0 1-6-5"/>`,
  trash: `<path d="M4.5 7h15"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/>`,
  retry: `<path d="M19 8a7 7 0 1 0 .5 6"/><path d="M15 4.5 19.5 8 15 11"/>`,
  tab: `<rect x="4" y="6" width="16" height="13" rx="2"/><path d="M4 10h16"/>`,
  page: `<rect x="6" y="3.5" width="12" height="17" rx="1.5"/><path d="M9 8h6M9 12h6M9 16h3"/>`,
  external: `<path d="M10 6H5.5v12.5H18V14"/><path d="M12 5.5h6.5V12"/><path d="M18.2 6.2 10.5 14"/>`,
  prev: `<path d="M15 6 8 12l7 6"/><path d="M8 6v12"/>`,
  next: `<path d="M9 6l7 6-7 6"/><path d="M16 6v12"/>`,
};

export function icon(name) {
  const body = paths[name] || "";
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}
