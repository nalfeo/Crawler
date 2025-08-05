// Project canvas for inspecting Azure Visual Studio credit usage.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import {
  addDays,
  buildCostBreakdown,
  roundCurrency,
  serviceNameFromUsage,
} from './lib/cost-model.mjs';
import { createRefreshCache } from './lib/refresh-cache.mjs';

const execFileAsync = promisify(execFile);
const servers = new Map();
const DEFAULT_MONTHLY_CREDIT = 150;
const SUBSCRIPTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POWERSHELL_AZ_WRAPPER = Buffer.from(
  [
    "$ErrorActionPreference = 'Stop'",
    '$azArgs = ConvertFrom-Json $env:COPILOT_AZ_ARGS',
    '& az @azArgs',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('; '),
  'utf16le',
).toString('base64');

function errorMessage(error) {
  if (error instanceof Error) {
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    return stderr || error.message;
  }
  return String(error);
}

async function runAz(args, signal) {
  try {
    if (process.platform === 'win32') {
      const azureEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith('COPILOT_')),
      );
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', POWERSHELL_AZ_WRAPPER],
        {
          encoding: 'utf8',
          env: {
            ...azureEnvironment,
            COPILOT_AZ_ARGS: JSON.stringify(args),
          },
          maxBuffer: 10 * 1024 * 1024,
          signal,
          windowsHide: true,
        },
      );
      return stdout.trim();
    }

    const { stdout } = await execFileAsync('az', args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      signal,
    });
    return stdout.trim();
  } catch (error) {
    throw new Error(
      `Azure CLI command failed. Run "az login" and try again. ${errorMessage(error)}`,
    );
  }
}

async function runAzJson(args, signal) {
  const output = await runAz([...args, '--output', 'json'], signal);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Azure CLI returned an invalid JSON response.');
  }
}

function findCurrentBillingPeriod(periods) {
  const today = new Date().toISOString().slice(0, 10);
  const normalized = periods.map((period) => period.properties ?? period);
  const sorted = normalized.sort((a, b) =>
    b.billingPeriodStartDate.localeCompare(a.billingPeriodStartDate),
  );
  const current = sorted.find((period) => {
    return period.billingPeriodStartDate <= today && period.billingPeriodEndDate >= today;
  });

  if (!current) {
    throw new Error('Azure did not return a current billing period.');
  }
  return current;
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });
}

async function fetchAzureResponse(url, options) {
  const maximumAttempts = 4;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const response = await fetch(url, options);
    if (response.status !== 429 || attempt === maximumAttempts) {
      return response;
    }
    const retryAfterHeader = response.headers.get('retry-after');
    const parsedRetryAfter = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
    const delaySeconds =
      Number.isFinite(parsedRetryAfter) && parsedRetryAfter > 0 ? parsedRetryAfter : attempt * 10;
    await sleep(Math.min(delaySeconds, 30) * 1000, options?.signal);
  }
  throw new Error('Azure billing retry loop ended unexpectedly.');
}

async function queryAzureCredit(config, signal) {
  const accountArgs = ['account', 'show'];
  if (config.subscriptionId) {
    accountArgs.push('--subscription', config.subscriptionId);
  }
  const account = await runAzJson(accountArgs, signal);
  const subscriptionId = account.id;

  if (!SUBSCRIPTION_ID_PATTERN.test(subscriptionId)) {
    throw new Error('Azure returned an invalid subscription ID.');
  }

  const periods = await runAzJson(
    ['billing', 'period', 'list', '--subscription', subscriptionId],
    signal,
  );
  const period = findCurrentBillingPeriod(periods);
  const accessToken = await runAz(
    [
      'account',
      'get-access-token',
      '--subscription',
      subscriptionId,
      '--resource',
      'https://management.azure.com',
      '--query',
      'accessToken',
      '--output',
      'tsv',
    ],
    signal,
  );

  const usageUrl = new URL(
    `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Consumption/usageDetails`,
  );
  usageUrl.searchParams.set('api-version', '2021-10-01');
  usageUrl.searchParams.set(
    '$filter',
    `properties/usageStart ge '${period.billingPeriodStartDate}' AND properties/usageEnd le '${addDays(new Date().toISOString().slice(0, 10), 1)}'`,
  );
  usageUrl.searchParams.set('$top', '1000');

  const details = [];
  let nextUrl = usageUrl.toString();
  for (let page = 0; nextUrl && page < 100; page += 1) {
    const response = await fetchAzureResponse(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Azure Consumption returned ${response.status}: ${detail}`);
    }
    const result = await response.json();
    details.push(...(result.value ?? []));
    nextUrl = result.nextLink || '';
  }
  if (nextUrl) {
    throw new Error('Azure Consumption returned more than 100 pages of usage details.');
  }

  const columns = [
    { name: 'PreTaxCost' },
    { name: 'UsageDate' },
    { name: 'ServiceName' },
    { name: 'Meter' },
    { name: 'Currency' },
  ];
  const rows = details.map(({ properties }) => [
    Number(properties.cost ?? 0),
    properties.date,
    serviceNameFromUsage(properties),
    properties.product,
    properties.billingCurrency,
  ]);
  const breakdown = buildCostBreakdown(rows, columns, period.billingPeriodStartDate);
  const used = breakdown.used;
  if (!Number.isFinite(used) || used < 0) {
    throw new Error('Azure returned an invalid usage amount.');
  }
  const currencyIndex = columns.findIndex((column) => column.name === 'Currency');

  const allowance = roundCurrency(config.monthlyCredit);
  const remaining = roundCurrency(Math.max(0, allowance - used));
  const overage = roundCurrency(Math.max(0, used - allowance));

  return {
    subscriptionName: account.name,
    subscriptionId,
    currency: rows[0]?.[currencyIndex] || 'USD',
    allowance,
    used,
    remaining,
    overage,
    usagePercent: allowance > 0 ? (used / allowance) * 100 : 0,
    periodStart: period.billingPeriodStartDate,
    periodEnd: period.billingPeriodEndDate,
    services: breakdown.services,
    daily: breakdown.daily,
    weekly: breakdown.weekly,
    explanation: breakdown.explanation,
    updatedAt: new Date().toISOString(),
  };
}

function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  res.end(JSON.stringify(value));
}

const refreshEntry = createRefreshCache(queryAzureCredit);

function renderHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
  <title>Azure Credit</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--background-color-default, #0d1117);
      color: var(--text-color-default, #f0f6fc);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    main { max-width: 760px; margin: 0 auto; padding: 28px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
    h1 {
      margin: 0;
      font-family: var(--font-sans-display, var(--font-sans, sans-serif));
      font-size: var(--text-title-large, 26px);
      font-weight: var(--font-weight-semibold, 600);
      line-height: var(--leading-title-large, 32px);
    }
    .subtitle { color: var(--text-color-muted, #8b949e); margin: 4px 0 0; }
    button {
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 8px;
      background: var(--background-color-default, #21262d);
      color: var(--text-color-default, #f0f6fc);
      cursor: pointer;
      font: inherit;
      font-weight: var(--font-weight-semibold, 600);
      padding: 8px 14px;
    }
    button:hover { border-color: var(--true-color-blue, #58a6ff); }
    button:focus-visible { outline: 2px solid var(--color-focus-outline, #58a6ff); outline-offset: 2px; }
    button:disabled { cursor: wait; opacity: 0.65; }
    .hero {
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 14px;
      margin-top: 24px;
      padding: 24px;
    }
    .remaining-label { color: var(--text-color-muted, #8b949e); }
    .remaining {
      font-size: 48px;
      font-weight: var(--font-weight-semibold, 600);
      letter-spacing: -1.5px;
      line-height: 1.1;
      margin: 6px 0 20px;
    }
    .track {
      background: var(--border-color-default, #30363d);
      border-radius: 999px;
      height: 12px;
      overflow: hidden;
    }
    .fill {
      background: var(--true-color-blue, #2f81f7);
      border-radius: inherit;
      height: 100%;
      min-width: 2px;
      transition: width 300ms ease;
      width: 0;
    }
    .fill.warning { background: var(--true-color-red, #f85149); }
    .progress-labels {
      color: var(--text-color-muted, #8b949e);
      display: flex;
      justify-content: space-between;
      margin-top: 8px;
    }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
    .card { border: 1px solid var(--border-color-default, #30363d); border-radius: 12px; padding: 16px; }
    .card-label { color: var(--text-color-muted, #8b949e); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
    .card-value { font-size: 18px; font-weight: var(--font-weight-semibold, 600); margin-top: 4px; }
    .section { border-top: 1px solid var(--border-color-default, #30363d); margin-top: 24px; padding-top: 22px; }
    .section-header { align-items: center; display: flex; justify-content: space-between; gap: 12px; }
    h2 { font-size: 18px; margin: 0; }
    .explanation { color: var(--text-color-muted, #8b949e); margin: 6px 0 18px; }
    .service-group { margin-top: 12px; }
    .service-row { display: grid; grid-template-columns: minmax(110px, 1fr) 2fr auto; align-items: center; gap: 12px; list-style: none; }
    .service-row::-webkit-details-marker { display: none; }
    details .service-name::before { content: "›"; display: inline-block; margin-right: 6px; transition: transform 120ms ease; }
    details[open] .service-name::before { transform: rotate(90deg); }
    .service-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .service-track { background: var(--border-color-default, #30363d); border-radius: 999px; height: 8px; overflow: hidden; }
    .service-fill { background: var(--true-color-blue, #2f81f7); border-radius: inherit; height: 100%; }
    .service-amount { font-family: var(--font-mono, Consolas, monospace); font-size: 12px; }
    .model-list { border-left: 2px solid var(--border-color-default, #30363d); margin: 8px 0 0 8px; padding-left: 14px; }
    .model-row { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; }
    .model-name { color: var(--text-color-muted, #8b949e); }
    .toggle { display: flex; }
    .toggle button { border-radius: 0; padding: 5px 10px; }
    .toggle button:first-child { border-radius: 7px 0 0 7px; }
    .toggle button:last-child { border-radius: 0 7px 7px 0; }
    .toggle button.active { background: var(--true-color-blue-muted, #1f6feb); border-color: var(--true-color-blue, #58a6ff); }
    .chart { align-items: end; display: flex; gap: 8px; height: 180px; margin-top: 18px; overflow-x: auto; padding-top: 20px; }
    .bar-group { align-items: center; display: flex; flex: 1 0 48px; flex-direction: column; height: 100%; justify-content: end; min-width: 48px; }
    .bar-value { font-family: var(--font-mono, Consolas, monospace); font-size: 10px; margin-bottom: 4px; }
    .bar { background: var(--true-color-blue, #2f81f7); border-radius: 5px 5px 0 0; min-height: 2px; width: min(34px, 70%); }
    .bar-label { color: var(--text-color-muted, #8b949e); font-size: 10px; margin-top: 6px; white-space: nowrap; }
    .empty { color: var(--text-color-muted, #8b949e); padding: 18px 0; }
    footer { color: var(--text-color-muted, #8b949e); font-size: 12px; margin-top: 16px; }
    .error {
      border: 1px solid var(--true-color-red, #f85149);
      border-radius: 12px;
      color: var(--true-color-red, #f85149);
      margin-top: 24px;
      padding: 16px;
      white-space: pre-wrap;
    }
    .hidden { display: none; }
    @media (max-width: 520px) {
      main { padding: 20px; }
      .grid { grid-template-columns: 1fr; }
      .remaining { font-size: 40px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Azure credit</h1>
        <p class="subtitle" id="subscription">Loading subscription...</p>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </header>
    <section id="dashboard" class="hidden" aria-live="polite">
      <div class="hero">
        <div class="remaining-label">Remaining this cycle</div>
        <div class="remaining" id="remaining">--</div>
        <div class="track" role="progressbar" aria-label="Credit used" aria-valuemin="0" aria-valuemax="100">
          <div class="fill" id="fill"></div>
        </div>
        <div class="progress-labels">
          <span id="used">-- used</span>
          <span id="allowance">-- total</span>
        </div>
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-label">Billing cycle</div>
          <div class="card-value" id="cycle">--</div>
        </div>
        <div class="card">
          <div class="card-label">Credit used</div>
          <div class="card-value" id="percent">--</div>
        </div>
      </div>
      <div class="section">
        <div class="section-header"><h2>What you're spending on</h2></div>
        <p class="explanation" id="explanation"></p>
        <div id="services"></div>
      </div>
      <div class="section">
        <div class="section-header">
          <h2>Spend over time</h2>
          <div class="toggle" aria-label="Trend interval">
            <button id="daily" class="active" type="button" aria-pressed="true">Day</button>
            <button id="weekly" type="button" aria-pressed="false">Week</button>
          </div>
        </div>
        <div class="chart" id="chart"></div>
      </div>
      <footer id="updated"></footer>
    </section>
    <div id="error" class="error hidden" role="alert"></div>
  </main>
  <script>
    const elements = {
      allowance: document.querySelector("#allowance"),
      cycle: document.querySelector("#cycle"),
      dashboard: document.querySelector("#dashboard"),
      error: document.querySelector("#error"),
      explanation: document.querySelector("#explanation"),
      fill: document.querySelector("#fill"),
      chart: document.querySelector("#chart"),
      daily: document.querySelector("#daily"),
      percent: document.querySelector("#percent"),
      refresh: document.querySelector("#refresh"),
      remaining: document.querySelector("#remaining"),
      subscription: document.querySelector("#subscription"),
      services: document.querySelector("#services"),
      track: document.querySelector(".track"),
      updated: document.querySelector("#updated"),
      used: document.querySelector("#used"),
      weekly: document.querySelector("#weekly"),
    };
    let currentData;
    let interval = "daily";

    function money(value, currency) {
      return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value);
    }

    function date(value) {
      return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
        .format(new Date(value + "T12:00:00Z"));
    }

    function setToggleState(element, isActive) {
      element.classList.toggle("active", isActive);
      element.setAttribute("aria-pressed", String(isActive));
    }

    function renderServices(data) {
      elements.explanation.textContent = data.explanation;
      if (!data.services.length) {
        elements.services.innerHTML = '<div class="empty">No posted charges yet.</div>';
        return;
      }
      const maximum = Math.max(...data.services.map((service) => service.amount), 0.01);
      elements.services.replaceChildren(...data.services.map((service) => {
        const expandable = service.models && service.models.length > 0;
        const group = document.createElement(expandable ? "details" : "div");
        group.className = "service-group";
        const row = document.createElement(expandable ? "summary" : "div");
        row.className = "service-row";
        const name = document.createElement("div");
        name.className = "service-name";
        name.textContent = service.name;
        name.title = service.name;
        const track = document.createElement("div");
        track.className = "service-track";
        const fill = document.createElement("div");
        fill.className = "service-fill";
        fill.style.width = ((service.amount / maximum) * 100) + "%";
        track.append(fill);
        const amount = document.createElement("div");
        amount.className = "service-amount";
        amount.textContent = money(service.amount, data.currency);
        row.append(name, track, amount);
        group.append(row);
        if (expandable) {
          const list = document.createElement("div");
          list.className = "model-list";
          service.models.forEach((model) => {
            const modelRow = document.createElement("div");
            modelRow.className = "model-row";
            const modelName = document.createElement("span");
            modelName.className = "model-name";
            modelName.textContent = model.name;
            const modelAmount = document.createElement("span");
            modelAmount.className = "service-amount";
            modelAmount.textContent = money(model.amount, data.currency);
            modelRow.append(modelName, modelAmount);
            list.append(modelRow);
          });
          group.append(list);
        }
        return group;
      }));
    }

    function renderChart(data) {
      const entries = data[interval];
      setToggleState(elements.daily, interval === "daily");
      setToggleState(elements.weekly, interval === "weekly");
      if (!entries.length) {
        elements.chart.innerHTML = '<div class="empty">No posted charges yet.</div>';
        return;
      }
      const maximum = Math.max(...entries.map((entry) => entry.amount), 0.01);
      elements.chart.replaceChildren(...entries.map((entry) => {
        const group = document.createElement("div");
        group.className = "bar-group";
        const value = document.createElement("div");
        value.className = "bar-value";
        value.textContent = money(entry.amount, data.currency);
        const bar = document.createElement("div");
        bar.className = "bar";
        bar.style.height = Math.max(2, (entry.amount / maximum) * 130) + "px";
        bar.title = value.textContent;
        const label = document.createElement("div");
        label.className = "bar-label";
        label.textContent = interval === "daily"
          ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(entry.date + "T12:00:00Z"))
          : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(entry.start + "T12:00:00Z"));
        group.append(value, bar, label);
        return group;
      }));
    }

    function render(data) {
      currentData = data;
      const clampedPercent = Math.min(100, Math.max(0, data.usagePercent));
      elements.subscription.textContent = data.subscriptionName;
      elements.remaining.textContent = money(data.remaining, data.currency);
      elements.used.textContent = money(data.used, data.currency) + " used";
      elements.allowance.textContent = money(data.allowance, data.currency) + " total";
      elements.cycle.textContent = date(data.periodStart) + " – " + date(data.periodEnd);
      elements.percent.textContent = data.usagePercent.toFixed(1) + "%";
      elements.fill.style.width = clampedPercent + "%";
      elements.fill.classList.toggle("warning", data.usagePercent >= 90);
      elements.track.setAttribute("aria-valuenow", String(Math.round(clampedPercent)));
      elements.daily.disabled = false;
      elements.weekly.disabled = false;
      renderServices(data);
      renderChart(data);
      elements.updated.textContent =
        "Updated " + new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })
          .format(new Date(data.updatedAt)) + ". Cost data may be delayed.";
      elements.error.classList.add("hidden");
      elements.dashboard.classList.remove("hidden");
    }

    async function load(method = "GET") {
      elements.refresh.disabled = true;
      elements.refresh.textContent = "Refreshing...";
      try {
        const response = await fetch(method === "POST" ? "/api/refresh" : "/api/data", { method });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || "Unable to load Azure usage.");
        render(payload);
      } catch (error) {
        elements.error.textContent = error instanceof Error ? error.message : String(error);
        elements.error.classList.remove("hidden");
      } finally {
        elements.refresh.disabled = false;
        elements.refresh.textContent = "Refresh";
      }
    }

    elements.refresh.addEventListener("click", () => load("POST"));
    elements.daily.addEventListener("click", () => {
      if (!currentData) return;
      interval = "daily";
      renderChart(currentData);
    });
    elements.weekly.addEventListener("click", () => {
      if (!currentData) return;
      interval = "weekly";
      renderChart(currentData);
    });
    load();
  </script>
</body>
</html>`;
}

async function startServer(config, initialData) {
  const entry = { config, data: initialData, server: undefined, url: undefined };
  const server = createServer(async (req, res) => {
    if (req.url === '/api/data' && req.method === 'GET') {
      sendJson(res, 200, entry.data);
      return;
    }

    if (req.url === '/api/refresh' && req.method === 'POST') {
      try {
        sendJson(res, 200, await refreshEntry(entry));
      } catch (error) {
        sendJson(res, 502, { error: errorMessage(error) });
      }
      return;
    }

    if (req.url === '/' && req.method === 'GET') {
      res.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      });
      res.end(renderHtml());
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  entry.server = server;
  entry.url = `http://127.0.0.1:${port}/`;
  return entry;
}

const canvas = createCanvas({
  id: 'azure-credit-dashboard',
  displayName: 'Azure Credit',
  description: 'Shows current-cycle Azure credit usage, remaining balance, and billing dates.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      subscriptionId: {
        type: 'string',
        pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
        description: 'Optional Azure subscription ID; defaults to the active subscription.',
      },
      monthlyCredit: {
        type: 'number',
        exclusiveMinimum: 0,
        default: DEFAULT_MONTHLY_CREDIT,
        description: 'Monthly credit allowance in the billing currency.',
      },
    },
  },
  actions: [
    {
      name: 'refresh',
      description: 'Refresh Azure usage and return the current credit summary.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      handler: async (ctx) => {
        const entry = servers.get(ctx.instanceId);
        if (!entry) {
          throw new CanvasError(
            'canvas_instance_not_open',
            'Open the Azure Credit canvas before refreshing it.',
          );
        }
        try {
          return await refreshEntry(entry);
        } catch (error) {
          throw new CanvasError('azure_query_failed', errorMessage(error));
        }
      },
    },
  ],
  open: async (ctx) => {
    let entry = servers.get(ctx.instanceId);
    if (!entry) {
      const input = ctx.input && typeof ctx.input === 'object' ? ctx.input : {};
      const config = {
        subscriptionId: input.subscriptionId,
        monthlyCredit: input.monthlyCredit ?? DEFAULT_MONTHLY_CREDIT,
      };
      try {
        const initialData = await queryAzureCredit(config);
        entry = await startServer(config, initialData);
        servers.set(ctx.instanceId, entry);
      } catch (error) {
        throw new CanvasError('azure_query_failed', errorMessage(error));
      }
    }

    return {
      title: 'Azure Credit',
      status: `${entry.data.currency} ${entry.data.remaining.toFixed(2)} remaining`,
      url: entry.url,
    };
  },
  onClose: async (ctx) => {
    const entry = servers.get(ctx.instanceId);
    if (entry) {
      servers.delete(ctx.instanceId);
      entry.refreshController?.abort();
      const closed = new Promise((resolve) => entry.server.close(() => resolve()));
      entry.server.closeAllConnections();
      await closed;
    }
  },
});

await joinSession({ canvases: [canvas] });
