#!/usr/bin/env python3
"""Bounded, stdlib-only local KataGo CPU protocol experiment; writes raw JSON evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import queue
import re
import subprocess
import tempfile
import threading
import time


class Engine:
    def __init__(self, argv, work):
        self.argv = argv
        self.work = work
        self.memory_file = work / (str(time.time_ns()) + '.memory.txt')
        self.started = time.perf_counter()
        command = ['/usr/bin/time', '-l', '-o', str(self.memory_file), *argv] if platform.system() == 'Darwin' else argv
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, bufsize=1, cwd=work)
        self.lines = queue.Queue()
        self.stderr = []
        self.transcript = []
        self.reader = threading.Thread(target=self.read_stdout, daemon=True)
        self.errors = threading.Thread(target=self.read_stderr, daemon=True)
        self.reader.start()
        self.errors.start()

    def read_stdout(self):
        for line in self.process.stdout:
            self.lines.put(line)
        self.lines.put(None)

    def read_stderr(self):
        for line in self.process.stderr:
            self.stderr.append(line)

    def line(self, deadline):
        remaining = deadline - time.perf_counter()
        if remaining <= 0:
            raise TimeoutError('Engine response deadline exceeded')
        line = self.lines.get(timeout=remaining)
        if line is None:
            raise RuntimeError('Engine exited: ' + ''.join(self.stderr))
        return line

    def gtp(self, command, allow_error=False):
        number = len(self.transcript) + 1
        start = time.perf_counter()
        self.process.stdin.write(f'{number} {command}\n')
        self.process.stdin.flush()
        response = ''
        deadline = start + 90
        while True:
            line = self.line(deadline)
            response += line
            if line == '\n' and response.strip():
                break
        elapsed = time.perf_counter() - start
        record = {'command': command, 'response': response, 'elapsed_seconds': elapsed}
        self.transcript.append(record)
        if not response.startswith(f'={number}') and not allow_error:
            raise RuntimeError(record)
        return re.sub(r'^[=?]\d+\s?', '', response).strip()

    def query(self, query):
        start = time.perf_counter()
        self.process.stdin.write(json.dumps(query) + '\n')
        self.process.stdin.flush()
        responses = []
        while True:
            response = json.loads(self.line(start + 90))
            responses.append(response)
            if 'error' in response or ('isDuringSearch' in response and not response['isDuringSearch']):
                break
        record = {'query': query, 'responses': responses, 'elapsed_seconds': time.perf_counter() - start}
        self.transcript.append(record)
        return response

    def close(self):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            self.process.wait(timeout=5)
        self.reader.join(timeout=2)
        self.errors.join(timeout=2)
        memory = self.memory_file.read_text() if self.memory_file.exists() else None
        match = re.search(r'(\d+)\s+maximum resident set size', memory or '')
        return {'argv': self.argv, 'returncode': self.process.returncode, 'stderr': ''.join(self.stderr),
                'transcript': self.transcript, 'time_l_output': memory,
                'peak_rss_bytes': int(match[1]) if match else None}


def file_info(path):
    path = Path(path).resolve()
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()}


def run(args):
    evidence = {'host': {'system': platform.platform(), 'machine': platform.machine(),
                         'cpu_count': os.cpu_count()}, 'measured_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'scope': 'LOCAL macOS arm64 CPU only; not Cloudflare performance or playing-strength evidence',
                'engine': file_info(args.engine), 'model': file_info(args.model), 'sessions': [], 'boards': []}
    evidence['version'] = subprocess.run([args.engine, 'version'], text=True, capture_output=True, check=True).stdout
    work = Path(tempfile.mkdtemp(prefix='katago-protocol-'))
    config = '\n'.join(['logToStderr = true', 'rules = chinese-ogs', 'komi = 7.5',
                        'logAllGTPCommunication = false', 'logSearchInfo = false',
                        'logSearchInfoForChosenMove = false',
                        'resignThreshold = -0.90',
                        'maxVisits = 32', 'maxTime = 3.0', 'numSearchThreads = 2',
                        'numEigenThreadsPerModel = 2', 'nnCacheSizePowerOfTwo = 16',
                        'nnMutexPoolSizePowerOfTwo = 10', 'allowResignation = false',
                        'ponderingEnabled = false', 'searchRandSeed = just-go-feasibility',
                        'nnRandSeed = just-go-feasibility', 'chosenMoveTemperature = 0',
                        'chosenMoveTemperatureEarly = 0']) + '\n'
    (work / 'gtp.cfg').write_text(config)
    evidence['gtp_config'] = config
    engine = Engine([args.engine, 'gtp', '-model', args.model, '-config', str(work / 'gtp.cfg')], work)
    try:
        engine.gtp('protocol_version')
        evidence['startup_to_first_gtp_response_seconds'] = time.perf_counter() - engine.started
        engine.gtp('name')
        engine.gtp('version')
        engine.gtp('kata-get-models')
        for size in [9, 13, 19]:
            engine.gtp(f'boardsize {size}')
            engine.gtp('clear_board')
            engine.gtp('kata-set-rules chinese-ogs')
            engine.gtp('kata-get-rules')
            engine.gtp('komi 6.5')
            assert engine.gtp('get_komi') == '6.5'
            history = [('B', 'D4'), ('W', 'F6'), ('B', 'pass'), ('W', 'C3')]
            for color, move in history:
                engine.gtp(f'play {color} {move}')
            board_before = engine.gtp('showboard')
            sgf_before = engine.gtp('printsgf')
            engine.gtp('clear_board')
            for color, move in history:
                engine.gtp(f'play {color} {move}')
            board_after = engine.gtp('showboard')
            sgf_after = engine.gtp('printsgf')
            assert board_before == board_after
            assert sgf_before == sgf_after
            engine.gtp('clear_cache')
            move = engine.gtp('genmove B')
            seconds = engine.transcript[-1]['elapsed_seconds']
            engine.gtp('undo')
            assert engine.gtp('showboard') == board_before
            board_result = {'size': size, 'generated_move': move, 'search_wall_seconds': seconds,
                            'history_replay_board_equal': True, 'history_replay_sgf_equal': True, 'undo_board_equal': True}
            evidence['boards'].append(board_result)
        engine.gtp('boardsize 9')
        engine.gtp('clear_board')
        ko_history = [('B', 'B3'), ('W', 'B2'), ('B', 'D3'), ('W', 'D2'), ('B', 'C4'),
                      ('W', 'C1'), ('B', 'A9'), ('W', 'C3'), ('B', 'C2')]
        for color, move in ko_history:
            engine.gtp(f'play {color} {move}')
        ko_board = engine.gtp('showboard')
        engine.gtp('play W C3', allow_error=True)
        evidence['gtp_accepts_immediate_ko_recapture'] = engine.transcript[-1]['response'].startswith('=')
        engine.gtp('clear_board')
        for color, move in ko_history:
            engine.gtp(f'play {color} {move}')
        assert engine.gtp('showboard') == ko_board
        move = engine.gtp('genmove W')
        assert move.upper() != 'C3'
        evidence['ko_history_replay_search_avoids_recapture'] = True
        engine.gtp('clear_board')
        engine.gtp('komi 7.5')
        engine.gtp('kata-set-param maxVisits 10000000')
        engine.gtp('kata-set-param maxTime 30')
        cancellation_board = engine.gtp('showboard')
        cancellation_sent = []
        def cancel_search():
            cancellation_sent.append(time.perf_counter())
            engine.process.stdin.write('\n')
            engine.process.stdin.flush()
        timer = threading.Timer(0.1, cancel_search)
        timer.start()
        try:
            cancelled = engine.gtp('kata-search_cancellable B')
            cancellation_finished = time.perf_counter()
        finally:
            timer.cancel()
            timer.join()
        assert cancelled == 'cancelled'
        assert engine.gtp('showboard') == cancellation_board
        evidence['cancellation'] = {
            'result': cancelled, 'board_unchanged': True,
            'signal_to_response_ms': (cancellation_finished - cancellation_sent[0]) * 1000}
        engine.gtp('kata-set-param maxVisits 16')
        engine.gtp('kata-set-param maxTime 1.0')
        selfplay_start = time.perf_counter()
        moves = []
        passes = 0
        for ply in range(300):
            color = 'B' if ply % 2 == 0 else 'W'
            move = engine.gtp(f'genmove {color}')
            moves.append([color, move])
            passes = passes + 1 if move.lower() == 'pass' else 0
            if passes == 2 or move.lower() == 'resign':
                break
        evidence['selfplay'] = {'board_size': 9, 'moves': moves, 'ply_count': len(moves),
                                'completed': passes == 2 or moves[-1][1].lower() == 'resign',
                                'termination': 'two_passes' if passes == 2 else 'resign' if moves[-1][1].lower() == 'resign' else '300_ply_cap',
                                'wall_seconds': time.perf_counter() - selfplay_start,
                                'final_score': engine.gtp('final_score'), 'sgf': engine.gtp('printsgf')}
        engine.gtp('quit')
    finally:
        evidence['sessions'].append(engine.close())
        Path(args.output).write_text(json.dumps(evidence, indent=2) + '\n')
    analysis_config = '\n'.join(['logToStderr = true', 'numAnalysisThreads = 1',
                                  'numSearchThreadsPerAnalysisThread = 2', 'numEigenThreadsPerModel = 2',
                                  'maxVisits = 32', 'nnCacheSizePowerOfTwo = 16', 'nnMutexPoolSizePowerOfTwo = 10']) + '\n'
    (work / 'analysis.cfg').write_text(analysis_config)
    evidence['analysis_config'] = analysis_config
    analysis = Engine([args.engine, 'analysis', '-model', args.model, '-config', str(work / 'analysis.cfg')], work)
    try:
        for size in [9, 13, 19]:
            query = {'id': str(size), 'moves': [['B', 'D4'], ['W', 'F6'], ['B', 'pass'], ['W', 'C3']],
                     'rules': 'chinese-ogs', 'komi': 6.5, 'boardXSize': size, 'boardYSize': size,
                     'maxVisits': 32, 'includePolicy': True, 'includeOwnership': True}
            result = analysis.query(query)
            assert 'error' not in result and result['turnNumber'] == 4
            assert len(result['policy']) == size * size + 1
            assert len(result['ownership']) == size * size
        ko_query = dict(query, id='ko-policy', boardXSize=9, boardYSize=9,
                        moves=[list(move) for move in ko_history])
        result = analysis.query(ko_query)
        assert result['policy'][(9 - 3) * 9 + 2] == -1
        evidence['analysis_ko_recapture_policy'] = result['policy'][(9 - 3) * 9 + 2]
        # Input replay is intentionally tolerant; search legality is a different contract.
        tolerant = analysis.query(dict(ko_query, id='ko-input', moves=ko_query['moves'] + [['W', 'C3']]))
        evidence['analysis_accepts_immediate_ko_recapture_input'] = 'error' not in tolerant
        illegal = dict(query, id='occupied-point', boardXSize=9, boardYSize=9,
                       moves=[['B', 'D4'], ['W', 'D4']])
        result = analysis.query(illegal)
        assert 'error' in result
        evidence['analysis_rejects_occupied_point'] = True
    finally:
        evidence['sessions'].append(analysis.close())
        Path(args.output).write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'output': args.output, 'boards': evidence['boards'],
                      'startup_seconds': evidence['startup_to_first_gtp_response_seconds'],
                      'selfplay': {key: value for key, value in evidence['selfplay'].items() if key not in ['moves', 'sgf']},
                      'peak_rss_bytes': [session['peak_rss_bytes'] for session in evidence['sessions']]}, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--engine', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    arguments.engine = str(Path(arguments.engine).resolve())
    arguments.model = str(Path(arguments.model).resolve())
    print('Starting bounded KataGo protocol experiment', flush=True)
    run(arguments)
