// Pure-JS auto-order ARIMA forecasting for short annual series.
//
// The dashboard data is yearly (no seasonality), so this fits a non-seasonal
// ARIMA(p, d, q). The differencing order d is chosen from the lag-1
// autocorrelation (a trended series keeps getting differenced until it looks
// stationary), and (p, q) are selected by AICc over a small grid. Estimation
// uses the Hannan-Rissanen two-stage method (a long AR to recover the
// innovations, then OLS of the series on its own lags and the estimated
// innovation lags), which is robust and cheap for the ~19 observations we have.
//
// Candidate fits whose AR part is non-stationary or whose MA part is
// non-invertible are rejected, so the search can't lock onto an explosive model
// that blows the 10-year extrapolation up. If nothing valid is found we fall
// back to ARIMA(0, d, 0) with drift (a random walk with drift), the standard
// robust baseline. Prediction intervals come from the MA(infinity) psi-weights
// of the full differenced process: se_k = sigma * sqrt(sum_{j<k} psi_j^2).

const Z_80 = 1.2815515594600006;
const Z_95 = 1.959963984540054;
const ROOT_EPS = 1e-6;

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / values.length;
}

function diffOnce(values) {
  const out = [];
  for (let i = 1; i < values.length; i += 1) {
    out.push(values[i] - values[i - 1]);
  }
  return out;
}

function diffN(values, d) {
  let out = values.slice();
  for (let i = 0; i < d; i += 1) {
    out = diffOnce(out);
  }
  return out;
}

// Solve (X'X + ridge) beta = X'y by Gaussian elimination with partial pivoting.
function olsSolve(rows, target) {
  const k = rows[0]?.length ?? 0;
  if (!k) return [];

  const xtx = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty = new Array(k).fill(0);

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    for (let i = 0; i < k; i += 1) {
      xty[i] += row[i] * target[r];
      for (let j = 0; j < k; j += 1) {
        xtx[i][j] += row[i] * row[j];
      }
    }
  }

  // Small ridge term keeps the system solvable if regressors are near-collinear.
  for (let i = 0; i < k; i += 1) {
    xtx[i][i] += 1e-8;
  }

  const aug = xtx.map((row, i) => [...row, xty[i]]);

  for (let col = 0; col < k; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < k; r += 1) {
      if (Math.abs(aug[r][col]) > Math.abs(aug[pivot][col])) {
        pivot = r;
      }
    }
    if (Math.abs(aug[pivot][col]) < 1e-12) {
      return null;
    }
    [aug[col], aug[pivot]] = [aug[pivot], aug[col]];

    const pivotValue = aug[col][col];
    for (let r = 0; r < k; r += 1) {
      if (r === col) continue;
      const factor = aug[r][col] / pivotValue;
      for (let c = col; c <= k; c += 1) {
        aug[r][c] -= factor * aug[col][c];
      }
    }
  }

  const beta = new Array(k);
  for (let i = 0; i < k; i += 1) {
    beta[i] = aug[i][k] / aug[i][i];
  }
  return beta.every(Number.isFinite) ? beta : null;
}

// Do all roots of (1 + c1 z + c2 z^2 + ...) lie strictly outside the unit
// circle? That is the stationarity test for an AR polynomial and the
// invertibility test for an MA polynomial. Only degree <= 2 is needed here.
function rootsOutsideUnitCircle(c) {
  if (c.length === 0) return true;
  if (c.length === 1) {
    // root at -1/c1, so |root| > 1 iff |c1| < 1.
    return Math.abs(c[0]) < 1 - ROOT_EPS;
  }
  // a z^2 + b z + 1, with a = c2, b = c1.
  const a = c[1];
  const b = c[0];
  if (Math.abs(a) < 1e-12) {
    return Math.abs(b) < 1 - ROOT_EPS;
  }
  const disc = b * b - 4 * a;
  if (disc >= 0) {
    const r1 = (-b + Math.sqrt(disc)) / (2 * a);
    const r2 = (-b - Math.sqrt(disc)) / (2 * a);
    return Math.abs(r1) > 1 + ROOT_EPS && Math.abs(r2) > 1 + ROOT_EPS;
  }
  // Complex conjugate roots: |root| = sqrt(1 / a) (a > 0 when disc < 0 here).
  return Math.sqrt(1 / a) > 1 + ROOT_EPS;
}

function isStationary(phi) {
  return rootsOutsideUnitCircle(phi.map((value) => -value));
}

function isInvertible(theta) {
  return rootsOutsideUnitCircle(theta.slice());
}

// Hannan-Rissanen estimation of a zero-mean ARMA(p, q) on the centred series w.
// `start` fixes the first fitted index so AICc is comparable across (p, q).
function fitArma(w, p, q, m, start) {
  const n = w.length;

  // Stage 1: long AR(m) to recover innovation estimates.
  const eps = new Array(n).fill(0);
  if (m > 0) {
    const arRows = [];
    const arTarget = [];
    for (let t = m; t < n; t += 1) {
      const row = [];
      for (let i = 1; i <= m; i += 1) row.push(w[t - i]);
      arRows.push(row);
      arTarget.push(w[t]);
    }
    if (arRows.length < m + 1) return null;
    const arCoef = olsSolve(arRows, arTarget);
    if (!arCoef) return null;
    for (let t = m; t < n; t += 1) {
      let pred = 0;
      for (let i = 1; i <= m; i += 1) pred += arCoef[i - 1] * w[t - i];
      eps[t] = w[t] - pred;
    }
  }

  // Stage 2: regress w[t] on its own lags and the estimated innovation lags.
  const rows = [];
  const target = [];
  for (let t = start; t < n; t += 1) {
    const row = [];
    for (let i = 1; i <= p; i += 1) row.push(w[t - i]);
    for (let j = 1; j <= q; j += 1) row.push(eps[t - j]);
    rows.push(row);
    target.push(w[t]);
  }

  const nEff = rows.length;
  if (nEff < p + q + 2) return null;

  let phi = [];
  let theta = [];
  if (p + q > 0) {
    const coef = olsSolve(rows, target);
    if (!coef) return null;
    phi = coef.slice(0, p);
    theta = coef.slice(p, p + q);
  }

  // Reject explosive / non-invertible fits so the extrapolation stays sane.
  if (!isStationary(phi) || !isInvertible(theta)) return null;

  let sse = 0;
  for (let r = 0; r < rows.length; r += 1) {
    let pred = 0;
    for (let i = 0; i < p; i += 1) pred += phi[i] * rows[r][i];
    for (let j = 0; j < q; j += 1) pred += theta[j] * rows[r][p + j];
    sse += (target[r] - pred) ** 2;
  }

  const sigma2 = sse / nEff;
  if (!(sigma2 > 0) || !Number.isFinite(sigma2)) return null;

  return { phi, theta, sigma2, nEff };
}

function aicc(sigma2, nEff, numParams) {
  const logLik = -0.5 * nEff * (Math.log(2 * Math.PI) + Math.log(sigma2) + 1);
  const k = numParams + 1; // +1 for sigma2
  const aic = -2 * logLik + 2 * k;
  const denom = nEff - k - 1;
  if (denom <= 0) return aic + 1e6;
  return aic + (2 * k * (k + 1)) / denom;
}

function polyMul(a, b) {
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      out[i + j] += a[i] * b[j];
    }
  }
  return out;
}

// (1 - B)^d expanded via binomial coefficients.
function differencePoly(d) {
  let poly = [1];
  for (let i = 0; i < d; i += 1) {
    poly = polyMul(poly, [1, -1]);
  }
  return poly;
}

// MA(infinity) psi-weights of the full ARIMA process (AR side includes (1-B)^d).
function psiWeights(phi, theta, d, horizon) {
  const arPoly = [1, ...phi.map((value) => -value)];
  const combined = polyMul(arPoly, differencePoly(d)); // 1 - Phi1 B - ...
  const bigPhi = combined.slice(1).map((value) => -value); // [Phi1, Phi2, ...]
  const maPoly = [1, ...theta];

  const psi = new Array(horizon).fill(0);
  psi[0] = 1;
  for (let j = 1; j < horizon; j += 1) {
    let value = j < maPoly.length ? maPoly[j] : 0;
    for (let i = 1; i <= Math.min(j, bigPhi.length); i += 1) {
      value += bigPhi[i - 1] * psi[j - i];
    }
    psi[j] = value;
  }
  return psi;
}

// Integrate a forecast of the d-th difference back up to the original level.
function integrateForecast(original, d, diffForecast) {
  const levels = [original];
  for (let i = 0; i < d; i += 1) {
    levels.push(diffOnce(levels[i]));
  }

  let current = diffForecast.slice();
  for (let level = d - 1; level >= 0; level -= 1) {
    let acc = levels[level][levels[level].length - 1];
    current = current.map((step) => {
      acc += step;
      return acc;
    });
  }
  return current;
}

// Difference while it reduces variance: a trend/unit root makes the first
// difference less variable, whereas overdifferencing inflates variance again.
// Stop early once a level becomes (near-)deterministic.
function chooseDifferenceOrder(values, maxD) {
  let series = values;
  let currentVar = variance(series);
  let d = 0;
  while (d < maxD) {
    if (currentVar < 1e-9) break;
    const next = diffOnce(series);
    const nextVar = variance(next);
    if (nextVar < currentVar * 0.999) {
      series = next;
      currentVar = nextVar;
      d += 1;
    } else {
      break;
    }
  }
  return d;
}

function buildIntervals(point, sigma2, psi, horizon) {
  const lower80 = [];
  const upper80 = [];
  const lower95 = [];
  const upper95 = [];
  let psiSq = 0;
  for (let h = 0; h < horizon; h += 1) {
    psiSq += psi[h] ** 2;
    const se = Math.sqrt(sigma2 * psiSq);
    lower80.push(point[h] - Z_80 * se);
    upper80.push(point[h] + Z_80 * se);
    lower95.push(point[h] - Z_95 * se);
    upper95.push(point[h] + Z_95 * se);
  }
  return { lower80, upper80, lower95, upper95 };
}

/**
 * Forecast a univariate annual series with an auto-order ARIMA(p, d, q).
 *
 * @param {number[]} series chronologically ordered values
 * @param {number} horizon number of future steps to forecast
 * @returns {null | {
 *   point: number[], lower80: number[], upper80: number[],
 *   lower95: number[], upper95: number[], order: [number, number, number]
 * }}
 */
export function forecastArima(series, horizon = 10) {
  const clean = series.filter((value) => Number.isFinite(value));
  if (clean.length < 6 || horizon < 1) {
    return null;
  }

  const maxD = clean.length >= 10 ? 2 : 1;
  const d = chooseDifferenceOrder(clean, maxD);
  const w0 = diffN(clean, d);
  if (w0.length < 4) return null;

  // Drift (the differenced-series mean) drives the long-run trend. Keep it for
  // d <= 1; drop it at d = 2 to avoid an explosive quadratic extrapolation.
  const mu = d >= 2 ? 0 : mean(w0);
  const w = w0.map((value) => value - mu);

  // Deterministic level (e.g. a perfectly linear trend): extrapolate exactly.
  if (variance(w) < 1e-9) {
    const point = integrateForecast(clean, d, new Array(horizon).fill(mu));
    return {
      point,
      lower80: point.slice(),
      upper80: point.slice(),
      lower95: point.slice(),
      upper95: point.slice(),
      order: [0, d, 0],
    };
  }

  const n = w.length;
  const m = Math.min(Math.max(2, Math.floor(n / 2)), 6);
  const maxPQ = 2;
  const start = Math.min(m + maxPQ, n - 2);

  let best = null;
  if (m < n && start < n) {
    for (let p = 0; p <= maxPQ; p += 1) {
      for (let q = 0; q <= maxPQ; q += 1) {
        const fit = fitArma(w, p, q, m, start);
        if (!fit) continue;
        const numParams = p + q + (mu !== 0 || d === 0 ? 1 : 0);
        const score = aicc(fit.sigma2, fit.nEff, numParams);
        if (!best || score < best.score) {
          best = { p, q, score, ...fit };
        }
      }
    }
  }

  // Fallback: ARIMA(0, d, 0) with drift — a random walk with drift.
  if (!best) {
    best = { p: 0, q: 0, phi: [], theta: [], sigma2: variance(w), nEff: n };
  }

  const { phi, theta, sigma2 } = best;

  // Recompute model residuals across the centred series to seed MA terms.
  const eps = new Array(n).fill(0);
  const maxLag = Math.max(phi.length, theta.length);
  for (let t = maxLag; t < n; t += 1) {
    let pred = 0;
    for (let i = 0; i < phi.length; i += 1) pred += phi[i] * w[t - 1 - i];
    for (let j = 0; j < theta.length; j += 1) pred += theta[j] * eps[t - 1 - j];
    eps[t] = w[t] - pred;
  }

  // Recursively forecast the centred differenced series.
  const wHist = w.slice();
  const epsHist = eps.slice();
  const wForecast = [];
  for (let h = 0; h < horizon; h += 1) {
    let value = 0;
    for (let i = 0; i < phi.length; i += 1) {
      value += phi[i] * wHist[wHist.length - 1 - i];
    }
    for (let j = 0; j < theta.length; j += 1) {
      value += theta[j] * epsHist[epsHist.length - 1 - j];
    }
    wHist.push(value);
    epsHist.push(0); // future innovations have expectation 0
    wForecast.push(value + mu); // undo centring -> forecast of the d-th difference
  }

  const point = integrateForecast(clean, d, wForecast);
  if (!point.every(Number.isFinite)) {
    return null;
  }

  const psi = psiWeights(phi, theta, d, horizon);
  const intervals = buildIntervals(point, sigma2, psi, horizon);

  return {
    point,
    ...intervals,
    order: [phi.length, d, theta.length],
  };
}
