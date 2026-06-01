import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Brush,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import rustLogo from "./assets/rust-logo.svg";
import { forecastArima } from "./forecast.js";
import "./App.css";

const FORECAST_HORIZON = 10;

const diseaseOptions = [
  { label: "All-cause admissions", value: "allcause" },
  { label: "Cardiovascular disease", value: "cvs" },
  { label: "Cancer", value: "cancer" },
  { label: "Diabetes mellitus", value: "dm" },
  { label: "Respiratory disease", value: "respiratory" },
];

const sexOptions = [
  { label: "Total", value: "t" },
  { label: "Female", value: "f" },
  { label: "Male", value: "m" },
  { label: "Both", value: "both" },
];

const metricOptions = [
  { label: "Admissions", value: "admissions" },
  { label: "Crude rates", value: "crude_rates" },
  { label: "Standardized rates", value: "standardized_rates" },
];

const seriesMeta = [
  { key: "live17_49", label: "17-49 years", color: "#1f7a63" },
  { key: "live50_69", label: "50-69 years", color: "#d88a2d" },
  { key: "live70Plus", label: "70+ years", color: "#295c9f" },
  { key: "liveTotal", label: "Total", color: "#102033" },
];

const causeSpecificCodes = {
  cvs: {
    t: [
      ["125", "125 - Essential hypertension (I10)"],
      ["128", "128 - Acute myocardial infarction (I21, I22)"],
      ["129", "129 - Other ischaemic heart disease (I20, I23-I25)"],
      ["132", "132 - Heart failure (I50)"],
      ["134", "134 - Cerebrovascular disease (I60-I69)"],
    ],
  },
  cancer: {
    m: [
      ["050", "050 - Lip/oral cavity/pharynx (C00-C14)"],
      ["053", "053 - Colon (C18)"],
      ["059", "059 - Trachea/bronchus/lung (C33-C34)"],
      ["069", "069 - Prostate (C61)"],
      ["051", "051 - Oesophagus (C15)"],
    ],
    f: [
      ["064", "064 - Breast (C50)"],
      ["076", "076 - Thyroid gland (C73)"],
      ["053", "053 - Colon (C18)"],
      ["066", "066 - Uterus, other/unspecified (C54, C55)"],
      ["065", "065 - Cervix uteri (C53)"],
    ],
  },
};

const sexPlotMeta = {
  t: { label: "Total", dash: undefined, fill: "#1f7a63" },
  f: { label: "Female", dash: undefined, fill: "#d88a2d" },
  m: { label: "Male", dash: "8 5", fill: "#466da8" },
};

function normalizeRows(response) {
  return response
    .map(([year, live17_49, live50_69, live70Plus, liveNA, liveTotal]) => ({
      year,
      live17_49,
      live50_69,
      live70Plus,
      liveNA,
      liveTotal,
    }))
    .sort((a, b) => a.year - b.year);
}

function getCauseSpecificChoices(disease, sex) {
  if (disease === "cvs") {
    const entries = causeSpecificCodes.cvs.t;
    return [
      { value: "__all__", label: "All records in selected category" },
      { value: "__all_doc__", label: "All listed cause-specific codes" },
      ...entries.map(([value, label]) => ({ value, label })),
    ];
  }

  if (disease === "cancer") {
    let entries = [];
    if (sex === "m") {
      entries = causeSpecificCodes.cancer.m;
    } else if (sex === "f") {
      entries = causeSpecificCodes.cancer.f;
    } else {
      const combined = [
        ...causeSpecificCodes.cancer.m,
        ...causeSpecificCodes.cancer.f,
      ];
      const seen = new Set();
      entries = combined.filter(([value]) => {
        if (seen.has(value)) {
          return false;
        }
        seen.add(value);
        return true;
      });
    }

    return [
      { value: "__all__", label: "All records in selected category" },
      { value: "__all_doc__", label: "All listed cause-specific codes" },
      ...entries.map(([value, label]) => ({ value, label })),
    ];
  }

  return [{ value: "__all__", label: "All records in selected category" }];
}

function hasCauseSpecificDrilldown(disease) {
  return disease === "cvs" || disease === "cancer";
}

function resolveCauseCodesForQuery(disease, sex, selectedCauseCode) {
  if (!selectedCauseCode || selectedCauseCode === "__all__") {
    return null;
  }

  if (selectedCauseCode === "__all_doc__") {
    return ["__all_doc__"];
  }

  return [selectedCauseCode];
}

function mergeDatasets(datasets, sexKeys) {
  const yearMap = new Map();

  sexKeys.forEach((sexKey) => {
    (datasets[sexKey] ?? []).forEach((row) => {
      const existing = yearMap.get(row.year) ?? { year: row.year };
      seriesMeta.forEach((series) => {
        existing[`${series.key}_${sexKey}`] = row[series.key];
      });
      yearMap.set(row.year, existing);
    });
  });

  return [...yearMap.values()].sort((a, b) => a.year - b.year);
}

function FilterSection({ title, children }) {
  return (
    <section className="filter-section">
      <p className="section-label">{title}</p>
      {children}
    </section>
  );
}

function formatValue(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "N/A";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: value >= 100 ? 0 : value >= 1 ? 2 : 4,
  }).format(value);
}

function ChartTooltip({ active, label, payload }) {
  if (!active || !payload?.length) {
    return null;
  }

  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-title">Year {label}</p>
      <div className="chart-tooltip-list">
        {payload.map((item) => (
          <div key={item.dataKey} className="chart-tooltip-row">
            <span className="chart-tooltip-name">
              <i style={{ backgroundColor: item.color }} />
              {item.name}
            </span>
            <strong>{formatValue(item.value)}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendLegend({ sexKeys }) {
  return (
    <div className="chart-legend-block">
      <div className="chart-legend-group">
        <span className="chart-legend-label">Age group</span>
        <div className="chart-legend-items">
          {seriesMeta.map((series) => (
            <span key={series.key} className="chart-legend-item">
              <i
                className="chart-legend-line"
                style={{ "--legend-color": series.color }}
              />
              {series.label}
            </span>
          ))}
        </div>
      </div>

      {sexKeys.length > 1 ? (
        <div className="chart-legend-group">
          <span className="chart-legend-label">Sex</span>
          <div className="chart-legend-items">
            {sexKeys.map((sexKey) => (
              <span key={sexKey} className="chart-legend-item">
                <i
                  className={
                    sexPlotMeta[sexKey].dash
                      ? "chart-legend-pattern dashed"
                      : "chart-legend-pattern"
                  }
                />
                {sexPlotMeta[sexKey].label}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function TotalLegend({ sexKeys }) {
  if (sexKeys.length <= 1) {
    return null;
  }

  return (
    <div className="chart-legend-block compact">
      <div className="chart-legend-group">
        <span className="chart-legend-label">Sex</span>
        <div className="chart-legend-items">
          {sexKeys.map((sexKey) => (
            <span key={sexKey} className="chart-legend-item">
              <i
                className={
                  sexPlotMeta[sexKey].dash
                    ? "chart-legend-pattern dashed"
                    : "chart-legend-pattern"
                }
              />
              {sexPlotMeta[sexKey].label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function LatestBarsLegend({ sexKeys }) {
  if (sexKeys.length <= 1) {
    return null;
  }

  return (
    <div className="chart-legend-block compact">
      <div className="chart-legend-group">
        <span className="chart-legend-label">Sex</span>
        <div className="chart-legend-items">
          {sexKeys.map((sexKey) => (
            <span key={sexKey} className="chart-legend-item">
              <i
                className="chart-legend-dot"
                style={{ "--legend-color": sexPlotMeta[sexKey].fill }}
              />
              {sexPlotMeta[sexKey].label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function TrendChart({ data, sexKeys }) {
  if (!data.length) {
    return <div className="chart-empty">No data available.</div>;
  }

  return (
    <div className="chart-wrap interactive-chart">
      <TrendLegend sexKeys={sexKeys} />
      <ResponsiveContainer width="100%" height={320}>
        <LineChart
          data={data}
          margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
        >
          <CartesianGrid
            stroke="rgba(16, 32, 51, 0.09)"
            strokeDasharray="3 3"
          />
          <XAxis
            dataKey="year"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#6c7985", fontSize: 12 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#6c7985", fontSize: 12 }}
            tickFormatter={formatValue}
          />
          <Tooltip content={<ChartTooltip />} />
          {sexKeys.flatMap((sexKey) =>
            seriesMeta.map((series) => (
              <Line
                key={`${series.key}_${sexKey}`}
                type="monotone"
                dataKey={`${series.key}_${sexKey}`}
                name={`${series.label} (${sexPlotMeta[sexKey].label})`}
                stroke={series.color}
                strokeDasharray={sexPlotMeta[sexKey].dash}
                strokeWidth={series.key === "liveTotal" ? 3.5 : 2.4}
                dot={false}
                connectNulls
                activeDot={{ r: 5, strokeWidth: 0 }}
              />
            )),
          )}
          <Brush
            dataKey="year"
            height={28}
            stroke="#1f7a63"
            travellerWidth={10}
            fill="rgba(31, 122, 99, 0.08)"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function TotalAreaChart({ data, sexKeys }) {
  if (!data.length) {
    return <div className="chart-empty">No data available.</div>;
  }

  return (
    <div className="chart-wrap interactive-chart">
      <TotalLegend sexKeys={sexKeys} />
      <ResponsiveContainer width="100%" height={320}>
        <AreaChart
          data={data}
          margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
        >
          <defs>
            <linearGradient id="totalGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#1f7a63" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#1f7a63" stopOpacity={0.04} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="rgba(16, 32, 51, 0.09)"
            strokeDasharray="3 3"
          />
          <XAxis
            dataKey="year"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#6c7985", fontSize: 12 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#6c7985", fontSize: 12 }}
            tickFormatter={formatValue}
          />
          <Tooltip content={<ChartTooltip />} />
          {sexKeys.length === 1 ? (
            <Area
              type="monotone"
              dataKey={`liveTotal_${sexKeys[0]}`}
              name={sexPlotMeta[sexKeys[0]].label}
              stroke="#102033"
              strokeWidth={3}
              fill="url(#totalGradient)"
              activeDot={{ r: 5, strokeWidth: 0 }}
            />
          ) : (
            sexKeys.map((sexKey) => (
              <Line
                key={`liveTotal_${sexKey}`}
                type="monotone"
                dataKey={`liveTotal_${sexKey}`}
                name={`Total (${sexPlotMeta[sexKey].label})`}
                stroke="#102033"
                strokeDasharray={sexPlotMeta[sexKey].dash}
                strokeWidth={3}
                dot={false}
                connectNulls
                activeDot={{ r: 5, strokeWidth: 0 }}
              />
            ))
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function LatestBarsChart({ latestBySex, sexKeys }) {
  if (!sexKeys.some((sexKey) => latestBySex[sexKey])) {
    return <div className="chart-empty">No data available.</div>;
  }

  const barData = seriesMeta.map((series) => {
    const row = { name: series.label };

    sexKeys.forEach((sexKey) => {
      row[`value_${sexKey}`] = latestBySex[sexKey]?.[series.key] ?? null;
    });

    return row;
  });

  return (
    <div className="chart-wrap interactive-chart">
      <LatestBarsLegend sexKeys={sexKeys} />
      <ResponsiveContainer width="100%" height={320}>
        <BarChart
          data={barData}
          margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
        >
          <CartesianGrid
            stroke="rgba(16, 32, 51, 0.09)"
            strokeDasharray="3 3"
          />
          <XAxis
            dataKey="name"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#6c7985", fontSize: 12 }}
            interval={0}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#6c7985", fontSize: 12 }}
            tickFormatter={formatValue}
          />
          <Tooltip
            content={<ChartTooltip />}
            cursor={{ fill: "rgba(16, 32, 51, 0.04)" }}
          />
          {sexKeys.map((sexKey) => (
            <Bar
              key={sexKey}
              dataKey={`value_${sexKey}`}
              name={sexPlotMeta[sexKey].label}
              fill={sexPlotMeta[sexKey].fill}
              radius={[12, 12, 4, 4]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LatestPlotTitle({ metric, sexLabel }) {
  const noun = metric === "admissions" ? "admissions" : "rates";
  return `Latest ${noun} snapshot by sex (${sexLabel})`;
}

// Fit an auto-order ARIMA to each active sex's Total series and assemble a single
// chart dataset: historical points plus FORECAST_HORIZON projected years with
// 80% / 95% prediction bands. The forecast is anchored to the last observed
// point so the dashed projection visually continues the solid history.
function buildForecast(chartRows, sexKeys) {
  if (!chartRows.length) {
    return null;
  }

  const lastYear = chartRows[chartRows.length - 1].year;
  const forecastsBySex = {};
  const models = {};

  sexKeys.forEach((sexKey) => {
    const series = chartRows
      .map((row) => row[`liveTotal_${sexKey}`])
      .filter((value) => typeof value === "number" && !Number.isNaN(value));
    const result = forecastArima(series, FORECAST_HORIZON);
    if (result) {
      forecastsBySex[sexKey] = result;
      models[sexKey] = { order: result.order };
    }
  });

  if (!Object.keys(forecastsBySex).length) {
    return null;
  }

  const rows = chartRows.map((row) => {
    const next = { year: row.year };
    sexKeys.forEach((sexKey) => {
      next[`hist_${sexKey}`] = row[`liveTotal_${sexKey}`] ?? null;
    });
    return next;
  });

  // Anchor each forecast line/band at the final observed value.
  const lastRow = rows[rows.length - 1];
  sexKeys.forEach((sexKey) => {
    if (!forecastsBySex[sexKey]) {
      return;
    }
    const anchor = lastRow[`hist_${sexKey}`];
    if (typeof anchor === "number") {
      lastRow[`fcst_${sexKey}`] = anchor;
      lastRow[`band80_${sexKey}`] = [anchor, anchor];
      lastRow[`band95_${sexKey}`] = [anchor, anchor];
    }
  });

  for (let h = 0; h < FORECAST_HORIZON; h += 1) {
    const next = { year: lastYear + h + 1 };
    sexKeys.forEach((sexKey) => {
      const forecast = forecastsBySex[sexKey];
      if (!forecast) {
        return;
      }
      next[`fcst_${sexKey}`] = forecast.point[h];
      next[`band80_${sexKey}`] = [forecast.lower80[h], forecast.upper80[h]];
      next[`band95_${sexKey}`] = [forecast.lower95[h], forecast.upper95[h]];
    });
    rows.push(next);
  }

  return { data: rows, models, lastYear, sexKeys };
}

function formatOrder(order) {
  return `ARIMA(${order[0]},${order[1]},${order[2]})`;
}

function ForecastLegend({ forecast, sexKeys }) {
  const orderLabel = [
    ...new Set(
      sexKeys
        .map((sexKey) => forecast.models[sexKey]?.order)
        .filter(Boolean)
        .map(formatOrder),
    ),
  ].join(" · ");

  return (
    <div className="chart-legend-block compact">
      <div className="chart-legend-group">
        <span className="chart-legend-label">Projection</span>
        <div className="chart-legend-items">
          <span className="chart-legend-item">
            <i className="chart-legend-line" style={{ "--legend-color": "#102033" }} />
            Observed
          </span>
          <span className="chart-legend-item">
            <i
              className="chart-legend-line dashed"
              style={{ "--legend-color": "#102033" }}
            />
            Forecast {orderLabel ? `· ${orderLabel}` : ""}
          </span>
          <span className="chart-legend-item">
            <i
              className="chart-legend-dot"
              style={{ "--legend-color": "rgba(16, 32, 51, 0.18)" }}
            />
            80% / 95% interval
          </span>
        </div>
      </div>

      {sexKeys.length > 1 ? (
        <div className="chart-legend-group">
          <span className="chart-legend-label">Sex</span>
          <div className="chart-legend-items">
            {sexKeys.map((sexKey) => (
              <span key={sexKey} className="chart-legend-item">
                <i
                  className="chart-legend-dot"
                  style={{ "--legend-color": sexPlotMeta[sexKey].fill }}
                />
                {sexPlotMeta[sexKey].label}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ForecastTooltip({ active, label, payload, sexKeys }) {
  if (!active || !payload?.length) {
    return null;
  }

  const row = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <p className="chart-tooltip-title">Year {label}</p>
      <div className="chart-tooltip-list">
        {sexKeys.map((sexKey) => {
          const observed = row[`hist_${sexKey}`];
          const projected = row[`fcst_${sexKey}`];
          const band = row[`band95_${sexKey}`];
          const isObserved = typeof observed === "number";
          const value = isObserved ? observed : projected;
          if (typeof value !== "number") {
            return null;
          }

          const name =
            sexKeys.length > 1
              ? `${sexPlotMeta[sexKey].label} (${isObserved ? "obs." : "fcst."})`
              : isObserved
                ? "Observed"
                : "Forecast";

          return (
            <div key={sexKey} className="chart-tooltip-row">
              <span className="chart-tooltip-name">
                <i style={{ backgroundColor: sexPlotMeta[sexKey].fill }} />
                {name}
              </span>
              <strong>
                {formatValue(value)}
                {!isObserved && Array.isArray(band)
                  ? ` (${formatValue(band[0])} – ${formatValue(band[1])})`
                  : ""}
              </strong>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ForecastChart({ forecast, sexKeys }) {
  if (!forecast) {
    return <div className="chart-empty">Not enough history to project a trend.</div>;
  }

  const { data, lastYear } = forecast;

  return (
    <div className="chart-wrap interactive-chart">
      <ForecastLegend forecast={forecast} sexKeys={sexKeys} />
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
          <CartesianGrid stroke="rgba(16, 32, 51, 0.09)" strokeDasharray="3 3" />
          <XAxis
            dataKey="year"
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#6c7985", fontSize: 12 }}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fill: "#6c7985", fontSize: 12 }}
            tickFormatter={formatValue}
          />
          <Tooltip content={<ForecastTooltip sexKeys={sexKeys} />} />
          {sexKeys.map((sexKey) => (
            <Area
              key={`band95_${sexKey}`}
              dataKey={`band95_${sexKey}`}
              stroke="none"
              fill={sexPlotMeta[sexKey].fill}
              fillOpacity={0.1}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          {sexKeys.map((sexKey) => (
            <Area
              key={`band80_${sexKey}`}
              dataKey={`band80_${sexKey}`}
              stroke="none"
              fill={sexPlotMeta[sexKey].fill}
              fillOpacity={0.18}
              isAnimationActive={false}
              connectNulls
            />
          ))}
          {sexKeys.map((sexKey) => (
            <Line
              key={`hist_${sexKey}`}
              type="monotone"
              dataKey={`hist_${sexKey}`}
              name="Observed"
              stroke={sexPlotMeta[sexKey].fill}
              strokeWidth={3}
              dot={false}
              connectNulls
              activeDot={{ r: 5, strokeWidth: 0 }}
            />
          ))}
          {sexKeys.map((sexKey) => (
            <Line
              key={`fcst_${sexKey}`}
              type="monotone"
              dataKey={`fcst_${sexKey}`}
              name="Forecast"
              stroke={sexPlotMeta[sexKey].fill}
              strokeWidth={2.4}
              strokeDasharray="6 4"
              dot={false}
              connectNulls
              activeDot={{ r: 5, strokeWidth: 0 }}
            />
          ))}
          <ReferenceLine
            x={lastYear}
            stroke="rgba(16, 32, 51, 0.35)"
            strokeDasharray="4 4"
            label={{
              value: "forecast",
              position: "insideTopRight",
              fill: "#6c7985",
              fontSize: 11,
            }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function App() {
  const [selectedMetric, setSelectedMetric] = useState(metricOptions[0].value);
  const [selectedDisease, setSelectedDisease] = useState(
    diseaseOptions[0].value,
  );
  const [selectedSex, setSelectedSex] = useState(sexOptions[0].value);
  const [selectedCauseCode, setSelectedCauseCode] = useState("__all__");
  const [datasetsBySex, setDatasetsBySex] = useState({});
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [testStatus, setTestStatus] = useState("idle");
  const [testOutput, setTestOutput] = useState("");

  useEffect(() => {
    const causeChoices = getCauseSpecificChoices(
      selectedDisease,
      selectedSex === "both" ? "t" : selectedSex,
    );
    const validValues = causeChoices.map((choice) => choice.value);
    if (!validValues.includes(selectedCauseCode)) {
      setSelectedCauseCode(causeChoices[0]?.value ?? "__all__");
    }
  }, [selectedDisease, selectedSex, selectedCauseCode]);

  useEffect(() => {
    let isActive = true;

    async function loadData() {
      setStatus("loading");
      setError("");

      try {
        const querySexes = selectedSex === "both" ? ["f", "m"] : [selectedSex];
        const responses = await Promise.all(
          querySexes.map(async (sexKey) => {
            const causeCodes = resolveCauseCodesForQuery(
              selectedDisease,
              sexKey,
              selectedCauseCode,
            );
            const response = await invoke("query_data", {
              disease: selectedDisease,
              sex: sexKey,
              metric: selectedMetric,
              causeCodes,
            });

            return [sexKey, normalizeRows(response)];
          }),
        );

        if (!isActive) {
          return;
        }

        setDatasetsBySex(Object.fromEntries(responses));
        setStatus("success");
      } catch (loadError) {
        if (!isActive) {
          return;
        }

        setDatasetsBySex({});
        setStatus("error");
        setError(String(loadError));
      }
    }

    loadData();

    return () => {
      isActive = false;
    };
  }, [selectedDisease, selectedSex, selectedMetric, selectedCauseCode]);

  const selectedMetricLabel =
    metricOptions.find((item) => item.value === selectedMetric)?.label ??
    selectedMetric;
  const selectedDiseaseLabel =
    diseaseOptions.find((item) => item.value === selectedDisease)?.label ??
    selectedDisease;
  const selectedSexLabel =
    sexOptions.find((item) => item.value === selectedSex)?.label ?? selectedSex;
  const activeSexKeys = selectedSex === "both" ? ["f", "m"] : [selectedSex];
  const causeChoices = getCauseSpecificChoices(
    selectedDisease,
    selectedSex === "both" ? "t" : selectedSex,
  );
  const showCauseDrilldown = hasCauseSpecificDrilldown(selectedDisease);
  const selectedCauseLabel =
    causeChoices.find((choice) => choice.value === selectedCauseCode)?.label ??
    "All";
  const chartRows = mergeDatasets(datasetsBySex, activeSexKeys);
  const forecast = useMemo(
    () => buildForecast(chartRows, activeSexKeys),
    [chartRows, activeSexKeys],
  );
  const latestBySex = Object.fromEntries(
    activeSexKeys.map((sexKey) => [
      sexKey,
      datasetsBySex[sexKey]?.at(-1) ?? null,
    ]),
  );
  const latestYear =
    activeSexKeys
      .map((sexKey) => latestBySex[sexKey]?.year)
      .filter((year) => typeof year === "number")
      .sort((a, b) => b - a)[0] ?? "N/A";
  const peakTotal = activeSexKeys
    .flatMap((sexKey) =>
      (datasetsBySex[sexKey] ?? []).map((row) => row.liveTotal),
    )
    .reduce((max, value) => Math.max(max, value), Number.NEGATIVE_INFINITY);
  const statusLabel =
    status === "loading"
      ? "Refreshing query"
      : status === "error"
        ? "Query failed"
        : "Ready";
  const heroCopy =
    selectedMetric === "admissions"
      ? "Hover the plots, use the legend, and zoom with the brush to inspect live admissions."
      : selectedMetric === "crude_rates"
        ? "Crude rates are admissions divided by the matching population for each year."
        : "Standardized rates use 2012 as the reference year.";
  const plotOneTitle =
    selectedMetric === "admissions"
      ? "Age-group admissions trends"
      : "Age-group rate trends (per 100,000 population)";
  const plotTwoTitle =
    selectedMetric === "admissions"
      ? "Total admissions over time"
      : selectedMetric === "crude_rates"
        ? "Crude rate over time (per 100,000 population)"
        : "Standardized rate over time (per 100,000 population)";
  const plotThreeTitle = LatestPlotTitle({
    metric: selectedMetric,
    sexLabel: selectedSexLabel,
  });
  const projectionNoun =
    selectedMetric === "admissions"
      ? "total admissions"
      : selectedMetric === "crude_rates"
        ? "crude rate"
        : "standardized rate";
  const plotFourTitle = `${FORECAST_HORIZON}-year ${projectionNoun} projection (ARIMA)`;

  async function runBackendTest() {
    setTestStatus("loading");

    try {
      const response = await invoke("test_read_csv");
      setTestOutput(String(response));
      setTestStatus("success");
    } catch (testError) {
      setTestOutput(String(testError));
      setTestStatus("error");
    }
  }

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="brand-lockup">
            <img className="rust-logo" src={rustLogo} alt="Rust logo" />
            <div>
              <p className="sidebar-kicker">NCD Rust</p>
              <h1>NCD Rust</h1>
              <p className="sidebar-copy">v0.0</p>
            </div>
          </div>
        </div>

        <div className="filter-stack">
          <FilterSection title="Metric">
            <div className="segmented-control metric-control">
              {metricOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={
                    option.value === selectedMetric
                      ? "segment active"
                      : "segment"
                  }
                  onClick={() => setSelectedMetric(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </FilterSection>

          <FilterSection title="Disease">
            <div className="choice-grid">
              {diseaseOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={
                    option.value === selectedDisease
                      ? "choice-pill active"
                      : "choice-pill"
                  }
                  onClick={() => setSelectedDisease(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </FilterSection>

          <FilterSection title="Sex">
            <div className="segmented-control">
              {sexOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={
                    option.value === selectedSex ? "segment active" : "segment"
                  }
                  onClick={() => setSelectedSex(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </FilterSection>

          {showCauseDrilldown ? (
            <FilterSection title="Cause-specific drilldown">
              <div className="choice-grid cause-grid">
                {causeChoices.map((choice) => (
                  <button
                    key={choice.value}
                    type="button"
                    className={
                      choice.value === selectedCauseCode
                        ? "choice-pill cause-pill active"
                        : "choice-pill cause-pill"
                    }
                    onClick={() => setSelectedCauseCode(choice.value)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            </FilterSection>
          ) : null}
        </div>

        <div className="sidebar-footer">
          <button
            type="button"
            className="primary-action"
            onClick={runBackendTest}
            disabled={testStatus === "loading"}
          >
            {testStatus === "loading" ? "Running test..." : "Test backend"}
          </button>
        </div>

        <div className="test-panel">
          <p className="section-label">Backend test output</p>
          <pre className="test-output">
            {testOutput || "No test output yet."}
          </pre>
        </div>
      </aside>

      <main className="main-panel">
        <header className="hero-card">
          <div className="hero-content">
            <p className="hero-kicker">Current view</p>
            <h2>{selectedDiseaseLabel}</h2>
            <p className="hero-copy">{heroCopy}</p>
            <div className="hero-status-row" aria-live="polite">
              <span
                className={
                  status === "loading"
                    ? "hero-status-indicator loading"
                    : status === "error"
                      ? "hero-status-indicator error"
                      : "hero-status-indicator"
                }
              />
              <span className="hero-status-text">{statusLabel}</span>
            </div>
          </div>

          <div className="hero-metrics">
            <div className="metric-card">
              <span className="metric-label">Metric</span>
              <strong>{selectedMetricLabel}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Selected sex</span>
              <strong>{selectedSexLabel}</strong>
            </div>
            {showCauseDrilldown ? (
              <div className="metric-card metric-card-wide">
                <span className="metric-label">Cause filter</span>
                <strong>{selectedCauseLabel}</strong>
              </div>
            ) : null}
            <div className="metric-card">
              <span className="metric-label">Years returned</span>
              <strong>{chartRows.length}</strong>
            </div>
            <div className="metric-card">
              <span className="metric-label">Peak total</span>
              <strong>
                {peakTotal === Number.NEGATIVE_INFINITY
                  ? "N/A"
                  : formatValue(peakTotal)}
              </strong>
            </div>
          </div>
        </header>

        {error ? <div className="status-banner error">{error}</div> : null}

        <section className="plot-grid">
          <article className="plot-card">
            <div className="plot-card-header">
              <span className="plot-eyebrow">Plot 01</span>
              <h3>{plotOneTitle}</h3>
            </div>
            <TrendChart data={chartRows} sexKeys={activeSexKeys} />
          </article>

          <article className="plot-card">
            <div className="plot-card-header">
              <span className="plot-eyebrow">Plot 02</span>
              <h3>{plotTwoTitle}</h3>
            </div>
            <TotalAreaChart data={chartRows} sexKeys={activeSexKeys} />
          </article>

          <article className="plot-card">
            <div className="plot-card-header">
              <span className="plot-eyebrow">Plot 03</span>
              <h3>{plotThreeTitle}</h3>
            </div>
            <LatestBarsChart
              latestBySex={latestBySex}
              sexKeys={activeSexKeys}
            />
          </article>

          <article className="plot-card">
            <div className="plot-card-header">
              <span className="plot-eyebrow">Plot 04</span>
              <h3>{plotFourTitle}</h3>
            </div>
            <ForecastChart forecast={forecast} sexKeys={activeSexKeys} />
          </article>
        </section>
      </main>
    </div>
  );
}

export default App;
