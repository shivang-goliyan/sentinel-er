// WUST campus: 2900 Eisenhower Ave, Alexandria, VA 22314 (address from wust.edu), geocoded with the
// US Census geocoder on 16 Sept 2026 → 38.802553, -77.082237.
export const WUST = { lat: 38.802553, lon: -77.082237 }

// The drill epicentre is our choice, not a real fault: about 3 km west-south-west of WUST, near
// Cameron Run. Magnitude and depth are the scenario in CLAUDE.md (M6.4, shallow crustal).
export const DEFAULT_DRILL = {
  lat: 38.7925,
  lon: -77.115,
  mag: 6.4,
  depth_km: 8,
  title: 'DRILL · M6.4 near Alexandria, Virginia',
  tz: 'America/New_York',
}
