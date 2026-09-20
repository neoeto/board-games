#!/usr/bin/env python3
"""Bounded local engine measurements, not a Cloudflare benchmark or rules oracle."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import platform
import statistics
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parent


def load_adapter(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Engine


GoEngine = load_adapter('go_probe', ROOT / 'katago/run.py')
XiangqiEngine = load_adapter('xiangqi_probe', ROOT / 'pikafish/probe.py')


def describe(values):
    ordered = sorted(values)
    return {'samples': len(values), 'median_ms': statistics.median(values),
            'p95_ms': ordered[math.ceil(len(values) * .95) - 1], 'max_ms': ordered[-1]}


def worker(args, index, count, board, barrier):
    engine = None
    try:
        if args.kind == 'katago':
            work = Path(tempfile.mkdtemp(prefix='just-go-load-'))
            config = work / 'analysis.cfg'
            config.write_text('logToStderr = true\nnumAnalysisThreads = 1\n'
                              'numSearchThreadsPerAnalysisThread = 2\nnumEigenThreadsPerModel = 2\n'
                              'maxVisits = 32\nnnCacheSizePowerOfTwo = 16\nnnMutexPoolSizePowerOfTwo = 10\n')
            engine = GoEngine([str(args.engine), 'analysis', '-model', str(args.model), '-config', str(config)], work)
            query = {'id': f'{index}-warmup', 'moves': [['B', 'D4'], ['W', 'F6'], ['B', 'pass'], ['W', 'C3']],
                     'rules': 'chinese-ogs', 'komi': 6.5, 'boardXSize': board, 'boardYSize': board,
                     'maxVisits': 32, 'includePolicy': True}
            warmup = engine.query(query)
            if 'error' in warmup:
                raise RuntimeError(warmup)
        else:
            engine = XiangqiEngine(args.engine, args.model)
            engine.send('uci')
            engine.until('uciok')
            for option in ['Threads value 1', 'Hash value 64', 'Ponder value false', 'EvalFile value ' + str(args.model)]:
                engine.send('setoption name ' + option)
            engine.ready()
            engine.search('position startpos', 'depth 1')
        ready_ms = (time.perf_counter() - engine.started) * 1000
        samples = []
        for sample in range(args.samples):
            if args.kind == 'pikafish':
                engine.reset()
            barrier.wait(timeout=120)
            if args.kind == 'katago':
                # Distinct legal positions avoid measuring cached repeated answers.
                vertex = 'A' + str(sample % board + 1)
                result = engine.query(dict(query, id=f'{index}-{sample}',
                                           moves=query['moves'] + [['B', vertex]]))
                if 'error' in result:
                    raise RuntimeError(result)
                if any('warning' in item for item in engine.transcript[-1]['responses']):
                    raise RuntimeError('Engine substituted settings; inspect warnings')
                elapsed = engine.transcript[-1]['elapsed_seconds'] * 1000
                best = min(result['moveInfos'], key=lambda move: move['order'])
                samples.append({'elapsed_ms': elapsed, 'input_extra_move': vertex,
                                'move': best['move'], 'visits': result['rootInfo']['visits']})
            else:
                result = engine.search('position startpos moves h2e2 h9g7 h0g2 g6g5', 'movetime 250')
                if result['bestmove'] not in engine.legal_moves():
                    raise RuntimeError('Search returned move outside engine legal set')
                samples.append({'elapsed_ms': result['elapsed_ms'], 'move': result['bestmove'],
                                'last_info': next((line for line in reversed(result['output']) if line.startswith('info depth')), None)})
        return {'worker': index, 'process_to_warmup_ms': ready_ms, 'samples': samples}
    except BaseException:
        barrier.abort()
        raise
    finally:
        if engine is not None:
            engine.close()


def main(args):
    args.engine = args.engine.resolve()
    args.model = args.model.resolve()
    report = {'scope': 'LOCAL host CPU process concurrency, NOT Cloudflare latency, capacity or billing',
              'host': platform.platform(), 'machine': platform.machine(),
              'measured_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'kind': args.kind, 'engine_sha256': hashlib.file_digest(args.engine.open('rb'), 'sha256').hexdigest(),
              'model_sha256': hashlib.file_digest(args.model.open('rb'), 'sha256').hexdigest(),
              'limits': {'go_search_threads_per_process': 2, 'go_eigen_threads': 2, 'go_visits': 32,
                         'xiangqi_threads_per_process': 1, 'xiangqi_hash_mib': 64, 'xiangqi_movetime_ms': 250},
              'caveats': ['Warmed processes: Go varies the position each sample (A-file cycling if samples exceed board size); Xiangqi hash resets each sample.',
                          'One independent engine process per concurrent request, not shared-process queue capacity.',
                          'Process launch/warmup is measured but not OS-cache cold or Cloudflare cold start.',
                          'Small samples and engine-only legal checks do not prove SLO or formal-rule compliance.'],
              'batches': []}
    try:
        for board in ([9, 13, 19] if args.kind == 'katago' else [None]):
            for count in [1, 5, 10]:
                started = time.perf_counter()
                barrier = threading.Barrier(count)
                with ThreadPoolExecutor(max_workers=count) as pool:
                    futures = [pool.submit(worker, args, index, count, board, barrier) for index in range(count)]
                    results = [future.result() for future in futures]
                times = [sample['elapsed_ms'] for result in results for sample in result['samples']]
                batch = {'board_size': board, 'concurrency': count, 'wall_seconds': time.perf_counter() - started,
                         'latency': describe(times), 'workers': results}
                report['batches'].append(batch)
                print(json.dumps({key: batch[key] for key in ['board_size', 'concurrency', 'latency']}), flush=True)
        report['success'] = True
    except BaseException as error:
        report['success'] = False
        report['error'] = repr(error)
        raise
    finally:
        args.output.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kind', choices=['katago', 'pikafish'], required=True)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=5)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error('--samples must be positive')
    main(args)
