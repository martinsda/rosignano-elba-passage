/**
 * Briefing de Travessia Rosignano Solvay ↔ Portoferraio (Elba)
 * Adaptado a partir do projecto maritime-weather (Lisboa → Cascais).
 *
 * Cada dia gera um briefing onde a travessia pode iniciar nesse dia,
 * em qualquer dos dois sentidos. Inclui plano de bordos consoante o vento.
 *
 * Fontes:
 *   Vento principal      → Open-Meteo (ECMWF IFS 0.25°)
 *   Temp / Precip / WMO  → Open-Meteo (modelo agregado)
 *   Vento alternativo    → Windy API (iconEu) — opcional, cross-check
 *
 * Sem marés (Mediterrâneo — amplitude < 0.5 m).
 *
 * Saídas:
 *   output/YYYY-MM-DD_rosignano-portoferraio-briefing.md
 *   index.html
 *   Email via SMTP (nodemailer)
 */

'use strict';

const nodemailer = require('nodemailer');
const { marked } = require('marked');
const fs         = require('fs');
const path       = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const WP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'waypoints.json'), 'utf8'));

const PAGE_URL = 'https://martinsda.github.io/rosignano-elba-passage/';

const CONFIG = {
  points: {
    rosignano:    WP.rosignano_solvay,
    portoferraio: WP.portoferraio,
  },
  timezone:      'Europe/Rome',
  distance_nm:   WP.passage.distance_nm,
  bearingSouth:  WP.passage.bearing_south_deg,  // Rosignano → Portoferraio
  bearingNorth:  WP.passage.bearing_north_deg,  // Portoferraio → Rosignano
  vessel:        WP.vessel,
  windyKey: process.env.WINDY_API_KEY || '',
  smtpHost: process.env.SMTP_HOST     || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '587'),
  smtpUser: process.env.SMTP_USER     || '',
  smtpPass: process.env.SMTP_PASS     || '',
  emailTo:  process.env.EMAIL_TO      || '',
};

// ─── Helpers de vento ─────────────────────────────────────────────────────────

const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];

function spdKt(u, v)   { return Math.sqrt(u*u + v*v) * 1.94384; }
function dirDeg(u, v)  { return ((Math.atan2(u, v) * 180 / Math.PI) + 360) % 360; }
function dirLabel(deg) { return COMPASS[Math.round(deg / 22.5) % 16]; }
function beaufort(kt) {
  const limits = [1, 4, 7, 11, 17, 22, 28, 34, 41, 48, 56, 64];
  const b = limits.findIndex(l => kt < l);
  return b === -1 ? 12 : b;
}

// Ângulo agudo (0-180°) entre vento e rumo
function relWindAngle(windDir, courseDeg) {
  // wind FROM windDir; we sail TO courseDeg.
  // Wind hits us at angle = |windDir - courseDeg| reduced to [0, 180]
  let a = Math.abs(windDir - courseDeg) % 360;
  if (a > 180) a = 360 - a;
  return a;
}

// Lado em que o vento bate, dado o rumo da embarcação
function windAmura(windDir, courseDeg) {
  const rel = (windDir - courseDeg + 360) % 360;
  return rel < 180 ? 'estibordo' : 'bombordo';
}

// Formato curto pt-PT: "Sáb 16 Mai"
const WEEKDAY_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MONTH_PT   = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
function shortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `${WEEKDAY_PT[d.getDay()]} ${d.getDate()} ${MONTH_PT[d.getMonth()]}`;
}

// ─── WMO ──────────────────────────────────────────────────────────────────────

const WMO_PT = {
  0:'Céu limpo', 1:'Maioritariamente limpo', 2:'Parcialmente nublado', 3:'Encoberto',
  45:'Nevoeiro', 48:'Nevoeiro gelado',
  51:'Chuvisco fraco', 53:'Chuvisco', 55:'Chuvisco forte',
  61:'🌧 Chuva fraca', 63:'🌧 Chuva moderada', 65:'🌧 Chuva forte',
  71:'Neve fraca', 73:'Neve moderada', 75:'Neve forte',
  80:'Aguaceiros', 81:'Aguaceiros', 82:'Aguaceiros fortes',
  95:'⚡ Trovoada', 96:'⚡ Trovoada+granizo', 99:'⚡ Trovoada+granizo',
};
function wmoLabel(c)    { return WMO_PT[c] || `WMO ${c}`; }
function wmoIsDanger(c) { return [95, 96, 99].includes(c); }

// ─── Fetchers ─────────────────────────────────────────────────────────────────

async function fetchOpenMeteo(point) {
  const params = new URLSearchParams({
    latitude:        point.lat,
    longitude:       point.lon,
    hourly:          'temperature_2m,precipitation_probability,precipitation,rain,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    daily:           'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,rain_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant',
    wind_speed_unit: 'kn',
    timezone:        CONFIG.timezone,
    forecast_days:   7,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status} for ${point.label}`);
  return res.json();
}

async function fetchEcmwf(point) {
  const params = new URLSearchParams({
    latitude:        point.lat,
    longitude:       point.lon,
    hourly:          'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    daily:           'wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant',
    wind_speed_unit: 'kn',
    timezone:        CONFIG.timezone,
    models:          'ecmwf_ifs025',
    forecast_days:   7,
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo ECMWF HTTP ${res.status} for ${point.label}`);
  return res.json();
}

async function fetchWindy(point) {
  if (!CONFIG.windyKey) return null;
  const res = await fetch('https://api.windy.com/api/point-forecast/v2', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lat: point.lat, lon: point.lon,
      model: 'iconEu',
      parameters: ['wind', 'windGust', 'pressure', 'temp'],
      levels: ['surface'],
      key: CONFIG.windyKey,
    }),
  });
  if (!res.ok) { console.warn(`  ✗ Windy ${point.label} HTTP ${res.status}`); return null; }
  return res.json();
}

// ─── Tabela horária (24h hoje) ────────────────────────────────────────────────

function buildHourlyTable(point, ecmwf, om, windy) {
  const todayStr = new Date().toLocaleString('sv-SE', { timeZone: CONFIG.timezone }).slice(0, 10);
  const hasEcmwf = ecmwf?.hourly?.time?.length > 0;
  const hasEcmwfGust = hasEcmwf && ecmwf.hourly.wind_gusts_10m?.some(v => v != null);
  const hasWindy = windy?.ts?.length > 0;
  const isTestKey = windy?.warning?.includes('shuffled');

  // Open-Meteo lookup
  const omByTime = {};
  om.hourly.time.forEach((t, i) => {
    omByTime[t] = {
      temp: om.hourly.temperature_2m[i],
      pp:   om.hourly.precipitation_probability[i],
      rain: om.hourly.precipitation[i],
      gust: om.hourly.wind_gusts_10m[i],
    };
  });

  // ECMWF lookup
  const ecmByTime = {};
  if (hasEcmwf) ecmwf.hourly.time.forEach((t, i) => {
    ecmByTime[t] = {
      spd:  ecmwf.hourly.wind_speed_10m[i],
      dir:  ecmwf.hourly.wind_direction_10m[i],
      gust: ecmwf.hourly.wind_gusts_10m?.[i] ?? null,
    };
  });

  // Windy ICON-EU lookup
  const iconByTime = {};
  if (hasWindy) windy.ts.forEach((ts, i) => {
    const localStr = new Date(ts).toLocaleString('sv-SE', { timeZone: CONFIG.timezone })
                                 .replace(' ', 'T').slice(0, 16);
    iconByTime[localStr] = {
      spd:  spdKt(windy['wind_u-surface'][i], windy['wind_v-surface'][i]),
      dir:  dirDeg(windy['wind_u-surface'][i], windy['wind_v-surface'][i]),
      gust: windy['gust-surface'][i] * 1.94384,
    };
  });

  const rows = [];
  const baseTimes = hasEcmwf ? ecmwf.hourly.time : om.hourly.time;
  baseTimes.forEach(t => {
    if (!t.startsWith(todayStr)) return;
    const om3  = omByTime[t]  || {};
    const ecm  = ecmByTime[t] || null;
    const icon = iconByTime[t] || null;
    const spd  = ecm?.spd ?? om.hourly.wind_speed_10m[om.hourly.time.indexOf(t)];
    const dir  = ecm?.dir ?? om.hourly.wind_direction_10m[om.hourly.time.indexOf(t)];
    const gust = ecm?.gust ?? icon?.gust ?? om3.gust ?? null;
    rows.push({
      time:    t.slice(11, 16),
      temp:    om3.temp,
      pp:      om3.pp,
      rain:    om3.rain,
      spd, dir, gust,
      bf:      beaufort(spd),
      dl:      dirLabel(dir),
      iconSpd: icon?.spd ?? null,
      iconDir: icon?.dir ?? null,
    });
  });

  if (!rows.length) return `### ${point.label} — sem dados horários\n`;

  const fv = (v, suf, dp=1) => v != null ? v.toFixed(dp) + suf : '—';
  const peakIdx = rows.reduce((b, r, i) => r.spd > rows[b].spd ? i : b, 0);
  const primaryLabel = hasEcmwf ? 'ECMWF IFS' : 'Open-Meteo';
  const gustLabel = hasEcmwf && !hasEcmwfGust && hasWindy ? ' †' : '';
  const sourceNote = hasEcmwf
    ? (hasWindy
        ? (isTestKey
            ? 'Vento: **ECMWF IFS** via Open-Meteo · ICON-EU: Windy (3h, ⚠ test key)'
            : 'Vento: **ECMWF IFS** via Open-Meteo (horário ✓) · ICON-EU cross-check: Windy (3h)')
        : 'Vento: **ECMWF IFS** via Open-Meteo (horário ✓)')
    : 'Vento: **Open-Meteo** (ECMWF não disponível)';

  const header = [
    `### ${point.label} (${point.lat}°N, ${point.lon}°E)`,
    ``,
    `> ${sourceNote} · Temp/Precip/Chuva: **Open-Meteo**`,
    ``,
    `| Hora  | Temp    | ${primaryLabel} Dir   | Vento (kt) | Rajada (kt)${gustLabel} | BFT  | Prec % | Chuva (mm) |`,
    `|-------|---------|-----------------------|------------|---------------------|------|--------|------------|`,
  ];

  const tableRows = rows.map((r, i) => {
    const p = i === peakIdx;
    const b = s => p ? `**${s}**` : s;
    const dirCell = String(Math.round(r.dir)).padStart(3) + '° ' + r.dl.padEnd(4);
    return `| ${b(r.time)}  | ${b(fv(r.temp, '°C'))}  | ${b(dirCell)} | ${b(fv(r.spd, 'kt'))} | ${b(fv(r.gust, 'kt'))} | ${b('F'+r.bf)} | ${b(r.pp != null ? r.pp + '%' : '—')} | ${b(fv(r.rain, 'mm'))} |`;
  });

  const peak = rows[peakIdx];
  const temps = rows.map(r => r.temp).filter(t => t != null);
  const minT = temps.length ? Math.min(...temps).toFixed(1) : '—';
  const maxT = temps.length ? Math.max(...temps).toFixed(1) : '—';
  const totR = rows.reduce((s, r) => s + (r.rain ?? 0), 0).toFixed(1);
  const dirEvo = [...new Set(rows.map(r => r.dl))].join(' → ');

  const summary = [
    ``,
    `**Resumo**: Pico ${fv(peak.spd, 'kt')} de ${Math.round(peak.dir)}° ${peak.dl} às ${peak.time}, rajadas ${fv(peak.gust, 'kt')} (F${peak.bf}). ` +
    `Rotação: ${dirEvo}. ` +
    (parseFloat(totR) > 0 ? `Total chuva: ${totR}mm. ` : `Sem precipitação. `) +
    `Temperatura: **${minT}°C** → **${maxT}°C**.`,
  ];

  return [...header, ...tableRows, ...summary].join('\n');
}

// ─── Multi-day (7 dias) ──────────────────────────────────────────────────────

function buildMultiDayTable(point, om) {
  const d = om.daily;
  const lines = [
    `### ${point.label} — 7 dias (Open-Meteo)`,
    ``,
    `| Data          | Condição              | Max°C | Min°C | Chuva % | Precip mm | Vento Max (kt) | Rajada Max (kt) | Dir dominante |`,
    `|---------------|-----------------------|-------|-------|---------|-----------|----------------|-----------------|---------------|`,
  ];
  const flags = [];

  d.time.forEach((date, i) => {
    const label     = shortDate(date);
    const wmo       = d.weather_code[i];
    const condition = wmoLabel(wmo);
    const pp        = d.precipitation_probability_max[i];
    const bold      = pp >= 50 || wmoIsDanger(wmo);
    const b         = s => bold ? `**${s}**` : s;
    const dl        = dirLabel(d.wind_direction_10m_dominant[i]);

    lines.push(
      `| ${b(label.padEnd(13))} | ${b(condition.padEnd(21))} | ${b(d.temperature_2m_max[i].toFixed(1))} | ${b(d.temperature_2m_min[i].toFixed(1))} | ${b(pp + '%')} | ${b(d.precipitation_sum[i].toFixed(1))} | ${b(d.wind_speed_10m_max[i].toFixed(1))} | ${b(d.wind_gusts_10m_max[i].toFixed(1))} | ${b(Math.round(d.wind_direction_10m_dominant[i]) + '° ' + dl)} |`
    );
    if (wmoIsDanger(wmo)) flags.push(`⚡ **${label} — NÃO NAVEGAR**: Trovoada (WMO ${wmo}), ${pp}% probabilidade.`);
  });

  if (flags.length) lines.push('', ...flags);
  return lines.join('\n');
}

// ─── Passage Planner ──────────────────────────────────────────────────────────

/**
 * Heurística de planeamento baseada na polar média de um cruzador 30':
 *   - TWA 0–35°  → impossível, tem que bordejar a TWA 45° (VMG 0.7×polar)
 *   - TWA 36–60° → bolina cerrada (1 bordo possível se favorável, ou 2)
 *   - TWA 61–120° → través (rumo directo, melhor andamento)
 *   - TWA 121–150° → largo (rumo directo)
 *   - TWA 151–180° → popa, considerar gybes ou borboleta
 * Limites de tripulação mista:
 *   - Vento >27 kt (F6+) → no-go absoluto
 *   - Bolina cerrada sustentada em vento >22 kt (F5+) → no-go
 *   - Trovoada (WMO 95/96/99) → no-go absoluto
 */
function passagePlanner({ wind_kt, wind_dir, gust_kt, wmo, course_deg, distance_nm }) {
  const tva = relWindAngle(wind_dir, course_deg);
  const goLimit       = CONFIG.vessel.max_wind_go_kt;
  const marginalLimit = CONFIG.vessel.max_wind_marginal_kt;

  let mode, eta_h, legs, decision, reason;

  if (wmoIsDanger(wmo)) {
    return {
      mode: 'n/a', tva,
      decision: 'NO-GO',
      reason: `Trovoada prevista (WMO ${wmo}) — não navegar.`,
      eta_h: null, legs: [],
    };
  }
  if (wind_kt > marginalLimit) {
    return {
      mode: 'n/a', tva,
      decision: 'NO-GO',
      reason: `Vento médio ${wind_kt.toFixed(1)} kt (F${beaufort(wind_kt)}) excede limite de ${marginalLimit} kt para tripulação mista.`,
      eta_h: null, legs: [],
    };
  }

  if (tva <= 35) {
    // Bolina forçada com bordos
    mode = 'bolina-cerrada';
    const through_water = distance_nm / Math.cos(45 * Math.PI / 180); // ≈ 1.414 × distância
    eta_h = through_water / CONFIG.vessel.cruise_kt;
    // 2 bordos simétricos por defeito
    const legDist = through_water / 2;
    const portTack    = ((course_deg - 45) + 360) % 360;
    const stbdTack    = ((course_deg + 45) + 360) % 360;
    legs = [
      { ord: 1, amura: 'estibordo', rumo: portTack, distancia_nm: +legDist.toFixed(1), tempo_h: +(legDist/CONFIG.vessel.cruise_kt).toFixed(1) },
      { ord: 2, amura: 'bombordo',  rumo: stbdTack, distancia_nm: +legDist.toFixed(1), tempo_h: +(legDist/CONFIG.vessel.cruise_kt).toFixed(1) },
    ];
    if (wind_kt > goLimit) {
      decision = 'NO-GO';
      reason = `Bolina cerrada sustentada em ${wind_kt.toFixed(1)} kt (F${beaufort(wind_kt)}) — fora de envelope para tripulação mista.`;
    } else {
      decision = 'GO (com bordos)';
      reason = `Vento de proa (TVA ${tva.toFixed(0)}°). Esperar ${legs.length} bordos a TWA 45°, total ${through_water.toFixed(1)} NM no rumo de bolina.`;
    }
  } else if (tva <= 60) {
    mode = 'bolina';
    eta_h = distance_nm / 4.5; // ligeiramente abaixo de cruzeiro
    legs = [{ ord: 1, amura: windAmura(wind_dir, course_deg), rumo: course_deg, distancia_nm: distance_nm, tempo_h: +eta_h.toFixed(1) }];
    decision = wind_kt > goLimit ? 'MARGINAL' : 'GO';
    reason = `Bolina aberta (TVA ${tva.toFixed(0)}°). Rumo directo possível, 1 bordo a ${Math.round(course_deg)}°.`;
  } else if (tva <= 120) {
    mode = 'través';
    eta_h = distance_nm / CONFIG.vessel.cruise_kt;
    legs = [{ ord: 1, amura: windAmura(wind_dir, course_deg), rumo: course_deg, distancia_nm: distance_nm, tempo_h: +eta_h.toFixed(1) }];
    decision = 'GO';
    reason = `Través (TVA ${tva.toFixed(0)}°) — andamento ideal, rumo directo ${Math.round(course_deg)}°.`;
  } else if (tva <= 150) {
    mode = 'largo';
    eta_h = distance_nm / CONFIG.vessel.cruise_kt;
    legs = [{ ord: 1, amura: windAmura(wind_dir, course_deg), rumo: course_deg, distancia_nm: distance_nm, tempo_h: +eta_h.toFixed(1) }];
    decision = 'GO';
    reason = `Largo (TVA ${tva.toFixed(0)}°) — rumo directo ${Math.round(course_deg)}°.`;
  } else {
    mode = 'popa';
    eta_h = distance_nm / 4.5;
    const gybe1 = ((course_deg - 20) + 360) % 360;
    const gybe2 = ((course_deg + 20) + 360) % 360;
    legs = [
      { ord: 1, amura: windAmura(wind_dir, gybe1), rumo: gybe1, distancia_nm: +(distance_nm/2).toFixed(1), tempo_h: +(distance_nm/2/4.5).toFixed(1) },
      { ord: 2, amura: windAmura(wind_dir, gybe2), rumo: gybe2, distancia_nm: +(distance_nm/2).toFixed(1), tempo_h: +(distance_nm/2/4.5).toFixed(1) },
    ];
    decision = wind_kt > goLimit ? 'MARGINAL (popa em F5+)' : 'GO';
    reason = `Popa (TVA ${tva.toFixed(0)}°) — gybes ou borboleta com vento sustentado, evitar broaching.`;
  }

  // Critério adicional: rajadas elevadas degradam um GO mesmo com média baixa
  if (decision === 'GO' && gust_kt != null) {
    if (gust_kt > 30) {
      decision = 'MARGINAL';
      reason += ` ⚠ Rajadas previstas ${gust_kt.toFixed(0)} kt (>F6 em rajada).`;
    } else if (gust_kt > 25) {
      decision = 'GO ⚠ rajadas';
      reason += ` Atenção a rajadas ${gust_kt.toFixed(0)} kt.`;
    }
  }

  return { mode, tva: +tva.toFixed(0), eta_h: eta_h ? +eta_h.toFixed(1) : null, legs, decision, reason };
}

// Vento médio diurno (06–20 local) a partir do daily Open-Meteo + amostragem horária
function dayWindStats(om, dayIdx) {
  const dayStr = om.daily.time[dayIdx];
  // Amostra horária dentro do dia, 06–20 local
  const speeds = [], dirs = [], gusts = [];
  om.hourly.time.forEach((t, i) => {
    if (!t.startsWith(dayStr)) return;
    const h = parseInt(t.slice(11, 13));
    if (h < 6 || h > 20) return;
    speeds.push(om.hourly.wind_speed_10m[i]);
    dirs.push(om.hourly.wind_direction_10m[i]);
    gusts.push(om.hourly.wind_gusts_10m[i]);
  });
  if (!speeds.length) {
    return {
      wind_kt:  om.daily.wind_speed_10m_max[dayIdx],
      gust_kt:  om.daily.wind_gusts_10m_max[dayIdx],
      wind_dir: om.daily.wind_direction_10m_dominant[dayIdx],
      wmo:      om.daily.weather_code[dayIdx],
    };
  }
  const avgSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const maxGust  = Math.max(...gusts.filter(g => g != null));
  // direcção média via vector sum
  let sx = 0, sy = 0;
  dirs.forEach((d, i) => {
    const rad = d * Math.PI / 180;
    sx += Math.sin(rad) * speeds[i];
    sy += Math.cos(rad) * speeds[i];
  });
  const avgDir = ((Math.atan2(sx, sy) * 180 / Math.PI) + 360) % 360;
  return {
    wind_kt:  avgSpeed,
    gust_kt:  maxGust,
    wind_dir: avgDir,
    wmo:      om.daily.weather_code[dayIdx],
  };
}

// ─── Plano de travessia para HOJE (ambos os sentidos) ─────────────────────────

function buildPassageSection(omRos, omPor) {
  const today = new Date().toLocaleString('sv-SE', { timeZone: CONFIG.timezone }).slice(0, 10);
  const todayIdxRos = omRos.daily.time.indexOf(today);
  const todayIdxPor = omPor.daily.time.indexOf(today);
  if (todayIdxRos < 0 || todayIdxPor < 0) return '## PLANO DE TRAVESSIA — HOJE\n\n> Dados diários indisponíveis para hoje.';

  const statsRos = dayWindStats(omRos, todayIdxRos);
  const statsPor = dayWindStats(omPor, todayIdxPor);

  // Sul-bound: parte de Rosignano, usa vento médio Rosignano (mais próximo da janela de partida)
  const south = passagePlanner({ ...statsRos, course_deg: CONFIG.bearingSouth, distance_nm: CONFIG.distance_nm });
  // Norte-bound: parte de Portoferraio
  const north = passagePlanner({ ...statsPor, course_deg: CONFIG.bearingNorth, distance_nm: CONFIG.distance_nm });

  function renderPlan(title, course, stats, plan) {
    const lines = [
      `### ${title} (rumo ${course}°)`,
      ``,
      `- **Vento médio diurno (06–20h)**: ${stats.wind_kt.toFixed(1)} kt de ${Math.round(stats.wind_dir)}° ${dirLabel(stats.wind_dir)}, rajadas até ${stats.gust_kt.toFixed(1)} kt (F${beaufort(stats.wind_kt)})`,
      `- **Ângulo do vento ao rumo**: ${plan.tva}° → ${plan.mode}`,
      `- **Decisão**: **${plan.decision}** — ${plan.reason}`,
    ];
    if (plan.eta_h) lines.push(`- **ETA total**: ${plan.eta_h} h @ cruzeiro ${CONFIG.vessel.cruise_kt} kt`);
    if (plan.legs.length) {
      lines.push(``, `**Plano de bordos**:`, ``,
        `| Ord | Amura | Rumo | Distância | Tempo |`,
        `|-----|-------|------|-----------|-------|`,
      );
      plan.legs.forEach(l => {
        lines.push(`| ${l.ord} | ${l.amura} | ${Math.round(l.rumo)}° ${dirLabel(l.rumo)} | ${l.distancia_nm} NM | ${l.tempo_h} h |`);
      });
    }
    return lines.join('\n');
  }

  return [
    `## PLANO DE TRAVESSIA — HOJE`,
    ``,
    renderPlan('Rosignano Solvay → Portoferraio', CONFIG.bearingSouth, statsRos, south),
    ``,
    renderPlan('Portoferraio → Rosignano Solvay', CONFIG.bearingNorth, statsPor, north),
  ].join('\n');
}

// ─── Janela semanal — go/no-go por dia e por sentido ──────────────────────────

function buildWeeklyWindow(omRos, omPor) {
  const lines = [
    `## JANELA SEMANAL — GO / NO-GO`,
    ``,
    `Vento médio diurno (06–20h local) e rajada máxima (G…) projectados no rumo da travessia. Embarcação 30', tripulação mista.`,
    ``,
    `> Legenda: ✓ GO · ⚠ GO com rajadas (>25 kt) · ⚠ MARGINAL · ✗ NO-GO`,
    ``,
    `| Data    | Sul (Ros→Por) Vento  | Modo            | Decisão            | Norte (Por→Ros) Vento | Modo            | Decisão            |`,
    `|---------|----------------------|-----------------|--------------------|------------------------|-----------------|--------------------|`,
  ];

  const goDaysSouth = [], goDaysNorth = [];

  omRos.daily.time.forEach((date, i) => {
    const label = shortDate(date);
    const sRos = dayWindStats(omRos, i);
    const sPor = dayWindStats(omPor, omPor.daily.time.indexOf(date));
    const south = passagePlanner({ ...sRos, course_deg: CONFIG.bearingSouth, distance_nm: CONFIG.distance_nm });
    const north = passagePlanner({ ...sPor, course_deg: CONFIG.bearingNorth, distance_nm: CONFIG.distance_nm });
    if (south.decision.startsWith('GO') && !south.decision.includes('⚠')) goDaysSouth.push(label);
    if (north.decision.startsWith('GO') && !north.decision.includes('⚠')) goDaysNorth.push(label);
    const windSouthCell = `${sRos.wind_kt.toFixed(0)}kt G${sRos.gust_kt.toFixed(0)} ${dirLabel(sRos.wind_dir)}`;
    const windNorthCell = `${sPor.wind_kt.toFixed(0)}kt G${sPor.gust_kt.toFixed(0)} ${dirLabel(sPor.wind_dir)}`;
    lines.push(
      `| ${label} | ${windSouthCell} | ${south.mode} | ${decisionEmoji(south.decision)} ${south.decision} | ${windNorthCell} | ${north.mode} | ${decisionEmoji(north.decision)} ${north.decision} |`
    );
  });

  lines.push(``,
    `**Sentido Sul (Rosignano → Portoferraio)**: ${goDaysSouth.length ? `melhores dias — ${goDaysSouth.join(', ')}` : 'sem dia GO claro na janela de 7 dias.'}`,
    `**Sentido Norte (Portoferraio → Rosignano)**: ${goDaysNorth.length ? `melhores dias — ${goDaysNorth.join(', ')}` : 'sem dia GO claro na janela de 7 dias.'}`,
    ``,
    `> Confiança alta D+0 a D+2, indicativa para além de 72 h. Verificar boletim oficial (Aeronautica Militare, ARPAT Toscana) na véspera da partida.`,
  );

  return lines.join('\n');
}

function decisionEmoji(d) {
  if (d.startsWith('GO') && d.includes('⚠')) return '⚠';
  if (d.startsWith('GO'))                    return '✓';
  if (d.startsWith('MARGINAL'))              return '⚠';
  return '✗';
}

// ─── HTML page ────────────────────────────────────────────────────────────────

function buildPageHtml(date, sections, reportFilename) {
  const renderedSections = sections
    .map(s => `<section id="${s.id}">${marked.parse(s.content)}</section>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="pt">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Briefing Travessia Rosignano ↔ Portoferraio — ${date}</title>
  <style>
    :root { --sea:#0a3d62; --sky:#1e90ff; --foam:#f0f8ff; --warn:#e67e22; --rain:#2980b9; --storm:#c0392b; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; background: var(--foam); color: #1a1a2e; line-height: 1.5; }
    header { background: var(--sea); color: white; padding: 1.5rem 2rem; display: flex; justify-content: space-between; align-items: flex-end; flex-wrap: wrap; gap: 0.5rem; }
    header h1 { font-size: 1.3rem; font-weight: 700; letter-spacing: 0.04em; }
    header p { font-size: 0.82rem; opacity: 0.75; margin-top: 0.2rem; }
    .badge { font-size: 0.72rem; background: var(--sky); padding: 0.25rem 0.75rem; border-radius: 20px; white-space: nowrap; }
    main { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1rem; display: grid; gap: 1rem; }
    section { background: white; border-radius: 10px; padding: 1.5rem 1.75rem; box-shadow: 0 1px 6px rgba(0,0,0,0.07); overflow-x: auto; }
    h2 { color: var(--sea); font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.1em; padding-bottom: 0.6rem; margin-bottom: 1rem; border-bottom: 2px solid var(--sky); }
    h3 { color: var(--sea); font-size: 0.95rem; margin-top: 1rem; margin-bottom: 0.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; margin-top: 0.5rem; }
    th { background: #f0f8ff; color: var(--sea); font-weight: 600; text-align: left; padding: 0.5rem 0.75rem; border-bottom: 2px solid #d0e8f8; white-space: nowrap; }
    td { padding: 0.4rem 0.75rem; border-bottom: 1px solid #eef2f7; white-space: nowrap; }
    tr:hover td { background: #f7fbff; }
    tr strong td, td strong { color: var(--sea); font-weight: 700; }
    blockquote { background: #fff9e6; border-left: 3px solid #f9a825; padding: 0.6rem 1rem; border-radius: 0 6px 6px 0; font-size: 0.83rem; margin: 0.5rem 0 1rem; color: #5d4037; }
    ul { margin-left: 1.25rem; font-size: 0.87rem; }
    li { margin: 0.2rem 0; }
    p { font-size: 0.87rem; margin-top: 0.75rem; color: #444; }
    p strong { color: var(--sea); }
    footer { text-align: center; font-size: 0.75rem; color: #888; padding: 1.5rem; }
    @media (max-width: 640px) { header { padding: 1rem; } section { padding: 1rem; } }
  </style>
</head>
<body>

<header>
  <div>
    <h1>⚓ Briefing de Travessia — Rosignano Solvay ↔ Portoferraio</h1>
    <p>Mar Tirreno · ${date} · Veleiro 30' · ${CONFIG.distance_nm} NM</p>
  </div>
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
    <a href="${PAGE_URL}" style="font-size:0.72rem;background:rgba(255,255,255,0.15);color:white;padding:0.25rem 0.75rem;border-radius:20px;text-decoration:none;white-space:nowrap;">Ver online →</a>
    <span class="badge">Gerado ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC</span>
  </div>
</header>

<main>
  ${renderedSections}
</main>

<footer>
  Dados: <strong>Open-Meteo</strong> (ECMWF IFS + agregado) · Windy iconEu opcional ·
  <a href="output/${reportFilename}">Relatório completo (markdown)</a>
</footer>

</body>
</html>`;
}

// ─── Email ────────────────────────────────────────────────────────────────────

async function sendEmail(date, html) {
  const transporter = nodemailer.createTransport({
    host:   CONFIG.smtpHost,
    port:   CONFIG.smtpPort,
    secure: CONFIG.smtpPort === 465,
    auth:   { user: CONFIG.smtpUser, pass: CONFIG.smtpPass },
  });
  await transporter.verify();
  const info = await transporter.sendMail({
    from:    `"Briefing Travessia ⚓" <${CONFIG.smtpUser}>`,
    to:      CONFIG.emailTo,
    subject: `⚓ Briefing Rosignano ↔ Portoferraio — ${date}`,
    html,
  });
  console.log(`  ✓ Email enviado: ${info.messageId}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toLocaleString('sv-SE', { timeZone: CONFIG.timezone }).slice(0, 10);
  console.log(`\n⚓ A gerar briefing de travessia para ${today}...\n`);

  const [omRos, omPor, ecmRos, ecmPor, wRos, wPor] = await Promise.all([
    fetchOpenMeteo(CONFIG.points.rosignano),
    fetchOpenMeteo(CONFIG.points.portoferraio),
    fetchEcmwf(CONFIG.points.rosignano).catch(e => { console.warn('  ✗ ECMWF Rosignano:', e.message); return null; }),
    fetchEcmwf(CONFIG.points.portoferraio).catch(e => { console.warn('  ✗ ECMWF Portoferraio:', e.message); return null; }),
    fetchWindy(CONFIG.points.rosignano).catch(() => null),
    fetchWindy(CONFIG.points.portoferraio).catch(() => null),
  ]);

  console.log(`  ✓ Open-Meteo Rosignano   — ${omRos.hourly.time.length} steps`);
  console.log(`  ✓ Open-Meteo Portoferraio — ${omPor.hourly.time.length} steps`);
  if (ecmRos) console.log(`  ✓ ECMWF IFS Rosignano   — ${ecmRos.hourly.time.length} steps`);
  if (ecmPor) console.log(`  ✓ ECMWF IFS Portoferraio — ${ecmPor.hourly.time.length} steps`);

  const hourlyRos = buildHourlyTable(CONFIG.points.rosignano,    ecmRos, omRos, wRos);
  const hourlyPor = buildHourlyTable(CONFIG.points.portoferraio, ecmPor, omPor, wPor);
  const multiRos  = buildMultiDayTable(CONFIG.points.rosignano,    omRos);
  const multiPor  = buildMultiDayTable(CONFIG.points.portoferraio, omPor);
  const passageMd = buildPassageSection(omRos, omPor);
  const weeklyMd  = buildWeeklyWindow(omRos, omPor);

  const dateLabel = new Date().toLocaleDateString('pt-PT', { day: 'numeric', month: 'long', year: 'numeric' });
  const filename  = `${today}_rosignano-portoferraio-briefing.md`;

  const todaySection = `## METEO DE HOJE\n\n${hourlyRos}\n\n${hourlyPor}`;
  const multiSection = `## PREVISÃO 7 DIAS\n\n${multiRos}\n\n${multiPor}`;

  const fullReport = [
    `# BRIEFING DE TRAVESSIA — ROSIGNANO SOLVAY ↔ PORTOFERRAIO`,
    `**Data**: ${dateLabel} · **Embarcação**: ${CONFIG.vessel.type} · **Distância directa**: ${CONFIG.distance_nm} NM`,
    `**Pontos**: Rosignano Solvay (${CONFIG.points.rosignano.lat}°N, ${CONFIG.points.rosignano.lon}°E) ↔ Portoferraio (${CONFIG.points.portoferraio.lat}°N, ${CONFIG.points.portoferraio.lon}°E)`,
    `**Rumos directos**: ${CONFIG.bearingSouth}° (S) · ${CONFIG.bearingNorth}° (N)`,
    `**Web**: [martinsda.github.io/rosignano-elba-passage](${PAGE_URL})`,
    ``,
    `---`,
    ``,
    todaySection,
    ``,
    `---`,
    ``,
    passageMd,
    ``,
    `---`,
    ``,
    multiSection,
    ``,
    `---`,
    ``,
    weeklyMd,
    ``,
    `---`,
    ``,
    `## DOCUMENTOS DE REFERÊNCIA`,
    ``,
    `- [Ventos do Mediterrâneo e Elba](docs/01-ventos-mediterraneo-elba.md)`,
    `- [Elba — História, Fundeadouros e Turismo](docs/02-elba-historia-fundeadouros-turismo.md)`,
    `- [Travessia — Costa e Pontos Relevantes](docs/03-travessia-rosignano-portoferraio.md)`,
    ``,
    `## FONTES`,
    ``,
    `| Fonte | Tipo | Endpoint |`,
    `|-------|------|----------|`,
    `| Open-Meteo (ECMWF IFS 0.25°) | Vento principal | \`api.open-meteo.com/v1/forecast?models=ecmwf_ifs025\` |`,
    `| Open-Meteo (agregado) | Temp, chuva, WMO, multi-day | \`api.open-meteo.com/v1/forecast\` |`,
    `| Windy API (iconEu) | Cross-check, opcional | \`api.windy.com/api/point-forecast/v2\` |`,
    ``,
    `*Gerado: ${new Date().toISOString()} UTC*`,
    ``,
    `> ⚠ Instrumento de planeamento. **Não substitui** o boletim oficial. Verificar Aeronautica Militare (meteoam.it), ARPAT Toscana e VHF 16/68 antes de zarpar.`,
  ].join('\n');

  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, filename), fullReport, 'utf8');
  console.log(`\n  ✓ Markdown → output/${filename}`);

  const pageHtml = buildPageHtml(today, [
    { id: 'today',    content: todaySection },
    { id: 'passage',  content: passageMd },
    { id: 'multi',    content: multiSection },
    { id: 'weekly',   content: weeklyMd },
  ], filename);
  fs.writeFileSync(path.join(__dirname, '..', 'index.html'), pageHtml, 'utf8');
  console.log(`  ✓ HTML     → index.html`);

  if (CONFIG.smtpHost && CONFIG.smtpUser && CONFIG.smtpPass && CONFIG.emailTo) {
    await sendEmail(today, pageHtml);
  } else {
    console.log(`  ✗ Email saltado — SMTP não configurado`);
  }

  console.log(`\n⚓ Concluído.\n`);
}

main().catch(err => {
  console.error('\n✗ Erro fatal:', err.message);
  console.error(err.stack);
  process.exit(1);
});
