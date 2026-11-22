// Recognizes citation-style queries ("Cal. PEN § 1170(h)", "Penal Code 1170 subdivision (h)", "PC 187",
// "42 USC 1983", "41 CFR 102-34.305", "1170") and cross-references inside statute text.
import { citationPrefixes, findCitation } from './corpus.js';
import { findState } from './states.js';

// California code names and everyday abbreviations → the code used in its citations ("Cal. PEN § 1170").
const CA_CODES = {
  'business and professions': 'BPC', 'b and p': 'BPC', bp: 'BPC', civil: 'CIV', cc: 'CIV',
  'civil procedure': 'CCP', ccp: 'CCP', commercial: 'COM', corporations: 'CORP', corp: 'CORP',
  education: 'EDC', ed: 'EDC', elections: 'ELEC', elec: 'ELEC', evidence: 'EVID', evid: 'EVID',
  family: 'FAM', fam: 'FAM', financial: 'FIN', fin: 'FIN', 'fish and game': 'FGC', 'food and agricultural': 'FAC',
  government: 'GOV', gov: 'GOV', gc: 'GOV', 'harbors and navigation': 'HNC', 'health and safety': 'HSC', 'h and s': 'HSC', hs: 'HSC',
  insurance: 'INS', ins: 'INS', labor: 'LAB', lab: 'LAB', lc: 'LAB', 'military and veterans': 'MVC', penal: 'PEN', pc: 'PEN',
  probate: 'PROB', prob: 'PROB', 'public contract': 'PCC', 'public resources': 'PRC', 'public utilities': 'PUC',
  'revenue and taxation': 'RTC', 'r and t': 'RTC', 'streets and highways': 'SHC', 'unemployment insurance': 'UIC',
  vehicle: 'VEH', veh: 'VEH', vc: 'VEH', water: 'WAT', 'welfare and institutions': 'WIC', 'w and i': 'WIC', wic: 'WIC',
};

// The first word of the jurisdiction's citations when it is an abbreviation: "Cal." for "Cal. PEN § 1170".
function stateAbbr(juris) {
  const first = citationPrefixes(juris).find((p) => !/const/i.test(p))?.split(' ')[0];
  return first?.endsWith('.') ? first : null;
}

// "Cal. PEN § " → "pen", "Tex. Estates Code § " → "estates", "Code of Civil Procedure" → "civil procedure".
function codeKey(text, juris) {
  const stateName = findState(juris)?.name.toLowerCase();
  let k = String(text).trim();
  // Reporter-style state abbreviation ("Cal.", "Tex.") — but not a code abbreviation like "Transp.".
  const lead = /^([A-Z][a-z]{1,6}\.)\s+/.exec(k);
  if (lead && lead[1] === stateAbbr(juris)) k = k.slice(lead[0].length);
  k = k
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[§.,'’]/g, ' ')
    .replace(/\s+/g, ' ');
  if (stateName) k = k.replace(new RegExp(`^\\s*(${stateName}|calif)\\b`), '');
  k = ` ${k.trim()} `;
  for (const w of ['ann', 'annotated', 'stat', 'stats', 'code', 'section', 'sec', 'sect', 'of', 'the']) k = k.replaceAll(` ${w} `, ' ');
  return k.trim();
}

export function resolveCodePrefix(juris, codeText) {
  const key = codeKey(codeText, juris);
  if (!key) return null;
  const prefixes = citationPrefixes(juris);
  const abbr = juris === 'ca' ? CA_CODES[key] : null;
  const exact =
    prefixes.find((p) => codeKey(p, juris) === key) || (abbr && prefixes.find((p) => codeKey(p, juris) === abbr.toLowerCase()));
  if (exact) return exact;
  // Abbreviated names ("Fam." → Family Code, "Transp." → Transportation Code) when only one code fits.
  if (key.length < 3) return null;
  const words = key.split(' ');
  const fits = prefixes.filter((p) => {
    const pw = codeKey(p, juris).split(' ');
    return pw.length === words.length && pw.every((w, i) => w.startsWith(words[i]));
  });
  return fits.length === 1 ? fits[0] : null;
}

const SUB_RE = /,?\s*\b(?:subd(?:ivision)?|para(?:graph)?|subparagraph)\.?\s*\(?\s*([a-z0-9]+)\s*\)?\s*(?:of\s+)?/i;
const NUM_RE = /^(.*?)(?:§+|\bsec(?:tion)?\.?|\bs\.)?\s*(\d+(?:[.\-:]\d+)*[a-z]?)\s*((?:\(\s*[a-z0-9]+\s*\))*)\s*$/i;

/**
 * Returns null when `q` isn't a citation. Otherwise one of:
 *  { juris, citation, sub }   exact section
 *  { juris, num, sub }        bare section number — matches every code
 *  { cfr: { title, section } }
 */
export function parseCitation(q, stateCode) {
  const text = q.trim();
  let m;
  if ((m = /^(\d+)\s*u\.?\s*s\.?\s*c\.?\s*a?\.?\s*(?:§+|sec(?:tion)?\.?)?\s*(\d[\w.\-–]*?)\s*((?:\([a-z0-9]+\))*)\s*$/i.exec(text)))
    return { juris: 'federal', citation: `${m[1]} U.S.C. § ${m[2]}`, sub: firstParen(m[3]) };
  if ((m = /^(\d+)\s*c\.?\s*f\.?\s*r\.?\s*(?:§+|part|sec(?:tion)?\.?)?\s*(\d+[\w.\-]*)\s*$/i.exec(text)))
    return { cfr: { title: m[1], section: m[2] } };

  const juris = stateCode?.toLowerCase();
  if (!juris) return null;
  // Colorado: "C.R.S. 42-4-1301(1)(a)", "Colo. Rev. Stat. § 18-3-106", or just "42-4-1301".
  if (juris === 'co' && (m = /^(?:c\.?\s*r\.?\s*s\.?|colo(?:rado)?\.?\s*rev(?:ised)?\.?\s*stat(?:utes?)?\.?)?\s*§*\s*(\d+(?:\.\d+)?-\d+(?:\.\d+)?-\d+(?:\.\d+)?)\s*((?:\(\s*[a-z0-9]+\s*\))*)\s*$/i.exec(text)))
    return { juris, citation: `Colo. Rev. Stat. § ${m[1]}`, sub: firstParen(m[2]) };
  // Full citation exactly as published, e.g. "765 ILCS 710/1.2".
  if (/\d/.test(text) && findCitation(juris, text)) return { juris, citation: text, sub: null };

  let sub = null;
  let rest = text;
  const s = SUB_RE.exec(rest);
  if (s) {
    sub = s[1];
    rest = (rest.slice(0, s.index) + ' ' + rest.slice(s.index + s[0].length)).trim();
  }
  m = NUM_RE.exec(rest);
  if (!m) return null;
  const [, codeText, num, parens] = m;
  sub = sub || firstParen(parens);
  if (!codeKey(codeText, juris)) return { juris, num, sub };
  const prefix = resolveCodePrefix(juris, codeText);
  return prefix ? { juris, citation: prefix + num, sub } : null;
}

const firstParen = (s) => (/\(\s*([a-z0-9]+)\s*\)/i.exec(s || '') || [])[1] || null;

/**
 * Turns "subdivision (h) of Section 1170", "Section 1203.4 of the Penal Code" or "section 1983 of this title"
 * into links to the referenced section when it exists in the index. `html` must already be escaped.
 */
const REF_RE =
  /\b(?:(?:subdivision|paragraph|subparagraph)\s+\(([a-z0-9]+)\)(?:\s*\([a-z0-9]+\))*\s+of\s+)?[Ss]ections?\s+(\d+(?:[.\-]\d+)*[a-z]?)((?:\([a-z0-9]+\))*)(?:\s+of\s+(?:the\s+)?([A-Z][A-Za-z]*(?:\s+(?:and\s+|of\s+)?[A-Z][A-Za-z]*)*\s+Code))?/g;

export function linkifyReferences(html, section) {
  const own = section.citation.replace(/\s*\(\d{4}\)$/, '').replace(/[\w.\-:]+$/, '');
  return html.replace(REF_RE, (match, subA, num, parens, codeName, offset, whole) => {
    // Texas style: "Section 201.051, Family Code".
    const after = /^,\s+((?:[A-Z][A-Za-z]*\s+)+Code)\b/.exec(whole.slice(offset + match.length));
    const name = codeName || after?.[1];
    const prefix = name ? resolveCodePrefix(section.juris, name) : own;
    if (!prefix) return match;
    const target = findCitation(section.juris, prefix + num);
    if (!target || target.act_id === section.act_id) return match;
    const sub = subA || firstParen(parens);
    const href = `#/read?src=oul&id=${encodeURIComponent(target.act_id)}${sub ? `&sub=${encodeURIComponent(sub)}` : ''}`;
    return `<a class="xref" href="${href}" title="${target.citation}${sub ? ` (${sub})` : ''}">${match}</a>`;
  });
}
