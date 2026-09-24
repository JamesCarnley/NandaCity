import assert from 'node:assert/strict';
import test from 'node:test';

import { syntheticEveningPlan } from '../../src/a2a/answer.js';
import { requestSchema, type CityRequest } from '../../src/interaction/schema.js';
import { makeInteractionFixture } from '../interaction/fixtures.js';

type Emphasis = 'food' | 'culture' | 'travel-value';
type FixturePlan = {
  kind: string;
  city: string;
  emphasis: Emphasis;
  area: string;
  requestedWindow: CityRequest['input']['timeWindow'];
  liveDataChecked: boolean;
  rationale: string;
  schedule: Array<{ order: number; role: string; label: string; place: string; detail: string }>;
  route: { from: string; to: string; mode: string; detail: string; estimate: string };
  budget: { currency: string; requestedMinorUnits: string; estimateOnly: boolean;
    allocations: { dinner: number; activity: number; transport: number }; estimatedTotalMinorUnits: number };
  sources: Array<{ label: string; kind: string; live: boolean; supports: string[] }>;
  unmetConstraints: string[];
};

function requestFor(city: 'Chicago' | 'Boston'): CityRequest {
  const request = structuredClone(makeInteractionFixture().request);
  if (city === 'Boston') {
    request.input.city = 'Boston';
    request.input.area = 'Back Bay';
    request.input.timeWindow = {
      start: '2026-10-02T18:00:00-04:00',
      end: '2026-10-02T22:00:00-04:00',
      timeZone: 'America/New_York',
    };
  }
  return requestSchema.parse(request);
}

function planFor(city: 'Chicago' | 'Boston', emphasis: Emphasis): FixturePlan {
  return JSON.parse(new TextDecoder().decode(syntheticEveningPlan(requestFor(city), emphasis))) as FixturePlan;
}

test('default synthetic answer remains a Chicago fixture with the established dinner and activity places', () => {
  const plan = JSON.parse(new TextDecoder().decode(syntheticEveningPlan(requestFor('Chicago')))) as FixturePlan;
  assert.equal(plan.kind, 'synthetic-evening-plan');
  assert.equal(plan.city, 'Chicago');
  assert.equal(plan.liveDataChecked, false);
  assert.deepEqual(plan.schedule.map((stop) => stop.place),
    ['Chicago Fixture Kitchen', 'Chicago Fixture Hall']);
});

test('all six city and emphasis combinations return complete, source-labeled non-live plans', () => {
  for (const city of ['Chicago', 'Boston'] as const) {
    for (const emphasis of ['food', 'culture', 'travel-value'] as const) {
      const request = requestFor(city);
      const plan = planFor(city, emphasis);
      assert.equal(plan.city, city);
      assert.equal(plan.emphasis, emphasis);
      assert.equal(plan.area, request.input.area);
      assert.deepEqual(plan.requestedWindow, request.input.timeWindow);
      assert.equal(plan.liveDataChecked, false);
      assert.ok(plan.rationale.length > 20);
      assert.deepEqual(plan.schedule.map((stop) => stop.role), ['dinner', 'activity']);
      assert.deepEqual(plan.schedule.map((stop) => stop.order), [1, 2]);
      for (const stop of plan.schedule) {
        assert.ok(stop.place.includes(city));
        assert.ok(stop.detail.length > 20);
      }
      assert.equal(plan.route.from, plan.schedule[0]?.place);
      assert.equal(plan.route.to, plan.schedule[1]?.place);
      assert.ok(request.input.transport.includes(plan.route.mode as CityRequest['input']['transport'][number]));
      assert.ok(plan.route.detail.length > 20);
      assert.match(plan.route.estimate, /not-live-checked/);
      assert.equal(plan.budget.currency, 'USD');
      assert.equal(plan.budget.requestedMinorUnits, request.input.budget.minorUnits);
      assert.equal(plan.budget.estimateOnly, true);
      assert.equal(plan.budget.estimatedTotalMinorUnits,
        Object.values(plan.budget.allocations).reduce((sum, value) => sum + value, 0));
      assert.ok(Object.values(plan.budget.allocations).every((value) => value >= 0));
      assert.ok(plan.sources.length >= 3);
      assert.ok(plan.sources.every((source) => source.kind === 'authored-fixture' && source.live === false &&
        source.label.includes(city) && source.supports.length > 0));
      assert.deepEqual(new Set(plan.sources.flatMap((source) => source.supports)),
        new Set(['dinner', 'activity', 'route', 'budget']));
      assert.ok(plan.unmetConstraints.some((constraint) => /opening hours|event inventory/i.test(constraint)));
      assert.ok(plan.unmetConstraints.some((constraint) => /not.*(booking|travel time|price)|unverified/i.test(constraint)));
      for (const key of ['rank', 'score', 'winner', 'qualityRanking']) {
        assert.equal(key in plan, false, `${city}/${emphasis} must not rank operators`);
      }
    }
  }
});

test('emphases make different dinner, activity, route, and budget choices within each city', () => {
  for (const city of ['Chicago', 'Boston'] as const) {
    const plans = (['food', 'culture', 'travel-value'] as const).map((emphasis) => planFor(city, emphasis));
    for (const select of [
      (plan: FixturePlan) => plan.schedule[0]?.detail,
      (plan: FixturePlan) => plan.schedule[1]?.detail,
      (plan: FixturePlan) => plan.route.detail,
      (plan: FixturePlan) => JSON.stringify(plan.budget.allocations),
      (plan: FixturePlan) => plan.rationale,
    ]) {
      assert.equal(new Set(plans.map(select)).size, 3, `${city} choices must differ beyond labels`);
    }
  }
});

test('city packs do not leak the other city into places, route, or source labels', () => {
  for (const emphasis of ['food', 'culture', 'travel-value'] as const) {
    const chicago = planFor('Chicago', emphasis);
    const boston = planFor('Boston', emphasis);
    assert.notDeepEqual(chicago.schedule, boston.schedule);
    assert.notDeepEqual(chicago.route.detail, boston.route.detail);
    for (const [plan, otherCity] of [[chicago, 'Boston'], [boston, 'Chicago']] as const) {
      const citySpecific = JSON.stringify({ schedule: plan.schedule, route: plan.route, sources: plan.sources });
      assert.ok(!citySpecific.includes(otherCity));
    }
  }
});

test('travel-value chooses the cheapest permitted non-walk mode and discloses an over-budget example', () => {
  for (const [city, expectedTotal] of [['Chicago', 2600], ['Boston', 2700]] as const) {
    const request = requestFor(city);
    request.input.transport = ['taxi', 'public-transit'];
    request.input.budget.minorUnits = '2500';
    const plan = JSON.parse(new TextDecoder().decode(
      syntheticEveningPlan(requestSchema.parse(request), 'travel-value'))) as FixturePlan;
    assert.equal(plan.route.mode, 'public-transit');
    assert.equal(plan.budget.allocations.transport, 500);
    assert.equal(plan.budget.estimatedTotalMinorUnits, expectedTotal);
    assert.ok(plan.unmetConstraints.some((constraint) => /exceeds the requested budget/.test(constraint)));
    assert.ok(plan.unmetConstraints.some((constraint) => /time window/.test(constraint)));
    assert.ok(plan.schedule.every((stop) => !('start' in stop) && !('end' in stop)));
  }
});

test('travel-value breaks equal authored transport costs by request order', () => {
  const request = requestFor('Chicago');
  request.input.transport = ['bicycle', 'walk'];
  const plan = JSON.parse(new TextDecoder().decode(
    syntheticEveningPlan(requestSchema.parse(request), 'travel-value'))) as FixturePlan;
  assert.equal(plan.route.mode, 'bicycle');
  assert.equal(plan.budget.allocations.transport, 0);
});
