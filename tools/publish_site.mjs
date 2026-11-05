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
const addDays = (d, k) => new Date(Date.parse(d + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
function actualOf(d) {   // 사전 등록 4-1: 대상일 D 의 D+1~D+3 수집 스냅숏 중 가장 이른 것. 없으면 '정답 없음'(null)
  const ymd = d.replace(/-/g, ''), lo = addDays(d, 1), hi = addDays(d, 3);
  const s = kac.filter(r => r.searchday === ymd && r.fetched_kst.slice(0, 8) >= lo && r.fetched_kst.slice(0, 8) <= hi).sort((a, b) => a.fetched_kst.localeCompare(b.fetched_kst))[0];
  if (!s) return null; const ppf = ppfOf(d), nc = +s.n_cancel, npc = +(s.n_precancel || 0);
  if (!Number.isFinite(nc) || !Number.isFinite(ppf)) return null;
  return { cancel: nc, precancel: npc, flights: +s.n_operating_flights, ppf, stranded: Math.round(nc * ppf), stranded_incl_precancel: Math.round((nc + npc) * ppf), crisis: nc * ppf >= 3000 ? 1 : 0, snapshot: s.fetched_kst };
}
// 내일 06~23시 시간대별 바람(예측에 쓴 바람 발표분 그대로)
function hourlyOf(target, issueWind, issuePty) {
  const want = target.replace(/-/g, '');
  const load = (issue, cats) => { const v = {}; if (!issue) return v;
    const f = J(`raw/live/${want}/fcst_${issue.slice(0, 10).replace(/-/g, '')}_${issue.slice(11, 13)}00.json`); if (!existsSync(f)) return v;
    for (const x of JSON.parse(readFileSync(f, 'utf8'))) if (x.fcstDate === want && cats.includes(x.category)) (v[+x.fcstTime.slice(0, 2)] ??= {})[x.category] = +x.fcstValue;
    return v; };
  const w = load(issueWind, ['WSD', 'VEC', 'UUU', 'VVV']), pt = load(issuePty || issueWind, ['PTY']);
  const out = [];
  for (let h = 6; h <= 23; h++) { const r = w[h]; if (!r) continue;
    let ws = r.WSD, dir = r.VEC;
    if ((ws == null || dir == null) && r.UUU != null && r.VVV != null) { ws = Math.hypot(r.UUU, r.VVV); dir = (Math.atan2(-r.UUU, -r.VVV) * 180 / Math.PI + 360) % 360; }   // 풍속·풍향이 없으면 동서·남북 성분으로 복원
    if (ws == null || dir == null) continue;
    const pty = pt[h]?.PTY ?? 0;   // 0 없음, 1 비, 2 비/눈, 3 눈, 4 소나기
    out.push({ h, wind_kt: +(ws * 1.94384).toFixed(1), xwind_kt: +(ws * Math.abs(Math.sin((dir - 58.46) * Math.PI / 180)) * 1.94384).toFixed(1), dir, pty, rain: pty > 0 ? 1 : 0 }); }
  return out;
}
const preds = csv(J('data/live_predictions.csv')).filter(r => r.recorded_before_target === '1');
const byTarget = {}; for (const r of preds) if (!byTarget[r.target] || byTarget[r.target].run_kst > r.run_kst) byTarget[r.target] = r;   // 대상일마다 첫 공식 기록
const histFile = path.join(SITE, 'data', 'history.json');
const prev = existsSync(histFile) ? Object.fromEntries(JSON.parse(readFileSync(histFile, 'utf8')).map(h => [h.target, h])) : {};
const history = Object.values(byTarget).sort((a, b) => a.target.localeCompare(b.target)).map(r => {
  const p = r.p_caution === '' ? null : +r.p_caution; const old = prev[r.target];
  const t = old && old.basis === 'combo' ? { basis: old.basis, combo: old.combo, tier: old.tier, amo_score: old.amo_score, token: old.token } : tierOf(p, dayBefore(r.target));
  const actual = old && old.actual ? old.actual : actualOf(r.target);
  return { target: r.target, issued_kst: r.run_kst, model_p: p, ...t, provisional: t.basis !== 'combo', actual };
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
    hourly: hourlyOf(last.target, ft.fc_issue_wind, ft.fc_issue_pty), generated_kst: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
    warnings: f.pre || {}, flights: { plan: ft.plan_dep_lag7 ?? null, plan_source: ft.plan_source ?? null, d2_cancel: ft.d2_cancel_dep ?? null } };
}
mkdirSync(path.join(SITE, 'data'), { recursive: true });
writeFileSync(path.join(SITE, 'data', 'latest.json'), JSON.stringify(latest, null, 1));
writeFileSync(path.join(SITE, 'data', 'history.json'), JSON.stringify(history, null, 1));
console.log(`latest ${latest?.target} 단계 ${latest?.tier} (${latest?.basis}) | 기록 ${history.length}일`);
if (process.argv.includes('--push')) {
  const g = (...a) => execFileSync('git', a, { cwd: SITE, stdio: 'pipe' }).toString();
  // 사이트 파일만 올린다(정해 둔 목록). 화면·도구를 고친 것도 다음 자동 실행 때 함께 올라간다.
  const files = ['index.html', 'README.md', '.nojekyll', 'data/latest.json', 'data/history.json', 'data/reference.json', 'data/backtest_calendar.json', 'tools/publish_site.mjs'].filter(f => existsSync(path.join(SITE, f)));
  g('add', '--', ...files);
  if (!g('diff', '--cached', '--name-only').trim()) { console.log('바뀐 내용 없음 (올릴 것 없음)'); }
  else { try { g('commit', '-m', `예보 갱신 ${latest?.target ?? ''}`); g('push'); console.log('올림 완료'); } catch (e) { console.log('올리기 실패:', String(e.stderr || e.message).slice(0, 300)); process.exitCode = 1; } }
}
