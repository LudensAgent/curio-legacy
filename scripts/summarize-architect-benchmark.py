"""Summarize measured constraints and API usage, without an aesthetic score.

Usage: python scripts/summarize-architect-benchmark.py <results-directory>
Writes summary.json. Geometry checks are offline approximations; successful
compilation or architect acceptance does not establish live construction success.
"""
import json
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1])
records = [json.loads(p.read_text(encoding='utf-8')) for p in root.glob('*.json') if p.name not in ['manifest.json', 'summary.json']]
records = [r for r in records if 'id' in r]
rows = []
for r in records:
    e = r.get('evaluation', {})
    attempts = r.get('attempts', [])
    usage = [a['response'].get('usage') or {} for a in attempts]
    checks = {
        'compiled': e.get('compiled', False),
        'compiler_warnings_clear': e.get('compiled', False) and not e.get('warnings'),
        'footprint': e.get('requestedFootprint', False),
        'furniture': e.get('compiled', False) and not e.get('missingFacilities'),
        'light': e.get('lighting', False),
        'windows': e.get('windowCells', 0) > 0,
        'entry': e.get('doors', 0) > 0 and e.get('blockedDoors') == 0 and e.get('requiredSouthEntry') is not False,
        'base_budget_512': e.get('compiled', False) and sum(e.get('materials', {}).values()) <= 512,
    }
    rows.append({
        'id': r['id'], 'scenario': r['scenario'], 'effort': r['effort'], 'max_tokens': r['maxTokens'], 'replicate': r['replicate'],
        'calls': len(attempts), 'seconds': round(r['totalLatencyMs']/1000, 2),
        'compiled': e.get('compiled', False), 'architect_accepted': e.get('runtimeAccepted', False),
        'measured_requirements_pass': all(checks.values()), 'checks': checks,
        'truncated_calls': sum(a['response'].get('finishReason') == 'length' for a in attempts),
        'prompt_tokens': sum(u.get('prompt_tokens', 0) for u in usage),
        'cached_tokens': sum(u.get('prompt_cache_hit_tokens', u.get('prompt_tokens_details', {}).get('cached_tokens', 0)) for u in usage),
        'completion_tokens': sum(u.get('completion_tokens', 0) for u in usage),
        'reasoning_tokens': sum(u.get('completion_tokens_details', {}).get('reasoning_tokens', 0) for u in usage),
        'first_delta_ms': attempts[0]['response'].get('firstDeltaMs') if attempts else None,
        'first_content_ms': attempts[0]['response'].get('firstContentMs') if attempts else None,
        'error': r.get('error', e.get('error')), 'warnings': e.get('warnings'),
        'missing_facilities': e.get('missingFacilities'), 'footprint': e.get('footprint'),
        'block_count': len(e.get('cells', [])), 'selected_round': r.get('selectedRound'),
    })
groups = []
for effort in ['off', 'low', 'high', 'max']:
    for cap in sorted(set(r['max_tokens'] for r in rows)):
        rr = [r for r in rows if r['effort'] == effort and r['max_tokens'] == cap]
        if not rr: continue
        groups.append({'effort': effort, 'max_tokens': cap, 'n': len(rr), 'compiled': sum(r['compiled'] for r in rr),
            'architect_accepted': sum(r['architect_accepted'] for r in rr), 'measured_requirements_pass': sum(r['measured_requirements_pass'] for r in rr),
            'mean_seconds': round(statistics.mean(r['seconds'] for r in rr), 2), 'median_seconds': round(statistics.median(r['seconds'] for r in rr), 2),
            'mean_completion_tokens': round(statistics.mean(r['completion_tokens'] for r in rr)),
            'mean_reasoning_tokens': round(statistics.mean(r['reasoning_tokens'] for r in rr)),
            'truncated_calls': sum(r['truncated_calls'] for r in rr), 'cache_tokens': sum(r['cached_tokens'] for r in rr)})
summary = {'samples': len(rows), 'calls': sum(r['calls'] for r in rows), 'groups': groups, 'rows': sorted(rows, key=lambda r: r['id'])}
(root/'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({k:v for k,v in summary.items() if k != 'rows'}, ensure_ascii=False, indent=2))
