export function roundCurrency(value) {
  return Number(`${Math.round(`${value}e2`)}e-2`);
}

export function allocateRoundedAmounts(entries, total) {
  const targetCents = Math.round(total * 100);
  const allocated = entries.map((entry) => {
    const exactCents = entry.amount * 100;
    const cents = Math.floor(exactCents);
    return { ...entry, cents, remainder: exactCents - cents };
  });
  let centsLeft = targetCents - allocated.reduce((sum, entry) => sum + entry.cents, 0);
  allocated.sort((a, b) => b.remainder - a.remainder || b.amount - a.amount);
  for (let index = 0; index < allocated.length && centsLeft > 0; index += 1) {
    allocated[index].cents += 1;
    centsLeft -= 1;
  }
  return allocated
    .map(({ cents, remainder: _remainder, ...entry }) => ({
      ...entry,
      amount: cents / 100,
    }))
    .sort((a, b) => b.amount - a.amount);
}

export function parseUsageDate(value) {
  const text = String(value);
  if (text.includes('-')) {
    return text.slice(0, 10);
  }
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function modelNameFromProduct(product) {
  const productName = String(product || 'Other model');
  const match = productName.match(
    /^(?:Azure OpenAI - )?(.+?) (?:cached )?(?:Inp|Outp) glbl Tokens(?: - .*)?$/i,
  );
  if (!match) {
    return productName;
  }
  return match[1].replace(/^gpt\s+/i, 'GPT-');
}

export function serviceNameFromUsage(properties) {
  const product = String(properties.product || '');
  if (/^Azure OpenAI\b/i.test(product)) {
    return 'Foundry Models';
  }
  if (/bandwidth|data transfer|rtn preference/i.test(product)) {
    return 'Bandwidth';
  }
  if (properties.consumedService === 'Microsoft.Storage') {
    return 'Storage';
  }
  return String(properties.consumedService || 'Other').replace(/^Microsoft\./, '');
}

export function buildCostBreakdown(rows, columns, periodStart) {
  const indexes = Object.fromEntries(columns.map((column, index) => [column.name, index]));
  const serviceTotals = new Map();
  const modelTotals = new Map();
  const dailyTotals = new Map();
  let rawTotal = 0;

  for (const row of rows) {
    const amount = Number(row[indexes.PreTaxCost] ?? 0);
    const service = String(row[indexes.ServiceName] || 'Other');
    const product = String(row[indexes.Meter] || 'Other model');
    const date = parseUsageDate(row[indexes.UsageDate]);
    rawTotal += amount;
    serviceTotals.set(service, (serviceTotals.get(service) ?? 0) + amount);
    if (service === 'Foundry Models') {
      const model = modelNameFromProduct(product);
      modelTotals.set(model, (modelTotals.get(model) ?? 0) + amount);
    }
    dailyTotals.set(date, (dailyTotals.get(date) ?? 0) + amount);
  }

  const used = roundCurrency(rawTotal);
  const services = allocateRoundedAmounts(
    [...serviceTotals].map(([name, amount]) => ({ name, amount })),
    used,
  ).map((service) => ({
    ...service,
    models:
      service.name === 'Foundry Models'
        ? allocateRoundedAmounts(
            [...modelTotals].map(([name, amount]) => ({
              name,
              amount,
            })),
            service.amount,
          )
        : [],
  }));
  const daily = allocateRoundedAmounts(
    [...dailyTotals].map(([date, amount]) => ({ date, amount })),
    used,
  ).sort((a, b) => a.date.localeCompare(b.date));
  const weeklyTotals = new Map();
  for (const entry of daily) {
    const elapsedDays = Math.floor(
      (new Date(`${entry.date}T00:00:00Z`) - new Date(`${periodStart}T00:00:00Z`)) / 86_400_000,
    );
    const weekIndex = Math.max(0, Math.floor(elapsedDays / 7));
    weeklyTotals.set(weekIndex, (weeklyTotals.get(weekIndex) ?? 0) + entry.amount);
  }
  const weekly = allocateRoundedAmounts(
    [...weeklyTotals].map(([weekIndex, amount]) => ({
      start: addDays(periodStart, weekIndex * 7),
      end: addDays(periodStart, weekIndex * 7 + 6),
      amount,
    })),
    used,
  ).sort((a, b) => a.start.localeCompare(b.start));
  const top = services[0];
  const explanation = top
    ? `${top.name} is your largest cost at ${Math.round((top.amount / used) * 100) || 0}% of current-cycle spend.`
    : 'No Azure charges have posted in this billing cycle yet.';

  return { used, services, daily, weekly, explanation };
}
