import type { CityRequest } from '../interaction/schema.js';

export type FixtureEmphasis = 'food' | 'culture' | 'travel-value';

type FixtureOption = {
  rationale: string;
  dinner: { place: string; detail: string; minorUnits: number };
  activity: { place: string; detail: string; minorUnits: number };
  routeDetail: string;
};

/** These are fictional concepts and authored cost examples, not venue, event, price, or route observations. */
const CITY_OPTIONS: Record<CityRequest['input']['city'], Record<FixtureEmphasis, FixtureOption>> = {
  Chicago: {
    food: {
      rationale: 'Spend more of the example budget on a fictional two-course dinner, then keep the activity informal.',
      dinner: {
        place: 'Chicago Fixture Kitchen',
        detail: 'Fictional shared-table tasting: compare a vegetable-forward starter and a main course against the dietary preferences before choosing.',
        minorUnits: 4700,
      },
      activity: {
        place: 'Chicago Fixture Hall',
        detail: 'Fictional small-room music-listening session with a flexible arrival window; no performance or seat inventory is implied.',
        minorUnits: 1200,
      },
      routeDetail: 'Use a conceptual Chicago grid-block connection after dinner, with a buffer for the activity; no street or duration is verified.',
    },
    culture: {
      rationale: 'Keep dinner simple so more of the example budget and evening attention can go to a fictional exhibition.',
      dinner: {
        place: 'Chicago Fixture Counter',
        detail: 'Fictional quick counter meal with a soup-and-sandwich choice, leaving the longer part of the window for the activity.',
        minorUnits: 2400,
      },
      activity: {
        place: 'Chicago Fixture Gallery',
        detail: 'Fictional curated exhibit visit with a discussion prompt; no real exhibition, opening hours, or ticket is asserted.',
        minorUnits: 3300,
      },
      routeDetail: 'Treat the Chicago grid-themed transfer as a pre-exhibit leg and allow time to settle in; no street or duration is verified.',
    },
    'travel-value': {
      rationale: 'Use an inexpensive fictional meal and a self-guided activity so the example leaves more budget unallocated.',
      dinner: {
        place: 'Chicago Fixture Market Counter',
        detail: 'Fictional fixed-price bowl-and-drink combination chosen for a shorter meal and lower example dinner allocation.',
        minorUnits: 2100,
      },
      activity: {
        place: 'Chicago Fixture Civic Walk',
        detail: 'Fictional self-guided architecture sketch exercise with no ticket or scheduled event in the example budget.',
        minorUnits: 0,
      },
      routeDetail: 'Plan a single Chicago grid-themed link that avoids an optional paid transfer where the requested mode permits; no street or duration is verified.',
    },
  },
  Boston: {
    food: {
      rationale: 'Give a fictional small-plates dinner the largest example allocation, then use a low-commitment activity.',
      dinner: {
        place: 'Boston Fixture Supper Room',
        detail: 'Fictional small-plates sequence with a shared starter and separate mains to compare preferences before settling on dinner.',
        minorUnits: 4900,
      },
      activity: {
        place: 'Boston Fixture Listening Room',
        detail: 'Fictional spoken-story listening session with flexible arrival; no real host, event, or ticket inventory is implied.',
        minorUnits: 1200,
      },
      routeDetail: 'Use a conceptual Boston winding-street connection after dinner, leaving a flexible arrival buffer; no street or duration is verified.',
    },
    culture: {
      rationale: 'Choose a short fictional supper and reserve more of the example budget for a fictional performance workshop.',
      dinner: {
        place: 'Boston Fixture Cafe',
        detail: 'Fictional soup-and-salad supper designed as a shorter stop before the longer activity portion of the evening.',
        minorUnits: 2500,
      },
      activity: {
        place: 'Boston Fixture Stage Studio',
        detail: 'Fictional participatory theater workshop; no real production, workshop seat, or performance time is asserted.',
        minorUnits: 3000,
      },
      routeDetail: 'Treat the Boston winding-street transfer as a pre-workshop leg with a settling-in buffer; no street or duration is verified.',
    },
    'travel-value': {
      rationale: 'Pair a lower-cost fictional dinner with a self-guided activity and avoid an optional paid transfer.',
      dinner: {
        place: 'Boston Fixture Lunchroom',
        detail: 'Fictional set-menu supper with a simple entree and drink, using a smaller example dinner allocation.',
        minorUnits: 2200,
      },
      activity: {
        place: 'Boston Fixture Story Walk',
        detail: 'Fictional self-guided neighborhood storytelling prompt with no ticket or scheduled event in the example budget.',
        minorUnits: 0,
      },
      routeDetail: 'Plan one Boston winding-street link without an optional paid transfer where the requested mode permits; no street or duration is verified.',
    },
  },
};

function routeMode(request: CityRequest, emphasis: FixtureEmphasis): CityRequest['input']['transport'][number] {
  if (emphasis === 'culture' && request.input.transport.includes('public-transit')) return 'public-transit';
  if (emphasis === 'travel-value') {
    // Equal authored costs retain the caller's allowed-mode order.
    return request.input.transport.reduce((cheapest, mode) =>
      exampleTransportCost(mode) < exampleTransportCost(cheapest) ? mode : cheapest);
  }
  return request.input.transport[0]!;
}

function exampleTransportCost(mode: CityRequest['input']['transport'][number]): number {
  return { walk: 0, 'public-transit': 500, bicycle: 0, car: 1000, taxi: 1800 }[mode];
}

/** One reusable authored-fixture generator. It makes no live availability, price, or travel-time claim. */
export function syntheticEveningPlan(request: CityRequest, emphasis: FixtureEmphasis = 'food'): Uint8Array {
  const city = request.input.city;
  const option = CITY_OPTIONS[city][emphasis];
  const mode = routeMode(request, emphasis);
  const allocations = {
    dinner: option.dinner.minorUnits,
    activity: option.activity.minorUnits,
    transport: exampleTransportCost(mode),
  };
  const estimatedTotalMinorUnits = allocations.dinner + allocations.activity + allocations.transport;
  const unmetConstraints = [
    'No live opening hours, event inventory, booking availability, or travel time was checked.',
    'Authored fixture prices are not verified quotes; actual costs, preference fit, and accessibility remain unverified.',
    'The fictional locations and conceptual route were not checked against the requested time window.',
  ];
  if (BigInt(estimatedTotalMinorUnits) > BigInt(request.input.budget.minorUnits)) {
    unmetConstraints.push('The authored example estimate exceeds the requested budget; no live-priced substitute was found.');
  }
  const answer = {
    version: '0.1',
    kind: 'synthetic-evening-plan',
    city,
    emphasis,
    area: request.input.area,
    requestedWindow: request.input.timeWindow,
    liveDataChecked: false,
    rationale: option.rationale,
    schedule: [
      {
        order: 1, role: 'dinner', label: 'Dinner option', place: option.dinner.place,
        detail: option.dinner.detail,
        transportToNext: { mode, estimate: 'not-live-checked' },
      },
      {
        order: 2, role: 'activity', label: 'Evening activity option', place: option.activity.place,
        detail: option.activity.detail,
      },
    ],
    route: {
      from: option.dinner.place, to: option.activity.place, mode,
      detail: option.routeDetail, estimate: 'not-live-checked',
    },
    budget: {
      currency: 'USD', requestedMinorUnits: request.input.budget.minorUnits,
      estimateOnly: true, allocations, estimatedTotalMinorUnits,
    },
    sources: [
      { label: `${city} authored fictional dinner and activity concepts (${emphasis})`,
        kind: 'authored-fixture', live: false, supports: ['dinner', 'activity'] },
      { label: `${city} authored conceptual route notes`,
        kind: 'authored-fixture', live: false, supports: ['route'] },
      { label: `${city} authored example cost allocations`,
        kind: 'authored-fixture', live: false, supports: ['budget'] },
    ],
    retrievalAsOf: 'fixture-2026-09-24',
    unmetConstraints,
  };
  return new TextEncoder().encode(JSON.stringify(answer));
}
