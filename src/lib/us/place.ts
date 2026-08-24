/* ===========================================================================
   place.ts — turn coordinates into somewhere a person recognises.
   ===========================================================================

   ---------------------------------------------------------------------------
   ONCE PER PHOTOGRAPH, NEVER ONCE PER RENDER

   This is the whole reason the resolved string is STORED rather than computed. A
   lookup on render would send her location to a third party every time either of
   them opened the page — dozens of disclosures a week for a label that cannot
   change once the photograph exists. At upload time it is one disclosure per
   photograph, which is the floor for any address lookup at all.

   That cost is real and worth naming: OpenStreetMap's Nominatim receives the
   coordinates. It is the tradeoff for a readable label, it was made deliberately,
   and there is no version of this feature without it.

   Nominatim rather than Google or Mapbox: no API key, no account, no billing
   relationship, and nothing to rotate. Its usage policy asks for an identifying
   User-Agent and at most one request a second. Two photographs a day sits so far
   inside that it is not worth engineering around.

   ---------------------------------------------------------------------------
   IT PREFERS A LANDMARK AND REFUSES TO NAME A BUSINESS

   At building precision her first photograph resolved to "Grande Pharmacie
   Daumesnil, 6, Place Félix Éboué". She was not at a pharmacy; that is simply what
   occupies the building at those coordinates. Naming it would be both more
   invasive than anyone wanted and usually wrong in spirit — the label is meant to
   say "here is where this was", not "here is the nearest till".

   So the preference order is:

     1. A REAL LANDMARK — a park, monument, museum, square, station. Something a
        person would say out loud. "Tour Eiffel, Paris 7e".
     2. THE STREET plus the district. "Place Félix Éboué, Paris 12e".
     3. THE DISTRICT alone. "Paris 12e", or "Annecy" when she travels.
     4. Null, and the caller falls back to showing the raw coordinates — so the pin
        never silently disappears and the promise that location is visible holds
        even when this fails.

   `amenity`, `shop`, `office` and `building` are deliberately NOT landmark sources.
   That is the class the pharmacy came from.

   ---------------------------------------------------------------------------
   IT CANNOT COST HER THE PHOTOGRAPH

   Total, like readCoords: every failure returns null. The caller runs this AFTER
   the frame is already saved, so a slow or dead geocoder delays a label rather than
   risking bytes. The timeout is short for the same reason — a label is not worth
   holding a request open for.
   =========================================================================== */

import type { Coords } from './exif';
import { timer, trace } from './trace';

/**
 * Short, because this is decoration on a photograph and not a postal address.
 *
 * A dead or slow Nominatim must not become a slow upload response. Two and a half
 * seconds is generous against its usual few hundred milliseconds, and the cost of
 * losing the race is a pin that shows numbers instead of a name.
 */
const TIMEOUT_MS = 2500;

/** Longer than this wraps to three lines under a photograph on a phone. */
const MAX_LEN = 64;

/**
 * Identifying, as Nominatim's usage policy requires.
 *
 * A generic or absent User-Agent is the documented way to get blocked, and being
 * blocked here would be silent — the label would simply stop appearing.
 */
const UA = 'us-private-wing/1.0 (personal two-person site; https://samueldwoo.com)';

/**
 * Nominatim CATEGORIES whose matched feature is worth naming out loud.
 *
 * THIS IS READ FROM THE TOP LEVEL OF THE RESPONSE, not from `address`, and getting
 * that wrong is what the first attempt did — it looked for `tourism` inside the
 * address hierarchy, which never contains it, so the Eiffel Tower resolved to
 * "Avenue Gustave Eiffel" and every landmark fell through to its nearest street.
 *
 * `amenity`, `shop`, `office` and `building` are absent on purpose. That is the
 * class the pharmacy came from, and the reason this allowlist exists at all: at the
 * zoom needed to match Tour Eiffel, her apartment matches a chemist.
 */
const LANDMARK_CATEGORIES = new Set([
  'tourism',
  'historic',
  'leisure',
  'natural',
  'water',
  'waterway',
  'bridge',
  'railway',
  'aeroway',
  'place',
  'boundary',
]);

/** The district, coarsest useful unit, tried in descending specificity. */
const DISTRICT_KEYS = [
  'suburb',
  'city_district',
  'borough',
  'town',
  'village',
  'municipality',
  'city',
  'county',
] as const;

/**
 * "Paris 12e Arrondissement" is how the data spells it and not how a person does.
 *
 * Only the arrondissement form is rewritten. A general attempt to prettify place
 * names would eventually mangle a real one, and being slightly verbose about
 * somewhere in the Alps is better than renaming it.
 */
function tidyDistrict(s: string): string {
  const m = /^Paris\s+(\d{1,2})e\s+Arrondissement$/i.exec(s.trim());
  return m ? `Paris ${m[1]}e` : s.trim();
}

function clean(s: unknown): string {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

/** Assemble the label from the matched feature plus the address hierarchy. */
function labelFrom(
  addr: Record<string, unknown>,
  name: string,
  category: string,
): string | null {
  const district = (() => {
    for (const k of DISTRICT_KEYS) {
      const v = clean(addr[k]);
      if (v) return tidyDistrict(v);
    }
    return '';
  })();

  /* A LANDMARK. `name` is Nominatim's display name for the feature it actually
     matched, and it is trusted ONLY when that feature's category is one a person
     would name. Same field, entirely different meaning depending on the category —
     "Tour Eiffel" and "Grande Pharmacie Daumesnil" both arrive here. */
  if (name && LANDMARK_CATEGORIES.has(category)) {
    const label = district && district !== name ? `${name}, ${district}` : name;
    return label.slice(0, MAX_LEN);
  }

  /* THE STREET, with no house number. The number is doorstep precision for no
     readability gain — "Place Félix Éboué" is recognisable, "6 Place Félix Éboué"
     is an address. */
  const road = clean(addr.road) || clean(addr.pedestrian) || clean(addr.footway);
  if (road) {
    const label = district && district !== road ? `${road}, ${district}` : road;
    return label.slice(0, MAX_LEN);
  }

  if (district) return district.slice(0, MAX_LEN);

  // Somewhere with no street and no district — open water, or a field.
  const country = clean(addr.country);
  return country ? country.slice(0, MAX_LEN) : (name ? name.slice(0, MAX_LEN) : null);
}

/**
 * Where these coordinates are, as a short human label, or null.
 *
 * Null is an ordinary answer: no network, a rate limit, a spot with nothing named
 * near it. The caller shows the coordinates instead.
 */
export async function lookupPlace(
  coords: Coords,
  timeoutMs: number = TIMEOUT_MS,
): Promise<string | null> {
  const url =
    'https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1' +
    /* ZOOM 18, deliberately the building/feature level — the same precision that
       returned the pharmacy. That is fine, and is the point: at 18 a real landmark
       matches AS a landmark ("Tour Eiffel", category `tourism`) while her apartment
       matches as `amenity` and is refused by the allowlist, falling through to the
       street. At 17 everything matched its nearest road and no landmark was ever
       reachable. Precision is filtered by category, not by asking for less of it. */
    `&zoom=18&lat=${encodeURIComponent(String(coords.lat))}&lon=${encodeURIComponent(String(coords.lon))}`;

  const t = timer();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(200, timeoutMs)),
    });
    if (!res.ok) {
      /* THE ONE FAILURE THIS FILE ALREADY PREDICTED, AND IT WAS THE ONE WITH NO LINE.
         The header says a generic User-Agent is the documented way to get blocked and
         that being blocked "would be silent — the label would simply stop appearing".
         It was: this exit returned null without logging, so a 403 or a 429 from
         Nominatim was indistinguishable from a photograph taken somewhere with nothing
         named nearby. `status` is the whole difference between "we are banned", "slow
         down" and "there is genuinely nothing there". */
      trace('place.lookup', { hit: false, status: res.status, ms: t.total() });
      return null;
    }

    const body = (await res.json()) as {
      address?: Record<string, unknown>;
      name?: unknown;
      category?: unknown;
    };
    const addr = body && typeof body.address === 'object' && body.address ? body.address : null;
    if (!addr) {
      /* A 200 with no address hierarchy: open water, or the middle of a field. An
         ordinary answer rather than a fault, but it was also unlogged, and "Nominatim
         answered and had nothing" needs to be tellable from "Nominatim never answered"
         — otherwise the only evidence is an absent line, which is also what a code path
         that never ran looks like. */
      trace('place.lookup', { hit: false, reason: 'no-address', ms: t.total() });
      return null;
    }

    const label = labelFrom(addr, clean(body.name), clean(body.category));
    const out = label && label.length > 1 ? label : null;
    /* `hit` and the LENGTH of the label, never the label — a place name has spaces
       and would be refused anyway, but saying so here makes the intent explicit. */
    trace('place.lookup', { hit: out !== null, chars: out ? out.length : 0, ms: t.total() });
    return out;
  } catch {
    /* Offline, timed out, rate limited, or not JSON. All the same answer: the pin
       shows numbers this time — and the line says how long it waited before giving
       up, which is what distinguishes "Nominatim is down" from "our deadline is too
       tight". */
    trace('place.lookup', { hit: false, failed: true, ms: t.total() });
    return null;
  }
}
