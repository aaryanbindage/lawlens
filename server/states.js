// name, postal code, slug used by law.justia.com/codes/<slug>/ and law.cornell.edu/states/<slug>
const RAW = [
  ['Alabama', 'AL'], ['Alaska', 'AK'], ['Arizona', 'AZ'], ['Arkansas', 'AR'], ['California', 'CA'],
  ['Colorado', 'CO'], ['Connecticut', 'CT'], ['Delaware', 'DE'], ['District of Columbia', 'DC'],
  ['Florida', 'FL'], ['Georgia', 'GA'], ['Hawaii', 'HI'], ['Idaho', 'ID'], ['Illinois', 'IL'],
  ['Indiana', 'IN'], ['Iowa', 'IA'], ['Kansas', 'KS'], ['Kentucky', 'KY'], ['Louisiana', 'LA'],
  ['Maine', 'ME'], ['Maryland', 'MD'], ['Massachusetts', 'MA'], ['Michigan', 'MI'], ['Minnesota', 'MN'],
  ['Mississippi', 'MS'], ['Missouri', 'MO'], ['Montana', 'MT'], ['Nebraska', 'NE'], ['Nevada', 'NV'],
  ['New Hampshire', 'NH'], ['New Jersey', 'NJ'], ['New Mexico', 'NM'], ['New York', 'NY'],
  ['North Carolina', 'NC'], ['North Dakota', 'ND'], ['Ohio', 'OH'], ['Oklahoma', 'OK'], ['Oregon', 'OR'],
  ['Pennsylvania', 'PA'], ['Puerto Rico', 'PR'], ['Rhode Island', 'RI'], ['South Carolina', 'SC'],
  ['South Dakota', 'SD'], ['Tennessee', 'TN'], ['Texas', 'TX'], ['Utah', 'UT'], ['Vermont', 'VT'],
  ['Virginia', 'VA'], ['Washington', 'WA'], ['West Virginia', 'WV'], ['Wisconsin', 'WI'], ['Wyoming', 'WY'],
];

export const STATES = RAW.map(([name, code]) => ({
  name,
  code,
  slug: name.toLowerCase().replace(/ /g, '-'),
}));

export function findState(code) {
  if (!code) return null;
  const c = String(code).toUpperCase();
  return STATES.find((s) => s.code === c) || null;
}

// Links the user can open themselves when no in-app source covers state statutes.
export function officialLinks(state, q) {
  const query = encodeURIComponent(q);
  return [
    {
      title: `${state.name} statutes matching “${q}” (web search of the state code)`,
      url: `https://www.google.com/search?q=${encodeURIComponent(`${q} ${state.name} statute`)}+site%3Alaw.justia.com%2Fcodes%2F${state.slug}`,
      note: 'Opens a search restricted to the published state code.',
    },
    {
      title: `Browse the ${state.name} code`,
      url: `https://law.justia.com/codes/${state.slug}/`,
      note: 'Full table of contents of the state statutes.',
    },
    {
      title: `${state.name} law resources (Cornell LII)`,
      url: `https://www.law.cornell.edu/states/${state.slug}`,
      note: 'Links to the official legislature, code, regulations and courts.',
    },
    {
      title: `${state.name} legislation mentioning “${q}” (Open States)`,
      url: `https://openstates.org/search/?query=${query}&state=${state.code.toLowerCase()}`,
      note: 'Bills and enacted session laws.',
    },
  ];
}
