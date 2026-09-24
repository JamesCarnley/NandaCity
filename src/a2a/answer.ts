import type { CityRequest } from '../interaction/schema.js';

/** Authored fixture data only: it intentionally makes no live availability or travel-time claim. */
export function syntheticEveningPlan(request: CityRequest): Uint8Array {
  const placePrefix = request.input.city === 'Chicago' ? 'Chicago' : 'Boston';
  const answer = {
    version: '0.1',
    kind: 'synthetic-evening-plan',
    city: request.input.city,
    area: request.input.area,
    requestedWindow: request.input.timeWindow,
    liveDataChecked: false,
    schedule: [
      {
        order: 1,
        label: 'Dinner option',
        place: `${placePrefix} Fixture Kitchen`,
        transportToNext: { mode: request.input.transport[0], estimate: 'not-live-checked' },
      },
      {
        order: 2,
        label: 'Evening activity option',
        place: `${placePrefix} Fixture Hall`,
      },
    ],
    sources: [{ label: 'Nanda City authored synthetic fixture', live: false }],
    retrievalAsOf: 'fixture-2026-09-24',
    unmetConstraints: [
      'No live opening hours, event inventory, booking availability, or travel time was checked.',
    ],
  };
  return new TextEncoder().encode(JSON.stringify(answer));
}
