export type ViolenceClass = "violent" | "nonviolent";

// Curated list of NYPD complaint offense descriptors considered violent.
// Sources: NYC Open Data (NYPD Complaint Data Historic) common values and FBI UCR violent crime definitions,
// plus practical additions for NYC dataset terminology.
const VIOLENT_OFNS_EXACT: string[] = [
  "MURDER & NON-NEGL. MANSLAUGHTER",
  "RAPE",
  "ROBBERY",
  "FELONY ASSAULT",
  "ASSAULT 3 & RELATED OFFENSES",
  "KIDNAPPING & RELATED OFFENSES",
  "SEX CRIMES",
  // The tiles code synthesizes this label for shootings; included here for consistency
  "SHOOTING INCIDENT",
];

// Broader keyword patterns to catch violent categories that may not be enumerated above.
const VIOLENT_KEYWORDS: string[] = [
  "MURDER",
  "MANSLAUGHTER",
  "HOMICIDE",
  "RAPE",
  "SEX",
  "ROBBERY",
  "ASSAULT",
  "KIDNAPPING",
  "SHOOT",
];

export function isViolentOfnsDesc(ofnsDesc: string | null | undefined): boolean {
  if (!ofnsDesc) return false;
  const v = ofnsDesc.toUpperCase();
  if (VIOLENT_OFNS_EXACT.includes(v)) return true;
  return VIOLENT_KEYWORDS.some((kw) => v.includes(kw));
}

export function violentOfnsList(): string[] {
  // Keep unique and uppercase
  return Array.from(new Set(VIOLENT_OFNS_EXACT.map((s) => s.toUpperCase())));
}

// Build a SoQL expression that matches violent offenses by descriptor using exact matches
// plus broader keyword LIKE patterns. Column should be an offense descriptor column.
export function buildViolentSoqlCondition(column: string = "ofns_desc"): string {
  const colUpper = `upper(${column})`;
  const exacts = violentOfnsList()
    .map((v) => v.replace(/'/g, "''"))
    .map((v) => `${colUpper} = '${v}'`);
  const likes = VIOLENT_KEYWORDS
    .map((kw) => kw.toUpperCase().replace(/'/g, "''"))
    .map((kw) => `${colUpper} like '%${kw}%'`);
  const parts = [...exacts, ...likes];
  return parts.length ? `(${parts.join(" OR ")})` : "(1 = 0)";
}

export function parseViolenceParam(vclassParam?: string): Set<ViolenceClass> {
  const set = new Set<ViolenceClass>();
  if (!vclassParam) {
    set.add("violent");
    set.add("nonviolent");
    return set;
  }
  for (const token of vclassParam.split(",")) {
    const t = token.trim().toLowerCase();
    if (t === "violent" || t === "nonviolent") set.add(t);
  }
  if (set.size === 0) {
    set.add("violent");
    set.add("nonviolent");
  }
  return set;
}


