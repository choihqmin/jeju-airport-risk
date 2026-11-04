// 매일 실행(17:45): 실시간 예측 기록 → 웹 화면용 JSON(data/latest.json, data/history.json) → (선택) GitHub 저장소에 올림
// 키·원자료는 올리지 않는다. 화면에 필요한 요약 값만 쓴다.
// 사용: node tools\publish_site.mjs [--push]    (사이트 폴더 안에서. 분석 폴더는 ROOT 환경변수 또는 기본값 D:\빅데이터경진대회)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const ROOT = process.env.ROOT || 'D:\\빅데이터경진대회';
const SITE = process.env.SITE || process.cwd();
const J = p => path.join(ROOT, ...p.split('/'));
const csv = f => { if (!existsSync(f)) return []; const t = readFileSync(f, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/).filter(Boolean); const h = t[0].split(',');
  return t.slice(1).map(l => { const c = l.split(','); return Object.fromEntries(h.map((k, i) => [k, c[i] ?? ''])); }); };
const ref = JSON.parse(readFileSync(path.join(SITE, 'data', 'reference.json'), 'utf8'));
const rp = ref.combo_ref_p, ra = ref.combo_ref_amo;
const pct = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] <= v) lo = m + 1; else hi = m; } return lo / arr.length; };
// 예보관 발표문 기호 (발표일 → 기호)
const tok = {};
if (existsSync(J('raw_amo/amo_tokens.txt'))) for (const line of readFileSync(J('raw_amo/amo_tokens.txt'), 'utf8').split(/\r?\n/)) {
  if (!line.includes(':')) continue; const [ym, ts] = line.split(':'); const y = 2000 + +ym.slice(0, 2), m = +ym.slice(2);
  ts.split(',').forEach((t, i) => { tok[`${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`] = t; });
}
const liveText = existsSync(J('raw_amo/amo_live_text.json')) ? JSON.parse(readFileSync(J('raw_amo/amo_live_text.json'), 'utf8')) : {};
const amoScore = (t, month) => { if (!t || t === 'X') return null; const m = t.match(/^([A-Z]*)(\d+)?(?:g(\d+))?(?:!(.+))?$/); if (!m) return t === '.' ? 0 : null;
  const code = m[1] || '', kt = m[2] ? +m[2] : 0; return kt + 10 * (code.includes('N') && [11, 12, 1, 2, 3].includes(month) ? 1 : 0) + 5 * (/[WS]/.test(code) ? 1 : 0); };
const dayBefore = d => new Date(Date.parse(d + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
function tierOf(p, issue) {
  const t = tok[issue]; const a = amoScore(t, +issue.slice(5, 7));
  if (a != null && p != null) { const c = (pct(rp, p) + pct(ra, a)) / 2; return { basis: 'combo', combo: c, tier: c >= ref.alert_threshold_combo ? 3 : c >= ref.tier2_combo ? 2 : 1, amo_score: a, token: t }; }
  if (p == null) return { basis: 'none', tier: null };
  return { basis: 'model', combo: null, tier: p >= ref.alert_threshold_model_p ? 3 : p >= ref.tier2_model_p ? 2 : 1, amo_score: null, token: t ?? null };
}
// 실제 결과(사전 등록 4-1): 대상일 다음 날 이후 처음 수집한 스냅숏
const kac = csv(J('data/kac_cju_dep_daily.csv')); const ppfRows = csv(J('data/pax_per_flight_monthly.csv'));
const ppfOf = d => { const m = d.slice(0, 7); const r = ppfRows.find(x => x.month === m) || ppfRows[ppfRows.length - 1]; return r ? +r.ppf : null; };
function actualOf(d) {
  const ymd = d.replace(/-/g, ''); const s = kac.filter(r => r.searchday === ymd && r.fetched_kst.slice(0, 8) > ymd).sort((a, b) => a.fetched_kst.localeCompare(b.fetched_kst))[0];
  if (!s) return null; const ppf = ppfOf(d), nc = +s.n_cancel, npc = +(s.n_precancel || 0);
  return { cancel: nc, precancel: npc, flights: +s.n_operating_flights, stranded: Math.round(nc * ppf), stranded_incl_precancel: Math.round((nc + npc) * ppf), crisis: nc * ppf >= 3000 ? 1 : 0, snapshot: s.fetched_kst };
}
const preds = csv(J('data/live_predictions.csv')).filter(r => r.recorded_before_target === '1');
const byTarget = {}; for (const r of preds) if (!byTarget[r.target] || byTarget[r.target].run_kst > r.run_kst) byTarget[r.target] = r;   // 대상일마다 첫 공식 기록
const history = Object.values(byTarget).sort((a, b) => a.target.localeCompare(b.target)).map(r => {
  const p = r.p_caution === '' ? null : +r.p_caution; const t = tierOf(p, dayBefore(r.target));
  return { target: r.target, issued_kst: r.run_kst, model_p: p, ...t, actual: actualOf(r.target) };
});
const last = history[history.length - 1];
let latest = null;
if (last) {
  const fj = J(`raw/live/${last.target.replace(/-/g, '')}/features.json`); const f = existsSync(fj) ? JSON.parse(readFileSync(fj, 'utf8')) : { feat: {}, pre: {} };
  const ft = f.feat || {}; const dir = ft.fc_dir_wmax_sin != null ? (Math.atan2(ft.fc_dir_wmax_sin, ft.fc_dir_wmax_cos) * 180 / Math.PI + 360) % 360 : null;
  const issue = dayBefore(last.target);
  latest = { ...last, model_sha: ref.model_sha,
    bulletin: last.token ? { issue_date: issue, token: last.token, head: liveText[issue]?.head ?? null, risk: liveText[issue]?.risk ?? null } : null,
    forecast: { wsd_max_kt: ft.fc_wsd_max_kt ?? null, xwind_max_kt: ft.fc_xwind_max_kt ?? null, dir_at_max_deg: dir, hrs_xwind_ge20kt: ft.fc_hrs_xwind_ge20kt ?? null,
                hrs_xwind_ge14kt: ft.fc_hrs_xwind_ge14kt ?? null, hrs_snow: ft.fc_hrs_snow ?? null, hrs_rain: ft.fc_hrs_rain ?? null, issue: ft.fc_issue_wind ?? null },
    observed_d1: { wind_max_kt: ft.d1_obs_wind_max_kt ?? null, xwind_max_kt: ft.d1_obs_xwind_max_kt ?? null, gust_max_kt: ft.d1_obs_gust_max_kt ?? null, vis_min_m: ft.d1_obs_vis_min_m ?? null, hrs_snow: ft.d1_obs_hrs_snow ?? null },
    warnings: f.pre || {}, flights: { plan: ft.plan_dep_lag7 ?? null, plan_source: ft.plan_source ?? null, d2_cancel: ft.d2_cancel_dep ?? null } };
}
mkdirSync(path.join(SITE, 'data'), { recursive: true });
writeFileSync(path.join(SITE, 'data', 'latest.json'), JSON.stringify(latest, null, 1));
writeFileSync(path.join(SITE, 'data', 'history.json'), JSON.stringify(history, null, 1));
console.log(`latest ${latest?.target} 단계 ${latest?.tier} (${latest?.basis}) | 기록 ${history.length}일`);
if (process.argv.includes('--push')) {
  const g = (...a) => execFileSync('git', a, { cwd: SITE, stdio: 'pipe' }).toString();
  g('add', 'data/latest.json', 'data/history.json');
  if (!g('status', '--porcelain', 'data').trim()) { console.log('바뀐 내용 없음 (올릴 것 없음)'); }
  else { try { g('commit', '-m', `예보 갱신 ${latest?.target ?? ''}`); g('push'); console.log('올림 완료'); } catch (e) { console.log('올리기 실패:', String(e.stderr || e.message).slice(0, 300)); process.exitCode = 1; } }
}
