/** Custom illustrations. Navy, flag red, and gold — drawn for this app, not a stock set. */

function frame(body) {
  return `<svg viewBox="0 0 160 78" aria-hidden="true">${body}</svg>`;
}

const ARTS = {
  induction: frame(`
    <rect width="160" height="78" rx="16" fill="#0c2340"/>
    <path d="M28 58c6-16 16-22 28-22h8c12 0 22 6 28 22" fill="#16365c"/>
    <path d="M46 30c2-12 10-18 18-18s16 6 18 18c-6 2-12 3-18 3s-12-1-18-3z" fill="#e4c36a"/>
    <circle cx="64" cy="34" r="8" fill="#f0c7a8"/>
    <rect x="100" y="18" width="34" height="42" rx="4" fill="#f7f3ea"/>
    <path d="M108 28h18M108 36h18M108 44h12" stroke="#0c2340" stroke-width="2" stroke-linecap="round"/>
    <rect x="108" y="50" width="14" height="4" rx="2" fill="#c8102e"/>
  `),
  fault: frame(`
    <rect width="160" height="78" rx="16" fill="#0c2340"/>
    <path d="M34 58V36l28-18 28 18v22" fill="#16365c"/>
    <path d="M34 36l28-18 28 18" fill="none" stroke="#e4c36a" stroke-width="3"/>
    <rect x="54" y="40" width="16" height="18" rx="2" fill="#f7f3ea"/>
    <path d="M112 16l-8 18h10l-6 20 16-24h-10l6-14z" fill="#c8102e"/>
  `),
  eicr: frame(`
    <rect width="160" height="78" rx="16" fill="#0c2340"/>
    <rect x="36" y="16" width="88" height="48" rx="10" fill="#f7f3ea"/>
    <circle cx="68" cy="40" r="14" fill="#0c2340"/>
    <path d="M68 40l8-8" stroke="#e4c36a" stroke-width="2" stroke-linecap="round"/>
    <circle cx="68" cy="40" r="2" fill="#c8102e"/>
    <path d="M96 30h18M96 38h14M96 46h18" stroke="#0c2340" stroke-width="2" stroke-linecap="round"/>
    <circle cx="112" cy="52" r="6" fill="#c8102e"/>
    <path d="M109 52l2 2 4-4" fill="none" stroke="#f7f3ea" stroke-width="1.6" stroke-linecap="round"/>
  `),
  toolbox: frame(`
    <rect width="160" height="78" rx="16" fill="#0c2340"/>
    <circle cx="46" cy="32" r="7" fill="#f0c7a8"/>
    <circle cx="80" cy="28" r="8" fill="#f0c7a8"/>
    <circle cx="114" cy="32" r="7" fill="#f0c7a8"/>
    <path d="M34 34h24M68 30h24M102 34h24" stroke="#e4c36a" stroke-width="6" stroke-linecap="round"/>
    <path d="M30 56c4-10 10-14 16-14s12 4 16 14M64 56c4-12 10-16 16-16s12 4 16 16M98 56c4-10 10-14 16-14s12 4 16 14" fill="#c8102e"/>
  `),
  interview: frame(`
    <rect width="160" height="78" rx="16" fill="#0c2340"/>
    <rect x="58" y="40" width="44" height="6" rx="2" fill="#e4c36a"/>
    <path d="M36 58V40h16v18" fill="#16365c"/>
    <path d="M108 58V40h16v18" fill="#16365c"/>
    <circle cx="44" cy="30" r="7" fill="#f0c7a8"/>
    <circle cx="116" cy="30" r="7" fill="#f0c7a8"/>
    <path d="M34 34c8 4 12 4 20 0M106 34c8 4 12 4 20 0" stroke="#c8102e" stroke-width="3" stroke-linecap="round"/>
  `),
  supplier: frame(`
    <rect width="160" height="78" rx="16" fill="#0c2340"/>
    <rect x="28" y="18" width="22" height="40" rx="8" fill="#f7f3ea"/>
    <rect x="34" y="24" width="10" height="16" rx="2" fill="#0c2340"/>
    <circle cx="39" cy="50" r="2" fill="#c8102e"/>
    <path d="M62 28c16-10 28-10 44 0" fill="none" stroke="#e4c36a" stroke-width="3"/>
    <path d="M66 38c12-6 20-6 32 0" fill="none" stroke="#e4c36a" stroke-width="3"/>
    <circle cx="118" cy="48" r="16" fill="#16365c" stroke="#c8102e" stroke-width="3"/>
    <circle cx="118" cy="48" r="5" fill="#e4c36a"/>
  `),
  free: frame(`
    <rect width="160" height="78" rx="16" fill="#0c2340"/>
    <path d="M78 14l-8 22h14l-4 22 20-28H86l4-16z" fill="#e4c36a"/>
    <circle cx="40" cy="40" r="10" fill="#c8102e"/>
    <circle cx="124" cy="36" r="8" fill="#2bb7ef"/>
  `),
};

export function scenarioArt(id) {
  return ARTS[id] || ARTS.free;
}

export function welcomeArt() {
  return `<svg viewBox="0 0 200 120" aria-hidden="true">
    <rect width="200" height="120" rx="0" fill="#0c2340"/>
    <circle cx="100" cy="58" r="36" fill="#16365c"/>
    <path d="M78 58c4-16 14-24 22-24s18 8 22 24c-6 3-13 5-22 5s-16-2-22-5z" fill="#e4c36a"/>
    <circle cx="100" cy="60" r="10" fill="#f0c7a8"/>
    <path d="M86 86c4-10 10-14 14-14s10 4 14 14" fill="#c8102e"/>
    <path d="M148 28l-6 16h10l-3 16 14-20h-9l4-12z" fill="#f7f3ea"/>
  </svg>`;
}

export function scoreRing(score) {
  const value = Math.max(0, Math.min(100, Number(score) || 0));
  const radius = 26;
  const circ = 2 * Math.PI * radius;
  const dash = (value / 100) * circ;
  return `<svg viewBox="0 0 72 72" class="ring" aria-hidden="true">
    <circle cx="36" cy="36" r="${radius}" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="6"/>
    <circle cx="36" cy="36" r="${radius}" fill="none" stroke="#c8102e" stroke-width="6" stroke-linecap="round"
      stroke-dasharray="${dash} ${circ}" transform="rotate(-90 36 36)"/>
    <text x="36" y="40" text-anchor="middle" font-size="16" font-weight="700" fill="currentColor">${value}</text>
  </svg>`;
}
