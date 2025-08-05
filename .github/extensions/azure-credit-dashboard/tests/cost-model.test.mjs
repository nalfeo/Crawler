import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateRoundedAmounts,
  buildCostBreakdown,
  modelNameFromProduct,
  roundCurrency,
  serviceNameFromUsage,
} from '../lib/cost-model.mjs';

const columns = [
  { name: 'PreTaxCost' },
  { name: 'UsageDate' },
  { name: 'ServiceName' },
  { name: 'Meter' },
  { name: 'Currency' },
];

test('rounds currency values to the nearest cent without magnitude drift', () => {
  assert.equal(roundCurrency(10.075), 10.08);
  assert.equal(roundCurrency(0.005), 0.01);
  assert.equal(roundCurrency(0.99), 0.99);
  assert.equal(roundCurrency(149.995), 150.0);
});

test('normalizes Azure OpenAI products to model families', () => {
  assert.equal(
    modelNameFromProduct('Azure OpenAI - gpt 4o 1120 cached Inp glbl Tokens - US West 3'),
    'GPT-4o 1120',
  );
  assert.equal(
    modelNameFromProduct('Azure OpenAI - gpt 4o 1120 Outp glbl Tokens - US West 3'),
    'GPT-4o 1120',
  );
});

test('classifies usage details into dashboard services', () => {
  assert.equal(
    serviceNameFromUsage({
      product: 'Azure OpenAI - gpt 4o 1120 Inp glbl Tokens - US West 3',
      consumedService: 'Microsoft.CognitiveServices',
    }),
    'Foundry Models',
  );
  assert.equal(
    serviceNameFromUsage({
      product: 'Rtn Preference: MGN - Standard Data Transfer Out',
      consumedService: 'Microsoft.Storage',
    }),
    'Bandwidth',
  );
  assert.equal(
    serviceNameFromUsage({
      product: 'Tiered Block Blob - Hot LRS - Data Stored',
      consumedService: 'Microsoft.Storage',
    }),
    'Storage',
  );
});

test('reconciles service, model, daily, and weekly totals to the cent', () => {
  const rows = [
    [
      0.105,
      '2026-07-12T00:00:00Z',
      'Foundry Models',
      'Azure OpenAI - gpt 4o 1120 Inp glbl Tokens - US West 3',
      'USD',
    ],
    [
      0.795215,
      '2026-07-13T00:00:00Z',
      'Foundry Models',
      'Azure OpenAI - gpt 4o 1120 Outp glbl Tokens - US West 3',
      'USD',
    ],
    [
      0.083229768,
      '2026-07-14T00:00:00Z',
      'Bandwidth',
      'Rtn Preference: MGN - Standard Data Transfer Out',
      'USD',
    ],
    [0.006, '2026-07-14T00:00:00Z', 'Storage', 'Tiered Block Blob - Hot LRS - Data Stored', 'USD'],
  ];

  const result = buildCostBreakdown(rows, columns, '2026-07-12');
  const foundry = result.services.find((service) => service.name === 'Foundry Models');
  const sum = (entries) => entries.reduce((total, entry) => total + entry.amount, 0);

  assert.equal(result.used, 0.99);
  assert.equal(sum(result.services), result.used);
  assert.equal(sum(result.daily), result.used);
  assert.equal(sum(result.weekly), result.used);
  assert.equal(sum(foundry.models), foundry.amount);
  assert.deepEqual(foundry.models, [{ name: 'GPT-4o 1120', amount: 0.9 }]);
});

test('allocates fractional cents without changing the requested total', () => {
  const result = allocateRoundedAmounts(
    [
      { name: 'a', amount: 0.004 },
      { name: 'b', amount: 0.004 },
      { name: 'c', amount: 0.004 },
    ],
    0.01,
  );
  assert.equal(
    result.reduce((total, entry) => total + entry.amount, 0),
    0.01,
  );
});
